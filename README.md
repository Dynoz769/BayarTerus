# BayarTerus — Payment Gateway

Payment gateway untuk merchant Malaysia. Merchant daftar akaun, **salin satu snippet dan tampal ke laman web mereka**, terus boleh terima bayaran melalui FPX, kad, e-dompet dan DuitNow QR.

```html
<script src="https://pay.domain-anda.com/js/bayarterus.js" data-key="pk_test_xxx"></script>

<button data-bayarterus data-amount="25.00" data-description="Kek Coklat">Bayar RM25</button>
```

## Fungsi

**Utama**
- Daftar/log masuk merchant, kunci API berasingan untuk **mod ujian** dan **live** (`pk_` awam, `sk_` rahsia)
- **Embed copy-paste**: butang bayar, borang amaun bebas, popup checkout (iframe) atau halaman penuh
- **Hosted checkout** dengan jenama merchant (nama, warna): FPX (13 bank), kad Visa/Mastercard, Touch 'n Go, GrabPay, Boost, ShopeePay, DuitNow QR
- **REST API** (`/v1`) untuk pelayan merchant, dengan `Idempotency-Key`
- **Webhook** bertandatangan HMAC-SHA256, cubaan semula automatik (6 kali), log penghantaran dan hantar semula
- **Refund** penuh dan separa
- **Baki** (tersedia / tertunda, penyelesaian T+N) dan **payout** ke akaun bank
- `return_url` dengan parameter bertandatangan

**Tambahan**
- **Pautan bayaran** untuk WhatsApp/Instagram, amaun tetap atau pelanggan tentukan sendiri
- Dashboard: statistik 30 hari, kadar kejayaan, carta harian, pecahan ikut kaedah
- Carian dan tapisan transaksi, **eksport CSV**
- Senarai pelanggan (direkod automatik)
- **Resit** boleh dicetak / disimpan sebagai PDF
- Cipta invois/bayaran manual dari dashboard
- Penjana snippet dalam dashboard dengan pratonton langsung
- Keselamatan: sekatan domain untuk kunci awam, pilihan mematikan amaun dari pelayar, had kadar, sesi `HttpOnly`, kata laluan scrypt, kunci rahsia disimpan sebagai hash
- Kad ujian dan bank/e-dompet simulasi untuk menguji tanpa wang sebenar
- Bayaran yang tidak dibayar tamat tempoh secara automatik (60 minit)

## Jalankan

Perlu Node.js 22.13 atau lebih baharu (menggunakan `node:sqlite` terbina dalam, jadi tiada pangkalan data luar).

```bash
npm install
npm start          # http://localhost:3000
npm test           # ujian API hujung-ke-hujung
```

| Halaman | URL |
|---|---|
| Laman utama | `/` |
| Daftar / log masuk | `/register`, `/login` |
| Dashboard merchant | `/dashboard` |
| Dokumentasi integrasi | `/docs` |
| Demo kedai (uji snippet) | `/demo` |
| Checkout | `/pay/:payment_id` |
| Pautan bayaran | `/l/:link_id` |
| Resit | `/receipt/:payment_id` |

Konfigurasi melalui pembolehubah persekitaran, lihat [`.env.example`](.env.example).

**Deploy ke internet** (Railway, Render atau VPS): lihat [DEPLOY.md](DEPLOY.md). GitHub Pages tidak boleh menjalankan server ini.

## Cara merchant guna

1. Daftar di `/register`.
2. Buka **Dashboard → Integrasi (Copy Config)**. Snippet sudah berisi kunci awam merchant.
3. Tampal di laman mereka (HTML biasa, WordPress "Custom HTML", Wix/Blogger "Embed").
4. Tetapkan URL webhook untuk sahkan bayaran di pelayan mereka.

Pilihan integrasi lain (pautan bayaran, `BayarTerus.pay()` untuk SPA, API pelayan cURL/Node/PHP, pengesahan webhook) ada di `/docs` dan dalam dashboard. Contoh fail ada dalam [`examples/`](examples).

## Struktur

```
src/
  server.js            Aplikasi Express, laluan halaman
  config.js            Caj, had amaun, tempoh penyelesaian, tetapan webhook
  db.js                Skema SQLite
  lib/
    service.js         Logik bayaran, refund, baki, payout, pautan, statistik
    processor.js       Lapisan pemproses: simulator (ujian) + adapter live
    webhooks.js        Event, tandatangan, pekerja penghantaran & cubaan semula
    auth.js            Kata laluan, sesi, kunci API
  routes/
    api.js             REST API /v1 + endpoint embed (kunci awam)
    checkout.js        API halaman checkout yang dihoskan
    dashboard.js       API dashboard merchant
public/
  js/bayarterus.js     SDK embed yang ditampal oleh merchant
  js/snippets.js       Penjana snippet (dashboard + docs)
  ...                  Halaman dashboard, checkout, docs, demo
```

## Penting: sebelum mod live

Mod **ujian** berfungsi sepenuhnya dengan simulator. Untuk memproses **wang sebenar**, gateway ini perlu disambungkan kepada pemproses berlesen, dan **pembayaran live akan ditolak sehingga itu dibuat**:

- **Pemproses / acquirer**: FPX melalui PayNet (atau peserta FPX), kad melalui bank acquirer, e-dompet melalui perjanjian dengan setiap penyedia. Tulis adapter dalam `liveAdapters` di `src/lib/processor.js` (kaedah `charge(payment, input)` yang memulangkan `succeeded` / `failed` / `processing` + `next_action`), dan tambah endpoint callback/webhook pemproses yang memanggil `finalizePayment()`. Kemudian tetapkan `LIVE_PROCESSOR=<nama>`.
- **Pematuhan**: menerima dana bagi pihak merchant lain biasanya memerlukan kelulusan Bank Negara Malaysia (contohnya pendaftaran sebagai *merchant acquirer* atau kerjasama dengan pemegang lesen). Proses KYC merchant juga perlu ditambah.
- **Data kad**: menyimpan atau memproses nombor kad sendiri memerlukan pematuhan **PCI DSS**. Untuk live, gunakan medan kad / halaman 3-D Secure yang dihoskan oleh acquirer dan jangan hantar nombor kad melalui pelayan ini. Simulator hanya menyemak format dan tidak menyimpan nombor kad (hanya 4 digit akhir).
- **Operasi**: proses payout ke bank (mod live mencipta payout berstatus `pending`), pemantauan penipuan, emel resit (belum disambungkan ke SMTP), sandaran pangkalan data, dan Redis untuk had kadar jika berbilang instans.
