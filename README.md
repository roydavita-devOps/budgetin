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
/makan nasi padang 18000
/minum kopi 15000
/bensin isi bensin motor 50000
/transport gojek ke kantor 22000
/lain beli kabel charger 25000
/gaji april 7000000
/freelance desain logo 250000
/ringkasan
/terakhir
/riwayat
/riwayat 2
/hapus 1
/hapus_semua
/hapus_akun
/nama Roy
/hubungkan_ulang
/export makan 2026-04
```

Sebelum memakai command transaksi, user harus menjalankan `/mulai` atau `/start` dan menekan tombol **Share Phone Number**. Nomor itu dipakai untuk menghubungkan akun Telegram dengan dashboard web, sehingga transaksi dari Telegram masuk ke dashboard user yang sama. Kalau user yang sama mengetik `/mulai` lagi, bot tidak meminta share nomor ulang. Jika nomor Telegram berubah, gunakan `/hubungkan_ulang`; sistem hanya mengubah nomor pada akun Telegram yang sama dan tidak memindahkan data ke akun Telegram berbeda. Untuk input nominal, tulis angka di belakang tanpa titik, koma, atau `Rp`. Command lama seperti `/keluar makan nasi padang 18000` dan `/masuk gaji april 7000000` tetap didukung, tetapi command kategori langsung lebih disarankan.

Penghapusan transaksi satuan masih bisa dilakukan user lewat `/hapus 1` setelah melihat daftar `/terakhir`. Penghapusan besar lewat satu pintu admin: `/hapus_semua` membuat permintaan hapus semua transaksi, dan `/hapus_akun` membuat permintaan hapus akun. Admin dengan nomor `081390195600` otomatis diberi akses admin setelah nomor itu terhubung ke bot. Admin memproses request lewat `/admin_setujui_hapus KODE` atau `/admin_tolak_hapus KODE`.

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
