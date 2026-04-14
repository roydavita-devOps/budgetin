# Budgetin

Financial tracker app untuk mencatat pemasukan dan pengeluaran melalui web dashboard dan Telegram bot.

## Run Locally

```bash
cp .env.example .env
docker-compose up --build
```

Services:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:4000`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

## Telegram Bot

Isi `TELEGRAM_BOT_TOKEN` di `.env`, lalu jalankan compose. Command:

```text
/add 50000 food makan siang
/income 250000 salary freelance
```

## API

Register:

```bash
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@budgetin.local","password":"secret123"}'
```

Create transaction:

```bash
curl -X POST http://localhost:4000/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"type":"expense","amount":50000,"category":"food","note":"makan siang"}'
```
