// Contoh penerima webhook untuk merchant (tanpa dependency).
//   BAYARTERUS_WEBHOOK_SECRET=whsec_xxx node examples/webhook-receiver.js
// Kemudian tetapkan URL webhook di dashboard kepada http://localhost:4000/webhook
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = process.env.BAYARTERUS_WEBHOOK_SECRET;
if (!SECRET) throw new Error('Tetapkan BAYARTERUS_WEBHOOK_SECRET');

function verify(header, body) {
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
  const expected = crypto.createHmac('sha256', SECRET).update(`${parts.t}.${body}`).digest('hex');
  const ok = parts.v1?.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  return ok && Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
}

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') return res.writeHead(404).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!verify(req.headers['bayarterus-signature'], body)) return res.writeHead(400).end('tandatangan tidak sah');
      const event = JSON.parse(body);
      const obj = event.data.object;
      console.log(`[${event.type}]`, obj.id, obj.status ?? '', obj.amount ?? '', obj.reference ?? '');
      if (event.type === 'payment.succeeded') {
        // TODO: cari pesanan obj.reference, semak obj.amount sama, tandakan DIBAYAR.
      }
      res.writeHead(200).end('ok');
    });
  })
  .listen(4000, () => console.log('Penerima webhook di http://localhost:4000/webhook'));
