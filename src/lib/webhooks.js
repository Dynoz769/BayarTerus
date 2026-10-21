import { config } from '../config.js';
import { hmac, newId, now } from './util.js';

// Tandatangan gaya "t=<timestamp>,v1=<hmac_sha256(secret, `${t}.${body}`)>".
export function signPayload(secret, body, timestamp = now()) {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${body}`)}`;
}

// Rekod event dan jadualkan penghantaran webhook jika merchant ada URL.
export function emitEvent(db, merchantId, mode, type, data) {
  const id = newId('evt');
  const ts = now();
  db.prepare('INSERT INTO events (id, merchant_id, mode, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    merchantId,
    mode,
    type,
    JSON.stringify(data),
    ts
  );
  const ep = db.prepare('SELECT url FROM webhook_endpoints WHERE merchant_id = ? AND mode = ?').get(merchantId, mode);
  if (ep?.url) {
    db.prepare(
      `INSERT INTO webhook_deliveries (id, event_id, merchant_id, mode, url, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
    ).run(newId('whd'), id, merchantId, mode, ep.url, ts, ts, ts);
    queueMicrotask(() => webhookWorker.kick());
  }
  return id;
}

export function eventPayload(evt) {
  return {
    id: evt.id,
    object: 'event',
    type: evt.type,
    livemode: evt.mode === 'live',
    created: evt.created_at,
    data: { object: JSON.parse(evt.data) },
  };
}

async function deliver(db, delivery) {
  const evt = db.prepare('SELECT * FROM events WHERE id = ?').get(delivery.event_id);
  const ep = db
    .prepare('SELECT secret FROM webhook_endpoints WHERE merchant_id = ? AND mode = ?')
    .get(delivery.merchant_id, delivery.mode);
  const body = JSON.stringify(eventPayload(evt));
  const attempts = delivery.attempts + 1;
  let statusCode = null;
  let error = null;
  let responseText = null;
  try {
    const res = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BayarTerus-Webhook/1.0',
        'BayarTerus-Signature': signPayload(ep.secret, body),
        'BayarTerus-Event': evt.type,
      },
      body,
      signal: AbortSignal.timeout(config.webhook.timeoutMs),
      redirect: 'manual',
    });
    statusCode = res.status;
    responseText = (await res.text()).slice(0, 1000);
  } catch (err) {
    error = String(err?.cause?.message || err?.message || err).slice(0, 500);
  }

  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
  let status = 'succeeded';
  let next = null;
  if (!ok) {
    const backoff = config.webhook.backoffSeconds[attempts - 1];
    if (attempts >= config.webhook.maxAttempts || backoff === undefined) status = 'failed';
    else {
      status = 'pending';
      next = now() + backoff;
    }
  }
  db.prepare(
    `UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?,
       last_error = ?, last_response = ?, updated_at = ? WHERE id = ?`
  ).run(status, attempts, next, statusCode, error, responseText, now(), delivery.id);
  return ok;
}

// Pekerja latar: hantar webhook yang tertunggak dan tamatkan bayaran lapuk.
export const webhookWorker = {
  db: null,
  timer: null,
  running: false,
  onTick: null,

  start(db, onTick) {
    this.db = db;
    this.onTick = onTick;
    this.timer = setInterval(() => this.kick(), config.webhook.pollMs);
    this.timer.unref?.();
  },

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  },

  async kick() {
    if (!this.db || this.running) return;
    this.running = true;
    try {
      this.onTick?.();
      const due = this.db
        .prepare(
          `SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY next_attempt_at LIMIT 20`
        )
        .all(now());
      await Promise.all(due.map((d) => deliver(this.db, d)));
    } catch (err) {
      console.error('[webhook]', err);
    } finally {
      this.running = false;
    }
  },
};

export function resendDelivery(db, deliveryId, merchantId, mode) {
  const d = db
    .prepare('SELECT * FROM webhook_deliveries WHERE id = ? AND merchant_id = ? AND mode = ?')
    .get(deliveryId, merchantId, mode);
  if (!d) return null;
  const ep = db.prepare('SELECT url FROM webhook_endpoints WHERE merchant_id = ? AND mode = ?').get(merchantId, mode);
  db.prepare(
    `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, url = COALESCE(?, url), updated_at = ? WHERE id = ?`
  ).run(now(), ep?.url || null, now(), d.id);
  queueMicrotask(() => webhookWorker.kick());
  return d.id;
}
