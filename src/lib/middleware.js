import { ApiError } from './util.js';

// Had kadar ringkas dalam memori (tetingkap tetap). Untuk berbilang instans,
// gantikan dengan Redis.
export function rateLimit({ windowMs = 60_000, max = 100, key = (req) => req.ip } = {}) {
  const hits = new Map();
  const timer = setInterval(() => hits.clear(), windowMs);
  timer.unref?.();
  return (req, res, next) => {
    const k = key(req);
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - n)));
    if (n > max) throw new ApiError(429, 'rate_limited', 'Terlalu banyak permintaan. Cuba sebentar lagi.');
    next();
  };
}

export function openCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, param: err.param } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Badan permintaan bukan JSON yang sah.' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'Badan permintaan terlalu besar.' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'server_error', message: 'Ralat dalaman pelayan.' } });
}
