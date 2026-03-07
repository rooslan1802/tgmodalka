import seedChildren from '../data/children.seed.json';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { ARIAL_TTF_BASE64 } from './embeddedFont.js';

const BASE_URL = 'https://damubala.kz';
const API_URL = `${BASE_URL}/v1`;
const CHILDREN_KEY = 'children:v1';
const CHAT_STATE_PREFIX = 'chat-state:v1:';
let wasmReady = false;
let arialFontBytes = null;

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

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function trimWithEllipsis(text, maxLen = 44) {
  const value = String(text || '').trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(1, maxLen - 1)).trim()}...`;
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function childKey(item = {}) {
  const login = cleanDigits(item.login);
  const name = normalizeText(item.childName);
  return `${login}|${name}`;
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

async function tgApiMultipart(env, method, fields = {}, fileFieldName, fileBytes, fileName, contentType) {
  const token = String(env.BOT_TOKEN || '').trim();
  if (!token) throw new Error('BOT_TOKEN is missing');

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.set(key, String(value));
  }
  form.set(fileFieldName, new Blob([fileBytes], { type: contentType }), fileName);

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: form
  });
  const data = await res.json();
  if (!data?.ok) throw new Error(data?.description || `Telegram API ${method} failed`);
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

async function sendDocument(env, chatId, bytes, fileName, caption = '', contentType = 'application/octet-stream') {
  return tgApiMultipart(
    env,
    'sendDocument',
    {
      chat_id: chatId,
      caption
    },
    'document',
    bytes,
    fileName,
    contentType
  );
}

async function sendPhotoBytes(env, chatId, bytes, fileName, caption = '', contentType = 'image/png') {
  return tgApiMultipart(
    env,
    'sendPhoto',
    {
      chat_id: chatId,
      caption
    },
    'photo',
    bytes,
    fileName,
    contentType
  );
}

async function answerCallback(env, callbackQueryId, text = '') {
  return tgApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text
  });
}

function chatStateKey(chatId) {
  return `${CHAT_STATE_PREFIX}${chatId}`;
}

async function loadChatState(env, chatId) {
  const raw = await env.CHILDREN_KV.get(chatStateKey(chatId));
  if (!raw) return { paused: false, awaitingQr: false };
  try {
    const parsed = JSON.parse(raw);
    return {
      paused: Boolean(parsed?.paused),
      awaitingQr: Boolean(parsed?.awaitingQr)
    };
  } catch {
    return { paused: false, awaitingQr: false };
  }
}

async function saveChatState(env, chatId, state) {
  const payload = {
    paused: Boolean(state?.paused),
    awaitingQr: Boolean(state?.awaitingQr)
  };
  await env.CHILDREN_KV.put(chatStateKey(chatId), JSON.stringify(payload));
}

async function sendChatAction(env, chatId, action) {
  return tgApi(env, 'sendChatAction', {
    chat_id: chatId,
    action
  });
}

async function loadChildren(env) {
  const seeded = Array.isArray(seedChildren) ? seedChildren : [];
  const raw = await env.CHILDREN_KV.get(CHILDREN_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const map = new Map();
        for (const row of parsed) {
          const key = childKey(row);
          if (!key) continue;
          map.set(key, row);
        }
        for (const row of seeded) {
          const key = childKey(row);
          if (!key) continue;
          if (!map.has(key)) map.set(key, row);
        }
        const merged = [...map.values()];
        if (merged.length !== parsed.length) {
          await saveChildren(env, merged);
        }
        return merged;
      }
    } catch {
      // fallback to seed
    }
  }
  const map = new Map();
  for (const row of seeded) {
    const key = childKey(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, row);
  }
  const uniqueSeed = [...map.values()];
  await env.CHILDREN_KV.put(CHILDREN_KEY, JSON.stringify(uniqueSeed));
  return uniqueSeed;
}

async function saveChildren(env, items) {
  await env.CHILDREN_KV.put(CHILDREN_KEY, JSON.stringify(Array.isArray(items) ? items : []));
}

async function resetChildrenFromSeed(env) {
  const seeded = Array.isArray(seedChildren) ? seedChildren : [];
  const map = new Map();
  for (const row of seeded) {
    const key = childKey(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, row);
  }
  const uniqueSeed = [...map.values()];
  await saveChildren(env, uniqueSeed);
  return uniqueSeed.length;
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

async function ensureResvgWasm() {
  if (wasmReady) return;
  await initWasm(resvgWasm);
  wasmReady = true;
}

function buildModalSvg({ childName, qrPngBase64 }) {
  const safeName = escapeXml(trimWithEllipsis(childName || ''));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="920" height="1100" viewBox="0 0 920 1100" xmlns="http://www.w3.org/2000/svg">
  <rect width="920" height="1100" fill="#d4ccc1"/>
  <rect x="20" y="24" width="880" height="1030" rx="10" fill="#f4f5f8"/>
  <text x="104" y="124" fill="#1f2440" font-size="56" font-weight="800" font-family="Arial">Подписание с помощью QR</text>
  <text x="104" y="190" fill="#7b819b" font-size="42" font-family="Arial">Отсканируйте QR-код с помощью</text>
  <text x="104" y="240" fill="#7b819b" font-size="42" font-family="Arial">мобильного приложения Egov Mobile</text>
  <rect x="104" y="282" width="712" height="160" rx="14" fill="#f7dec8" stroke="#f2b17f" stroke-width="2"/>
  <text x="130" y="334" fill="#1f2440" font-size="26" font-weight="700" font-family="Arial">После подписания в Egov Mobile, можете</text>
  <text x="130" y="372" fill="#1f2440" font-size="26" font-weight="700" font-family="Arial">нажать на кнопку "Продолжить" или закрыть</text>
  <text x="130" y="406" fill="#1f2440" font-size="26" font-weight="700" font-family="Arial">модальное окно</text>
  <text x="104" y="490" fill="#6b7088" font-size="44" font-weight="700" font-family="Arial">${safeName}</text>
  <text x="850" y="86" fill="#111" font-size="54" font-family="Arial">×</text>
  <rect x="245" y="512" width="430" height="430" fill="#fff"/>
  <image x="245" y="512" width="430" height="430" href="data:image/png;base64,${qrPngBase64}"/>
  <rect x="245" y="930" width="430" height="86" rx="14" fill="#ff7400"/>
  <text x="322" y="986" fill="#fff" font-size="46" font-weight="700" font-family="Arial">Продолжить</text>
</svg>`;
}

async function buildModalPngBytes({ childName, qrValue }) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1024x1024&margin=20&data=${encodeURIComponent(qrValue)}`;
  const qrResponse = await fetch(qrUrl);
  if (!qrResponse.ok) {
    throw new Error(`QR fetch failed: HTTP ${qrResponse.status}`);
  }
  const qrBytes = new Uint8Array(await qrResponse.arrayBuffer());
  const qrPngBase64 = bytesToBase64(qrBytes);
  if (!qrPngBase64) throw new Error('Не удалось построить QR');

  const svg = buildModalSvg({ childName, qrPngBase64 });
  await ensureResvgWasm();
  if (!arialFontBytes) {
    arialFontBytes = base64ToBytes(ARIAL_TTF_BASE64);
  }
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 920 },
    font: {
      fontFiles: [arialFontBytes],
      loadSystemFonts: false,
      defaultFontFamily: 'Arial'
    }
  });
  const pngData = resvg.render();
  return pngData.asPng();
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
      qrValue: link,
      passwordUsed: auth.passwordUsed,
      passwordUpdated: auth.passwordUpdated
    };
  }

  return { success: false, message: 'Не найдено записей для подписания' };
}

function buildStartKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🟢 START', callback_data: 'ctrl:start' },
        { text: '⛔ STOP', callback_data: 'ctrl:stop' }
      ],
      [
        { text: '🔄 ОБНОВИТЬ БАЗУ', callback_data: 'seed_import' },
        { text: '👥 КОЛ-ВО', callback_data: 'count_children' }
      ]
    ]
  };
}

function buildReplyKeyboard() {
  return {
    keyboard: [
      [{ text: 'START' }, { text: 'STOP' }],
      [{ text: '/import_seed' }, { text: '/count' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

async function sendMainKeyboard(env, chatId, text = 'Выберите действие:') {
  return sendMessage(env, chatId, text, { reply_markup: buildReplyKeyboard() });
}

async function handleMessage(env, message) {
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (!chatId || !text) return;

  if (text === '/start') {
    const all = await loadChildren(env);
    await saveChatState(env, chatId, { paused: false, awaitingQr: false });
    await sendMessage(
      env,
      chatId,
      `Бот готов. Детей в базе: ${all.length}.\n` +
        'Нажмите START и сразу введите имя ребенка.',
      {
        reply_markup: buildStartKeyboard()
      }
    );
    await sendMainKeyboard(env, chatId, 'Быстрые кнопки активированы.');
    return;
  }

  if (text === 'START') {
    await saveChatState(env, chatId, { paused: false, awaitingQr: true });
    await sendMessage(env, chatId, 'Режим запущен. Введите имя ребенка для поиска.', { reply_markup: buildStartKeyboard() });
    await sendMainKeyboard(env, chatId);
    return;
  }

  if (text === 'STOP') {
    await saveChatState(env, chatId, { paused: true, awaitingQr: false });
    await sendMessage(env, chatId, 'Режим остановлен. Нажмите START для продолжения.', { reply_markup: buildStartKeyboard() });
    await sendMainKeyboard(env, chatId);
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

  const state = await loadChatState(env, chatId);
  if (state.paused) {
    await sendMessage(env, chatId, 'Бот на паузе. Нажмите START.');
    return;
  }

  if (!state.awaitingQr) {
    await sendMessage(env, chatId, 'Нажмите START, затем введите имя ребенка.');
    await sendMainKeyboard(env, chatId);
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
  await saveChatState(env, chatId, { ...state, awaitingQr: false });
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
    await sendMainKeyboard(env, chatId);
    return;
  }

  if (data === 'ctrl:start') {
    await answerCallback(env, callbackId, 'Запущено');
    await saveChatState(env, chatId, { paused: false, awaitingQr: true });
    await sendMessage(env, chatId, 'Режим запущен. Введите имя ребенка для поиска.', { reply_markup: buildStartKeyboard() });
    await sendMainKeyboard(env, chatId);
    return;
  }

  if (data === 'ctrl:stop') {
    await answerCallback(env, callbackId, 'Остановлено');
    await saveChatState(env, chatId, { paused: true, awaitingQr: false });
    await sendMessage(env, chatId, 'Режим остановлен. Нажмите START для продолжения.', { reply_markup: buildStartKeyboard() });
    await sendMainKeyboard(env, chatId);
    return;
  }

  if (data === 'count_children') {
    await answerCallback(env, callbackId, 'Считаю...');
    const all = await loadChildren(env);
    await sendMessage(env, chatId, `В базе ${all.length} детей.`);
    await sendMainKeyboard(env, chatId);
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
    if (!result.success || !result.qrValue) {
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

    const modalPngBytes = await buildModalPngBytes({
      childName: child.childName,
      qrValue: result.qrValue
    });
    await sendPhotoBytes(
      env,
      chatId,
      modalPngBytes,
      `modal-${cleanDigits(child.login) || child.id}.png`,
      caption,
      'image/png'
    );
    await sendMainKeyboard(env, chatId);
  } catch (error) {
    await sendMessage(env, chatId, `Ошибка генерации QR: ${error?.message || 'неизвестная ошибка'}`);
    await sendMainKeyboard(env, chatId);
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
