import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { webhookWorker } from '../src/lib/webhooks.js';

let server;
let base;
let db;
let cookie;
let sk;
let pk;
let hook;
const received = [];

async function req(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

const dash = (path, opts = {}) =>
  req(`/dashboard/api${path}`, { ...opts, headers: { Cookie: cookie, 'X-Requested-With': 'BayarTerus', ...(opts.headers || {}) } });
const v1 = (path, opts = {}) => req(`/v1${path}`, { ...opts, headers: { Authorization: `Bearer ${sk}`, ...(opts.headers || {}) } });

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  webhookWorker.db = db;

  hook = http.createServer((r, s) => {
    let data = '';
    r.on('data', (c) => (data += c));
    r.on('end', () => {
      received.push({ headers: r.headers, body: data });
      s.end('ok');
    });
  }).listen(0);

  const reg = await req('/dashboard/api/auth/register', {
    method: 'POST',
    body: { email: 'kedai@contoh.com', password: 'rahsia123', business_name: 'Kedai Ujian' },
  });
  assert.equal(reg.status, 201);
  cookie = reg.headers.get('set-cookie').split(';')[0];
  sk = reg.body.secret_keys.test;
  pk = (await dash('/keys')).body.public_key;
});

after(() => {
  server.close();
  hook.close();
  webhookWorker.db = null;
});

test('kunci API: sk tidak sah ditolak, pk dalam format betul', async () => {
  assert.match(pk, /^pk_test_/);
  const bad = await req('/v1/payments', { headers: { Authorization: 'Bearer sk_test_salah' } });
  assert.equal(bad.status, 401);
});

test('dashboard memerlukan header CSRF untuk POST', async () => {
  const r = await req('/dashboard/api/links', { method: 'POST', headers: { Cookie: cookie }, body: { title: 'x' } });
  assert.equal(r.status, 403);
});

test('cipta bayaran, idempotency, bayar dengan kad, caj dikira, webhook ditandatangani', async () => {
  const url = `http://127.0.0.1:${hook.address().port}/hook`;
  assert.equal((await dash('/webhook', { method: 'PUT', body: { url } })).status, 200);
  const secret = (await dash('/webhook')).body.secret;

  const body = { amount: '100.00', description: 'Pesanan 1', reference: 'ORD-1', customer: { email: 'ali@contoh.com' }, return_url: 'https://kedai.test/ok' };
  const a = await v1('/payments', { method: 'POST', body, headers: { 'Idempotency-Key': 'k1' } });
  const b = await v1('/payments', { method: 'POST', body, headers: { 'Idempotency-Key': 'k1' } });
  assert.equal(a.status, 201);
  assert.equal(a.body.id, b.body.id);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(a.body.status, 'pending');
  assert.match(a.body.checkout_url, /\/pay\/pay_/);

  const declined = await req(`/checkout/api/payments/${a.body.id}/pay`, {
    method: 'POST',
    body: { method: 'card', card_number: '4000000000000002', exp_month: '12', exp_year: '2099', cvc: '123', email: 'ali@contoh.com' },
  });
  assert.equal(declined.body.payment.status, 'failed');

  const paid = await req(`/checkout/api/payments/${a.body.id}/pay`, {
    method: 'POST',
    body: { method: 'card', card_number: '4242 4242 4242 4242', exp_month: '12', exp_year: '99', cvc: '123', email: 'ali@contoh.com' },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.payment.status, 'succeeded');

  const p = (await v1(`/payments/${a.body.id}`)).body;
  assert.equal(p.fee, '2.20');
  assert.equal(p.net, '97.80');
  assert.equal(p.payment_method.detail, 'visa •••• 4242');
  assert.ok(p.customer.id.startsWith('cus_'));

  const again = await req(`/checkout/api/payments/${a.body.id}/pay`, {
    method: 'POST',
    body: { method: 'card', card_number: '4242424242424242', exp_month: '12', exp_year: '99', cvc: '123' },
  });
  assert.equal(again.status, 409);

  await webhookWorker.kick();
  const succ = received.find((r) => JSON.parse(r.body).type === 'payment.succeeded');
  assert.ok(succ, 'webhook payment.succeeded diterima');
  const sig = Object.fromEntries(succ.headers['bayarterus-signature'].split(',').map((x) => x.split('=')));
  const expected = crypto.createHmac('sha256', secret).update(`${sig.t}.${succ.body}`).digest('hex');
  assert.equal(sig.v1, expected);

  const ret = await req(`/checkout/api/payments/${a.body.id}/return`);
  const u = new URL(ret.body.url);
  assert.equal(u.searchParams.get('status'), 'succeeded');
  const data = `${u.searchParams.get('payment_id')}|succeeded|100.00|ORD-1`;
  assert.equal(u.searchParams.get('signature'), crypto.createHmac('sha256', secret).update(data).digest('hex'));
});

test('refund separa dan penuh, baki dan payout', async () => {
  const { body: list } = await v1('/payments?status=succeeded');
  const id = list.data[0].id;
  const r1 = await v1(`/payments/${id}/refunds`, { method: 'POST', body: { amount: '10.00', reason: 'rosak' } });
  assert.equal(r1.status, 201);
  assert.equal((await v1(`/payments/${id}`)).body.status, 'partially_refunded');
  const tooMuch = await v1(`/payments/${id}/refunds`, { method: 'POST', body: { amount: '95.00' } });
  assert.equal(tooMuch.status, 400);

  const bal = (await v1('/balance')).body;
  assert.equal(bal.available, '87.80');

  const noBank = await v1('/payouts', { method: 'POST', body: {} });
  assert.equal(noBank.status, 400);
  await dash('/settings', { method: 'PUT', body: { bank_name: 'Maybank', bank_account_no: '1234567890', bank_account_name: 'Kedai Ujian' } });
  const po = await v1('/payouts', { method: 'POST', body: { amount: '50.00' } });
  assert.equal(po.status, 201);
  assert.equal((await v1('/balance')).body.available, '37.80');
  const over = await v1('/payouts', { method: 'POST', body: { amount: '50.00' } });
  assert.equal(over.status, 409);
});

test('embed dengan kunci awam + sekatan domain + amaun pelayar dimatikan', async () => {
  const ok = await req('/v1/embed/payments', { method: 'POST', body: { key: pk, amount: '12.50', description: 'Butang' } });
  assert.equal(ok.status, 201);
  assert.match(ok.body.checkout_url, /\/pay\//);

  await dash('/settings', { method: 'PUT', body: { allowed_domains: 'kedaisaya.com' } });
  const blocked = await req('/v1/embed/payments', { method: 'POST', body: { key: pk, amount: '1.00' }, headers: { Origin: 'https://jahat.com' } });
  assert.equal(blocked.status, 403);
  const sub = await req('/v1/embed/payments', { method: 'POST', body: { key: pk, amount: '1.00' }, headers: { Origin: 'https://www.kedaisaya.com' } });
  assert.equal(sub.status, 201);

  const link = (await dash('/links', { method: 'POST', body: { title: 'Yuran', amount: '30.00' } })).body;
  await dash('/settings', { method: 'PUT', body: { allow_client_amount: false } });
  const h = { Origin: 'https://kedaisaya.com' };
  const denied = await req('/v1/embed/payments', { method: 'POST', body: { key: pk, amount: '1.00' }, headers: h });
  assert.equal(denied.status, 403);
  const viaLink = await req('/v1/embed/payments', { method: 'POST', body: { key: pk, link: link.id, amount: '0.01' }, headers: h });
  assert.equal(viaLink.status, 201);
  const p = (await v1(`/payments/${viaLink.body.id}`)).body;
  assert.equal(p.amount, '30.00', 'amaun pautan tidak boleh diubah oleh pelayar');
  await dash('/settings', { method: 'PUT', body: { allowed_domains: '', allow_client_amount: true } });
});

test('aliran FPX melalui bank simulasi', async () => {
  const p = (await v1('/payments', { method: 'POST', body: { amount: '20.00' } })).body;
  const r = await req(`/checkout/api/payments/${p.id}/pay`, { method: 'POST', body: { method: 'fpx', bank: 'MBB0228', email: 'abu@contoh.com' } });
  assert.equal(r.body.payment.status, 'processing');
  assert.match(r.body.next_action.url, /\/sim\//);
  const done = await req(`/checkout/api/payments/${p.id}/simulate`, { method: 'POST', body: { approve: true } });
  assert.equal(done.body.payment.status, 'succeeded');
  assert.equal((await v1(`/payments/${p.id}`)).body.fee, '1.00');
});

test('pautan bayaran dengan amaun pelanggan', async () => {
  const link = (await v1('/payment_links', { method: 'POST', body: { title: 'Sumbangan' } })).body;
  assert.equal(link.customer_chooses_amount, true);
  const low = await req(`/checkout/api/links/${link.id}`, { method: 'POST', body: { amount: '0.50', email: 'a@b.com' } });
  assert.equal(low.status, 400);
  const ok = await req(`/checkout/api/links/${link.id}`, { method: 'POST', body: { amount: '15', email: 'a@b.com' } });
  assert.equal(ok.status, 201);
});

test('validasi input', async () => {
  for (const amount of ['abc', '-5', '1.234', '0.50', '99999999']) {
    const r = await v1('/payments', { method: 'POST', body: { amount } });
    assert.equal(r.status, 400, `amaun ${amount}`);
  }
  const r = await v1('/payments', { method: 'POST', body: { amount: '5', return_url: 'javascript:alert(1)' } });
  assert.equal(r.status, 400);
});

test('mod live ditolak tanpa pemproses berlesen', async () => {
  const reg = await req('/dashboard/api/auth/register', {
    method: 'POST',
    body: { email: 'live@contoh.com', password: 'rahsia123', business_name: 'Live' },
  });
  const p = (await req('/v1/payments', { method: 'POST', body: { amount: '5.00' }, headers: { Authorization: `Bearer ${reg.body.secret_keys.live}` } })).body;
  assert.equal(p.livemode, true);
  const r = await req(`/checkout/api/payments/${p.id}/pay`, {
    method: 'POST',
    body: { method: 'card', card_number: '4242424242424242', exp_month: '12', exp_year: '99', cvc: '123' },
  });
  assert.equal(r.status, 503);
});

test('eksport CSV dan pengasingan merchant', async () => {
  const csv = await dash('/payments.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /id,tarikh,status/);

  const other = await req('/dashboard/api/auth/register', {
    method: 'POST',
    body: { email: 'lain@contoh.com', password: 'rahsia123', business_name: 'Lain' },
  });
  const mine = (await v1('/payments')).body.data[0].id;
  const r = await req(`/v1/payments/${mine}`, { headers: { Authorization: `Bearer ${other.body.secret_keys.test}` } });
  assert.equal(r.status, 404);
});
