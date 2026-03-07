const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const dotenv = require('dotenv');
const { Telegraf, Markup } = require('telegraf');
const { importChildrenFile } = require('./services/importService');
const { readAllChildren, findChildrenByName, getChildById, updateChildPassword } = require('./services/childrenStore');
const { buildChildQrModal } = require('./services/damubalaQrService');
const { buildModalPngBuffer } = require('./services/modalImageService');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const DEFAULT_PASSWORD_1 = String(process.env.DEFAULT_PASSWORD_1 || 'Aa123456!').trim();
const DEFAULT_PASSWORD_2 = String(process.env.DEFAULT_PASSWORD_2 || 'Aa123456@').trim();
const IMPORTS_DIR = path.resolve(__dirname, '..', process.env.IMPORTS_DIR || './data/imports');
const LOCAL_IMPORT_FILE = path.join(__dirname, '..', 'База детей.xlsx');
const PORT = Number(process.env.PORT || 0);

if (!BOT_TOKEN) {
  throw new Error('Не задан BOT_TOKEN. Добавьте токен в tg bot/.env');
}

fs.mkdirSync(IMPORTS_DIR, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);
const userState = new Map();

function setUserState(userId, patch) {
  const prev = userState.get(userId) || {};
  userState.set(userId, { ...prev, ...patch, updatedAt: Date.now() });
}

function getUserState(userId) {
  return userState.get(userId) || {};
}

function formatChildLine(child, index) {
  return `${index + 1}. ${child.childName}`;
}

async function runLocalImport(ctx) {
  if (!fs.existsSync(LOCAL_IMPORT_FILE)) {
    await ctx.reply(`Файл не найден: ${LOCAL_IMPORT_FILE}`);
    return;
  }
  const result = importChildrenFile(LOCAL_IMPORT_FILE, {
    primaryPassword: DEFAULT_PASSWORD_1,
    backupPassword1: DEFAULT_PASSWORD_2
  });
  await ctx.reply(
    `Импорт из локального файла завершен.\n` +
      `Строк в файле: ${result.totalRows}\n` +
      `Загружено детей: ${result.imported}`
  );
}

bot.start(async (ctx) => {
  const count = readAllChildren().length;
  await ctx.reply(
    `Бот готов. Детей в базе: ${count}.\n` +
      '1) Отправьте таблицу (.xlsx/.xls/.csv/.json) или выполните /import_local.\n' +
      '2) Напишите имя ребенка (или часть имени) и выберите из подсказок.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Импорт из файла в папке', 'do_import_local')],
      [Markup.button.callback('Проверить количество детей', 'do_count')]
    ])
  );

  await ctx.reply(
    'Быстрые кнопки:',
    Markup.keyboard([['/import_local', '/count'], ['/cancel']]).resize()
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'Команды:\n' +
      '/start - запуск\n' +
      '/count - сколько детей в базе\n' +
      '/import_local - импорт файла "База детей.xlsx" из папки tg bot\n' +
      '/cancel - сброс текущего выбора\n\n' +
      'Также можно просто отправить таблицу детей или написать имя ребенка.'
  );
});

bot.command('count', async (ctx) => {
  const count = readAllChildren().length;
  await ctx.reply(`В базе ${count} детей.`);
});

bot.command('cancel', async (ctx) => {
  userState.delete(ctx.from.id);
  await ctx.reply('Выбор сброшен. Напишите имя ребенка заново.');
});

bot.command('import_local', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    await runLocalImport(ctx);
  } catch (error) {
    await ctx.reply(`Ошибка локального импорта: ${error?.message || 'неизвестная ошибка'}`);
  }
});

bot.action('do_import_local', async (ctx) => {
  await ctx.answerCbQuery('Запускаю импорт...');
  try {
    await ctx.sendChatAction('typing');
    await runLocalImport(ctx);
  } catch (error) {
    await ctx.reply(`Ошибка локального импорта: ${error?.message || 'неизвестная ошибка'}`);
  }
});

bot.action('do_count', async (ctx) => {
  await ctx.answerCbQuery('Считаю...');
  const count = readAllChildren().length;
  await ctx.reply(`В базе ${count} детей.`);
});

bot.on('document', async (ctx) => {
  try {
    await ctx.sendChatAction('typing');
    const doc = ctx.message.document;
    const fileName = String(doc.file_name || 'import-file').trim();
    const ext = path.extname(fileName).toLowerCase();
    if (!['.xlsx', '.xls', '.csv', '.json'].includes(ext)) {
      await ctx.reply('Поддерживаемые форматы: .xlsx, .xls, .csv, .json');
      return;
    }

    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href);
    if (!res.ok) {
      throw new Error(`Не удалось скачать файл: HTTP ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const localPath = path.join(IMPORTS_DIR, `${Date.now()}-${fileName.replace(/\s+/g, '_')}`);
    fs.writeFileSync(localPath, buf);

    const result = importChildrenFile(localPath, {
      primaryPassword: DEFAULT_PASSWORD_1,
      backupPassword1: DEFAULT_PASSWORD_2
    });
    await ctx.reply(
      `Импорт завершен.\n` +
        `Строк в файле: ${result.totalRows}\n` +
        `Загружено детей: ${result.imported}`
    );
  } catch (error) {
    await ctx.reply(`Ошибка импорта: ${error?.message || 'неизвестная ошибка'}`);
  }
});

bot.on('text', async (ctx) => {
  const text = String(ctx.message.text || '').trim();
  if (!text || text.startsWith('/')) return;

  await ctx.sendChatAction('typing');
  const found = findChildrenByName(text, 8);
  if (!found.length) {
    await ctx.reply('Не нашел детей по этому имени. Попробуйте другой фрагмент имени.');
    return;
  }

  setUserState(ctx.from.id, {
    searchText: text,
    candidates: found.map((x) => x.id)
  });

  const keyboard = Markup.inlineKeyboard(
    found.map((item, idx) => [Markup.button.callback(`${idx + 1}. ${item.childName}`, `pick_child:${item.id}`)])
  );

  await ctx.reply(
    `Найдено ${found.length}. Выберите ребенка:\n${found.map(formatChildLine).join('\n')}`,
    keyboard
  );
});

bot.action(/pick_child:(.+)/, async (ctx) => {
  const childId = String(ctx.match[1] || '');
  const child = getChildById(childId);

  if (!child) {
    await ctx.answerCbQuery('Ребенок не найден');
    await ctx.reply('Ребенок не найден в базе. Возможно, база была перезагружена.');
    return;
  }

  await ctx.answerCbQuery('Генерирую QR...');
  await ctx.sendChatAction('upload_photo');

  try {
    const result = await buildChildQrModal({
      iin: child.login,
      rowPassword: child.password,
      defaultPassword1: child.backupPassword1 || DEFAULT_PASSWORD_1,
      defaultPassword2: child.backupPassword2 || DEFAULT_PASSWORD_2,
      childName: child.childName
    });

    if (!result?.success || !result?.item?.qrDataUrl) {
      throw new Error(result?.message || 'Не удалось получить QR для подписи');
    }

    if (result.passwordUsed && result.passwordUsed !== child.password) {
      updateChildPassword(child.id, result.passwordUsed);
    }

    const png = await buildModalPngBuffer({
      qrDataUrl: result.item.qrDataUrl,
      childName: child.childName
    });

    const notices = [];
    if (result.passwordUpdated) {
      notices.push('Пароль был обновлен на запасной (по требованию Damubala).');
    } else if (result.passwordUsed && result.passwordUsed !== child.password) {
      notices.push('Основной пароль в базе автоматически заменен на рабочий запасной.');
    }

    const caption = notices.length
      ? `Ребенок: ${child.childName}\n${notices.join('\n')}`
      : `Ребенок: ${child.childName}`;

    await ctx.replyWithPhoto({ source: png, filename: `modal-${child.childName}.png` }, { caption });
  } catch (error) {
    await ctx.reply(`Ошибка генерации QR: ${error?.message || 'неизвестная ошибка'}`);
  }
});

bot.catch((error, ctx) => {
  const text = `Внутренняя ошибка: ${error?.message || 'unknown'}`;
  if (ctx?.reply) {
    ctx.reply(text).catch(() => {});
  }
  console.error(error);
});

bot.launch().then(() => {
  console.log('Telegram bot started');
});

if (PORT > 0) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'tg-damubala-bot' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('tg-damubala-bot');
  });
  server.listen(PORT, () => {
    console.log(`Health server listening on ${PORT}`);
  });
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

function cleanupUserState() {
  const ttl = 30 * 60 * 1000;
  const now = Date.now();
  for (const [userId, state] of userState.entries()) {
    if (!state?.updatedAt || now - state.updatedAt > ttl) {
      userState.delete(userId);
    }
  }
}

setInterval(cleanupUserState, 5 * 60 * 1000).unref?.();

process.on('uncaughtException', (err) => {
  fs.writeFileSync(path.join(os.tmpdir(), 'tg-bot-uncaught.log'), String(err?.stack || err), 'utf8');
  console.error(err);
});
