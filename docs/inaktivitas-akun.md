# Inaktivitas Akun

Status: pengembangan dan pengujian. Jangan aktifkan pemantauan atau penghapusan otomatis pada production sampai tinjauan keamanan, prosedur operasional, dan pengujian end-to-end selesai.

## Kebijakan yang Disepakati

- Hanya akun baru setelah aktivasi yang dapat didaftarkan dalam pemantauan. Akun yang sudah ada tetap dikecualikan sampai pemilik memberi keputusan terpisah. Admin, akun diblokir, akun nonaktif karena penghapusan manual, dan nomor admin yang dilindungi dikecualikan.
- Aktivitas berarti transaksi baru yang berhasil disimpan, bukan login, refresh, melihat dashboard, atau mengubah transaksi lama. Awal hitungan adalah saat akun terdaftar dalam pemantauan, atau transaksi baru terakhir jika lebih baru.
- Setelah 30 hari tanpa transaksi baru, akun nonaktif dan bot mencoba mengirim peringatan ke Telegram pribadi. Jika pengiriman gagal atau tidak pasti, sistem mencoba lagi dan tidak memulai tenggat penghapusan.
- Pilihan pertahankan mengaktifkan akun kembali dan mengulang hitungan 30 hari. Pilihan hapus berarti menghapus akun dan data terkait di database secara permanen. Tanpa respons, usulan kebijakan adalah penghapusan paling cepat 48 jam setelah pengiriman terkonfirmasi.

## Sakelar Dan Batas

`INACTIVITY_AUTO_ENABLED=false` dan `INACTIVITY_AUTO_PURGE_ENABLED=false` adalah nilai default. Sakelar pertama menentukan enrollment akun baru dan menjalankan pemantauan. Sakelar kedua terpisah dan membatasi penghapusan otomatis karena tidak ada respons; tindakan hapus eksplisit memerlukan pemantauan aktif. Ketika sakelar kedua mati, isi peringatan menyatakan bahwa penghapusan tanpa respons tidak aktif.

Pengujian menggunakan PostgreSQL dan Redis sintetis, sender Telegram palsu, serta akun yang dibuat hanya untuk tes. Tidak ada peringatan atau penghapusan pengguna production sebagai bagian pengujian.

Watermark poll Telegram adalah pengaman tambahan, bukan bukti mutlak bahwa respons pengguna tidak sedang terlambat dikirim. Ketika ada celah polling yang tidak dapat diverifikasi, latch `recovery_required` menahan penghapusan otomatis tanpa menghentikan bot. Belum ada prosedur rekonsiliasi yang dapat membuktikan seluruh respons pengguna dan memulihkan latch secara aman. Sinkronisasi banyak poller, gangguan jaringan, skema database, retensi identitas lama, dan beban lock juga masih perlu ditinjau sebelum aktivasi. Jangan menghapus latch secara manual untuk melewati pengaman.

## Verifikasi Terisolasi

Dengan dependensi backend dan image Docker PostgreSQL serta Redis tersedia, jalankan dari root repository:

```powershell
node backend/test/inactivity-integration.mjs
node backend/test/inactivity-api.test.mjs
```

Tes otomatis tidak menggantikan uji interaksi Telegram dan browser, verifikasi kontrol operasional, atau tinjauan keamanan akhir. Tidak ada data pengguna yang boleh digunakan untuk pengujian destruktif.
