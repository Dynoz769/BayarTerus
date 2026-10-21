// Lapisan pemproses bayaran.
//
// Mod "test" menggunakan simulator terbina dalam supaya merchant boleh menguji
// integrasi hujung-ke-hujung tanpa wang sebenar. Mod "live" MESTI disambungkan
// kepada acquirer / pemproses berlesen (bank, PayNet FPX, rangkaian kad,
// penyedia e-dompet). Tambah adapter dalam `liveAdapters` di bawah dan tetapkan
// LIVE_PROCESSOR=<nama> — tanpa itu pembayaran live akan ditolak.
import { config } from '../config.js';
import { ApiError, badRequest } from './util.js';

export const METHODS = ['card', 'fpx', 'ewallet', 'duitnow_qr'];

export const FPX_BANKS = [
  { code: 'MBB0228', name: 'Maybank2u' },
  { code: 'BCBB0235', name: 'CIMB Clicks' },
  { code: 'PBB0233', name: 'Public Bank' },
  { code: 'RHB0218', name: 'RHB Now' },
  { code: 'HLB0224', name: 'Hong Leong Connect' },
  { code: 'AMBB0209', name: 'AmOnline' },
  { code: 'BIMB0340', name: 'Bank Islam' },
  { code: 'BMMB0341', name: 'Bank Muamalat' },
  { code: 'BKRM0602', name: 'Bank Rakyat' },
  { code: 'BSN0601', name: 'BSN' },
  { code: 'ABB0233', name: 'Affin Bank' },
  { code: 'OCBC0229', name: 'OCBC Bank' },
  { code: 'UOB0226', name: 'UOB Bank' },
];

export const EWALLETS = [
  { code: 'tng', name: "Touch 'n Go eWallet" },
  { code: 'grabpay', name: 'GrabPay' },
  { code: 'boost', name: 'Boost' },
  { code: 'shopeepay', name: 'ShopeePay' },
];

// Kad ujian (mod test sahaja).
export const TEST_CARDS = {
  '4242424242424242': { ok: true },
  '5555555555554444': { ok: true },
  '4000000000000002': { ok: false, reason: 'Kad ditolak oleh bank pengeluar.' },
  '4000000000009995': { ok: false, reason: 'Baki tidak mencukupi.' },
  '4000000000000069': { ok: false, reason: 'Kad telah tamat tempoh.' },
};

export function luhnValid(number) {
  let sum = 0;
  let dbl = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = Number(number[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return number.length >= 12 && sum % 10 === 0;
}

export function cardBrand(number) {
  if (/^4/.test(number)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(number)) return 'mastercard';
  if (/^3[47]/.test(number)) return 'amex';
  return 'card';
}

// Sahkan input kaedah bayaran dan pulangkan { method, detail, card? }.
export function validateMethodInput(body) {
  const method = body.method;
  if (!METHODS.includes(method)) throw badRequest('Kaedah bayaran tidak disokong.', 'method');

  if (method === 'card') {
    const number = String(body.card_number || '').replace(/\D/g, '');
    const month = Number(body.exp_month);
    let year = Number(body.exp_year);
    const cvc = String(body.cvc || '');
    if (!luhnValid(number)) throw badRequest('Nombor kad tidak sah.', 'card_number');
    if (!(month >= 1 && month <= 12)) throw badRequest('Bulan tamat tempoh tidak sah.', 'exp_month');
    if (year < 100) year += 2000;
    const d = new Date();
    if (!year || year < d.getFullYear() || (year === d.getFullYear() && month < d.getMonth() + 1)) {
      throw badRequest('Kad telah tamat tempoh.', 'exp_year');
    }
    if (!/^\d{3,4}$/.test(cvc)) throw badRequest('CVC tidak sah.', 'cvc');
    const brand = cardBrand(number);
    return { method, detail: `${brand} •••• ${number.slice(-4)}`, card: { number, brand } };
  }
  if (method === 'fpx') {
    const bank = FPX_BANKS.find((b) => b.code === body.bank);
    if (!bank) throw badRequest('Sila pilih bank.', 'bank');
    return { method, detail: bank.name };
  }
  if (method === 'ewallet') {
    const w = EWALLETS.find((x) => x.code === body.wallet);
    if (!w) throw badRequest('Sila pilih e-dompet.', 'wallet');
    return { method, detail: w.name };
  }
  return { method, detail: 'DuitNow QR' };
}

const simulator = {
  // Kad diproses serta-merta. Kaedah lain memerlukan pelanggan "log masuk"
  // ke halaman bank/e-dompet simulasi, jadi kita pulangkan next_action redirect.
  charge(payment, input) {
    if (input.method === 'card') {
      const rule = TEST_CARDS[input.card.number];
      if (rule && !rule.ok) return { status: 'failed', failure_reason: rule.reason };
      return { status: 'succeeded' };
    }
    return {
      status: 'processing',
      next_action: { type: 'redirect', url: `${config.baseUrl}/sim/${payment.id}` },
    };
  },
};

const liveAdapters = {
  // contoh: myacquirer: { charge(payment, input) { ... panggil API acquirer ... } }
};

export function getProcessor(mode) {
  if (mode === 'test') return simulator;
  const adapter = config.liveProcessor && liveAdapters[config.liveProcessor];
  if (!adapter) {
    throw new ApiError(
      503,
      'live_processor_unavailable',
      'Pembayaran live belum diaktifkan untuk gateway ini. Gunakan mod test atau hubungi pentadbir.'
    );
  }
  return adapter;
}
