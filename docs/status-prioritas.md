# Status Pekerjaan Prioritas

Status peninjauan: 24 November 2026. Dokumen ini mencatat kondisi saat perubahan disiapkan; periksa kembali kondisi runtime sebelum melakukan deployment.

## Selesai dalam Kode

- Bot menerima pesan dan kontak hanya dari chat pribadi yang sesuai dengan pengirim. Kontak harus memiliki `user_id` yang cocok; backend juga memeriksa ID tujuan OTP dan penghubungan akun.
- Permintaan dan verifikasi OTP dibatasi per nomor dengan Redis, dan pemakaian OTP dilakukan secara atomik. Ketika Redis tidak tersedia, OTP sementara ditolak. Respons permintaan tidak membedakan secara langsung nomor terdaftar dan tidak terdaftar.
- Startup production memeriksa secret JWT, token internal, dan password database agar tidak memakai nilai default atau nilai pendek. Contoh konfigurasi lokal tetap tersedia di `.env.example`.
- Compose disiapkan untuk mengikat port backend, PostgreSQL, dan Redis ke loopback host. Komunikasi antar-container tetap menggunakan jaringan internal.
- API transaksi mendukung `offset` dan pengurutan stabil. Dashboard memuat seluruh halaman, memisahkan pencarian riwayat dari ringkasan, dan mengurutkan tren bulanan berdasarkan periode WIB.
- Cache ringkasan tidak digunakan untuk permintaan dengan filter tambahan, sehingga hasil filter berbeda tidak berbagi cache bulan yang sama.
- Pesan gagal dan bantuan akun diperjelas. `.env.*` dan folder backup lokal diabaikan Git, dan CI mewajibkan tes untuk backend dan bot serta build dan tes dashboard.
- Skrip backup dan latihan restore sintetis tersedia; lihat [panduan backup](backup-postgres.md).

## Hasil Verifikasi

- Tes unit backend, bot, dan dashboard dijalankan menggunakan data sintetis; tes rate limit juga dijalankan pada Redis sementara.
- Tes API integrasi memakai PostgreSQL dan Redis terisolasi, dua akun sintetis, batas WIB, export, dan paginasi lebih dari 500 transaksi.
- Latihan backup dan restore dengan data sintetis berhasil pada container terisolasi. Hasil ini bukan bukti bahwa backup produksi tersedia atau dapat dipulihkan.
- Build frontend dan image staging dilakukan terpisah dari layanan production. Uji interaksi browser, integrasi Telegram langsung, dan restore backup produksi belum dilakukan.

## Sebelum Deployment

**Perubahan kode belum otomatis mengubah container yang sedang berjalan.** Pada saat pemeriksaan, backend production masih memakai secret default, password database default, dan port layanan database/cache terikat ke seluruh antarmuka host. Jangan menganggap risiko tersebut sudah tertangani sampai konfigurasi diterapkan dan diverifikasi.

1. Siapkan lokasi backup produksi yang privat dan terenkripsi, lalu buat backup dan uji restore secara terisolasi sesuai [panduan backup](backup-postgres.md). Tentukan penanggung jawab, retensi, dan jadwal uji pemulihan.
2. Siapkan nilai acak untuk `JWT_SECRET` dan `BOT_INTERNAL_TOKEN` yang berbeda dan masing-masing minimal 32 byte. Siapkan password database acak minimal 24 byte. Jangan simpan nilainya di Git atau log.
3. Koordinasikan perubahan password role PostgreSQL dengan `DATABASE_URL` dan `POSTGRES_PASSWORD` yang digunakan aplikasi. Perubahan `.env` saja tidak mengubah password role dalam database yang sudah ada. Rencanakan pemulihan kredensial dan rollback sebelum memulai.
4. Pastikan jalur Cloudflare dan frontend menggunakan jaringan Docker. Binding loopback tidak melayani klien yang mengakses langsung port backend atau database dari host lain.
5. Bangun dan jalankan layanan sesuai prosedur deployment. Verifikasi port, kesehatan layanan, login, bot, ringkasan, dan transaksi dengan akun uji yang diizinkan tanpa mencetak OTP atau data pribadi.

Rotasi JWT membatalkan access token yang ditandatangani kunci lama. Refresh token yang masih valid tidak otomatis dicabut. Pengguna dengan tujuan chat lama yang bukan chat pribadi perlu menghubungkan kembali lewat bot, dan mungkin memerlukan bantuan admin.

## Risiko dan Pekerjaan Lanjutan

- Rate limit per nomor melindungi OTP dari percobaan berulang, tetapi orang yang mengetahui nomor dapat menghabiskan jatah percobaan dan mengunci login sementara. Pembatasan per sumber harus diterapkan di lapisan tepercaya setelah topologi proxy dan aturan akses diverifikasi; `OTP_TRUST_PROXY_HOPS` tidak boleh diisi berdasarkan perkiraan.
- Respons yang sama mengurangi pengungkapan status nomor, tetapi tidak menghilangkan seluruh kemungkinan analisis waktu respons.
- Dashboard mengambil semua halaman ke browser; ini memperbaiki batas 500 data tetapi dapat lebih berat pada akun yang sangat besar. Paginasi berbasis offset bukan snapshot dan perubahan transaksi yang bersamaan masih dapat menyebabkan hasil tidak konsisten; desain agregasi server dan paginasi snapshot perlu dievaluasi.
- Belum ada pembuktian backup aktual di penyimpanan aman, kebijakan retensi, RPO/RTO, monitoring atau alert otomatis, maupun pemindaian menyeluruh seluruh sistem.
