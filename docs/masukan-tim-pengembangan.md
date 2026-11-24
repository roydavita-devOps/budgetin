# Masukan Tim untuk Pengembangan Budgetin

Tanggal peninjauan: 24 November 2026

Dasar source: commit `84e8390`

## Tujuan dan Batas Peninjauan

Dokumen ini menggabungkan masukan agen 1 sampai 9 untuk membantu pemilik produk menentukan langkah berikutnya. Saran bukan tugas yang sudah diimplementasikan. Budgetin diposisikan sebagai pencatat keuangan pribadi: Telegram menjadi kanal utama pencatatan dan web menjadi dashboard pengelolaan data. Informasi keuangan yang ditampilkan harus bersifat deskriptif, bukan nasihat keuangan.

Peninjauan dilakukan dengan membaca source dan dokumentasi yang relevan. Tim tidak mengakses data pengguna atau isi `.env`, tidak menguji alur end-to-end, tidak memeriksa tampilan di browser, dan tidak melakukan perubahan aplikasi atau deployment. Kondisi produksi, dampak aktual, serta dugaan kegagalan atau keamanan perlu diuji lebih lanjut di lingkungan terpisah. Rekomendasi di bawah bukan jaminan keamanan.

## Kesepakatan Arah Produk

1. Utamakan kepercayaan, ketepatan transaksi, dan pemulihan data sebelum memperluas fitur atau jumlah pengguna.
2. Pertahankan Telegram sebagai jalur utama. Validasi kebutuhan input web, PWA, WhatsApp, dan aplikasi mobile dengan pengguna sebelum memilih platform baru.
3. Buat perbaikan bertahap dengan pengujian, backup, dan rencana pemulihan yang sesuai risiko; data lama harus tetap dapat digunakan.
4. Ukur pengalaman pengguna tanpa mengumpulkan isi transaksi atau data pribadi yang tidak diperlukan.

## Masukan Setiap Agen

### 1. Product Owner

**Temuan:** Bot meminta nominal dalam format angka polos di akhir perintah. Pengguna yang baru menghubungkan nomor dapat mulai mencatat, sementara beberapa fungsi web membutuhkan verifikasi admin. Dashboard sudah memiliki pengelolaan transaksi dan export. Referensi: [bantuan bot](../telegram-bot/src/bot.js#L542), [alur verifikasi bot](../telegram-bot/src/bot.js#L708), dan [dashboard](../frontend/app/page.jsx#L490).

**Saran:**

- Validasi perjalanan pengguna dari menghubungkan akun, membuat transaksi pertama, memperbaiki kesalahan, hingga melihat laporan. Catat hambatan tanpa merekam isi transaksi.
- Tentukan apakah input web dan dompet memang dibutuhkan sebelum mengembangkan PWA atau kanal baru. Jangan mengubah persyaratan verifikasi sebelum risiko dan tujuannya dipahami.
- Sepakati metrik keberhasilan dan sampel uji sebelum mengukur hasil; jangan menganggap rencana monetisasi lama sebagai bukti bahwa pengguna bersedia membayar.

**Ukuran selesai:** masalah utama, bukti pengguna, keputusan prioritas, dan kriteria penerimaan terdokumentasi.

### 2. UI/UX Designer

**Temuan:** Beberapa kegagalan pengambilan data hanya dicatat di console, sementara tampilan kosong tetap dapat muncul. Sejumlah input mengandalkan placeholder. Warna teks tombol pada pasangan warna yang diperiksa perlu ditinjau kontrasnya. Referensi: [pengambilan data](../frontend/app/page.jsx#L770), [filter dan login](../frontend/app/page.jsx#L959), dan [warna tema](../frontend/app/globals.css#L16).

**Saran:**

- Bedakan kondisi memuat, kosong, gagal, dan data yang belum diperbarui; berikan cara mencoba ulang.
- Tambahkan label yang jelas, fokus keyboard, dan periksa kontras kedua tema, khususnya pada tombol dan layar kecil.
- Tinjau konfirmasi penghapusan satuan dan massal agar pengguna dapat memahami tindakan dan hasilnya.

**Ukuran selesai:** skenario kosong dan gagal dapat dibedakan; kontrol utama dapat digunakan dengan keyboard dan terbaca pada kedua tema. Uji visual dan pengguna tetap diperlukan.

### 3. Backend Developer

**Temuan:** Perubahan skema tertentu dikerjakan saat API mulai dan beberapa operasi dijalankan sebagai query terpisah. Filter transaksi memakai batas WIB, tetapi validasi bentuk tanggal perlu dilengkapi validasi tanggal kalender. Kunci cache ringkasan yang diperiksa membedakan pengguna dan bulan, sementara query juga menerima filter lain. Referensi: [inisialisasi skema](../backend/src/server.js#L393), [filter waktu](../backend/src/server.js#L693), dan [cache ringkasan](../backend/src/server.js#L790).

**Saran:**

- Rancang migrasi database berversi yang dapat diuji pada salinan data dan ditangani bila gagal.
- Tinjau operasi persetujuan penghapusan agar perubahan data dan status permintaan tetap konsisten jika terjadi kegagalan atau permintaan bersamaan.
- Uji dugaan benturan cache untuk filter berbeda, validasi tanggal yang tidak sah, dan konsistensi WIB.

**Ukuran selesai:** migrasi dan skenario gagal diuji di lingkungan terpisah; hasil ringkasan sesuai filter; perubahan tidak merusak data lama.

### 4. Frontend Developer

**Temuan:** Sumber data dashboard meminta maksimal 500 transaksi; data tren bulanan meminta 500 transaksi terlama tanpa filter bulan. Label tren bulanan diurutkan sebagai teks. Pencarian riwayat turut digunakan pada permintaan transaksi yang menjadi sumber tampilan lain. Referensi: [perhitungan tren](../frontend/app/page.jsx#L164), [permintaan transaksi](../frontend/app/page.jsx#L430), dan [batas API](../backend/src/server.js#L1953).

**Saran:**

- Pindahkan agregasi ringkasan dan tren ke perhitungan yang mencakup seluruh data yang sesuai, serta rancang paginasi riwayat.
- Urutkan tren berdasarkan kunci tanggal, pisahkan filter riwayat dari ringkasan, dan cegah respons lama menimpa pilihan terbaru.
- Pecah logika halaman secara bertahap setelah ada pengujian untuk mengurangi risiko regresi.

**Ukuran selesai:** hasil ringkasan dan tren cocok dengan data uji yang melebihi 500 transaksi dan melewati pergantian tahun; perubahan filter cepat tetap menampilkan hasil yang sesuai.

### 5. Telegram dan Integrasi

**Temuan:** Pemeriksaan kontak saat ini hanya menolak ID yang berbeda jika ID kontak tersedia. Pada jalur yang diperiksa, chat ID asal disimpan untuk akun; pembatasan chat pribadi belum terlihat. Polling menaikkan offset sebelum pemrosesan selesai. Penghapusan massal dilakukan satu per satu. Referensi: [polling](../telegram-bot/src/bot.js#L40), [penghubungan kontak](../telegram-bot/src/bot.js#L673), dan [hapus transaksi](../telegram-bot/src/bot.js#L855).

**Saran:**

- Verifikasi kemungkinan penggunaan di grup dan penyerahan kontak tanpa ID; rancang pembatasan chat pribadi untuk alur sensitif serta pemulihan bagi akun yang terdampak.
- Rancang pencegahan duplikasi saat update diulang dan bedakan kegagalan menyimpan dari kegagalan mengirim konfirmasi.
- Perbaiki koreksi transaksi, validasi pilihan hapus, dan kejelasan hasil penghapusan sebagian.

**Ukuran selesai:** pengujian sintetis membuktikan alur sensitif tidak membocorkan informasi ke grup, pengulangan tidak menggandakan transaksi, dan hasil koreksi mudah dipahami. Kemungkinan penyalahgunaan belum diuji pada peninjauan ini.

### 6. QA / Software Tester

**Temuan:** Backend dan bot menyediakan perintah `node --test`, tetapi penelusuran berkas proyek yang dilakukan belum menemukan suite tes; frontend belum memiliki skrip test. Pembatasan berdasarkan pemilik terlihat pada filter dan perubahan transaksi. Referensi: [skrip backend](../backend/package.json#L6), [skrip bot](../telegram-bot/package.json#L6), dan [filter berdasarkan pengguna](../backend/src/server.js#L693).

**Saran:**

- Buat pengujian untuk dua akun sintetis: baca, ubah, hapus, export, status blokir, dan isolasi data.
- Uji transaksi, cache, operasi massal, dan pemulihan dari kegagalan menggunakan database terpisah.
- Tambahkan kasus waktu WIB menjelang dan setelah tengah malam, akhir bulan, tahun kabisat, dan tahun baru, lalu bandingkan daftar, ringkasan, dan export.

**Ukuran selesai:** skenario penting dapat dijalankan ulang, hasilnya tercatat, dan tidak menggunakan data produksi.

### 7. DevOps / Infrastructure Engineer

**Temuan:** Compose menggunakan volume PostgreSQL dan menerbitkan port PostgreSQL serta Redis ke host. Healthcheck Compose yang terlihat ada pada PostgreSQL dan Redis, sementara backend memiliki endpoint health tersendiri. Workflow CI memakai perintah `--if-present`, sehingga perintah yang tidak tersedia dapat terlewati. Referensi: [Compose](../docker-compose.yml#L5), [health backend](../backend/src/server.js#L899), dan [workflow CI](../.github/workflows/ci.yml#L21).

**Saran:**

- Verifikasi apakah backup terpisah sudah ada dan uji pemulihan menggunakan lingkungan terisolasi. Tetapkan frekuensi, retensi, serta target kehilangan data dan waktu pemulihan bersama pemilik produk.
- Tinjau paparan jaringan, konfigurasi production, pemeriksaan layanan, alert, dan prosedur rollback.
- Jadikan pengujian yang disepakati wajib dalam CI dan periksa build image serta integrasi yang relevan.

**Ukuran selesai:** hasil uji restore dan waktunya tercatat; pengaturan jaringan diperiksa sesuai lingkungan; gangguan simulasi dapat terdeteksi. Keberadaan backup atau firewall di luar repositori belum diperiksa.

### 8. Security Engineer

**Temuan:** Pada source yang ditinjau, kontak tanpa `user_id` tidak ditolak secara eksplisit, dan pembatasan chat pribadi belum terlihat sebelum kontak diproses. Backend dan Compose juga memiliki nilai fallback untuk secret; endpoint OTP yang ditinjau belum menunjukkan pembatasan percobaan. Redis dipublikasikan ke host pada Compose. Referensi: [kontak bot](../telegram-bot/src/bot.js#L673), [konfigurasi backend](../backend/src/server.js#L13), [OTP](../backend/src/server.js#L957), dan [Compose](../docker-compose.yml#L23).

**Saran:**

- Prioritaskan verifikasi risiko penghubungan nomor dan chat nonpribadi. Uji dengan akun sintetis apakah kontak tanpa identitas atau milik pihak lain ditolak dan apakah OTP dapat terkirim di grup.
- Pastikan konfigurasi production tidak memakai secret default, batasi akses backend internal serta database/cache, dan rotasi kredensial yang terbukti perlu dirotasi.
- Rancang pembatasan permintaan dan percobaan OTP per akun serta sumber, termasuk respons yang tidak perlu mengungkap status nomor.

**Ukuran selesai:** pengujian terisolasi membuktikan penolakan skenario yang dilarang; konfigurasi production diperiksa secara terotorisasi; temuan dan sisa risiko tercatat. Kemungkinan eksploitasi dan kontrol eksternal belum diverifikasi.

### 9. Customer Support

**Temuan:** Beberapa pesan akun diblokir atau dinonaktifkan meminta pengguna menghubungi admin tanpa menyertakan kanal pada pesan yang diperiksa. Pesan terkait tenggat pemulihan perlu ditinjau agar tidak memberi harapan keliru setelah tenggat. Referensi: [pesan web](../frontend/app/page.jsx#L1002), [pesan pemulihan bot](../telegram-bot/src/bot.js#L359), dan [validasi pemulihan](../backend/src/server.js#L1678).

**Saran:**

- Tentukan kanal bantuan resmi yang dapat diakses saat akun terkunci, lalu tampilkan di tempat pengguna membutuhkan bantuan.
- Jelaskan status pemulihan sebelum dan sesudah tenggat menggunakan WIB, serta konsistenkan informasi masa berlaku OTP dan cara meminta kode baru.
- Tambahkan pengingat agar OTP tidak dibagikan kepada siapa pun. Untuk pengguna baru yang tiba langsung di web, uji apakah mereka dapat menemukan langkah mulai dari Telegram tanpa membuat pesan masuk terlalu panjang.

**Ukuran selesai:** pengguna uji dapat menemukan bantuan dan langkah pemulihan yang sesuai; tim support tidak meminta OTP atau isi transaksi. Efektivitas pesan dan ketersediaan kanal belum diuji pada pengguna nyata.

## Prioritas Bersama

P0 berarti harus diperiksa atau ditangani sebelum perluasan penggunaan; P1 adalah perbaikan pengalaman inti setelah risiko utama terkendali; P2 perlu validasi produk lebih lanjut. Urutan ini adalah usulan tim, bukan jadwal atau klaim bahwa masalah sudah diperbaiki.

| Prioritas | Pekerjaan | Agen | Hasil yang diharapkan |
| --- | --- | --- | --- |
| P0 | Verifikasi penghubungan kontak Telegram dan alur sensitif di grup; perbaiki jika terbukti perlu | 5, 8, 3, 6 | Kontak tak sah ditolak dan OTP serta data sensitif hanya dikirim melalui jalur yang tepat dalam pengujian |
| P0 | Periksa secret default, batas percobaan OTP, akses internal dan paparan database/cache | 8, 7, 3, 6 | Risiko aktual terdokumentasi dan pengaturan yang tidak aman ditangani serta diuji |
| P0 | Verifikasi backup, retensi, dan uji restore terisolasi | 7, 3, 6 | Prosedur serta hasil pemulihan tercatat sesuai target yang disepakati |
| P0 | Verifikasi dan perbaiki ketepatan ringkasan/tren saat lebih dari 500 transaksi serta filter dan urutan bulan | 4, 3, 6 | Agregat data uji cocok dengan keseluruhan transaksi, termasuk lintas tahun |
| P0 | Uji isolasi akun, batas WIB, cache ringkasan dan konsistensi operasi hapus | 6, 3, 5, 8 | Pengujian sintetis dapat diulang dan seluruh risiko yang ditemukan ditangani atau dicatat |
| P1 | Perjelas status gagal, loading, kosong, konfirmasi, label dan kontras | 2, 4, 6 | Pengguna memahami kondisi dan dapat menggunakan kontrol pada mobile serta kedua tema |
| P1 | Perbaiki alur dukungan, OTP, dan informasi tenggat pemulihan | 9, 1, 5, 4, 8 | Pesan jelas, aman, dan mengarah ke kanal bantuan yang tersedia |
| P1 | Tingkatkan keandalan pencatatan Telegram dan hasil operasi massal | 5, 3, 6 | Uji gangguan dan pengulangan tidak menghasilkan data ganda atau status yang menyesatkan |
| P2 | Validasi input web, dompet, PWA, WhatsApp, dan aplikasi mobile | 1, 2, 3, 4, 5, 7 | Ada bukti kebutuhan, perkiraan dampak, dan keputusan lanjut atau tunda |

## Urutan Kerja yang Diusulkan

1. **Pemeriksaan awal:** agen 7 dan 8 memverifikasi kondisi operasional secara terotorisasi; agen 6 menyiapkan skenario dengan data sintetis. Hindari perubahan produksi sampai dampaknya dipahami.
2. **Privasi dan ketepatan:** agen 3, 4, dan 5 menangani hasil P0 yang terkonfirmasi; agen 6 dan 8 memeriksa kembali perubahan yang relevan.
3. **Pengalaman pengguna:** agen 1 dan 2 menyusun alur bersama agen 9; agen 4 dan 5 mengimplementasikan pilihan yang disetujui, lalu agen 6 menguji.
4. **Validasi ekspansi:** agen 1 mengumpulkan kebutuhan dan membandingkan biaya serta manfaat sebelum memutuskan fitur atau platform berikutnya.

## Keputusan yang Diperlukan Pemilik Produk

- Sepakati target backup: frekuensi, lama penyimpanan, dan waktu pemulihan yang dapat diterima.
- Tentukan kanal support resmi dan siapa yang bertanggung jawab menangani akun terkunci.
- Tentukan prioritas setelah P0, misalnya input web atau fitur dompet, berdasarkan masukan pengguna.
- Tentukan kelompok pengguna uji dan metrik keberhasilan tanpa mengumpulkan rincian transaksi pribadi.

## Status

Dokumen ini berisi hasil tinjauan awal dan usulan kerja. Tidak ada fitur, konfigurasi produksi, atau data pengguna yang diubah sebagai bagian dari peninjauan. Setiap pekerjaan lanjutan perlu ditinjau dan diuji sesuai cakupannya.
