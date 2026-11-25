# Status Pekerjaan Prioritas

Status peninjauan: 24 November 2026 setelah maintenance. Periksa kembali kondisi runtime untuk perubahan berikutnya.

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
- Latihan backup dan restore dengan data sintetis berhasil pada container terisolasi. Backup database produksi juga berhasil dibuat dan dipulihkan pada PostgreSQL sementara tanpa jaringan; pemeriksaan skema dasar berhasil tanpa menampilkan data pengguna. Ini bukan pengujian pemulihan aplikasi secara menyeluruh.
- Build frontend, tes otomatis dan tes integrasi memakai data sintetis berhasil. Setelah deployment, halaman publik dan endpoint kesehatan API yang mengakses database mengembalikan HTTP 200, dan akses transaksi tanpa login ditolak dengan HTTP 401. Uji OTP dan transaksi nyata belum dikonfirmasi.

## Status Runtime

- Backend, frontend, dan bot versi baru sudah dijalankan; tunnel publik aktif. Proses startup terlihat normal. Pengiriman pesan, alur OTP, tampilan dengan data pengguna, dan transaksi langsung masih perlu diverifikasi dengan akun uji.
- Password role PostgreSQL, `JWT_SECRET`, dan `BOT_INTERNAL_TOKEN` telah dirotasi; autentikasi database dengan password baru diverifikasi. Port backend, PostgreSQL, dan Redis terikat pada loopback host. Rotasi JWT membatalkan access token lama; refresh token yang masih valid tidak otomatis dicabut.
- Backup aktual disimpan di luar repositori pada lokasi pilihan pemilik. Enkripsi belum terverifikasi dan izin folder masih luas; backup tidak dienkripsi oleh skrip. Tindak lanjuti enkripsi, pembatasan akses, dan salinan terpisah.
- Rotasi dilakukan dengan `scripts/rotate-production-secrets.ps1`, yang diuji pada database sementara. Jurnal pemulihan terenkripsi menggunakan Windows DPAPI untuk akun Windows yang menjalankan rotasi, dan disimpan di luar Git. Jurnal tetap sensitif: akses ke akun tersebut dapat memungkinkan dekripsi. Lindungi juga profil dan kunci pemulihannya. Jika rotasi terputus, jangan menjalankan ulang tanpa memeriksa kesesuaian password role dan konfigurasi; koordinasikan pemulihan dengan operator dan jangan tampilkan isi jurnal di log.

## Tindak Lanjut

1. Verifikasi login OTP, tampilan dashboard, transaksi Telegram, dan riwayat dengan akun yang diizinkan, tanpa mencatat OTP atau data pribadi.
2. Amankan lokasi backup produksi dengan enkripsi dan pembatasan akses, sesuai [panduan backup](backup-postgres.md). Tentukan penanggung jawab, retensi, dan jadwal uji pemulihan.
3. Gunakan rencana deployment dan rollback untuk perubahan berikutnya. Binding loopback tidak melayani klien yang mengakses langsung port backend atau database dari host lain.

Pengguna dengan tujuan chat lama yang bukan chat pribadi perlu menghubungkan kembali lewat bot, dan mungkin memerlukan bantuan admin.

## Risiko dan Pekerjaan Lanjutan

- Rate limit per nomor melindungi OTP dari percobaan berulang, tetapi orang yang mengetahui nomor dapat menghabiskan jatah percobaan dan mengunci login sementara. Pembatasan per sumber harus diterapkan di lapisan tepercaya setelah topologi proxy dan aturan akses diverifikasi; `OTP_TRUST_PROXY_HOPS` tidak boleh diisi berdasarkan perkiraan.
- Respons yang sama mengurangi pengungkapan status nomor, tetapi tidak menghilangkan seluruh kemungkinan analisis waktu respons.
- Dashboard mengambil semua halaman ke browser; ini memperbaiki batas 500 data tetapi dapat lebih berat pada akun yang sangat besar. Paginasi berbasis offset bukan snapshot dan perubahan transaksi yang bersamaan masih dapat menyebabkan hasil tidak konsisten; desain agregasi server dan paginasi snapshot perlu dievaluasi.
- Belum ada pembuktian backup aktual di penyimpanan terenkripsi dan dibatasi aksesnya, kebijakan retensi, RPO/RTO, monitoring atau alert otomatis, maupun pemindaian menyeluruh seluruh sistem.

## Lanjutan 25 November 2026

- Backend, frontend, dan bot perubahan lanjutan telah dijalankan melalui Compose. Pemeriksaan awal halaman publik dan health API/database mengembalikan HTTP 200, serta log startup bot normal. Pengujian OTP, penghapusan nyata, tampilan visual, dan alur pengguna melalui browser belum dikonfirmasi.
- Konfirmasi penonaktifan akun serta keputusan admin untuk penghapusan memakai transaksi database dan penguncian permintaan; pembuatan permintaan juga diserialkan per akun. Penghapusan seluruh transaksi ditolak ketika akun sedang nonaktif atau diblokir. Pengujian sintetis memeriksa rollback dan permintaan bersamaan, termasuk kegagalan saat menghapus seluruh transaksi dan masa recovery.
- Pemulihan melalui admin hanya dapat dilakukan sebelum tenggat yang tersimpan; perintah verifikasi dan blokir tidak dapat digunakan untuk mengubah akun nonaktif. Akun lama tanpa tenggat tidak dapat dipulihkan melalui perintah biasa dan memerlukan penanganan operator.
- Filter tanggal pada daftar, ringkasan Telegram, dan ekspor menolak tanggal kalender atau rentang yang tidak valid. Pengujian mencakup hari kabisat dan batas WIB.
- Bot menolak daftar pilihan hapus yang tidak valid dan menginformasikan hasil parsial atau belum pasti ketika penghapusan bertahap terhenti; pengguna diarahkan memeriksa riwayat sebelum mencoba lagi.
- Input login dan filter riwayat diberi label, dan kontrol terkait diberi indikator fokus keyboard. Pemeriksaan visual, kontras menyeluruh, urutan Tab, dan pengujian dengan pengguna masih diperlukan.
- Bot menyampaikan ketika notifikasi admin tidak dapat dikirim; belum tersedia antrian notifikasi persisten atau percobaan ulang otomatis. Pencegahan duplikasi pencatatan Telegram secara menyeluruh juga belum diimplementasikan. Penghapusan beberapa transaksi melalui bot masih bertahap, bukan operasi atomik. Migrasi database berversi dan agregasi/paginasi server juga belum selesai.
- Worker yang ada tidak menghapus akun atau transaksi secara permanen setelah masa recovery; ia hanya memperbarui status permintaan. Jangan mengaktifkan penghapusan otomatis terhadap data lama tanpa keputusan pemilik, verifikasi dampak, dan rencana terpisah.

## Pembaruan Keandalan Telegram

- Commit `cd2c9b0` menerapkan retry untuk pencatatan yang hasilnya belum pasti dan deduplikasi berdasarkan ID update Telegram. Penanda dan transaksi disimpan secara atomik; update yang sama tidak membuat transaksi baru setelah transaksi sebelumnya dihapus.
- Pengujian sintetis mencakup respons yang terputus, retry, permintaan bersamaan, rollback, dan isolasi pemilik. Dua pesan terpisah tetap dianggap dua transaksi; konfirmasi Telegram juga dapat terkirim lebih dari sekali ketika respons pengirimannya terputus.
- Perubahan telah dipasang pada layanan online. Pemilik melaporkan telah melakukan pengujian transaksi setelah deployment; rincian hasilnya tidak dicatat di sini. Docker kemudian dimatikan oleh pemilik, sehingga status runtime perlu diperiksa kembali saat layanan dijalankan.
- Pekerjaan penonaktifan otomatis masih terpisah pada cabang `wip/inactivity-lifecycle` dan belum diterapkan sebagai bagian dari perubahan ini.

## Pengalaman Pengguna Berikutnya

- Kegagalan memuat sub-kategori ditampilkan dengan opsi mencoba ulang; data antar-sesi dipisahkan dan perubahan yang memerlukan daftar sub-kategori ditangguhkan sampai daftar tersedia.
- Pesan Telegram membedakan tenggat pemulihan yang masih berlaku, sudah lewat, atau tidak tersedia. Pesan web mengarahkan pengguna ke kontak admin tanpa menjanjikan pemulihan setelah tenggat.
- Edit dan hapus transaksi memuat ulang data ketika hasil permintaan belum pasti. Untuk operasi massal, jumlah respons yang berhasil dibedakan dari hasil yang belum dapat dipastikan; pengguna diminta memeriksa Riwayat sebelum mencoba lagi.
- Perubahan ini diuji dengan mock dan data sintetis tanpa Docker. Browser diperiksa pada login dan Riwayat, termasuk ukuran desktop/ponsel, dark/light, retry sub-kategori, dan respons hapus massal yang terputus. Pemeriksaan seluruh halaman, akses keyboard menyeluruh, serta pengujian dengan pengguna masih diperlukan; perubahan ini belum diterapkan pada layanan online.
