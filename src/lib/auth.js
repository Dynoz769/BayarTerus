import crypto from 'node:crypto';
import { config } from '../config.js';
import { ApiError, newId, now, randomString, sha256, safeEqual } from './util.js';

export const MODES = ['test', 'live'];

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return safeEqual(candidate, hash);
}

// Jana pasangan kunci baharu untuk satu mod. Kunci rahsia hanya dipulangkan sekali.
export function generateKeys(db, merchantId, mode) {
  const publicKey = `pk_${mode}_${randomString(24)}`;
  const secretKey = `sk_${mode}_${randomString(32)}`;
  db.prepare(
    `INSERT INTO api_keys (merchant_id, mode, public_key, secret_hash, secret_last4, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, mode) DO UPDATE SET
       public_key = excluded.public_key, secret_hash = excluded.secret_hash,
       secret_last4 = excluded.secret_last4, created_at = excluded.created_at`
  ).run(merchantId, mode, publicKey, sha256(secretKey), secretKey.slice(-4), now());
  return { publicKey, secretKey };
}

export function ensureWebhookEndpoint(db, merchantId, mode) {
  db.prepare(
    `INSERT OR IGNORE INTO webhook_endpoints (merchant_id, mode, url, secret) VALUES (?, ?, NULL, ?)`
  ).run(merchantId, mode, `whsec_${randomString(32)}`);
}

export function createSession(db, merchantId) {
  const token = randomString(48);
  db.prepare('INSERT INTO sessions (token_hash, merchant_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    merchantId,
    now() + config.sessionDays * 86400
  );
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'bt_session';

export function sessionCookie(token, req) {
  const secure = req.secure || config.baseUrl.startsWith('https://') ? '; Secure' : '';
  const maxAge = token ? config.sessionDays * 86400 : 0;
  return `${SESSION_COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Middleware dashboard: sesi cookie + header X-Requested-With untuk permintaan
// yang mengubah data (perlindungan CSRF ringkas bersama SameSite=Lax).
export function requireSession(db) {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const row = token
      ? db
          .prepare(
            `SELECT m.* FROM sessions s JOIN merchants m ON m.id = s.merchant_id
             WHERE s.token_hash = ? AND s.expires_at > ?`
          )
          .get(sha256(token), now())
      : null;
    if (!row) throw new ApiError(401, 'unauthorized', 'Sila log masuk.');
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'BayarTerus') {
      throw new ApiError(403, 'csrf', 'Permintaan ditolak.');
    }
    const mode = req.get('X-Mode') || req.query.mode || 'test';
    if (!MODES.includes(mode)) throw new ApiError(400, 'invalid_mode', 'Mod mesti test atau live.');
    req.merchant = row;
    req.mode = mode;
    next();
  };
}

function bearer(req) {
  const h = req.get('Authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (h.startsWith('Basic ')) {
    // Sokong gaya curl -u sk_test_xxx:
    return Buffer.from(h.slice(6), 'base64').toString().split(':')[0];
  }
  return null;
}

// Middleware API pelayan: kunci rahsia sk_test_/sk_live_.
export function requireSecretKey(db) {
  return (req, _res, next) => {
    const key = bearer(req);
    if (!key || !/^sk_(test|live)_/.test(key)) {
      throw new ApiError(401, 'unauthorized', 'Sediakan kunci rahsia: Authorization: Bearer sk_test_...');
    }
    const row = db
      .prepare(
        `SELECT m.*, k.mode AS key_mode FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
         WHERE k.secret_hash = ?`
      )
      .get(sha256(key));
    if (!row) throw new ApiError(401, 'unauthorized', 'Kunci API tidak sah.');
    req.mode = row.key_mode;
    delete row.key_mode;
    req.merchant = row;
    next();
  };
}

export function findByPublicKey(db, key) {
  if (!key || !/^pk_(test|live)_/.test(key)) return null;
  const row = db
    .prepare(
      `SELECT m.*, k.mode AS key_mode FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
       WHERE k.public_key = ?`
    )
    .get(key);
  if (!row) return null;
  const mode = row.key_mode;
  delete row.key_mode;
  return { merchant: row, mode };
}

export function createMerchant(db, { email, password, businessName }) {
  const id = newId('mch', 16);
  db.prepare(
    `INSERT INTO merchants (id, email, password_hash, business_name, support_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email.toLowerCase(), hashPassword(password), businessName, email.toLowerCase(), now());
  const keys = {};
  for (const mode of MODES) {
    keys[mode] = generateKeys(db, id, mode);
    ensureWebhookEndpoint(db, id, mode);
  }
  return { id, keys };
}
