// Penjana snippet integrasi. Digunakan oleh dashboard (dengan kunci sebenar
// merchant) dan halaman dokumentasi (dengan kunci contoh).
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const Snippets = {
  button({ base, pk, amount = '25.00', description = 'Produk saya', label, returnUrl, redirect, reference }) {
    const attrs = [`data-amount="${attr(amount)}"`, `data-description="${attr(description)}"`];
    if (reference) attrs.push(`data-reference="${attr(reference)}"`);
    if (returnUrl) attrs.push(`data-return-url="${attr(returnUrl)}"`);
    if (redirect) attrs.push('data-redirect="true"');
    return `<!-- BayarTerus: tampal sekali sahaja dalam halaman -->
<script src="${base}/js/bayarterus.js" data-key="${pk}"></script>

<!-- Butang bayar -->
<button data-bayarterus
        ${attrs.join('\n        ')}>
  ${attr(label || `Bayar RM${amount}`)}
</button>`;
  },

  link({ base, pk, linkId, label = 'Bayar sekarang' }) {
    return `<script src="${base}/js/bayarterus.js" data-key="${pk}"></script>

<button data-bayarterus data-link="${attr(linkId)}">${attr(label)}</button>`;
  },

  form({ base, pk, description = 'Sumbangan' }) {
    return `<script src="${base}/js/bayarterus.js" data-key="${pk}"></script>

<form data-bayarterus data-description="${attr(description)}">
  <input name="name" placeholder="Nama" required>
  <input name="email" type="email" placeholder="Emel" required>
  <input name="amount" placeholder="Amaun (RM)" inputmode="decimal" required>
  <button type="submit">Bayar</button>
</form>`;
  },

  jsApi({ base, pk }) {
    return `<script src="${base}/js/bayarterus.js" data-key="${pk}"></script>
<script>
  // Panggil dari kod anda sendiri (cth. selepas troli disahkan)
  async function checkout() {
    const result = await BayarTerus.pay({
      amount: '49.90',
      description: 'Pesanan #1001',
      reference: 'ORDER-1001',
      email: 'pelanggan@contoh.com',
    });
    if (result.status === 'succeeded') {
      // Paparkan terima kasih. PENTING: sahkan juga melalui webhook
      // atau GET /v1/payments/{id} di pelayan sebelum hantar barang.
      alert('Terima kasih! ID bayaran: ' + result.payment_id);
    }
  }

  // Atau dengar event global:
  document.addEventListener('bayarterus:success', (e) => console.log('Berjaya', e.detail));
  document.addEventListener('bayarterus:failed', (e) => console.log('Gagal', e.detail));
  document.addEventListener('bayarterus:close', (e) => console.log('Ditutup', e.detail));
</script>`;
  },

  curl({ base, sk = 'sk_test_KUNCI_RAHSIA' }) {
    return `curl ${base}/v1/payments \\
  -H "Authorization: Bearer ${sk}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1001" \\
  -d '{
    "amount": "49.90",
    "description": "Pesanan #1001",
    "reference": "ORDER-1001",
    "customer": { "email": "pelanggan@contoh.com", "name": "Ali" },
    "return_url": "https://kedai-anda.com/terima-kasih",
    "metadata": { "order_id": "1001" }
  }'

# Respons mengandungi "checkout_url" — redirect pelanggan ke URL itu.`;
  },

  node({ base, sk = 'sk_test_KUNCI_RAHSIA' }) {
    return `// Node.js 18+ (fetch terbina dalam)
const BAYARTERUS_KEY = process.env.BAYARTERUS_SECRET_KEY; // ${sk}

async function createPayment(order) {
  const res = await fetch('${base}/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${BAYARTERUS_KEY}\`,
      'Content-Type': 'application/json',
      'Idempotency-Key': \`order-\${order.id}\`,
    },
    body: JSON.stringify({
      amount: order.total,            // "49.90"
      description: \`Pesanan #\${order.id}\`,
      reference: String(order.id),
      customer: { email: order.email },
      return_url: 'https://kedai-anda.com/terima-kasih',
    }),
  });
  const payment = await res.json();
  if (!res.ok) throw new Error(payment.error.message);
  return payment.checkout_url; // redirect pelanggan ke sini
}`;
  },

  php({ base, sk = 'sk_test_KUNCI_RAHSIA' }) {
    return `<?php
$key = getenv('BAYARTERUS_SECRET_KEY'); // ${sk}

$ch = curl_init('${base}/v1/payments');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    "Authorization: Bearer $key",
    'Content-Type: application/json',
    'Idempotency-Key: order-1001',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'amount' => '49.90',
    'description' => 'Pesanan #1001',
    'reference' => '1001',
    'customer' => ['email' => 'pelanggan@contoh.com'],
    'return_url' => 'https://kedai-anda.com/terima-kasih.php',
  ]),
]);
$payment = json_decode(curl_exec($ch), true);
header('Location: ' . $payment['checkout_url']);`;
  },

  webhookNode({ secret = 'whsec_RAHSIA_WEBHOOK' }) {
    return `// Express — sahkan tandatangan webhook BayarTerus
import crypto from 'node:crypto';
import express from 'express';

const WEBHOOK_SECRET = process.env.BAYARTERUS_WEBHOOK_SECRET; // ${secret}
const app = express();

app.post('/webhook/bayarterus', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.get('BayarTerus-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(\`\${parts.t}.\${req.body}\`)
    .digest('hex');

  const valid = parts.v1 && parts.v1.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  if (!valid || !fresh) return res.status(400).send('Tandatangan tidak sah');

  const event = JSON.parse(req.body);
  if (event.type === 'payment.succeeded') {
    const payment = event.data.object;
    // Tandakan pesanan payment.reference sebagai DIBAYAR (semak amaun!)
  }
  res.sendStatus(200);
});`;
  },

  webhookPhp({ secret = 'whsec_RAHSIA_WEBHOOK' }) {
    return `<?php
$secret = getenv('BAYARTERUS_WEBHOOK_SECRET'); // ${secret}
$body = file_get_contents('php://input');
parse_str(str_replace(',', '&', $_SERVER['HTTP_BAYARTERUS_SIGNATURE'] ?? ''), $sig);

$expected = hash_hmac('sha256', $sig['t'] . '.' . $body, $secret);
if (!hash_equals($expected, $sig['v1'] ?? '') || abs(time() - (int)$sig['t']) > 300) {
  http_response_code(400);
  exit('Tandatangan tidak sah');
}

$event = json_decode($body, true);
if ($event['type'] === 'payment.succeeded') {
  $payment = $event['data']['object'];
  // Tandakan pesanan $payment['reference'] sebagai DIBAYAR
}
http_response_code(200);`;
  },

  returnVerify({ secret = 'whsec_RAHSIA_WEBHOOK' }) {
    return `<?php
// Halaman return_url anda: sahkan parameter tidak diubah oleh pelanggan.
$secret = getenv('BAYARTERUS_WEBHOOK_SECRET'); // ${secret}
$data = $_GET['payment_id'] . '|' . $_GET['status'] . '|' . $_GET['amount'] . '|' . ($_GET['reference'] ?? '');
$ok = hash_equals(hash_hmac('sha256', $data, $secret), $_GET['signature'] ?? '');

if ($ok && $_GET['status'] === 'succeeded') {
  echo 'Terima kasih! Bayaran diterima.';
}`;
  },
};
window.Snippets = Snippets;
