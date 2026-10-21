// REST API awam untuk pelayan merchant (kunci rahsia) + endpoint embed (kunci awam).
import express from 'express';
import { findByPublicKey, requireSecretKey } from '../lib/auth.js';
import { openCors, rateLimit } from '../lib/middleware.js';
import { eventPayload } from '../lib/webhooks.js';
import {
  cancelPayment,
  checkoutUrl,
  createLink,
  createPayment,
  createPayout,
  createRefund,
  getBalance,
  getMerchantPayment,
  listPayments,
  listRefunds,
  serializeCustomer,
  serializeLink,
  serializePayment,
  serializePayout,
  serializeRefund,
} from '../lib/service.js';
import { ApiError, badRequest, notFound, now } from '../lib/util.js';

const list = (data, hasMore = false) => ({ object: 'list', data, has_more: hasMore });

export function apiRouter(db) {
  const r = express.Router();
  r.use(openCors);

  // --- Embed (kunci awam, dipanggil dari pelayar pelanggan) -----------------
  r.post(
    '/embed/payments',
    rateLimit({ max: 30, key: (req) => `embed:${req.ip}` }),
    (req, res) => {
      const body = req.body || {};
      const found = findByPublicKey(db, body.key);
      if (!found) throw new ApiError(401, 'unauthorized', 'Kunci awam (data-key) tidak sah.');
      const { merchant, mode } = found;

      // Sekat domain jika merchant menetapkan senarai domain dibenarkan.
      const allowed = merchant.allowed_domains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (allowed.length) {
        let host = '';
        try {
          host = new URL(req.get('Origin') || req.get('Referer') || '').hostname.toLowerCase();
        } catch {}
        const ok = allowed.some((d) => host === d || host.endsWith(`.${d}`));
        if (!ok) throw new ApiError(403, 'domain_not_allowed', `Domain "${host || 'tidak diketahui'}" tidak dibenarkan untuk kunci ini.`);
      }

      let link = null;
      if (body.link) {
        link = db.prepare('SELECT * FROM payment_links WHERE id = ? AND merchant_id = ? AND mode = ?').get(body.link, merchant.id, mode);
        if (!link || !link.active) throw notFound('Pautan bayaran');
        if (link.amount !== null) body.amount = (link.amount / 100).toFixed(2);
      } else if (!merchant.allow_client_amount) {
        throw new ApiError(
          403,
          'client_amount_disabled',
          'Amaun dari pelayar dimatikan. Gunakan data-link (pautan bayaran) atau cipta bayaran melalui API pelayan.'
        );
      }

      const p = createPayment(
        db,
        merchant,
        mode,
        {
          amount: body.amount,
          description: body.description,
          reference: body.reference,
          customer: { email: body.email, name: body.name, phone: body.phone },
          return_url: body.return_url,
          metadata: body.metadata,
        },
        { source: link ? 'link' : 'embed', link }
      );
      res.status(201).json({ id: p.id, status: p.status, checkout_url: checkoutUrl(p.id) });
    }
  );

  // --- API pelayan (kunci rahsia) ------------------------------------------
  const auth = requireSecretKey(db);
  r.use(auth, rateLimit({ max: 300, key: (req) => `api:${req.merchant.id}` }));

  r.post('/payments', (req, res) => {
    const key = req.get('Idempotency-Key');
    if (key) {
      if (key.length > 255) throw badRequest('Idempotency-Key terlalu panjang.');
      const prev = db
        .prepare('SELECT * FROM idempotency_keys WHERE merchant_id = ? AND mode = ? AND key = ?')
        .get(req.merchant.id, req.mode, key);
      if (prev) {
        res.set('Idempotent-Replayed', 'true');
        return res.status(prev.status_code).json(JSON.parse(prev.response));
      }
    }
    const p = createPayment(db, req.merchant, req.mode, req.body || {}, { source: 'api' });
    const out = serializePayment(p);
    if (key) {
      db.prepare(
        'INSERT OR IGNORE INTO idempotency_keys (merchant_id, mode, key, status_code, response, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(req.merchant.id, req.mode, key, 201, JSON.stringify(out), now());
    }
    res.status(201).json(out);
  });

  r.get('/payments', (req, res) => {
    const { data, has_more } = listPayments(db, req.merchant.id, req.mode, req.query);
    res.json(list(data.map(serializePayment), has_more));
  });

  r.get('/payments/:id', (req, res) => {
    res.json(serializePayment(getMerchantPayment(db, req.merchant.id, req.mode, req.params.id)));
  });

  r.post('/payments/:id/cancel', (req, res) => {
    res.json(serializePayment(cancelPayment(db, req.merchant.id, req.mode, req.params.id)));
  });

  r.post('/payments/:id/refunds', (req, res) => {
    res.status(201).json(serializeRefund(createRefund(db, req.merchant.id, req.mode, req.params.id, req.body || {})));
  });

  r.get('/payments/:id/refunds', (req, res) => {
    getMerchantPayment(db, req.merchant.id, req.mode, req.params.id);
    res.json(list(listRefunds(db, req.merchant.id, req.mode, req.params.id).map(serializeRefund)));
  });

  r.get('/refunds', (req, res) => {
    res.json(list(listRefunds(db, req.merchant.id, req.mode).map(serializeRefund)));
  });

  r.post('/payment_links', (req, res) => {
    res.status(201).json(serializeLink(createLink(db, req.merchant.id, req.mode, req.body || {})));
  });

  r.get('/payment_links', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM payment_links WHERE merchant_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 100')
      .all(req.merchant.id, req.mode);
    res.json(list(rows.map(serializeLink)));
  });

  r.get('/payment_links/:id', (req, res) => {
    const l = db
      .prepare('SELECT * FROM payment_links WHERE id = ? AND merchant_id = ? AND mode = ?')
      .get(req.params.id, req.merchant.id, req.mode);
    if (!l) throw notFound('Pautan bayaran');
    res.json(serializeLink(l));
  });

  r.get('/customers', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM customers WHERE merchant_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 100')
      .all(req.merchant.id, req.mode);
    res.json(list(rows.map(serializeCustomer)));
  });

  r.get('/balance', (req, res) => {
    const { available_cents, total_cents, ...bal } = getBalance(db, req.merchant.id, req.mode);
    res.json(bal);
  });

  r.post('/payouts', (req, res) => {
    res.status(201).json(serializePayout(createPayout(db, req.merchant, req.mode, req.body || {})));
  });

  r.get('/payouts', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM payouts WHERE merchant_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 100')
      .all(req.merchant.id, req.mode);
    res.json(list(rows.map(serializePayout)));
  });

  r.get('/events', (req, res) => {
    const rows = db
      .prepare('SELECT * FROM events WHERE merchant_id = ? AND mode = ? ORDER BY created_at DESC, id DESC LIMIT 100')
      .all(req.merchant.id, req.mode);
    res.json(list(rows.map(eventPayload)));
  });

  r.get('/events/:id', (req, res) => {
    const e = db
      .prepare('SELECT * FROM events WHERE id = ? AND merchant_id = ? AND mode = ?')
      .get(req.params.id, req.merchant.id, req.mode);
    if (!e) throw notFound('Event');
    res.json(eventPayload(e));
  });

  r.use((_req, _res) => {
    throw notFound('Endpoint');
  });

  return r;
}
