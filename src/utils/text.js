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

module.exports = { normalizeText, cleanDigits };
