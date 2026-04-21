# Categories And Export

Dokumen ini merangkum standar kategori, filter dashboard, dan desain export.

## Tujuan

Kategori dibuat standar supaya:
- dashboard lebih mudah dibaca
- data konsisten
- export bisa diambil per kategori atau periode

## Kategori Standar

### Expense
- `food_drink`: Makan & Minum
- `transport`: Transportasi
- `other_expense`: Lain-Lain

### Income
- `salary`: Gaji Pokok
- `freelance`: Freelance

## Kenapa Memakai Kode Kategori

Data transaksi menyimpan `category` sebagai kode stabil, misalnya:
- `food_drink`
- `transport`
- `salary`

Label tampilan tetap fleksibel dan bisa diubah tanpa merusak data lama.

## Mapping Input User

- `food`, `drink`, `makan`, `minum`, `kopi`, `snack` -> `food_drink`
- `kendaraan`, `transport`, `transpot`, `bensin`, `parkir`, `tol`, `ojek` -> `transport`
- `lain`, `lainnya`, `other`, `misc` -> `other_expense`
- `gaji`, `salary`, `gaji pokok` -> `salary`
- `freelance`, `project`, `sampingan` -> `freelance`

## Filter Dashboard

### Type
- Semua
- Pemasukan
- Pengeluaran

### Kategori
- Semua kategori
- Makan & Minum
- Transportasi
- Lain-Lain
- Gaji Pokok
- Freelance

### Sort
- Terbaru
- Terlama
- Nominal terbesar
- Nominal terkecil

## Ringkasan Dashboard

- Total pemasukan
- Total pengeluaran
- Saldo
- Ringkasan kategori
- Riwayat transaksi yang bisa difilter dan di-sort

## Export Telegram

Command yang didukung:

- `/export`
- `/export_semua`
- `/export_bulan`
- `/export_tanggal YYYY-MM-DD`
- `/export_range YYYY-MM-DD YYYY-MM-DD`

Kategori bisa ditambahkan, misalnya:

- `makan`
- `transport`
- `lain`
- `gaji`
- `freelance`

Contoh:

```text
/export makan 2026-04
/export_bulan 2026-04 makan
/export_tanggal 2026-04-16 transport
/export_range 2026-04-01 2026-04-16 freelance
```

## Export Web

Endpoint:

- `GET /exports/transactions.csv`

Query parameter:

- `type=income`
- `type=expense`
- `category=food_drink`
- `month=2026-04`

Contoh:

- `GET /exports/transactions.csv`
- `GET /exports/transactions.csv?type=expense`
- `GET /exports/transactions.csv?category=transport`
- `GET /exports/transactions.csv?category=food_drink&month=2026-04`

## Format CSV

Kolom export:

- `date`
- `type`
- `category`
- `category_label`
- `amount`
- `note`

Contoh:

```csv
date,type,category,category_label,amount,note
2026-04-15,expense,food_drink,Makan & Minum,50000,makan siang
2026-04-15,expense,transport,Transportasi,30000,bensin motor
2026-04-15,income,freelance,Freelance,250000,project landing page
```

## Prioritas Lanjutan

1. Pertahankan kategori standar
2. Pertahankan filter type/category/sort
3. Pertahankan export CSV
4. Jika dibutuhkan, upgrade ke XLSX
