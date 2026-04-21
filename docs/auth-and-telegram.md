# Auth And Telegram Flow

Dokumen ini merangkum keputusan arsitektur untuk auth dan integrasi Telegram per user.

## Prinsip Utama

Budgetin memakai pendekatan Telegram-first authentication, bukan SMS OTP murni.

Alasan:
- Telegram Bot API tidak bisa mengirim pesan ke user yang belum pernah interaksi dengan bot.
- OTP via Telegram lebih murah, lebih sederhana, dan sesuai dengan konsep produk.

## Flow Auth Yang Dipilih

1. User buka bot Telegram Budgetin.
2. User tekan `/mulai` atau `/start`.
3. Bot menampilkan tombol `Share Phone Number`.
4. User share nomor Telegram miliknya.
5. Backend menyimpan:
   - `telegram_user_id`
   - `telegram_chat_id`
   - `phone_number`
6. User login/register di web dengan nomor telepon + OTP.
7. OTP diverifikasi backend.
8. User masuk ke dashboard pribadinya.
9. Semua transaksi dari Telegram masuk ke akun user tersebut secara private.

## Struktur Data

### `users`
- `id`
- `phone_number`
- `created_at`

### `telegram_accounts`
- `id`
- `user_id`
- `telegram_user_id`
- `telegram_chat_id`
- `phone_number`
- `username`
- `first_name`
- `linked_at`

### `otp_codes`
- `id`
- `phone_number`
- `code_hash`
- `purpose`
- `expires_at`
- `consumed_at`
- `created_at`

## API Yang Dibutuhkan

- `POST /auth/request-otp`
- `POST /auth/verify-otp`
- `POST /telegram/contact`
- `GET /me`

## Perubahan Bot Yang Dibutuhkan

Command utama yang harus mendukung flow private per user:

- `/mulai`
- `/makan ...`
- `/transport ...`
- `/gaji ...`
- `/ringkasan`

Kalau akun Telegram belum terhubung, bot harus menjawab:

```text
User belum terdaftar.
Ketik /mulai lalu tekan Share Phone Number untuk menghubungkan Telegram kamu ke Budgetin.
```

## Prioritas Implementasi

1. Update schema database untuk phone + Telegram account + OTP
2. Ubah auth backend ke nomor + OTP
3. Ubah bot agar meminta contact Telegram
4. Simpan transaksi berdasarkan akun Telegram milik user
5. Ubah login frontend menjadi nomor HP + OTP

## Privacy Note Ke User

Saat user menjalankan `/mulai`, bot menampilkan note singkat:

```text
Privasi kamu aman:
- Admin tidak dapat melihat detail transaksi harian kamu
- Admin hanya melihat status akun dan ringkasan sistem
```
