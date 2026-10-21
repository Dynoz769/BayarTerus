// API dalaman untuk dashboard merchant (sesi cookie).
import express from 'express';
import { config } from '../config.js';
import { tx } from '../db.js';
import {
  createMerchant,
  createSession,
  destroySession,
  generateKeys,
  hashPassword,
  parseCookies,
  requireSession,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
} from '../lib/auth.js';
import { rateLimit } from '../lib/middleware.js';
import { emitEvent, eventPayload, resendDelivery } from '../lib/webhooks.js';
import {
  cancelPayment,
  createLink,
  createPayment,
  createPayout,
  createRefund,
  getBalance,
  getMerchantPayment,
  getStats,
  listPayments,
  listRefunds,
  serializeCustomer,
  serializeLink,
  serializePayment,
  serializePayout,
  serializeRefund,
} from '../lib/service.js';
import {
  ApiError,
  badRequest,
  isEmail,
  isHttpUrl,
  notFound,
  optionalString,
  optionalUrl,
  randomString,
  toCsv,
} from '../lib/util.js';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i;

function publicMerchant(m) {
  return {
    id: m.id,
    email: m.email,
    business_name: m.business_name,
    website: m.website,
    support_email: m.support_email,
    brand_color: m.brand_color,
    allowed_domains: m.allowed_domains,
    allow_client_amount: !!m.allow_client_amount,
    bank_name: m.bank_name,
    bank_account_no: m.bank_account_no,
    bank_account_name: m.bank_account_name,
    created_at: m.created_at,
  };
}

export function dashboardRouter(db) {
  const r = express.Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, key: (req) => `auth:${req.ip}` });

  r.post('/auth/register', authLimiter, (req, res) => {
    const { email, password, business_name: businessName } = req.body || {};
    if (!isEmail(email)) throw badRequest('Emel tidak sah.', 'email');
    if (typeof password !== 'string' || password.length < 8) throw badRequest('Kata laluan minimum 8 aksara.', 'password');
    const name = optionalString(businessName, 'business_name', 120);
    if (!name) throw badRequest('Nama perniagaan diperlukan.', 'business_name');
    if (db.prepare('SELECT 1 FROM merchants WHERE email = ?').get(email.toLowerCase())) {
      throw new ApiError(409, 'email_taken', 'Emel ini sudah didaftarkan.');
    }
    const { id, keys } = tx(db, () => createMerchant(db, { email, password, businessName: name }));
    res.set('Set-Cookie', sessionCookie(createSession(db, id), req));
    // Kunci rahsia dipaparkan sekali sahaja.
    res.status(201).json({
      merchant_id: id,
      secret_keys: { test: keys.test.secretKey, live: keys.live.secretKey },
    });
  });

  r.post('/auth/login', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    const m = isEmail(email) ? db.prepare('SELECT * FROM merchants WHERE email = ?').get(email.toLowerCase()) : null;
    if (!m || !verifyPassword(String(password || ''), m.password_hash)) {
      throw new ApiError(401, 'invalid_credentials', 'Emel atau kata laluan salah.');
    }
    res.set('Set-Cookie', sessionCookie(createSession(db, m.id), req));
    res.json({ ok: true });
  });

  r.post('/auth/logout', (req, res) => {
    destroySession(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.set('Set-Cookie', sessionCookie(null, req));
    res.json({ ok: true });
  });

  r.use(requireSession(db));
  const M = (req) => [req.merchant.id, req.mode];

  r.get('/me', (req, res) => {
    res.json({ merchant: publicMerchant(req.merchant), mode: req.mode, base_url: config.baseUrl, live_enabled: !!config.liveProcessor });
  });

  r.get('/stats', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    res.json({ ...getStats(db, ...M(req), days), balance: getBalance(db, ...M(req)) });
  });

  // --- Bayaran ---
  r.get('/payments', (req, res) => {
    const { data, has_more } = listPayments(db, ...M(req), req.query);
    res.json({ data: data.map(serializePayment), has_more });
  });

  r.get('/payments.csv', (req, res) => {
    const { data } = listPayments(db, ...M(req), { ...req.query, export: true, limit: 10000 });
    const csv = toCsv(data, [
      { label: 'id', get: (p) => p.id },
      { label: 'tarikh', get: (p) => new Date(p.created_at * 1000).toISOString() },
      { label: 'status', get: (p) => p.status },
      { label: 'amaun', get: (p) => (p.amount / 100).toFixed(2) },
      { label: 'caj', get: (p) => (p.fee / 100).toFixed(2) },
      { label: 'bersih', get: (p) => (p.net / 100).toFixed(2) },
      { label: 'refund', get: (p) => (p.amount_refunded / 100).toFixed(2) },
      { label: 'kaedah', get: (p) => p.method },
      { label: 'butiran_kaedah', get: (p) => p.method_detail },
      { label: 'rujukan', get: (p) => p.reference },
      { label: 'keterangan', get: (p) => p.description },
      { label: 'emel_pelanggan', get: (p) => p.customer_email },
      { label: 'nama_pelanggan', get: (p) => p.customer_name },
    ]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="bayarterus-${req.mode}-transaksi.csv"`);
    res.send(`﻿${csv}`);
  });

  r.get('/payments/:id', (req, res) => {
    const p = getMerchantPayment(db, ...M(req), req.params.id);
    const events = db
      .prepare(`SELECT * FROM events WHERE merchant_id = ? AND mode = ? AND (json_extract(data, '$.id') = ? OR json_extract(data, '$.payment') = ?) ORDER BY created_at, rowid`)
      .all(...M(req), p.id, p.id);
    res.json({
      payment: serializePayment(p),
      refunds: listRefunds(db, ...M(req), p.id).map(serializeRefund),
      events: events.map(eventPayload),
    });
  });

  r.post('/payments', (req, res) => {
    const p = createPayment(db, req.merchant, req.mode, req.body || {}, { source: 'dashboard' });
    res.status(201).json(serializePayment(p));
  });

  r.post('/payments/:id/refund', (req, res) => {
    res.status(201).json(serializeRefund(createRefund(db, ...M(req), req.params.id, req.body || {})));
  });

  r.post('/payments/:id/cancel', (req, res) => {
    res.json(serializePayment(cancelPayment(db, ...M(req), req.params.id)));
  });

  // --- Pautan bayaran ---
  r.get('/links', (req, res) => {
    const rows = db
      .prepare(
        `SELECT l.*, (SELECT COUNT(*) FROM payments p WHERE p.link_id = l.id AND p.status IN ('succeeded','partially_refunded','refunded')) AS paid_count,
                (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.link_id = l.id AND p.status IN ('succeeded','partially_refunded','refunded')) AS paid_total
         FROM payment_links l WHERE merchant_id = ? AND mode = ? ORDER BY created_at DESC`
      )
      .all(...M(req));
    res.json({ data: rows.map((l) => ({ ...serializeLink(l), paid_count: l.paid_count, paid_total: (l.paid_total / 100).toFixed(2) })) });
  });

  r.post('/links', (req, res) => {
    res.status(201).json(serializeLink(createLink(db, ...M(req), req.body || {})));
  });

  r.patch('/links/:id', (req, res) => {
    const l = db.prepare('SELECT * FROM payment_links WHERE id = ? AND merchant_id = ? AND mode = ?').get(req.params.id, ...M(req));
    if (!l) throw notFound('Pautan bayaran');
    db.prepare('UPDATE payment_links SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, l.id);
    res.json(serializeLink(db.prepare('SELECT * FROM payment_links WHERE id = ?').get(l.id)));
  });

  // --- Pelanggan ---
  r.get('/customers', (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.*, COUNT(p.id) AS payments_count, COALESCE(SUM(p.amount - p.amount_refunded), 0) AS total_spent
         FROM customers c LEFT JOIN payments p ON p.customer_id = c.id AND p.status IN ('succeeded','partially_refunded','refunded')
         WHERE c.merchant_id = ? AND c.mode = ? GROUP BY c.id ORDER BY c.created_at DESC LIMIT 500`
      )
      .all(...M(req));
    res.json({
      data: rows.map((c) => ({ ...serializeCustomer(c), payments_count: c.payments_count, total_spent: (c.total_spent / 100).toFixed(2) })),
    });
  });

  // --- Baki & payout ---
  r.get('/balance', (req, res) => {
    const payouts = db
      .prepare('SELECT * FROM payouts WHERE merchant_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 100')
      .all(...M(req));
    res.json({ balance: getBalance(db, ...M(req)), payouts: payouts.map(serializePayout), min_payout: (config.minPayout / 100).toFixed(2) });
  });

  r.post('/payouts', (req, res) => {
    res.status(201).json(serializePayout(createPayout(db, req.merchant, req.mode, req.body || {})));
  });

  // --- Kunci API ---
  r.get('/keys', (req, res) => {
    const k = db.prepare('SELECT public_key, secret_last4, created_at FROM api_keys WHERE merchant_id = ? AND mode = ?').get(...M(req));
    res.json({ public_key: k.public_key, secret_key_hint: `sk_${req.mode}_••••${k.secret_last4}`, created_at: k.created_at });
  });

  r.post('/keys/roll', (req, res) => {
    const keys = generateKeys(db, ...M(req));
    res.json({ public_key: keys.publicKey, secret_key: keys.secretKey });
  });

  // --- Webhook ---
  r.get('/webhook', (req, res) => {
    const ep = db.prepare('SELECT url, secret FROM webhook_endpoints WHERE merchant_id = ? AND mode = ?').get(...M(req));
    const deliveries = db
      .prepare(
        `SELECT d.*, e.type FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
         WHERE d.merchant_id = ? AND d.mode = ? ORDER BY d.created_at DESC LIMIT 50`
      )
      .all(...M(req));
    res.json({ url: ep.url, secret: ep.secret, deliveries });
  });

  r.put('/webhook', (req, res) => {
    const url = optionalUrl(req.body?.url, 'url');
    if (url && req.mode === 'live') {
      const u = new URL(url);
      if (u.protocol !== 'https:') throw badRequest('URL webhook mod live mesti https.', 'url');
      if (PRIVATE_HOST.test(u.hostname)) throw badRequest('URL webhook tidak boleh menghala ke rangkaian dalaman.', 'url');
    }
    db.prepare('UPDATE webhook_endpoints SET url = ? WHERE merchant_id = ? AND mode = ?').run(url, ...M(req));
    res.json({ url });
  });

  r.post('/webhook/roll-secret', (req, res) => {
    const secret = `whsec_${randomString(32)}`;
    db.prepare('UPDATE webhook_endpoints SET secret = ? WHERE merchant_id = ? AND mode = ?').run(secret, ...M(req));
    res.json({ secret });
  });

  r.post('/webhook/test', (req, res) => {
    const ep = db.prepare('SELECT url FROM webhook_endpoints WHERE merchant_id = ? AND mode = ?').get(...M(req));
    if (!ep.url) throw badRequest('Tetapkan URL webhook dahulu.');
    const id = emitEvent(db, ...M(req), 'ping', { message: 'Webhook ujian dari BayarTerus', merchant: req.merchant.id });
    res.json({ event_id: id });
  });

  r.post('/webhook/deliveries/:id/resend', (req, res) => {
    if (!resendDelivery(db, req.params.id, ...M(req))) throw notFound('Penghantaran');
    res.json({ ok: true });
  });

  // --- Tetapan ---
  r.put('/settings', (req, res) => {
    const b = req.body || {};
    const m = req.merchant;
    const name = optionalString(b.business_name, 'business_name', 120) ?? m.business_name;
    const color = b.brand_color ?? m.brand_color;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw badRequest('Warna jenama mesti format #RRGGBB.', 'brand_color');
    const support = optionalString(b.support_email, 'support_email', 254);
    if (support && !isEmail(support)) throw badRequest('Emel sokongan tidak sah.', 'support_email');
    const website = optionalString(b.website, 'website', 300);
    if (website && !isHttpUrl(website)) throw badRequest('Laman web mesti URL http/https.', 'website');
    const domains = String(b.allowed_domains ?? m.allowed_domains)
      .split(/[,\s]+/)
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    if (domains.some((d) => !/^[a-z0-9.-]+(:\d+)?$/.test(d))) throw badRequest('Senarai domain tidak sah.', 'allowed_domains');
    const accNo = optionalString(b.bank_account_no, 'bank_account_no', 30);
    if (accNo && !/^\d{6,20}$/.test(accNo)) throw badRequest('Nombor akaun bank mesti 6–20 digit.', 'bank_account_no');

    db.prepare(
      `UPDATE merchants SET business_name = ?, brand_color = ?, support_email = ?, website = ?, allowed_domains = ?,
         allow_client_amount = ?, bank_name = ?, bank_account_no = ?, bank_account_name = ? WHERE id = ?`
    ).run(
      name,
      color,
      support,
      website,
      domains.map((d) => d.replace(/:\d+$/, '')).join(','),
      b.allow_client_amount === undefined ? m.allow_client_amount : b.allow_client_amount ? 1 : 0,
      optionalString(b.bank_name, 'bank_name', 80),
      accNo,
      optionalString(b.bank_account_name, 'bank_account_name', 120),
      m.id
    );
    res.json({ merchant: publicMerchant(db.prepare('SELECT * FROM merchants WHERE id = ?').get(m.id)) });
  });

  r.put('/password', (req, res) => {
    const { current_password: cur, new_password: next } = req.body || {};
    if (!verifyPassword(String(cur || ''), req.merchant.password_hash)) throw badRequest('Kata laluan semasa salah.', 'current_password');
    if (typeof next !== 'string' || next.length < 8) throw badRequest('Kata laluan baharu minimum 8 aksara.', 'new_password');
    db.prepare('UPDATE merchants SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.merchant.id);
    res.json({ ok: true });
  });

  r.use((_req, _res) => {
    throw notFound('Endpoint');
  });

  return r;
}
