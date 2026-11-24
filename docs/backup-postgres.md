# Backup dan pemulihan PostgreSQL

## Status dan batas

Pada 24 November 2026, uji menggunakan data sintetis berhasil: dump dibuat, dipulihkan ke database baru pada container terisolasi, dan isi contoh diperiksa sebagai hasil boolean. Pengulangan terakhir berlangsung sekitar 13 detik termasuk pembuatan resource dan backup; ini **bukan RTO produksi**. Uji juga memeriksa penolakan arsip yang terpotong dan tujuan di dalam repositori, serta bahwa dump yang gagal tidak meninggalkan file parsial. `scripts/backup-test-restore.ps1` dapat mengulangi uji. Tidak ada backup atau data produksi yang dibuat, dibaca, atau dipulihkan dalam uji tersebut. Keberadaan dan kualitas backup di luar repositori belum diketahui.

Pemilik produk dan operator harus menyepakati frekuensi, retensi, RPO, RTO, penanggung jawab, dan jadwal latihan restore. Belum ada kebijakan yang disetujui atau otomatisasi retensi. Buat monitoring keberhasilan, umur backup terakhir, kapasitas, dan kegagalan restore; jangan menganggap keberadaan file sebagai bukti dapat dipulihkan.

## Sebelum backup

- Pilih direktori **privat, di luar repository dan semua working tree Git**, pada penyimpanan terenkripsi dengan kontrol akses terbatas, kapasitas cukup, serta backup terpisah/offsite yang disetujui. Pastikan folder tidak tersinkron ke lokasi publik. Periksa ACL, enkripsi, dan kebijakan penyimpanan dengan administrator; skrip tidak memverifikasinya dan tidak mengenkripsi file.
- Pada Windows, siapkan direktori baru di dalam parent yang sudah privat pada volume terenkripsi. Di Properties > Security > Advanced, periksa pemilik, nonaktifkan pewarisan akses yang tidak semestinya, dan batasi izin kepada identitas operator yang diperlukan, SYSTEM, dan administrator yang berwenang sesuai kebijakan. Periksa juga izin akses jaringan/share dan pastikan file baru mewarisi ACL tersebut. Jangan ubah ACL folder yang sudah dipakai layanan lain. Pemeriksaan dan penetapan ACL tetap tanggung jawab operator; skrip tidak mengubah atau mengaudit ACL.
- Backup mengandung seluruh isi database dalam bentuk sensitif. `-ConfirmSecureStorage` adalah pernyataan operator, bukan pemeriksaan keamanan otomatis. Jangan jalankan pada produksi sebelum lokasi dan aksesnya benar-benar diverifikasi. Batasi akses ke arsip, hash, log, salinan uji, dan kunci enkripsi.
- Gunakan PowerShell 7, Docker, dan container PostgreSQL yang **secara eksplisit sudah diidentifikasi dan diotorisasi**. `pg_dump` dan `pg_restore` harus tersedia dalam container. Klien `pg_dump` tidak boleh lebih lama dari server; cocokkan versi dengan server. Skrip tidak memakai Compose atau membaca `.env`.
- Database dan user diberikan sebagai parameter, bukan password. Siapkan autentikasi PostgreSQL yang aman pada container, misalnya `pgpass` yang dikonfigurasi dan dilindungi oleh operator. Skrip memakai `--no-password` dan tidak menampilkan diagnostik mentah, yang dapat mengandung informasi sensitif. Jangan memasukkan password atau URL berkredensial dalam argumen, log, atau contoh perintah.
- Pastikan peran memiliki akses untuk membaca semua objek yang diperlukan, serta ada kapasitas disk. `pg_dump` menghasilkan snapshot konsisten satu database, bukan backup seluruh cluster: role/global objects, tablespace, file eksternal, konfigurasi, WAL, dan point-in-time recovery memerlukan rencana terpisah. Restore dengan `--no-owner --no-privileges` tidak mempertahankan kepemilikan dan grant; rencanakan pemulihannya secara aman.

## Membuat backup

Setelah pemeriksaan di atas, operator mengganti placeholder berikut dengan identitas terotorisasi dan path privat yang sudah ada:

```powershell
pwsh -NoProfile -File scripts/backup-postgres.ps1 `
  -Container <container-postgres-terotorisasi> `
  -Database <nama-database> -User <user-backup> `
  -Destination <direktori-privat-di-luar-git> -ConfirmSecureStorage
```

Skrip menulis file `.partial` dengan nama acak, menjalankan `pg_dump` format custom, lalu membaca seluruh arsip dengan `pg_restore` tanpa menghubungi database sebelum mempublikasikannya sebagai `.dump`. SHA-256 ditampilkan untuk dicatat secara aman dan dibandingkan setelah pemindahan. Hash yang disimpan bersama arsip tanpa perlindungan terpisah tidak membuktikan keaslian. Validasi decode bukan pengganti restore; ia tidak membuktikan isi lengkap secara semantik. Kegagalan biasa menghapus file parsial, tetapi penghentian paksa atau gangguan host dapat meninggalkannya: operator harus menangani sisa file secara aman sesuai kebijakan.

Skrip menolak path dalam repositori ini, direktori di bawah penanda `.git`, dan path dengan symbolic link/junction. Pemeriksaan ini bukan bukti bahwa penyimpanan aman atau tidak terhubung ke Git melalui mount, konfigurasi Git khusus, atau mekanisme sinkronisasi. Operator wajib memastikan file tidak pernah masuk Git, termasuk backup lama dan salinannya. Jangan tambahkan aturan ignore sebagai pengganti penyimpanan privat.

## Uji pemulihan sintetis

Di host Docker dengan image `postgres:16-alpine` tersedia secara lokal, jalankan:

```powershell
pwsh -NoProfile -File scripts/backup-test-restore.ps1
```

Uji ini memakai nama container dan volume acak, `--network none`, tanpa port atau volume produksi. Hanya data yang dibuat oleh uji yang dipakai; container, volume, dan direktori sementara tersebut dibersihkan setelahnya. Peringatan cleanup perlu ditindaklanjuti hanya untuk nama resource uji yang dicetak. Uji tidak menarik image; siapkan image dari sumber tepercaya jika belum tersedia. Durasi yang dicetak meliputi persiapan dan bukan ukuran RTO produksi.

## Latihan restore backup aktual

Lakukan hanya dengan otorisasi dan lokasi pemrosesan data sensitif yang disetujui. Gunakan host atau container baru yang terisolasi dari jaringan dan volume produksi, dengan PostgreSQL versi yang kompatibel, kredensial terpisah, penyimpanan sementara terenkripsi, serta akses operator terbatas. Pastikan ruang cukup dan catat waktu mulai. Jangan arahkan perintah restore ke container, database, atau volume produksi.

1. Periksa hash arsip terhadap catatan tepercaya, tanpa membuka atau menampilkan isinya. Catat identitas backup dan hasil perbandingan secara terbatas.
2. Buat database kosong pada instance terisolasi. Salin arsip ke lokasi privat di instance uji, lalu gunakan `pg_restore --exit-on-error --no-owner --no-privileges -U <user-uji> -d <database-uji> <arsip-uji>` pada instance tersebut. Jangan gunakan `--clean` terhadap database yang berisi data yang harus dipertahankan. Pastikan tool dan server kompatibel; tangani role, extension, tablespace, dan grant sesuai rencana lingkungan uji.
3. Periksa keberhasilan restore dan jalankan pemeriksaan skema, constraint, serta konsistensi aplikasi yang disetujui. Catat hanya hasil lulus/gagal, waktu, versi, dan temuan non-sensitif; jangan cetak baris pengguna, daftar akun, isi dump, atau diagnostik mentah. Batasi juga log database dan aplikasi selama pengujian.
4. Catat total waktu, waktu backup, batas snapshot, penyimpangan dan apakah memenuhi RPO/RTO yang disepakati. Hapus **hanya** resource dan salinan sementara yang dibuat khusus untuk latihan, sesuai prosedur penyimpanan sensitif. Jangan hapus atau ubah backup sumber. Perbaiki kegagalan dan ulangi latihan.

Restore produksi yang sesungguhnya memerlukan rencana insiden dan persetujuan terpisah: tentukan titik pemulihan, hentikan penulisan dengan prosedur terkoordinasi, lindungi data terkini, siapkan rollback, dan validasi sebelum layanan dibuka kembali. Petunjuk uji ini bukan otorisasi atau prosedur otomatis untuk menimpa produksi.
