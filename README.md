# Budgetin

Financial tracker app untuk mencatat pemasukan dan pengeluaran melalui web dashboard dan Telegram bot.

## Documentation

Dokumen perencanaan dan produk sudah dipisah ke folder `docs/`:

- [docs/overview.md](x:/PROJECT%20MANDIRI/budgetin/docs/overview.md)
- [docs/auth-and-telegram.md](x:/PROJECT%20MANDIRI/budgetin/docs/auth-and-telegram.md)
- [docs/categories-and-export.md](x:/PROJECT%20MANDIRI/budgetin/docs/categories-and-export.md)
- [docs/roadmap.md](x:/PROJECT%20MANDIRI/budgetin/docs/roadmap.md)
- [docs/commercialization.md](x:/PROJECT%20MANDIRI/budgetin/docs/commercialization.md)

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

## Environment

`.env.example` adalah template. `.env` adalah nilai runtime yang dipakai `docker compose` di mesin local atau server. Daftar key harus sinkron, tetapi secret asli hanya boleh ada di `.env`.

Ringkasan key penting:

- `JWT_SECRET`: secret JWT backend
- `ADMIN_PHONE_NUMBER`: nomor admin utama untuk flow verifikasi dan moderation
- `REFRESH_TOKEN_TTL_DAYS`: masa berlaku refresh token dalam hari
- `REFRESH_COOKIE_NAME`: nama cookie refresh token
- `COOKIE_SECURE`: gunakan `true` untuk production HTTPS, `false` untuk local HTTP
- `CORS_ORIGIN`: daftar origin web yang diizinkan, pisahkan dengan koma
- `NEXT_PUBLIC_API_URL`: base path API yang dipakai frontend
- `API_INTERNAL_URL`: URL internal backend untuk proxy frontend dan bot
- `WEB_APP_URL`: URL dashboard yang dikirim Telegram bot ke user
- `TELEGRAM_BOT_TOKEN`: token bot Telegram
- `BOT_INTERNAL_TOKEN`: token internal backend <-> telegram bot
- `CLOUDFLARE_TUNNEL_TOKEN`: token Cloudflare Tunnel

Untuk production Budgetin yang sudah live di HTTPS, gunakan:

```env
COOKIE_SECURE=true
WEB_APP_URL=https://budgetin.seni.my.id/
CORS_ORIGIN=http://localhost:3000,https://budgetin.seni.my.id
```

## Telegram Bot

Isi `TELEGRAM_BOT_TOKEN` di `.env`, lalu jalankan compose. Command utama:

```text
/mulai
/bantuan
/catat
/lihat
/export
/akun
```

Bot otomatis memasang command menu Telegram, jadi user bisa tap menu `/` dan memilih `/mulai`, `/bantuan`, `/catat`, `/lihat`, `/export`, atau `/akun` tanpa mengetik manual. Gunakan `WEB_APP_URL` di `.env` untuk link dashboard yang dikirim bot saat onboarding.

Saat user baru share nomor Telegram, admin akan menerima notifikasi verifikasi. User tetap bisa mencatat transaksi lewat Telegram, tetapi dashboard web lengkap, grafik, transaksi lengkap, dan export baru aktif setelah admin menjalankan `/admin_verifikasi_user TELEGRAM_ID`. Admin bisa memblokir user dengan `/admin_blokir_user TELEGRAM_ID` dan memulihkan akun nonaktif dengan `/admin_pulihkan_user TELEGRAM_ID`.

Akun admin mendapat menu Telegram khusus berisi `/admin`, `/admin_user`, dan `/admin_ringkasan`. Command `/admin_user` menjadi pusat daftar user berdasarkan status, misalnya `/admin_user pending`, `/admin_user verified`, `/admin_user blocked`, atau `/admin_user nonaktif`. Admin hanya melihat statistik user, daftar user berdasarkan status, dan ringkasan agregat, bukan detail transaksi pribadi user. Command teknis seperti verifikasi, blokir, dan pulihkan tetap aktif, tetapi muncul di konteks daftar user yang sesuai. Nominal agregat disembunyikan jika user aktif bulan ini kurang dari 5 untuk menjaga privacy.

Command cepat yang tetap bisa dipakai:

```text
/makan nasi padang 18000
/minum kopi 15000
/bensin isi bensin motor 50000
/transport gojek ke kantor 22000
/lain beli kabel charger 25000
/gaji april 7000000
/freelance desain logo 250000
/ringkasan
/riwayat
/hapus 1
/hapus 1,2,3
/konfirmasi_hapus 1,2,3
/hapus_semua
/hapus_akun
/konfirmasi_hapus_akun KODE
/nama Roy
/hubungkan_ulang
/admin
/admin_user
/admin_ringkasan
/export_semua
/export_bulan
/export_bulan 2026-04 makan
/export_tanggal 2026-04-16 transport
/export_range 2026-04-01 2026-04-16 freelance
/export makan 2026-04
```

Sebelum memakai command transaksi, user harus menjalankan `/mulai` atau `/start` dan menekan tombol **Share Phone Number**. Nomor itu dipakai untuk menghubungkan akun Telegram dengan dashboard web, sehingga transaksi dari Telegram masuk ke dashboard user yang sama. Kalau user belum terdaftar dan memakai command selain `/mulai`, bot akan menjawab `User belum terdaftar` dan mengarahkan user ke `/mulai`. Kalau user yang sama mengetik `/mulai` lagi, bot tidak meminta share nomor ulang. Jika nomor Telegram berubah, gunakan `/hubungkan_ulang`; sistem hanya mengubah nomor pada akun Telegram yang sama dan tidak memindahkan data ke akun Telegram berbeda. Untuk input nominal, tulis angka di belakang tanpa titik, koma, atau `Rp`. Command lama seperti `/keluar makan nasi padang 18000` dan `/masuk gaji april 7000000` tetap didukung, tetapi command kategori langsung lebih disarankan.

Penghapusan transaksi satuan masih bisa dilakukan user lewat `/hapus 1` setelah melihat daftar `/riwayat`. User juga bisa memilih beberapa nomor sekaligus, misalnya `/hapus 1,2,3`; bot akan meminta konfirmasi lewat `/konfirmasi_hapus 1,2,3` sebelum menghapus banyak transaksi. Untuk hapus akun, user memakai `/hapus_akun`, lalu bot memberi kode konfirmasi dalam format yang mudah dicopy. Setelah user mengirim `/konfirmasi_hapus_akun KODE`, akun langsung dinonaktifkan dan admin menerima notifikasi. Admin masih bisa memulihkan akun dalam 2 hari lewat `/admin_pulihkan_user TELEGRAM_ID`.

Penghapusan semua transaksi tetap lewat satu pintu admin: `/hapus_semua` membuat permintaan ke admin. Admin dengan nomor `081390195600` otomatis diberi akses admin setelah nomor itu terhubung ke bot. Admin memproses request lewat `/admin_setujui_hapus KODE` atau `/admin_tolak_hapus KODE`.

Untuk export, `/export` menampilkan menu. User bisa memakai `/export_semua`, `/export_bulan`, `/export_tanggal YYYY-MM-DD`, atau `/export_range YYYY-MM-DD YYYY-MM-DD`. Kategori bisa ditambahkan di belakang command, misalnya `makan`, `transport`, `lain`, `gaji`, atau `freelance`.

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
