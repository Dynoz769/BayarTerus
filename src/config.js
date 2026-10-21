const port = Number(process.env.PORT) || 3000;

// URL awam: BASE_URL jika ditetapkan, jika tidak dikesan daripada platform hosting.
function detectBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${port}`;
}

export const config = {
  port,
  // URL awam gateway. Digunakan dalam snippet embed, checkout_url dan pautan bayaran.
  baseUrl: detectBaseUrl().replace(/\/$/, ''),
  dbPath: process.env.DB_PATH || 'data/bayarterus.db',
  currency: 'MYR',

  // Minimum RM1.00, maksimum RM30,000 setiap transaksi (dalam sen).
  minAmount: 100,
  maxAmount: 3_000_000,

  // Caj gateway setiap kaedah bayaran: peratus + caj tetap (sen).
  fees: {
    card: { percent: 2.2, fixed: 0 },
    fpx: { percent: 0, fixed: 100 },
    ewallet: { percent: 1.5, fixed: 0 },
    duitnow_qr: { percent: 1.0, fixed: 0 },
  },

  // Bilangan hari sebelum dana boleh dikeluarkan (T+N).
  settlementDays: { test: 0, live: Number(process.env.LIVE_SETTLEMENT_DAYS ?? 2) },
  minPayout: 1000,
  paymentExpiryMinutes: 60,
  sessionDays: 7,

  webhook: {
    maxAttempts: 6,
    timeoutMs: 10_000,
    // Kelewatan (saat) sebelum cubaan ke-2, ke-3, ...
    backoffSeconds: [30, 120, 600, 3600, 21600],
    pollMs: 5_000,
  },

  // Pemproses mod live. Tanpa ini, mod live akan menolak pembayaran
  // (simulator hanya untuk mod test). Lihat src/lib/processor.js.
  liveProcessor: process.env.LIVE_PROCESSOR || null,
};
