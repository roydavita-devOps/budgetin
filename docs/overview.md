# Budgetin Overview

Dokumen ini merangkum visi awal dan gambaran teknis Budgetin.

## Ringkasan

Budgetin adalah aplikasi pencatatan keuangan pribadi yang menggabungkan:
- input cepat lewat Telegram
- dashboard web untuk laporan dan analisis
- login berbasis nomor telepon yang terhubung ke Telegram

## Tujuan

- Tracking pemasukan dan pengeluaran
- Monitoring keuangan harian dan bulanan
- Input data via Telegram bot
- Dashboard analytics sederhana

## Arsitektur

Budgetin memakai pendekatan service terpisah yang dijalankan lewat Docker:

- `frontend/` untuk dashboard web Next.js
- `backend/` untuk API dan logic utama
- `telegram-bot/` untuk interaksi user di Telegram
- `database/` untuk schema PostgreSQL
- Redis untuk cache / summary

Alur utama:

`Frontend` -> `Backend API` -> `PostgreSQL / Redis`  
`Telegram Bot` -> `Backend API` -> `PostgreSQL / Redis`

## Tech Stack

### Backend
- Node.js
- Express

### Frontend
- Next.js
- Tailwind CSS

### Database
- PostgreSQL
- Redis

### DevOps
- Docker
- Docker Compose
- GitHub
- GitHub Actions

### Integrasi
- Telegram Bot API

## Struktur Folder

```text
budgetin/
├── backend/
├── frontend/
├── telegram-bot/
├── database/
├── .github/
└── README.md
```

## Kebutuhan Docker

Semua service utama dijalankan dalam container:

- frontend
- backend
- postgres
- redis
- telegram-bot

## Database Dasar

Tabel inti yang menjadi fondasi Budgetin:

- `users`
- `telegram_accounts`
- `otp_codes`
- `transactions`
- `categories`
- `deletion_requests`

## Goal Akhir

Budgetin bisa dijalankan dengan:

```bash
docker compose up --build
```

Semua service aktif:
- web app
- API
- Telegram bot
- database
- redis
