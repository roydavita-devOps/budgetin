# Budgetin Implementation Plan

Budgetin adalah aplikasi pencatat pemasukan dan pengeluaran yang berjalan lewat web dashboard dan Telegram bot. Target lokal: seluruh service bisa dijalankan dengan `docker-compose up`.

## Scope MVP

- Register dan login user dengan JWT.
- Tambah transaksi pemasukan atau pengeluaran.
- Lihat daftar transaksi terbaru.
- Lihat ringkasan income, expense, dan balance.
- Kelola kategori dasar.
- Input transaksi lewat Telegram command.
- Semua service berjalan di Docker Compose.

## Architecture

```text
Frontend Next.js
  -> Backend REST API
      -> PostgreSQL
      -> Redis
Telegram Bot
  -> Backend REST API
```

Untuk MVP, auth, transaction, category, dan analytics dibuat dalam satu backend service modular. Ini lebih ringan untuk local development, tetapi masih mudah dipisah menjadi microservices jika traffic dan tim sudah membutuhkan pemisahan service.

## Tech Stack

- Backend: Node.js, Express, PostgreSQL, JWT.
- Frontend: Next.js, Tailwind CSS.
- Telegram bot: Node.js polling Telegram Bot API.
- Database: PostgreSQL.
- Cache/session-ready: Redis.
- DevOps: Docker, Docker Compose, GitHub Actions.

## Development Order

1. Setup struktur folder.
2. Setup database schema.
3. Buat backend REST API.
4. Buat frontend dashboard.
5. Buat Telegram bot integration.
6. Dockerize semua service.
7. Tambahkan CI dasar.
8. Jalankan `docker-compose up --build`.

## API Contract

- `POST /auth/register`
- `POST /auth/login`
- `GET /categories`
- `POST /categories`
- `GET /transactions`
- `POST /transactions`
- `GET /analytics/summary`

## Telegram Command

```text
/add 50000 food makan siang
/income 250000 salary freelance
```

Bot akan login/register memakai user service account dari environment variable, lalu membuat transaksi ke backend.

## Environment

Gunakan `.env` berdasarkan `.env.example`. Secret tidak boleh di-hardcode.

## Done Criteria

- `docker-compose up --build` menjalankan frontend, backend, telegram bot, PostgreSQL, dan Redis.
- Backend healthcheck tersedia di `http://localhost:4000/health`.
- Frontend tersedia di `http://localhost:3000`.
- Data transaksi tersimpan di PostgreSQL.
