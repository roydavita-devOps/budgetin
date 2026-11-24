# Integrasi backend terisolasi

Dari root repositori, dengan Docker daemon lokal, Node.js >= 18, `backend/node_modules` yang sudah tersedia, serta image lokal `postgres:16-alpine` dan `redis:7-alpine`:

```powershell
node backend/test/integration-run.mjs
```

Tidak ada pull, install, build, push, atau deploy. Runner opt-in dan tidak menjalankan container saat ditemukan oleh `node --test`. Runner membuat dua container bernama acak dengan port acak yang hanya dipublikasikan ke `127.0.0.1`, penyimpanan Postgres dan Redis `tmpfs`, serta Redis persistence nonaktif. Tidak ada bind mount atau volume Budgetin. Backend dijalankan dari source lokal dengan environment eksplisit, kredensial acak sintetis, timezone UTC, Telegram token kosong, dan tanpa membaca `.env`. Runner hanya membangun URL ke port container yang baru dibuat; `DATABASE_URL` atau `REDIS_URL` dari environment diabaikan. Schema `database/init/001_schema.sql` dan migrasi startup backend hanya dijalankan terhadap Postgres sementara tersebut, **bukan production atau database Budgetin yang berjalan**. Akun, transaksi, dan token semuanya sintetis. Container dihapus dengan `docker rm -f -v` pada akhir run, kegagalan, SIGINT, atau SIGTERM.

Pengujian mencakup batas hari dan bulan WIB, ekspor CSV dan >500 transaksi, isolasi dua akun untuk baca dan mutasi, paginasi Telegram, dan isolasi serta invalidasi cache Redis. Data besar dimasukkan langsung ke Postgres sementara, sedangkan registrasi, pembacaan, dan mutasi diuji melalui API HTTP sesungguhnya. Tidak menggunakan layanan Telegram eksternal.

Paginasi web diuji menggunakan `limit` dan `offset`. Bila backend belum mendukung offset, runner melaporkan `TODO` dan tes lainnya tetap berjalan. Setelah kontrak API berubah, jalankan mode wajib berikut dan sesuaikan parameter/ekspektasi runner jika kontrak paginasi yang disepakati berbeda:

```powershell
$env:INTEGRATION_REQUIRE_PAGINATION = '1'
node backend/test/integration-run.mjs
Remove-Item Env:INTEGRATION_REQUIRE_PAGINATION
```

Batasan: `tmpfs` memerlukan dukungan daemon Docker; backend memakai port host sementara dan mengikuti perilaku bind backend (saat ini semua interface). Gunakan hanya pada host/jaringan tepercaya. Terdapat kemungkinan kecil race saat pemilihan port; runner menunggu pesan startup prosesnya sendiri sebelum mengirim request. Jika proses atau daemon dimatikan paksa, cleanup mungkin tidak terpanggil; periksa hanya container berlabel `budgetin.integration=temporary` sebelum menghapus sisa run secara manual. Jangan menghapus container atau volume lain. Tes mengasumsikan tidak ada penulisan eksternal selama paginasi; tidak menguji concurrency, pagination berbasis cursor, atau UI. Jangan menjalankan runner di mesin dengan kode backend/schema lokal yang tidak dipercaya, karena keduanya dieksekusi.
