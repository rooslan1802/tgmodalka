const sharp = require('sharp');

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function trimWithEllipsis(text, maxLen = 44) {
  const value = String(text || '').trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(1, maxLen - 1)).trim()}…`;
}

async function buildModalPngBuffer({ qrDataUrl, childName }) {
  const safeName = escapeXml(trimWithEllipsis(childName || ''));
  const svg = `
<svg width="920" height="1100" viewBox="0 0 920 1100" xmlns="http://www.w3.org/2000/svg">
  <rect width="920" height="1100" fill="#d4ccc1"/>
  <rect x="20" y="24" width="880" height="1030" rx="10" fill="#f4f5f8"/>
  <text x="104" y="124" fill="#1f2440" font-size="56" font-weight="800" font-family="Arial, sans-serif">Подписание с помощью QR</text>
  <text x="104" y="190" fill="#7b819b" font-size="42" font-family="Arial, sans-serif">Отсканируйте QR-код с помощью</text>
  <text x="104" y="240" fill="#7b819b" font-size="42" font-family="Arial, sans-serif">мобильного приложения Egov Mobile</text>

  <rect x="104" y="282" width="712" height="160" rx="14" fill="#f7dec8" stroke="#f2b17f" stroke-width="2"/>
  <text x="130" y="334" fill="#1f2440" font-size="26" font-weight="700" font-family="Arial, sans-serif">После подписания в Egov Mobile, можете</text>
  <text x="130" y="372" fill="#1f2440" font-size="26" font-weight="700" font-family="Arial, sans-serif">нажать на кнопку &quot;Продолжить&quot; или закрыть</text>
  <text x="130" y="406" fill="#1f2440" font-size="26" font-weight="700" font-family="Arial, sans-serif">модальное окно</text>

  <text x="104" y="490" fill="#6b7088" font-size="44" font-weight="700" font-family="Arial, sans-serif">${safeName}</text>
  <text x="850" y="86" fill="#111" font-size="54" font-family="Arial, sans-serif">×</text>

  <rect x="245" y="930" width="430" height="86" rx="14" fill="#ff7400"/>
  <text x="322" y="986" fill="#fff" font-size="46" font-weight="700" font-family="Arial, sans-serif">Продолжить</text>
</svg>`;

  const qrBufferRaw = Buffer.from(qrDataUrl.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ''), 'base64');
  const qrBuffer = await sharp(qrBufferRaw)
    .resize(430, 430, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();

  const base = sharp(Buffer.from(svg)).png();
  const output = await base
    .composite([
      {
        input: Buffer.from(
          `<svg width="430" height="430" xmlns="http://www.w3.org/2000/svg"><rect width="430" height="430" fill="#fff"/></svg>`
        ),
        left: 245,
        top: 512
      },
      {
        input: qrBuffer,
        left: 245,
        top: 512
      }
    ])
    .png()
    .toBuffer();

  return output;
}

module.exports = { buildModalPngBuffer };
