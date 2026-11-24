# Panduan Agen Budgetin

Budgetin adalah pencatat keuangan pribadi dengan input Telegram, dashboard web Next.js, API Node.js, PostgreSQL, dan Redis. Gunakan `Asia/Jakarta` untuk periode dan tampilan transaksi. Jangan menambahkan nasihat keuangan.

## Koordinasi

- Gunakan agen khusus di `.codex/agents/` sesuai pekerjaan yang diminta dan kemampuan multi-agent yang tersedia di sesi. Delegasikan tugas yang terpisah dan jelas, lalu integrasikan serta periksa hasilnya.
- Agen: `budgetin_product`, `budgetin_ux`, `budgetin_backend`, `budgetin_frontend`, `budgetin_telegram`, `budgetin_qa`, `budgetin_devops`, `budgetin_security`, dan `budgetin_support`.
- Tidak semua agen harus dijalankan untuk setiap tugas. Untuk perubahan lintas area, libatkan peran terkait dan QA sesuai risiko; untuk akses akun atau data pengguna, libatkan tinjauan security bila memungkinkan.
- Jika pemilihan agen khusus tidak tersedia dalam sesi, gunakan kemampuan delegasi yang ada dengan instruksi peran dari file terkait. Jelaskan keterbatasan bila pekerjaan bergantung pada kemampuan tersebut.
- Hindari dua agen mengedit file yang sama secara bersamaan. Koordinator tetap bertanggung jawab atas hasil akhir, integrasi, dan pelaporan.

## Aturan Proyek

- Periksa kode terkini dan pertahankan perubahan yang sudah ada. Dokumen lama bisa berisi rencana historis.
- Jaga kepemilikan data, privasi, validasi, kompatibilitas API, dan konsistensi WIB.
- Jangan tampilkan atau commit token, OTP, password, `.env`, atau data pribadi. Gunakan data uji untuk verifikasi bila memungkinkan.
- Rencanakan migrasi, backup, dan rollback untuk perubahan yang berdampak pada data atau produksi. Jangan menghapus data pengguna atau melakukan tindakan destruktif tanpa permintaan yang jelas.
- Jangan mengirim pesan ke pengguna lain atau broadcast tanpa instruksi eksplisit.
- Ikuti instruksi pengguna mengenai implementasi, diskusi, push, dan deployment. Laporkan tindakan dan pengujian yang benar-benar dilakukan.

Panduan peran dan prioritas ada di `docs/tim-dan-alur-kerja.md`.
