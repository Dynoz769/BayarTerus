import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  business_name TEXT NOT NULL,
  website TEXT,
  support_email TEXT,
  brand_color TEXT NOT NULL DEFAULT '#0f766e',
  allowed_domains TEXT NOT NULL DEFAULT '',
  allow_client_amount INTEGER NOT NULL DEFAULT 1,
  bank_name TEXT,
  bank_account_no TEXT,
  bank_account_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  mode TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE,
  secret_last4 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, mode)
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  mode TEXT NOT NULL,
  url TEXT,
  secret TEXT NOT NULL,
  PRIMARY KEY (merchant_id, mode)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (merchant_id, mode, email)
);

CREATE TABLE IF NOT EXISTS payment_links (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  amount INTEGER,
  redirect_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  reference TEXT,
  customer_id TEXT,
  customer_email TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  method TEXT,
  method_detail TEXT,
  fee INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL DEFAULT 0,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  return_url TEXT,
  cancel_url TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  link_id TEXT,
  source TEXT NOT NULL DEFAULT 'api',
  failure_reason TEXT,
  client_secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(merchant_id, mode, reference);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  amount INTEGER NOT NULL,
  fee_returned INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  bank_name TEXT,
  bank_account_no TEXT,
  bank_account_name TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status_code INTEGER,
  last_error TEXT,
  last_response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  key TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, mode, key)
);
`;

export function openDb(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// Jalankan fn dalam satu transaksi SQLite.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
