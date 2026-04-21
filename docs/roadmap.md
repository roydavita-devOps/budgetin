# Budgetin Roadmap

Dokumen ini merangkum next step dan arah pengembangan produk.

## Next Step Dasar

Sebelum user memakai Budgetin secara luas:

- register hanya dengan nomor HP yang punya Telegram
- auth cukup memakai OTP
- setiap user punya dashboard sendiri
- dashboard dan Telegram terhubung private per user

## MVP Yang Sudah Dibangun

- login/register via Telegram OTP
- dashboard pribadi per user
- input transaksi via Telegram
- kategori standar
- filter dan export CSV
- delete transaksi via Telegram
- dashboard name customization
- persistent login dan logout
- admin verification
- admin summary dasar

## Fitur Yang Sudah Dianggap Penting

- delete transaksi
- export CSV
- dashboard laporan
- admin verification flow
- recovery akun nonaktif

## Prioritas Roadmap Berikutnya

1. Hardening sebelum hosting
   - security
   - backup
   - monitoring
   - env production

2. Dokumentasi legal dan operasional
   - privacy policy
   - terms of service
   - data deletion policy

3. Peningkatan laporan
   - grafik lebih matang
   - insight yang lebih jelas
   - analisis periodik

4. Export lanjutan
   - XLSX
   - laporan otomatis

5. Admin tooling
   - admin dashboard web sederhana
   - monitoring user onboarding

## Roadmap Produk

### Private Beta
- dipakai sendiri
- dipakai 5-10 user dekat
- cari bug dan validasi perilaku input lewat Telegram

### Closed Paid Pilot
- 10-30 user
- cek apakah user mau bayar
- cek fitur mana yang benar-benar bernilai

### Production Hardening
- security
- backup
- monitoring
- deployment

### Public Launch
- dilakukan setelah flow utama stabil
- dokumentasi sudah rapi
- pricing sudah jelas
