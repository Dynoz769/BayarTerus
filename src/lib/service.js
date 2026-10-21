// Logik teras: bayaran, refund, pelanggan, baki dan payout.
// Digunakan oleh API pelayan, endpoint embed, checkout dan dashboard.
import { config } from '../config.js';
import { tx } from '../db.js';
import { emitEvent } from './webhooks.js';
import { getProcessor, validateMethodInput } from './processor.js';
import {
  ApiError,
  badRequest,
  hmac,
  isEmail,
  newId,
  notFound,
  now,
  optionalString,
  optionalUrl,
  parseAmount,
  parseMetadata,
  randomString,
  toDecimal,
} from './util.js';

const OPEN_STATUSES = ['pending', 'processing', 'failed'];

export function calcFee(method, amount) {
  const f = config.fees[method] || { percent: 0, fixed: 0 };
  return Math.min(amount, Math.round((amount * f.percent) / 100) + f.fixed);
}

export function checkoutUrl(paymentId) {
  return `${config.baseUrl}/pay/${paymentId}`;
}

export function serializePayment(p) {
  return {
    id: p.id,
    object: 'payment',
    livemode: p.mode === 'live',
    status: p.status,
    amount: toDecimal(p.amount),
    amount_cents: p.amount,
    currency: p.currency,
    description: p.description,
    reference: p.reference,
    customer: {
      id: p.customer_id,
      email: p.customer_email,
      name: p.customer_name,
      phone: p.customer_phone,
    },
    payment_method: p.method ? { type: p.method, detail: p.method_detail } : null,
    fee: toDecimal(p.fee),
    net: toDecimal(p.net),
    amount_refunded: toDecimal(p.amount_refunded),
    failure_reason: p.failure_reason,
    metadata: JSON.parse(p.metadata || '{}'),
    payment_link: p.link_id,
    source: p.source,
    checkout_url: checkoutUrl(p.id),
    return_url: p.return_url,
    cancel_url: p.cancel_url,
    expires_at: p.expires_at,
    paid_at: p.paid_at,
    created: p.created_at,
  };
}

export function serializeRefund(r) {
  return {
    id: r.id,
    object: 'refund',
    livemode: r.mode === 'live',
    payment: r.payment_id,
    amount: toDecimal(r.amount),
    amount_cents: r.amount,
    reason: r.reason,
    status: r.status,
    created: r.created_at,
  };
}

export function serializeLink(l) {
  return {
    id: l.id,
    object: 'payment_link',
    livemode: l.mode === 'live',
    title: l.title,
    description: l.description,
    amount: l.amount === null ? null : toDecimal(l.amount),
    customer_chooses_amount: l.amount === null,
    redirect_url: l.redirect_url,
    active: !!l.active,
    url: `${config.baseUrl}/l/${l.id}`,
    created: l.created_at,
  };
}

export function serializePayout(p) {
  return {
    id: p.id,
    object: 'payout',
    livemode: p.mode === 'live',
    amount: toDecimal(p.amount),
    amount_cents: p.amount,
    status: p.status,
    bank: { name: p.bank_name, account_no: p.bank_account_no, account_name: p.bank_account_name },
    created: p.created_at,
    paid_at: p.paid_at,
  };
}

export function serializeCustomer(c) {
  return {
    id: c.id,
    object: 'customer',
    livemode: c.mode === 'live',
    email: c.email,
    name: c.name,
    phone: c.phone,
    created: c.created_at,
  };
}

// --- Bayaran ---------------------------------------------------------------

export function createPayment(db, merchant, mode, body, { source = 'api', link = null } = {}) {
  const amount = parseAmount(body.amount, { min: config.minAmount, max: config.maxAmount });
  if (body.currency && String(body.currency).toUpperCase() !== config.currency) {
    throw badRequest(`Hanya mata wang ${config.currency} disokong.`, 'currency');
  }
  const email = optionalString(body.customer?.email ?? body.email, 'customer.email', 254);
  if (email && !isEmail(email)) throw badRequest('Emel pelanggan tidak sah.', 'customer.email');

  const payment = {
    id: newId('pay'),
    merchant_id: merchant.id,
    mode,
    amount,
    currency: config.currency,
    status: 'pending',
    description: optionalString(body.description, 'description', 500) ?? link?.title ?? null,
    reference: optionalString(body.reference, 'reference', 100),
    customer_email: email?.toLowerCase() ?? null,
    customer_name: optionalString(body.customer?.name ?? body.name, 'customer.name', 120),
    customer_phone: optionalString(body.customer?.phone ?? body.phone, 'customer.phone', 30),
    return_url: optionalUrl(body.return_url, 'return_url') ?? link?.redirect_url ?? null,
    cancel_url: optionalUrl(body.cancel_url, 'cancel_url'),
    metadata: JSON.stringify(parseMetadata(body.metadata)),
    link_id: link?.id ?? null,
    source,
    client_secret: `${randomString(32)}`,
    expires_at: now() + config.paymentExpiryMinutes * 60,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO payments (id, merchant_id, mode, amount, currency, status, description, reference,
       customer_email, customer_name, customer_phone, return_url, cancel_url, metadata, link_id, source,
       client_secret, expires_at, created_at)
     VALUES (:id, :merchant_id, :mode, :amount, :currency, :status, :description, :reference,
       :customer_email, :customer_name, :customer_phone, :return_url, :cancel_url, :metadata, :link_id, :source,
       :client_secret, :expires_at, :created_at)`
  ).run(payment);
  const row = getPaymentRow(db, payment.id);
  emitEvent(db, merchant.id, mode, 'payment.created', serializePayment(row));
  return row;
}

export function getPaymentRow(db, id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

export function getMerchantPayment(db, merchantId, mode, id) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ? AND merchant_id = ? AND mode = ?').get(id, merchantId, mode);
  if (!p) throw notFound('Bayaran');
  return p;
}

export function listPayments(db, merchantId, mode, q = {}) {
  const where = ['merchant_id = ?', 'mode = ?'];
  const args = [merchantId, mode];
  if (q.status) {
    where.push('status = ?');
    args.push(String(q.status));
  }
  if (q.method) {
    where.push('method = ?');
    args.push(String(q.method));
  }
  if (q.reference) {
    where.push('reference = ?');
    args.push(String(q.reference));
  }
  if (q.search) {
    where.push('(id LIKE ? OR reference LIKE ? OR customer_email LIKE ? OR description LIKE ?)');
    const s = `%${String(q.search).replace(/[%_]/g, '')}%`;
    args.push(s, s, s, s);
  }
  if (q.from) {
    where.push('created_at >= ?');
    args.push(Number(q.from));
  }
  if (q.to) {
    where.push('created_at <= ?');
    args.push(Number(q.to));
  }
  if (q.starting_after) {
    const ref = db.prepare('SELECT created_at, id FROM payments WHERE id = ?').get(String(q.starting_after));
    if (ref) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args.push(ref.created_at, ref.created_at, ref.id);
    }
  }
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), q.export ? 10000 : 100);
  const rows = db
    .prepare(`SELECT * FROM payments WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, limit + 1);
  return { data: rows.slice(0, limit), has_more: rows.length > limit };
}

function upsertCustomer(db, p) {
  if (!p.customer_email) return null;
  const existing = db
    .prepare('SELECT * FROM customers WHERE merchant_id = ? AND mode = ? AND email = ?')
    .get(p.merchant_id, p.mode, p.customer_email);
  if (existing) {
    db.prepare('UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?').run(
      p.customer_name,
      p.customer_phone,
      existing.id
    );
    return existing.id;
  }
  const id = newId('cus');
  db.prepare(
    'INSERT INTO customers (id, merchant_id, mode, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, p.merchant_id, p.mode, p.customer_email, p.customer_name, p.customer_phone, now());
  return id;
}

function assertPayable(p) {
  if (p.status === 'succeeded' || p.status.includes('refunded')) {
    throw new ApiError(409, 'already_paid', 'Bayaran ini telah berjaya.');
  }
  if (!OPEN_STATUSES.includes(p.status) || p.expires_at < now()) {
    throw new ApiError(409, 'payment_closed', 'Bayaran ini telah tamat tempoh atau dibatalkan.');
  }
}

// Dipanggil oleh halaman checkout apabila pelanggan menghantar kaedah bayaran.
export async function payPayment(db, paymentId, body) {
  const p = getPaymentRow(db, paymentId);
  if (!p) throw notFound('Bayaran');
  assertPayable(p);

  const customerEmail = optionalString(body.email, 'email', 254);
  if (customerEmail && !isEmail(customerEmail)) throw badRequest('Emel tidak sah.', 'email');
  const input = validateMethodInput(body);
  const result = await getProcessor(p.mode).charge(p, input);

  return tx(db, () => {
    const current = getPaymentRow(db, p.id);
    assertPayable(current);
    db.prepare(
      `UPDATE payments SET method = ?, method_detail = ?, customer_email = COALESCE(?, customer_email),
         customer_name = COALESCE(?, customer_name), status = 'processing', failure_reason = NULL WHERE id = ?`
    ).run(
      input.method,
      input.detail,
      customerEmail?.toLowerCase() ?? null,
      optionalString(body.name, 'name', 120),
      p.id
    );
    if (result.status === 'processing') return { payment: getPaymentRow(db, p.id), next_action: result.next_action };
    return { payment: finalizePayment(db, p.id, result.status === 'succeeded', result.failure_reason) };
  });
}

// Tandakan bayaran berjaya/gagal, kira caj dan hantar event. Mesti dalam transaksi.
export function finalizePayment(db, paymentId, success, failureReason = null) {
  const p = getPaymentRow(db, paymentId);
  if (p.status !== 'processing') return p;
  if (success) {
    const fee = calcFee(p.method, p.amount);
    const customerId = upsertCustomer(db, p);
    db.prepare(
      `UPDATE payments SET status = 'succeeded', fee = ?, net = ?, paid_at = ?, customer_id = ? WHERE id = ?`
    ).run(fee, p.amount - fee, now(), customerId, p.id);
  } else {
    db.prepare(`UPDATE payments SET status = 'failed', failure_reason = ? WHERE id = ?`).run(
      failureReason || 'Bayaran tidak berjaya.',
      p.id
    );
  }
  const row = getPaymentRow(db, p.id);
  emitEvent(db, p.merchant_id, p.mode, success ? 'payment.succeeded' : 'payment.failed', serializePayment(row));
  return row;
}

export function cancelPayment(db, merchantId, mode, id) {
  return tx(db, () => {
    const p = getMerchantPayment(db, merchantId, mode, id);
    if (!['pending', 'failed'].includes(p.status)) {
      throw new ApiError(409, 'invalid_state', `Bayaran berstatus "${p.status}" tidak boleh dibatalkan.`);
    }
    db.prepare(`UPDATE payments SET status = 'cancelled' WHERE id = ?`).run(p.id);
    const row = getPaymentRow(db, p.id);
    emitEvent(db, merchantId, mode, 'payment.cancelled', serializePayment(row));
    return row;
  });
}

export function expireStalePayments(db) {
  const stale = db
    .prepare(`SELECT id FROM payments WHERE status IN ('pending','processing','failed') AND expires_at < ? LIMIT 200`)
    .all(now());
  for (const { id } of stale) {
    tx(db, () => {
      db.prepare(`UPDATE payments SET status = 'expired' WHERE id = ? AND status IN ('pending','processing','failed')`).run(id);
      const row = getPaymentRow(db, id);
      emitEvent(db, row.merchant_id, row.mode, 'payment.expired', serializePayment(row));
    });
  }
  return stale.length;
}

// Tandatangan pada return_url supaya merchant boleh sahkan pelanggan tidak ubah status.
export function returnSignature(db, p) {
  const ep = db.prepare('SELECT secret FROM webhook_endpoints WHERE merchant_id = ? AND mode = ?').get(p.merchant_id, p.mode);
  return hmac(ep.secret, `${p.id}|${p.status}|${toDecimal(p.amount)}|${p.reference ?? ''}`);
}

export function buildReturnUrl(db, p, base) {
  const u = new URL(base);
  u.searchParams.set('payment_id', p.id);
  u.searchParams.set('status', p.status);
  u.searchParams.set('amount', toDecimal(p.amount));
  if (p.reference) u.searchParams.set('reference', p.reference);
  u.searchParams.set('signature', returnSignature(db, p));
  return u.toString();
}

// --- Refund ----------------------------------------------------------------

export function createRefund(db, merchantId, mode, paymentId, body = {}) {
  return tx(db, () => {
    const p = getMerchantPayment(db, merchantId, mode, paymentId);
    if (!['succeeded', 'partially_refunded'].includes(p.status)) {
      throw new ApiError(409, 'invalid_state', 'Hanya bayaran yang berjaya boleh direfund.');
    }
    const remaining = p.amount - p.amount_refunded;
    const amount =
      body.amount === undefined || body.amount === null || body.amount === ''
        ? remaining
        : parseAmount(body.amount, { min: 1 });
    if (amount > remaining) throw badRequest(`Amaun refund melebihi baki boleh refund (RM${toDecimal(remaining)}).`, 'amount');
    const bal = getBalance(db, merchantId, mode);
    if (amount > bal.total_cents) {
      throw new ApiError(409, 'insufficient_balance', 'Baki akaun tidak mencukupi untuk refund ini.');
    }
    const refund = {
      id: newId('re'),
      payment_id: p.id,
      merchant_id: merchantId,
      mode,
      amount,
      reason: optionalString(body.reason, 'reason', 300),
      status: 'succeeded',
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO refunds (id, payment_id, merchant_id, mode, amount, reason, status, created_at)
       VALUES (:id, :payment_id, :merchant_id, :mode, :amount, :reason, :status, :created_at)`
    ).run(refund);
    const totalRefunded = p.amount_refunded + amount;
    db.prepare('UPDATE payments SET amount_refunded = ?, status = ? WHERE id = ?').run(
      totalRefunded,
      totalRefunded >= p.amount ? 'refunded' : 'partially_refunded',
      p.id
    );
    const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refund.id);
    emitEvent(db, merchantId, mode, 'refund.succeeded', { ...serializeRefund(r), payment_object: serializePayment(getPaymentRow(db, p.id)) });
    return r;
  });
}

export function listRefunds(db, merchantId, mode, paymentId) {
  const sql = paymentId
    ? 'SELECT * FROM refunds WHERE merchant_id = ? AND mode = ? AND payment_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM refunds WHERE merchant_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 100';
  return paymentId ? db.prepare(sql).all(merchantId, mode, paymentId) : db.prepare(sql).all(merchantId, mode);
}

// --- Baki & payout ---------------------------------------------------------

export function getBalance(db, merchantId, mode) {
  const cutoff = now() - config.settlementDays[mode] * 86400;
  const q = (sql, ...a) => db.prepare(sql).get(merchantId, mode, ...a).v ?? 0;
  const netAll = q(
    `SELECT SUM(net) v FROM payments WHERE merchant_id = ? AND mode = ? AND status IN ('succeeded','partially_refunded','refunded')`
  );
  const netSettled = q(
    `SELECT SUM(net) v FROM payments WHERE merchant_id = ? AND mode = ? AND status IN ('succeeded','partially_refunded','refunded') AND paid_at <= ?`,
    cutoff
  );
  const refunds = q(`SELECT SUM(amount) v FROM refunds WHERE merchant_id = ? AND mode = ? AND status = 'succeeded'`);
  const payouts = q(`SELECT SUM(amount) v FROM payouts WHERE merchant_id = ? AND mode = ? AND status != 'failed'`);
  const total = netAll - refunds - payouts;
  const available = Math.min(total, netSettled - refunds - payouts);
  return {
    object: 'balance',
    livemode: mode === 'live',
    currency: config.currency,
    available: toDecimal(available),
    pending: toDecimal(total - available),
    total: toDecimal(total),
    available_cents: available,
    total_cents: total,
    settlement_days: config.settlementDays[mode],
  };
}

export function createPayout(db, merchant, mode, body = {}) {
  return tx(db, () => {
    if (!merchant.bank_account_no || !merchant.bank_name || !merchant.bank_account_name) {
      throw badRequest('Sila lengkapkan maklumat akaun bank dalam Tetapan dahulu.');
    }
    const bal = getBalance(db, merchant.id, mode);
    const amount =
      body.amount === undefined || body.amount === '' ? bal.available_cents : parseAmount(body.amount, { min: 1 });
    if (amount < config.minPayout) throw badRequest(`Payout minimum ialah RM${toDecimal(config.minPayout)}.`, 'amount');
    if (amount > bal.available_cents) throw new ApiError(409, 'insufficient_balance', 'Baki tersedia tidak mencukupi.');
    const payout = {
      id: newId('po'),
      merchant_id: merchant.id,
      mode,
      amount,
      // Mod test: terus "dibayar". Mod live: menunggu pemprosesan oleh pentadbir/bank.
      status: mode === 'test' ? 'paid' : 'pending',
      bank_name: merchant.bank_name,
      bank_account_no: merchant.bank_account_no,
      bank_account_name: merchant.bank_account_name,
      created_at: now(),
      paid_at: mode === 'test' ? now() : null,
    };
    db.prepare(
      `INSERT INTO payouts (id, merchant_id, mode, amount, status, bank_name, bank_account_no, bank_account_name, created_at, paid_at)
       VALUES (:id, :merchant_id, :mode, :amount, :status, :bank_name, :bank_account_no, :bank_account_name, :created_at, :paid_at)`
    ).run(payout);
    const row = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payout.id);
    emitEvent(db, merchant.id, mode, 'payout.created', serializePayout(row));
    return row;
  });
}

// --- Payment links ---------------------------------------------------------

export function createLink(db, merchantId, mode, body) {
  const title = optionalString(body.title, 'title', 120);
  if (!title) throw badRequest('Tajuk diperlukan.', 'title');
  const amount =
    body.amount === undefined || body.amount === null || body.amount === ''
      ? null
      : parseAmount(body.amount, { min: config.minAmount, max: config.maxAmount });
  const link = {
    id: newId('plink', 14),
    merchant_id: merchantId,
    mode,
    title,
    description: optionalString(body.description, 'description', 1000),
    amount,
    redirect_url: optionalUrl(body.redirect_url, 'redirect_url'),
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO payment_links (id, merchant_id, mode, title, description, amount, redirect_url, created_at)
     VALUES (:id, :merchant_id, :mode, :title, :description, :amount, :redirect_url, :created_at)`
  ).run(link);
  return db.prepare('SELECT * FROM payment_links WHERE id = ?').get(link.id);
}

// --- Statistik dashboard ---------------------------------------------------

export function getStats(db, merchantId, mode, days = 30) {
  const since = now() - days * 86400;
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS count_all,
         SUM(CASE WHEN status IN ('succeeded','partially_refunded','refunded') THEN 1 ELSE 0 END) AS count_paid,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS count_failed,
         SUM(CASE WHEN status IN ('succeeded','partially_refunded','refunded') THEN amount ELSE 0 END) AS gross,
         SUM(CASE WHEN status IN ('succeeded','partially_refunded','refunded') THEN fee ELSE 0 END) AS fees,
         SUM(amount_refunded) AS refunded
       FROM payments WHERE merchant_id = ? AND mode = ? AND created_at >= ?`
    )
    .get(merchantId, mode, since);
  const daily = db
    .prepare(
      `SELECT date(paid_at, 'unixepoch', '+8 hours') AS day, SUM(amount) AS gross, COUNT(*) AS count
       FROM payments WHERE merchant_id = ? AND mode = ? AND paid_at >= ?
         AND status IN ('succeeded','partially_refunded','refunded')
       GROUP BY day ORDER BY day`
    )
    .all(merchantId, mode, since);
  const byMethod = db
    .prepare(
      `SELECT method, COUNT(*) AS count, SUM(amount) AS gross FROM payments
       WHERE merchant_id = ? AND mode = ? AND paid_at >= ? AND status IN ('succeeded','partially_refunded','refunded')
       GROUP BY method ORDER BY gross DESC`
    )
    .all(merchantId, mode, since);
  const attempted = (totals.count_paid ?? 0) + (totals.count_failed ?? 0);
  return {
    days,
    gross: toDecimal(totals.gross ?? 0),
    fees: toDecimal(totals.fees ?? 0),
    refunded: toDecimal(totals.refunded ?? 0),
    count_all: totals.count_all ?? 0,
    count_paid: totals.count_paid ?? 0,
    success_rate: attempted ? Math.round(((totals.count_paid ?? 0) / attempted) * 1000) / 10 : null,
    daily: daily.map((d) => ({ day: d.day, gross: toDecimal(d.gross), count: d.count })),
    by_method: byMethod.map((m) => ({ method: m.method, count: m.count, gross: toDecimal(m.gross) })),
  };
}
