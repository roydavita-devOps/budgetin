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
/mulai
/keluar makan makan siang 50000
/masuk freelance project logo 250000
/ringkasan
/terakhir
/hapus 1
/nama Roy
/export makan 2026-04
```

Sebelum memakai command transaksi, user harus menjalankan `/mulai` atau `/start` dan menekan tombol **Share Phone Number**. Nomor itu dipakai untuk menghubungkan akun Telegram dengan dashboard web, sehingga transaksi dari Telegram masuk ke dashboard user yang sama. Untuk input nominal, tulis angka di belakang tanpa titik, koma, atau `Rp`.

## API

Register/login via OTP:

```bash
curl -X POST http://localhost:4000/auth/request-otp \
  -H "Content-Type: application/json" \
  -d '{"phone_number":"+6281234567890"}'
```

Verify OTP:

```bash
curl -X POST http://localhost:4000/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone_number":"+6281234567890","code":"123456"}'
```

Create transaction:

```bash
curl -X POST http://localhost:4000/transactions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"type":"expense","amount":50000,"category":"food","note":"makan siang"}'
```
