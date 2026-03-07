import seedChildren from '../data/children.seed.json';

const BASE_URL = 'https://damubala.kz';
const API_URL = `${BASE_URL}/v1`;
const CHILDREN_KEY = 'children:v1';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function cleanDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function escapeMarkdown(text) {
  return String(text || '').replace(/([_\-*\[\]()~`>#+=|{}.!])/g, '\\$1');
}

async function tgApi(env, method, payload) {
  const token = String(env.BOT_TOKEN || '').trim();
  if (!token) throw new Error('BOT_TOKEN is missing');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data?.ok) {
    throw new Error(data?.description || `Telegram API ${method} failed`);
  }
  return data.result;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function sendPhoto(env, chatId, photoUrl, caption = '') {
  return tgApi(env, 'sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption
  });
}

async function answerCallback(env, callbackQueryId, text = '') {
  return tgApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text
  });
}

async function sendChatAction(env, chatId, action) {
  return tgApi(env, 'sendChatAction', {
    chat_id: chatId,
    action
  });
}

async function loadChildren(env) {
  const raw = await env.CHILDREN_KV.get(CHILDREN_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fallback to seed
    }
  }
  const seeded = Array.isArray(seedChildren) ? seedChildren : [];
  await env.CHILDREN_KV.put(CHILDREN_KEY, JSON.stringify(seeded));
  return seeded;
}

async function saveChildren(env, items) {
  await env.CHILDREN_KV.put(CHILDREN_KEY, JSON.stringify(Array.isArray(items) ? items : []));
}

async function resetChildrenFromSeed(env) {
  const seeded = Array.isArray(seedChildren) ? seedChildren : [];
  await saveChildren(env, seeded);
  return seeded.length;
}

function findChildrenByName(all, query, limit = 8) {
  const q = normalizeText(query);
  if (!q) return [];
  return all
    .map((item) => {
      const name = normalizeText(item.childName);
      let score = 0;
      if (name === q) score = 300;
      else if (name.startsWith(q)) score = 200;
      else if (name.includes(q)) score = 120;
      if (!score) return null;
      return { item, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.item.childName.localeCompare(b.item.childName, 'ru'))
    .slice(0, limit)
    .map((x) => x.item);
}

function pickAuth(data) {
  const token = data?.token?.token || data?.token?.accessToken || data?.token;
  const userId = data?.userId;
  if (!token || !userId) return null;
  return { token, userId };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function apiRequest(path, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function signIn(iin, password, timeoutMs) {
  const response = await apiRequest('/v1/Account/SignIn', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ iin, password })
  }, timeoutMs);

  const data = await readJson(response);
  const auth = pickAuth(data);
  const message = String(data?.message || data?.error || '').toLowerCase();
  const forceUpdate = Boolean(data?.expired) || message.includes('update password') || message.includes('обнов') || message.includes('устар');

  return {
    ok: response.ok,
    token: auth?.token || null,
    userId: auth?.userId || null,
    expired: forceUpdate
  };
}

async function updateExpiredPassword(token, currentPassword, newPassword, timeoutMs) {
  const response = await apiRequest('/v1/Account/UpdateUserPassword', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ currentPassword, newPassword })
  }, timeoutMs);
  return response.ok;
}

function pickAlternatePassword(currentPassword, defaultPassword1, defaultPassword2) {
  const p1 = String(defaultPassword1 || '').trim();
  const p2 = String(defaultPassword2 || '').trim();
  if (!currentPassword) return p1 || p2;
  if (currentPassword === p1) return p2 || p1;
  if (currentPassword === p2) return p1 || p2;
  return p1 || p2;
}

async function signInWithFallback({ iin, rowPassword, defaultPassword1, defaultPassword2, timeoutMs }) {
  const tried = new Set();
  const passwords = [rowPassword, defaultPassword1, defaultPassword2]
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value) return false;
      if (tried.has(value)) return false;
      tried.add(value);
      return true;
    });

  for (const password of passwords) {
    const login = await signIn(iin, password, timeoutMs);
    if (!login.ok || !login.token || !login.userId) continue;

    if (login.expired) {
      const alternatePassword = pickAlternatePassword(password, defaultPassword1, defaultPassword2);
      if (!alternatePassword || alternatePassword === password) continue;

      const changed = await updateExpiredPassword(login.token, password, alternatePassword, timeoutMs);
      if (!changed) continue;

      const retry = await signIn(iin, alternatePassword, timeoutMs);
      if (retry.ok && retry.token && retry.userId) {
        return {
          token: retry.token,
          userId: retry.userId,
          passwordUsed: alternatePassword,
          passwordUpdated: true
        };
      }
      continue;
    }

    return {
      token: login.token,
      userId: login.userId,
      passwordUsed: password,
      passwordUpdated: false
    };
  }

  return null;
}

async function getTimeSheets(authHeaders, timeoutMs) {
  const pageSize = 100;
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await apiRequest(
      `/v1/timeSheet/Get?PageNumber=${page}&PageSize=${pageSize}&hVisitHistoryStatusIds=1`,
      {
        method: 'GET',
        headers: authHeaders
      },
      timeoutMs
    );
    if (!response.ok) break;
    const data = await readJson(response);
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function getSignatureDetails(attendanceId, authHeaders, timeoutMs) {
  const response = await apiRequest(`/v1/timeSheet/SignatureDetails/${attendanceId}?userId=`, {
    method: 'GET',
    headers: authHeaders
  }, timeoutMs);
  if (!response.ok) return [];
  const data = await readJson(response);
  return Array.isArray(data) ? data : [];
}

async function verifyBeforeSign(attendanceId, subscriptionIds, authHeaders, timeoutMs) {
  const response = await apiRequest('/v1/timeSheet/ParentVerifyBeforeSign', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ attendanceId, subscriptionIds })
  }, timeoutMs);
  return response.ok;
}

function buildEgovSignLink({ attendanceId, userId, subscriptionIds }) {
  const payload = subscriptionIds.join('-');
  return `mobileSign:${API_URL}/EgovMobile/mgovSign?id=${attendanceId}&egovMobileSignType=1&userId=${userId}&payload=${payload}`;
}

function buildQrImageUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=1024x1024&margin=20&data=${encodeURIComponent(value)}`;
}

async function generateQr(env, child) {
  const iin = cleanDigits(child.login);
  if (iin.length !== 12) {
    return { success: false, message: 'Некорректный ИИН/логин' };
  }

  const default1 = String(env.DEFAULT_PASSWORD_1 || 'Aa123456!').trim();
  const default2 = String(env.DEFAULT_PASSWORD_2 || 'Aa123456@').trim();

  const auth = await signInWithFallback({
    iin,
    rowPassword: child.password,
    defaultPassword1: child.backupPassword1 || default1,
    defaultPassword2: child.backupPassword2 || default2,
    timeoutMs: 45000
  });

  if (!auth) {
    return { success: false, message: 'Не удалось войти в Damubala' };
  }

  const authHeaders = {
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${auth.token}`,
    pragma: 'no-cache',
    'cache-control': 'no-cache',
    'content-type': 'application/json'
  };

  const sheets = await getTimeSheets(authHeaders, 45000);
  if (!sheets.length) {
    return { success: false, message: 'Нет табелей на подпись' };
  }

  for (const sheet of sheets) {
    const attendanceId = sheet?.id;
    if (!attendanceId) continue;

    const details = await getSignatureDetails(attendanceId, authHeaders, 45000);
    const signable = details.filter((item) => item?.hVisitHistoryStatus?.id === 6 && item?.subscriptionId);
    if (!signable.length) continue;

    const subscriptionIds = signable.map((item) => item.subscriptionId);
    const verifyOk = await verifyBeforeSign(attendanceId, subscriptionIds, authHeaders, 45000);
    if (!verifyOk) continue;

    const link = buildEgovSignLink({
      attendanceId,
      userId: auth.userId,
      subscriptionIds
    });

    return {
      success: true,
      qrUrl: buildQrImageUrl(link),
      passwordUsed: auth.passwordUsed,
      passwordUpdated: auth.passwordUpdated
    };
  }

  return { success: false, message: 'Не найдено записей для подписания' };
}

function buildStartKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Импорт seed базы', callback_data: 'seed_import' }],
      [{ text: 'Количество детей', callback_data: 'count_children' }]
    ]
  };
}

async function handleMessage(env, message) {
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (!chatId || !text) return;

  if (text === '/start') {
    const all = await loadChildren(env);
    await sendMessage(
      env,
      chatId,
      `Бот готов. Детей в базе: ${all.length}.\n` +
        '1) Нажмите кнопку "Импорт seed базы" при необходимости.\n' +
        '2) Напишите имя ребенка и выберите из подсказок.',
      { reply_markup: buildStartKeyboard() }
    );
    return;
  }

  if (text === '/count') {
    const all = await loadChildren(env);
    await sendMessage(env, chatId, `В базе ${all.length} детей.`);
    return;
  }

  if (text === '/import_seed') {
    const count = await resetChildrenFromSeed(env);
    await sendMessage(env, chatId, `Seed-импорт завершен. Загружено детей: ${count}`);
    return;
  }

  const all = await loadChildren(env);
  const found = findChildrenByName(all, text, 8);
  if (!found.length) {
    await sendMessage(env, chatId, 'Не нашел детей по этому имени. Попробуйте другой фрагмент.');
    return;
  }

  const inline_keyboard = found.map((item, idx) => [
    { text: `${idx + 1}. ${item.childName}`, callback_data: `pick:${item.id}` }
  ]);

  await sendMessage(
    env,
    chatId,
    `Найдено ${found.length}. Выберите ребенка:\n${found.map((x, i) => `${i + 1}. ${x.childName}`).join('\n')}`,
    { reply_markup: { inline_keyboard } }
  );
}

async function handleCallbackQuery(env, callbackQuery) {
  const data = String(callbackQuery?.data || '');
  const chatId = callbackQuery?.message?.chat?.id;
  const callbackId = callbackQuery?.id;

  if (!chatId || !callbackId) return;

  if (data === 'seed_import') {
    await answerCallback(env, callbackId, 'Импортирую...');
    const count = await resetChildrenFromSeed(env);
    await sendMessage(env, chatId, `Seed-импорт завершен. Загружено детей: ${count}`);
    return;
  }

  if (data === 'count_children') {
    await answerCallback(env, callbackId, 'Считаю...');
    const all = await loadChildren(env);
    await sendMessage(env, chatId, `В базе ${all.length} детей.`);
    return;
  }

  if (!data.startsWith('pick:')) {
    await answerCallback(env, callbackId);
    return;
  }

  const childId = data.slice(5);
  const all = await loadChildren(env);
  const child = all.find((x) => String(x.id) === String(childId));

  if (!child) {
    await answerCallback(env, callbackId, 'Ребенок не найден');
    await sendMessage(env, chatId, 'Ребенок не найден в базе.');
    return;
  }

  await answerCallback(env, callbackId, 'Генерирую QR...');
  await sendChatAction(env, chatId, 'upload_photo');

  try {
    const result = await generateQr(env, child);
    if (!result.success || !result.qrUrl) {
      await sendMessage(env, chatId, `Ошибка генерации QR: ${result.message || 'неизвестная ошибка'}`);
      return;
    }

    if (result.passwordUsed && result.passwordUsed !== child.password) {
      const next = all.map((item) =>
        String(item.id) === String(child.id) ? { ...item, password: result.passwordUsed } : item
      );
      await saveChildren(env, next);
    }

    let caption = `Ребенок: ${child.childName}`;
    if (result.passwordUpdated) {
      caption += '\nПароль обновлен на запасной (как в Studia).';
    }

    await sendPhoto(env, chatId, result.qrUrl, caption);
    await sendMessage(
      env,
      chatId,
      `Ссылка для подписи:\n${escapeMarkdown('Отсканируйте QR для подписи в Egov Mobile')}`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (error) {
    await sendMessage(env, chatId, `Ошибка генерации QR: ${error?.message || 'неизвестная ошибка'}`);
  }
}

async function handleWebhook(env, request) {
  const expected = String(env.WEBHOOK_SECRET || '').trim();
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const secret = pathParts[1] || '';

  if (!expected || secret !== expected) {
    return jsonResponse({ ok: false, message: 'forbidden' }, 403);
  }

  const update = await request.json();
  if (update?.message) {
    await handleMessage(env, update.message);
  } else if (update?.callback_query) {
    await handleCallbackQuery(env, update.callback_query);
  }

  return jsonResponse({ ok: true });
}

async function handleSetWebhook(env) {
  const baseUrl = String(env.PUBLIC_BASE_URL || '').trim();
  const secret = String(env.WEBHOOK_SECRET || '').trim();
  if (!baseUrl || !secret) {
    return jsonResponse({ ok: false, message: 'PUBLIC_BASE_URL/WEBHOOK_SECRET missing' }, 400);
  }
  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhook/${secret}`;
  const result = await tgApi(env, 'setWebhook', {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query']
  });
  return jsonResponse({ ok: true, webhookUrl, result });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'tgmodalka-cloudflare-worker' });
    }

    if (url.pathname === '/set-webhook') {
      return handleSetWebhook(env);
    }

    if (request.method === 'POST' && url.pathname.startsWith('/webhook/')) {
      return handleWebhook(env, request);
    }

    return jsonResponse({
      ok: true,
      service: 'tgmodalka-cloudflare-worker',
      routes: ['/health', '/set-webhook', 'POST /webhook/<secret>']
    });
  }
};
