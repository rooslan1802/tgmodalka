# Cloudflare Workers deployment (no card)

Эта версия бота работает на Cloudflare Workers (free, без привязки карты).

## Важно
- Это webhook-бот (не polling).
- База детей хранится в Cloudflare KV.
- Команда `/import_seed` загружает seed-базу из `data/children.seed.json`.
- Для Cloudflare-версии отправляется QR-картинка (без рендеринга PNG-модалки через `sharp`).

## 1) Подготовка
```bash
cd cloudflare-worker
npm install
```

## 2) Создать KV namespace
```bash
npx wrangler kv namespace create CHILDREN_KV
```
Скопируйте `id` и вставьте в `wrangler.toml` в `kv_namespaces.id`.

## 3) Логин в Cloudflare
```bash
npx wrangler login
```

## 4) Деплой
```bash
npm run deploy
```
После деплоя получите URL воркера, например:
`https://tgmodalka-bot.<subdomain>.workers.dev`

## 5) ENV переменные в Cloudflare Dashboard
Worker -> Settings -> Variables:
- `BOT_TOKEN` = токен Telegram бота
- `DEFAULT_PASSWORD_1` = `Aa123456!`
- `DEFAULT_PASSWORD_2` = `Aa123456@`
- `PUBLIC_BASE_URL` = URL вашего воркера (`https://...workers.dev`)
- `WEBHOOK_SECRET` = любая случайная строка

## 6) Установить webhook
Откройте в браузере:
`https://...workers.dev/set-webhook`

Если всё ок, вернется JSON с `ok: true`.

## 7) Проверка в Telegram
- `/start`
- `/import_seed`
- ввод имени ребенка
- выбор из кнопок
