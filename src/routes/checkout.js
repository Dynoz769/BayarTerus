// API untuk halaman checkout yang dihoskan (dipanggil oleh public/checkout.js).
import express from 'express';
import { config } from '../config.js';
import { tx } from '../db.js';
import { rateLimit } from '../lib/middleware.js';
import { EWALLETS, FPX_BANKS, METHODS } from '../lib/processor.js';
import {
  buildReturnUrl,
  createPayment,
  finalizePayment,
  getPaymentRow,
  payPayment,
  serializeLink,
} from '../lib/service.js';
import { ApiError, notFound, toDecimal } from '../lib/util.js';

function publicPayment(db, p) {
  const m = db.prepare('SELECT business_name, brand_color, support_email, website FROM merchants WHERE id = ?').get(p.merchant_id);
  const closed = !['pending', 'processing', 'failed'].includes(p.status);
  return {
    id: p.id,
    status: p.status,
    livemode: p.mode === 'live',
    amount: toDecimal(p.amount),
    currency: p.currency,
    description: p.description,
    reference: p.reference,
    customer_email: p.customer_email,
    customer_name: p.customer_name,
    payment_method: p.method ? { type: p.method, detail: p.method_detail } : null,
    failure_reason: p.failure_reason,
    expires_at: p.expires_at,
    paid_at: p.paid_at,
    created: p.created_at,
    has_return_url: !!p.return_url,
    has_cancel_url: !!(p.cancel_url || p.return_url),
    closed,
    merchant: {
      name: m.business_name,
      brand_color: m.brand_color,
      support_email: m.support_email,
      website: m.website,
    },
    methods: METHODS,
    fpx_banks: FPX_BANKS,
    ewallets: EWALLETS,
  };
}

export function checkoutRouter(db) {
  const r = express.Router();
  r.use(rateLimit({ max: 120, key: (req) => `co:${req.ip}` }));

  const load = (id) => {
    const p = getPaymentRow(db, id);
    if (!p) throw notFound('Bayaran');
    return p;
  };

  r.get('/payments/:id', (req, res) => {
    res.json(publicPayment(db, load(req.params.id)));
  });

  r.post('/payments/:id/pay', rateLimit({ max: 15, key: (req) => `pay:${req.ip}:${req.params.id}` }), async (req, res) => {
    const out = await payPayment(db, req.params.id, req.body || {});
    res.json({ payment: publicPayment(db, out.payment), next_action: out.next_action || null });
  });

  // Halaman bank / e-dompet simulasi (mod test sahaja).
  r.post('/payments/:id/simulate', (req, res) => {
    const p = load(req.params.id);
    if (p.mode !== 'test') throw new ApiError(403, 'forbidden', 'Simulator hanya untuk mod test.');
    if (p.status !== 'processing') throw new ApiError(409, 'invalid_state', 'Bayaran tidak menunggu pengesahan.');
    const approve = req.body?.approve === true;
    const row = tx(db, () => finalizePayment(db, p.id, approve, approve ? null : 'Pelanggan membatalkan di halaman bank.'));
    res.json({ payment: publicPayment(db, row) });
  });

  // Kembali ke laman merchant. URL ditandatangani supaya status tidak boleh dipalsukan.
  r.get('/payments/:id/return', (req, res) => {
    const p = load(req.params.id);
    const cancel = req.query.cancel === '1';
    const base = cancel ? p.cancel_url || p.return_url : p.return_url;
    if (!base) return res.json({ url: null });
    res.json({ url: buildReturnUrl(db, p, base) });
  });

  r.get('/links/:id', (req, res) => {
    const l = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id);
    if (!l) throw notFound('Pautan bayaran');
    const m = db.prepare('SELECT business_name, brand_color FROM merchants WHERE id = ?').get(l.merchant_id);
    const { url, ...link } = serializeLink(l);
    res.json({ ...link, merchant: { name: m.business_name, brand_color: m.brand_color }, min_amount: toDecimal(config.minAmount) });
  });

  r.post('/links/:id', rateLimit({ max: 20, key: (req) => `link:${req.ip}` }), (req, res) => {
    const l = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id);
    if (!l || !l.active) throw notFound('Pautan bayaran');
    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(l.merchant_id);
    const body = req.body || {};
    const p = createPayment(
      db,
      merchant,
      l.mode,
      {
        amount: l.amount !== null ? toDecimal(l.amount) : body.amount,
        customer: { email: body.email, name: body.name, phone: body.phone },
      },
      { source: 'link', link: l }
    );
    res.status(201).json({ id: p.id, checkout_url: `/pay/${p.id}` });
  });

  return r;
}
