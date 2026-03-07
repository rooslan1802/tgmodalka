const QRCode = require('qrcode');

const BASE_URL = 'https://damubala.kz';
const API_URL = `${BASE_URL}/v1`;

function normalizeIin(value) {
  return String(value || '').replace(/\D/g, '').trim();
}

function buildEgovSignLink({ attendanceId, userId, subscriptionIds }) {
  const payload = subscriptionIds.join('-');
  return `mobileSign:${API_URL}/EgovMobile/mgovSign?id=${attendanceId}&egovMobileSignType=1&userId=${userId}&payload=${payload}`;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function matchChildName(targetName, candidateName) {
  const t = normalizeName(targetName);
  const c = normalizeName(candidateName);
  if (!t || !c) return false;
  if (c.includes(t) || t.includes(c)) return true;
  const tTokens = t.split(' ').filter(Boolean);
  const cTokens = c.split(' ').filter(Boolean);
  if (!tTokens.length || !cTokens.length) return false;
  const common = tTokens.filter((x) => cTokens.includes(x)).length;
  return common >= Math.min(2, tTokens.length);
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
    status: response.status,
    token: auth?.token || null,
    userId: auth?.userId || null,
    expired: forceUpdate,
    data
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
    if (!login.ok || !login.token || !login.userId) {
      continue;
    }

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
          passwordUpdated: true,
          previousPassword: password
        };
      }
      continue;
    }

    return {
      token: login.token,
      userId: login.userId,
      passwordUsed: password,
      passwordUpdated: false,
      previousPassword: rowPassword && rowPassword !== password ? rowPassword : null
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

async function buildChildQrModal(payload = {}) {
  const iin = normalizeIin(payload.iin || payload.login);
  if (!iin || iin.length !== 12) {
    return { success: false, code: 'invalid-iin', message: 'Некорректный ИИН/логин' };
  }

  const auth = await signInWithFallback({
    iin,
    rowPassword: payload.rowPassword,
    defaultPassword1: payload.defaultPassword1 || 'Aa123456@',
    defaultPassword2: payload.defaultPassword2 || 'Aa123456!',
    timeoutMs: Number(payload.timeoutMs || 45000)
  });

  if (!auth) {
    return { success: false, code: 'login-failed', message: 'Не удалось войти в аккаунт' };
  }

  const authHeaders = {
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${auth.token}`,
    pragma: 'no-cache',
    'cache-control': 'no-cache',
    'content-type': 'application/json'
  };

  const timeoutMs = Number(payload.timeoutMs || 45000);
  const timeSheets = await getTimeSheets(authHeaders, timeoutMs);
  if (!timeSheets.length) {
    return {
      success: false,
      code: 'no-timesheets',
      message: 'Нет табелей на подпись',
      passwordUsed: auth.passwordUsed,
      passwordUpdated: auth.passwordUpdated
    };
  }

  const targetName = normalizeName(payload.childName || '');
  const items = [];

  for (const sheet of timeSheets) {
    const attendanceId = sheet?.id;
    if (!attendanceId) continue;

    const details = await getSignatureDetails(attendanceId, authHeaders, timeoutMs);
    const signableChildren = details.filter((item) => item?.hVisitHistoryStatus?.id === 6 && item?.subscriptionId);
    if (!signableChildren.length) continue;

    const subscriptionIds = signableChildren.map((item) => item.subscriptionId);
    const verifyOk = await verifyBeforeSign(attendanceId, subscriptionIds, authHeaders, timeoutMs);
    if (!verifyOk) continue;

    const childrenNames = signableChildren.map(
      (x) => `${String(x?.childLastName || '').trim()} ${String(x?.childFirstName || '').trim()}`.trim()
    );

    const qrValue = buildEgovSignLink({
      attendanceId,
      userId: auth.userId,
      subscriptionIds
    });

    const qrDataUrl = await QRCode.toDataURL(qrValue, {
      type: 'image/png',
      margin: 2,
      width: 1024,
      color: { dark: '#000000', light: '#FFFFFF' }
    });

    items.push({
      attendanceId,
      childrenNames,
      qrDataUrl
    });
  }

  if (!items.length) {
    return {
      success: false,
      code: 'no-signable',
      message: 'Не найдено записей для подписания',
      passwordUsed: auth.passwordUsed,
      passwordUpdated: auth.passwordUpdated
    };
  }

  return {
    // Как в Studia: если точного совпадения по имени не найдено, берем первый доступный QR.
    success: true,
    item: (targetName
      ? items.find((item) => item.childrenNames.some((name) => matchChildName(targetName, name)))
      : null) || items[0],
    passwordUsed: auth.passwordUsed,
    passwordUpdated: Boolean(auth.passwordUpdated),
    previousPassword: auth.previousPassword || null
  };
}

module.exports = { buildChildQrModal };
