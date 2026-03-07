const fs = require('node:fs');
const path = require('node:path');
const { normalizeText, cleanDigits } = require('../utils/text');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'children.json');

function ensureStore() {
  const dir = path.dirname(DATA_PATH);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(DATA_PATH, '[]\n', 'utf8');
  }
}

function readAllChildren() {
  ensureStore();
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAllChildren(items) {
  ensureStore();
  fs.writeFileSync(DATA_PATH, JSON.stringify(Array.isArray(items) ? items : [], null, 2), 'utf8');
}

function normalizeChild(input = {}, index = 0, defaults = {}) {
  const childName = String(
    input.childName ||
      input.child_full_name ||
      input['ФИО ребенка'] ||
      input['ФИО ребёнка'] ||
      input['Ребенок'] ||
      input['Имя ребенка'] ||
      ''
  ).trim();

  const login = cleanDigits(
    input.login || input.iin || input.parentIIN || input.parent_iin || input['ИИН родителя'] || input['Логин'] || ''
  );

  const password = String(input.password || input.pass || input['Пароль'] || defaults.primaryPassword || '').trim();
  const backupPassword1 = String(
    input.backupPassword1 ||
      input.backup_password_1 ||
      input.reservePassword1 ||
      input['Запасной пароль 1'] ||
      defaults.backupPassword1 ||
      ''
  ).trim();
  const backupPassword2 = String(
    input.backupPassword2 ||
      input.backup_password_2 ||
      input.reservePassword2 ||
      input['Запасной пароль 2'] ||
      defaults.backupPassword2 ||
      ''
  ).trim();

  return {
    id: String(input.id || `${Date.now()}-${index}`),
    childName,
    login,
    password,
    backupPassword1,
    backupPassword2,
    parentName: String(input.parentName || input.parent_full_name || input['ФИО родителя'] || '').trim(),
    phone: String(input.phone || input.parentPhone || input['Телефон'] || '').trim()
  };
}

function setChildren(items, options = {}) {
  const defaults = {
    primaryPassword: String(options.primaryPassword || '').trim(),
    backupPassword1: String(options.backupPassword1 || '').trim(),
    backupPassword2: String(options.backupPassword2 || '').trim()
  };
  const normalized = (Array.isArray(items) ? items : [])
    .map((item, index) => normalizeChild(item, index, defaults))
    .filter((row) => row.childName && row.login && (row.password || row.backupPassword1 || row.backupPassword2));

  writeAllChildren(normalized);
  return normalized;
}

function findChildrenByName(query, limit = 8) {
  const q = normalizeText(query);
  if (!q) return [];
  const all = readAllChildren();

  const scored = all
    .map((item) => {
      const name = normalizeText(item.childName);
      let score = 0;
      if (name === q) score = 300;
      else if (name.startsWith(q)) score = 200;
      else if (name.includes(q)) score = 120;
      if (score === 0) return null;
      return { item, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.item.childName.localeCompare(b.item.childName, 'ru'))
    .slice(0, Math.max(1, Number(limit) || 8))
    .map((x) => x.item);

  return scored;
}

function getChildById(id) {
  const all = readAllChildren();
  return all.find((item) => String(item.id) === String(id)) || null;
}

function updateChildPassword(id, nextPassword) {
  const all = readAllChildren();
  const idx = all.findIndex((item) => String(item.id) === String(id));
  if (idx < 0) return false;
  all[idx].password = String(nextPassword || '').trim();
  writeAllChildren(all);
  return true;
}

module.exports = {
  readAllChildren,
  setChildren,
  findChildrenByName,
  getChildById,
  updateChildPassword
};
