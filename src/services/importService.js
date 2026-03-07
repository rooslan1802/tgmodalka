const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const { setChildren } = require('./childrenStore');

function parseRowsFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.readFile(filePath);
    const firstSheet = wb.SheetNames[0];
    if (!firstSheet) return [];
    return XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { defval: '' });
  }

  if (ext === '.csv') {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parse(raw, { columns: true, skip_empty_lines: true, bom: true });
  }

  throw new Error('Поддерживаются только .xlsx, .xls, .csv, .json');
}

function importChildrenFile(filePath, options = {}) {
  const rows = parseRowsFromFile(filePath);
  const imported = setChildren(rows, options);
  return {
    totalRows: rows.length,
    imported: imported.length
  };
}

module.exports = { importChildrenFile };
