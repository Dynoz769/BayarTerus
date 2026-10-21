# Deploy BayarTerus (link awam berfungsi penuh)

BayarTerus perlukan server Node.js yang sentiasa hidup dan **cakera kekal** untuk pangkalan data. Tanpa cakera kekal, semua akaun merchant dan transaksi akan hilang setiap kali server restart atau di-deploy semula.

Repo ini sudah ada `Dockerfile`, `railway.json` dan `render.yaml`, jadi tiada kod perlu diubah. Pilih satu platform.

---

## Pilihan A: Railway (disyorkan)

Sokong volume (cakera kekal) dengan kos rendah.

1. Daftar di <https://railway.com> dan log masuk dengan GitHub.
2. **New Project → Deploy from GitHub repo** → pilih `Dynoz769/BayarTerus`.
3. Buka service yang dicipta → **Settings → Source**: tukar branch kepada `claude/focused-fermat-p4b9tk` (atau `main` jika anda sudah merge).
4. Tambah volume: klik kanan pada service (atau tekan `Ctrl/⌘ + K` → "Volume") → **Add Volume**, dan tetapkan **Mount path** kepada:
   ```
   /app/data
   ```
5. **Settings → Networking → Generate Domain**. Railway akan beri URL seperti `https://bayarterus-production.up.railway.app`.
6. Tunggu deploy siap (status hijau). Buka URL tersebut → `/register` untuk daftar merchant pertama.

URL awam dikesan automatik. Jika anda guna domain sendiri (cth. `pay.kedaisaya.com`), tambah pembolehubah `BASE_URL=https://pay.kedaisaya.com` dalam tab **Variables**.

---

## Pilihan B: Render

1. Daftar di <https://render.com> dan sambungkan GitHub.
2. **New → Blueprint** → pilih repo `Dynoz769/BayarTerus` dan branch `claude/focused-fermat-p4b9tk`.
3. Render akan baca `render.yaml` dan cipta service `bayarterus` dengan disk 1 GB di `/app/data`, di rantau Singapura.
4. Sahkan dan deploy. URL akan jadi `https://bayarterus.onrender.com` (atau seumpamanya).

Nota: disk kekal di Render memerlukan pelan **Starter (berbayar)**. Pelan percuma tiada disk, jadi data akan hilang. Jangan guna pelan percuma untuk merchant sebenar.

---

## Pilihan C: VPS sendiri (DigitalOcean, Hostinger VPS, dsb.)

```bash
# Pasang Node.js 22, kemudian:
git clone -b claude/focused-fermat-p4b9tk https://github.com/Dynoz769/BayarTerus
cd BayarTerus
npm ci --omit=dev
BASE_URL=https://pay.domain-anda.com TRUST_PROXY=1 PORT=3000 npm start
```

Letakkan di belakang nginx/Caddy dengan HTTPS, dan gunakan `pm2` atau `systemd` supaya server hidup semula selepas reboot. Data disimpan dalam folder `data/` — sandarkan secara berkala.

---

## Selepas deploy

| Semak | URL |
|---|---|
| Server hidup | `https://URL-ANDA/healthz` → `{"ok":true}` |
| Laman utama | `https://URL-ANDA/` |
| Daftar merchant | `https://URL-ANDA/register` |
| Dokumentasi | `https://URL-ANDA/docs` |

Snippet dalam **Dashboard → Integrasi** akan guna URL ini secara automatik, jadi merchant boleh salin dan tampal di laman mereka terus.

## Had semasa

Semua di atas berjalan dalam **mod ujian** (kad ujian dan bank simulasi). Untuk wang sebenar, gateway perlu disambungkan kepada pemproses bayaran berlesen — lihat bahagian "Penting: sebelum mod live" dalam [README](README.md).
