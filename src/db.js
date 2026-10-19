import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file = process.env.DATABASE_PATH || 'data/ledgerline.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS firms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      trial_ends_at INTEGER NOT NULL,
      stripe_customer_id TEXT,
      subscription_status TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','member','client')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('invite','reset','login')),
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      email TEXT,
      role TEXT,
      company_ids TEXT,
      created_by INTEGER,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      start_date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS companies_firm ON companies(firm_id);
    CREATE TABLE IF NOT EXISTS company_access (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, company_id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('in','out')),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tx_company ON transactions(company_id, date);
  `);
  return db;
}
