import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { errorHandler } from './lib/middleware.js';
import { expireStalePayments } from './lib/service.js';
import { webhookWorker } from './lib/webhooks.js';
import { apiRouter } from './routes/api.js';
import { checkoutRouter } from './routes/checkout.js';
import { dashboardRouter } from './routes/dashboard.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Halaman checkout perlu boleh dibuka dalam iframe di laman merchant (modal embed).
    const embeddable = /^\/(pay|sim|l)\//.test(req.path);
    res.set('Content-Security-Policy', `frame-ancestors ${embeddable ? '*' : "'self'"}`);
    next();
  });

  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  app.use('/v1', apiRouter(db));
  app.use('/checkout/api', checkoutRouter(db));
  app.use('/dashboard/api', dashboardRouter(db));

  const page = (file) => (_req, res) => res.sendFile(path.join(PUBLIC, file));
  app.get('/pay/:id', page('checkout.html'));
  app.get('/sim/:id', page('sim.html'));
  app.get('/l/:id', page('link.html'));
  app.get('/receipt/:id', page('receipt.html'));
  app.get('/dashboard', page('dashboard.html'));
  app.get('/login', page('login.html'));
  app.get('/register', page('register.html'));
  app.get('/docs', page('docs.html'));
  app.get('/demo', page('demo.html'));

  // Skrip embed boleh dimuatkan dari mana-mana domain.
  app.get('/js/bayarterus.js', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(PUBLIC, 'js', 'bayarterus.js'));
  });

  app.use(express.static(PUBLIC, { extensions: ['html'] }));
  app.use(errorHandler);
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const app = createApp(db);
  webhookWorker.start(db, () => expireStalePayments(db));
  app.listen(config.port, () => {
    console.log(`BayarTerus berjalan di ${config.baseUrl}`);
    console.log(`  Dashboard: ${config.baseUrl}/dashboard   Dokumentasi: ${config.baseUrl}/docs   Demo: ${config.baseUrl}/demo`);
  });
}
