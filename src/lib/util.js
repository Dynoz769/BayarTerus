import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(len = 24) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const newId = (prefix, len = 20) => `${prefix}_${randomString(len)}`;

export const now = () => Math.floor(Date.now() / 1000);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export class ApiError extends Error {
  constructor(status, code, message, param) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export const badRequest = (message, param) => new ApiError(400, 'invalid_request', message, param);
export const notFound = (what = 'Rekod') => new ApiError(404, 'not_found', `${what} tidak dijumpai.`);

// Terima "25.50" atau 25.5 (ringgit) dan pulangkan integer dalam sen.
export function parseAmount(value, { param = 'amount', min, max } = {}) {
  if (value === undefined || value === null || value === '') throw badRequest('Amaun diperlukan.', param);
  const str = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) throw badRequest('Amaun mesti nombor positif dengan maksimum 2 titik perpuluhan, cth. 25.50.', param);
  const sen = Math.round(Number(str) * 100);
  if (min !== undefined && sen < min) throw badRequest(`Amaun minimum ialah ${formatMoney(min)}.`, param);
  if (max !== undefined && sen > max) throw badRequest(`Amaun maksimum ialah ${formatMoney(max)}.`, param);
  return sen;
}

export const formatMoney = (sen) => `RM${(sen / 100).toFixed(2)}`;
export const toDecimal = (sen) => (sen / 100).toFixed(2);

export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

export function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function optionalString(value, param, maxLen = 255) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest(`${param} mesti teks.`, param);
  if (value.length > maxLen) throw badRequest(`${param} melebihi ${maxLen} aksara.`, param);
  return value.trim();
}

export function optionalUrl(value, param) {
  const s = optionalString(value, param, 2000);
  if (s && !isHttpUrl(s)) throw badRequest(`${param} mesti URL http/https yang sah.`, param);
  return s;
}

export function parseMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('metadata mesti objek key/value.', 'metadata');
  const entries = Object.entries(value);
  if (entries.length > 20) throw badRequest('metadata maksimum 20 kunci.', 'metadata');
  const out = {};
  for (const [k, v] of entries) {
    if (k.length > 40) throw badRequest('Kunci metadata maksimum 40 aksara.', 'metadata');
    const sv = String(v);
    if (sv.length > 500) throw badRequest('Nilai metadata maksimum 500 aksara.', 'metadata');
    out[k] = sv;
  }
  return out;
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Elak formula injection apabila dibuka dalam Excel.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => c.label).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(c.get(r))).join(','));
  return lines.join('\n');
}
