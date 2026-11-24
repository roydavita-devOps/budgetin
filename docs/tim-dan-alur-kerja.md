# Tim dan Alur Kerja Pengembangan Budgetin

Dokumen ini adalah panduan kerja untuk melanjutkan Budgetin. Setiap peran di bawah memiliki konfigurasi agen khusus di `.codex/agents/`. Koordinator mendelegasikan tugas kepada agen yang relevan apabila kemampuan multi-agent dan agen khusus tersedia di sesi.

Pemilik produk tetap menentukan prioritas, menerima risiko bisnis, dan bertanggung jawab atas keputusan operasional. Temuan dan hasil pengujian harus disampaikan sesuai kondisi sebenarnya, termasuk bagian yang belum diuji.

## Konteks Produk

- Budgetin adalah pencatat keuangan pribadi, bukan penasihat keuangan.
- Telegram merupakan jalur utama pencatatan; dashboard web digunakan untuk melihat dan mengelola data.
- Waktu transaksi, filter, dan laporan menggunakan WIB (`Asia/Jakarta`).
- Data transaksi bersifat pribadi. Fitur admin dibatasi sesuai hak akses yang berlaku.
- Aplikasi sudah digunakan, sehingga perubahan harus memperhatikan data pengguna dan layanan yang sedang berjalan.
- Rencana input web, PWA, WhatsApp, atau aplikasi mobile perlu divalidasi dan diprioritaskan sebelum dikembangkan.

Struktur utama proyek:

| Area | Lokasi | Fungsi |
| --- | --- | --- |
| Web | `frontend/` | Dashboard Next.js dan interaksi pengguna |
| API | `backend/` | Autentikasi, transaksi, akses data, dan aturan aplikasi |
| Bot | `telegram-bot/` | Interaksi dan pencatatan melalui Telegram |
| Database | `database/` | Skema dan inisialisasi PostgreSQL |
| Infrastruktur | `docker-compose.yml`, `.github/` | Container dan otomatisasi proyek |
| Dokumentasi | `docs/`, `README.md` | Panduan dan rencana proyek |

Dokumen lama dapat berisi rencana historis. Periksa kode dan konfigurasi terkini sebelum menyimpulkan sebuah fitur sudah tersedia atau belum.

## Pembagian Peran

### 1. Product Owner

- Memahami kebutuhan pengguna, masalah yang ingin diselesaikan, dan manfaatnya.
- Menyusun prioritas bersama pemilik Budgetin serta membatasi ruang lingkup setiap pekerjaan.
- Menuliskan alur utama, kondisi gagal, dan kriteria penerimaan yang dapat diuji.
- Memastikan laporan tetap informatif tanpa menambahkan nasihat keuangan.

**Hasil kerja:** deskripsi masalah, prioritas, alur pengguna, dan kriteria penerimaan.

### 2. UI/UX Designer

- Merancang alur yang mudah dipahami untuk Telegram dan web, terutama pada layar ponsel.
- Memeriksa hierarki, keterbacaan, aksesibilitas, dan konsistensi light mode serta dark mode.
- Memperhatikan keadaan kosong, loading, error, dan konfirmasi tindakan yang mengubah data.
- Menguji desain terhadap tugas nyata, misalnya mencari atau memperbaiki transaksi.

**Hasil kerja:** usulan alur atau desain, penjelasan keputusan, dan temuan pengujian.

### 3. Backend Developer

- Mengembangkan API dan aturan transaksi, akun, kategori, serta autentikasi.
- Memastikan setiap operasi memeriksa kepemilikan data dan hak akses pengguna.
- Menjaga konsistensi waktu WIB, validasi input, dan kompatibilitas respons API.
- Merencanakan perubahan skema dan migrasi yang menjaga data lama.

**Hasil kerja:** perubahan API atau database, penjelasan kompatibilitas, dan pengujian yang relevan.

### 4. Frontend Developer

- Mengembangkan dashboard dan formulir yang responsif serta mudah digunakan.
- Menghubungkan antarmuka dengan API tanpa membocorkan data pengguna lain.
- Menangani loading, error, sesi login, dan pembaruan data setelah transaksi berubah.
- Memeriksa tampilan dan interaksi pada desktop serta ponsel, termasuk kedua tema.

**Hasil kerja:** perubahan antarmuka, pemeriksaan build, dan pengujian alur terkait.

### 5. Bot dan Integration Developer

- Mengembangkan command, tombol, dan alur percakapan Telegram yang ringkas.
- Memastikan transaksi masuk ke akun yang benar serta nominal dan tanggal tervalidasi.
- Menangani kegagalan API atau Telegram dengan pesan yang jelas dan menghindari pencatatan ganda.
- Menjaga penggunaan token internal dan membatasi fungsi admin sesuai otorisasi.

**Hasil kerja:** perubahan alur bot atau integrasi dan pengujian kasus berhasil serta gagal.

### 6. QA / Software Tester

- Menguji kriteria penerimaan dan dampak perubahan terhadap alur yang sudah ada.
- Memeriksa login, transaksi, edit/hapus, filter, export, dan batas akses sesuai perubahan.
- Menguji batas tanggal WIB, termasuk akhir bulan, awal tahun, dan tahun kabisat ketika relevan.
- Mencatat langkah reproduksi, hasil yang diharapkan, hasil sebenarnya, dan risiko yang belum diuji.

**Hasil kerja:** hasil pengujian yang dapat diulang dan laporan bug berdasarkan bukti.

### 7. DevOps / Infrastructure Engineer

- Mengelola build, deployment, konfigurasi, monitoring, dan log layanan.
- Memeriksa kesehatan frontend, backend, bot, database, Redis, dan koneksi publik.
- Menyiapkan backup database dan menguji pemulihan di lingkungan terpisah.
- Merencanakan rollback dan memeriksa dampak migrasi sebelum deployment.
- Meninjau paparan port database dan Redis serta konfigurasi production sesuai lingkungan nyata.

**Hasil kerja:** langkah deployment dan rollback, status layanan, serta bukti backup dan uji pemulihan bila dikerjakan.

### 8. Security Engineer

- Meninjau autentikasi, OTP, sesi, otorisasi, dan akses antar-pengguna.
- Menjaga secret agar tidak masuk Git, log, laporan, atau screenshot.
- Memeriksa validasi input, pembatasan percobaan, dependensi, dan konfigurasi produksi.
- Melakukan penilaian keamanan sesuai cakupan pekerjaan tanpa mengklaim sistem sepenuhnya aman.

**Hasil kerja:** daftar temuan berdasarkan tingkat risiko, perbaikan, dan batas pemeriksaan.

### 9. Customer Support

- Mencatat keluhan, langkah terjadinya masalah, dan kebutuhan pengguna tanpa meminta OTP atau password.
- Membantu alur akun dan penggunaan produk sesuai prosedur yang berlaku.
- Menyampaikan masalah yang berulang kepada Product Owner dan tim teknis.
- Menjaga kerahasiaan pengguna dan menghindari pengumpulan detail transaksi yang tidak diperlukan.

**Hasil kerja:** ringkasan masalah, status penanganan, dan masukan produk yang sudah diminimalkan datanya.

## Cara AI Memakai Peran

1. Tentukan peran yang relevan dengan permintaan. Contoh: perubahan filter transaksi melibatkan Product Owner, Backend, Frontend, QA, dan Security bila menyentuh akses data.
2. Baca kode, dokumentasi, dan status Git yang terkait; jangan menganggap rencana lama sebagai fakta terbaru.
3. Tetapkan perubahan dan kriteria selesai sesuai permintaan. Untuk permintaan diskusi saja, berikan saran tanpa mengubah kode.
4. Kerjakan perubahan dengan mempertahankan data dan perilaku yang tidak termasuk ruang lingkup.
5. Uji sesuai risiko. Gunakan lingkungan dan data uji yang terpisah bila pekerjaan dapat mengubah data.
6. Laporkan hasil, pengujian, keterbatasan, dan tindakan lanjutan. Lakukan push atau deployment bila diminta atau telah diotorisasi.

Agen dipanggil sesuai kebutuhan dan tidak berjalan terus-menerus atau selalu bersamaan. Ketersediaan pemilihan agen khusus bergantung pada lingkungan Codex; jika tidak tersedia, koordinator dapat menggunakan instruksi peran untuk mendelegasikan tugas dengan alat yang tersedia. Pengujian, audit independen, atau persetujuan manusia tidak boleh diklaim telah dilakukan jika memang belum dilakukan.

Contoh permintaan: "Gunakan agen frontend dan QA untuk memperbaiki filter dashboard, lalu minta agen security meninjau akses datanya." Untuk tugas produk, sebut `budgetin_product` atau jelaskan bahwa analisis Product Owner diperlukan. Daftar lengkap nama agen ada di `AGENTS.md`.

## Prioritas Lanjutan

Berikut adalah usulan awal, bukan daftar pekerjaan yang sudah selesai. Pemilik produk dapat mengubah urutannya.

| Prioritas | Pekerjaan | Peran utama | Hasil yang diharapkan |
| --- | --- | --- | --- |
| P0 | Verifikasi backup dan uji pemulihan database di lingkungan terpisah | DevOps, Backend | Prosedur pemulihan dan hasil uji tercatat |
| P0 | Tinjau akses data, login, secret, dan konfigurasi production | Security, Backend, DevOps | Risiko diprioritaskan dan perbaikan yang diperlukan direncanakan |
| P0 | Uji alur transaksi dan batas waktu WIB | QA, Backend, Bot, Frontend | Transaksi masuk ke akun dan periode yang benar |
| P1 | Tinjau pengalaman pengguna pada ponsel, login, dan input transaksi | Product Owner, UI/UX, Frontend | Masalah pengguna dan opsi perbaikan terurut |
| P1 | Rancang input transaksi langsung di web | Product Owner, UI/UX, Frontend, Backend | Alur dan kriteria penerimaan disepakati sebelum implementasi |
| P2 | Rancang dompet, saldo awal, dan transfer antar-dompet | Product Owner, Backend, UI/UX | Aturan saldo dan dampak pada laporan disepakati |
| P2 | Evaluasi PWA, WhatsApp, dan aplikasi mobile | Product Owner, DevOps, Developer | Keputusan berdasarkan kebutuhan pengguna, biaya, dan pemeliharaan |

## Definisi Selesai

Sebuah pekerjaan dianggap siap diserahkan ketika:

- Kriteria penerimaan yang disepakati terpenuhi dan perubahan ditinjau sesuai cakupannya.
- Pengujian yang relevan dijalankan; kegagalan atau keterbatasan dilaporkan.
- Data lama, privasi pengguna, otorisasi, dan WIB dipertimbangkan bila terdampak.
- Perubahan konfigurasi, migrasi, serta langkah rollback didokumentasikan bila diperlukan.
- Dokumentasi diperbarui bila perilaku atau cara menjalankan aplikasi berubah.
- Status commit, push, dan deployment disampaikan sesuai tindakan yang benar-benar dilakukan.

## Rujukan

- [Gambaran proyek](overview.md)
- [Autentikasi dan Telegram](auth-and-telegram.md)
- [Kategori dan export](categories-and-export.md)
- [Roadmap terdahulu](roadmap.md)
- [README proyek](../README.md)
