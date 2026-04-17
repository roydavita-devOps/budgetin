# Budgetin GitHub Issues Plan

File ini berisi draft issue awal yang disarankan untuk dimasukkan ke GitHub Issues.

## Label Sederhana

- `bug`: error atau perilaku yang tidak sesuai.
- `feature`: fitur baru.
- `security`: pekerjaan keamanan.
- `before-hosting`: pekerjaan wajib sebelum project dihosting.
- `idea`: ide yang belum prioritas.

## Draft Issue Awal

### 1. [Before Hosting] Prepare Budgetin for hosting

Tujuan:
Menyiapkan Budgetin agar bisa dipakai user lain di luar localhost.

Checklist:
- [ ] Tentukan platform hosting frontend.
- [ ] Tentukan platform hosting backend.
- [ ] Siapkan PostgreSQL production.
- [ ] Siapkan Redis production jika masih diperlukan.
- [ ] Pasang domain.
- [ ] Aktifkan HTTPS.
- [ ] Tes register, login OTP, input Telegram, dashboard, export, dan hapus akun.

Label:
`before-hosting`

### 2. [Security] Secure Telegram bot token and production env

Tujuan:
Memastikan token Telegram, JWT secret, bot internal token, dan database URL tidak bocor.

Checklist:
- [ ] Pastikan `.env` tidak masuk GitHub.
- [ ] Gunakan secret manager dari platform hosting.
- [ ] Ganti token jika pernah terlanjur terlihat publik.
- [ ] Pakai `JWT_SECRET` dan `BOT_INTERNAL_TOKEN` yang kuat di production.
- [ ] Dokumentasikan env production yang wajib diisi.

Label:
`security`

### 3. [Feature] Add Excel export

Tujuan:
User bisa export data ke Excel, bukan hanya CSV.

Checklist:
- [ ] Tentukan format file `.xlsx`.
- [ ] Export bisa difilter berdasarkan bulan.
- [ ] Export bisa difilter berdasarkan tanggal atau range tanggal.
- [ ] Export bisa difilter berdasarkan kategori.
- [ ] Bisa dipakai dari web dan Telegram.

Label:
`feature`

### 4. [Feature] Improve dashboard charts

Tujuan:
Dashboard lebih mudah dipahami user awam melalui grafik.

Checklist:
- [ ] Grafik pemasukan vs pengeluaran per bulan.
- [ ] Grafik pengeluaran per kategori.
- [ ] Filter grafik berdasarkan bulan.
- [ ] Tampilan tetap jelas di mobile.

Label:
`feature`

### 5. [Feature] Add admin dashboard

Tujuan:
Admin tidak hanya mengontrol user lewat Telegram, tetapi juga punya halaman web sederhana.

Checklist:
- [ ] Lihat daftar user.
- [ ] Lihat status verified, blocked, deleted.
- [ ] Verifikasi user.
- [ ] Blokir user.
- [ ] Pulihkan akun dalam recovery window.

Label:
`feature`

### 6. [Bug] Test account delete and recovery flow

Tujuan:
Memastikan flow hapus akun dan recovery 2 hari berjalan aman.

Checklist:
- [ ] User menjalankan `/hapus_akun`.
- [ ] User konfirmasi dengan `/konfirmasi_hapus_akun KODE`.
- [ ] Akun tidak bisa memakai bot setelah dinonaktifkan.
- [ ] Dashboard menampilkan status akun dinonaktifkan.
- [ ] Admin menerima notifikasi.
- [ ] Admin bisa menjalankan `/admin_pulihkan_user TELEGRAM_ID`.
- [ ] User bisa memakai bot dan dashboard lagi setelah dipulihkan.

Label:
`bug`

### 7. [Idea] Plan subscription or monetization model

Tujuan:
Menyusun opsi komersial Budgetin untuk target user personal.

Catatan opsi:
- Free basic + paid advanced export.
- One-time payment.
- Lifetime license untuk early user.
- Donation/supporter.
- Subscription ringan setelah MVP stabil.

Checklist:
- [ ] Tentukan fitur gratis.
- [ ] Tentukan fitur berbayar.
- [ ] Validasi apakah user personal mau membayar.
- [ ] Tentukan metode pembayaran.

Label:
`idea`
