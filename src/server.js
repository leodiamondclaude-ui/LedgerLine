import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, createSession, sessionUser, destroySession, newToken, hashToken, rateLimiter, passwordProblem, SESSION_DAYS } from './auth.js';
import { billingEnabled, billingState, checkoutUrl, portalUrl, verifyWebhook, applyWebhook, TRIAL_DAYS } from './billing.js';
import { sendMail } from './mail.js';
import { readReceipt, receiptsEnabled, IN, OUT } from './receipts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const DAY = 86400000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

// ---- input checks
const str = (v, max, label, required = true) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) fail(400, `${label} is required.`);
  if (s.length > max) fail(400, `${label} must be ${max} characters or fewer.`);
  return s;
};
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v);
const date = (v, label = 'Date') => isDate(v) ? v : fail(400, `${label} must be a date like 2026-10-19.`);
const cents = (v, label = 'Amount', { allowZero = false, allowNegative = false } = {}) => {
  const n = typeof v === 'string' && v.trim() === '' ? 0 : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e10) fail(400, `${label} must be a number.`);
  const c = Math.round(n * 100);
  if (!allowNegative && c < 0) fail(400, `${label} can't be negative.`);
  if (!allowZero && c === 0) fail(400, `${label} must be more than zero.`);
  return c;
};
const email = v => {
  const e = str(v, 200, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email address.');
  return e;
};
const txType = v => v === 'in' || v === 'out' ? v : fail(400, 'Type must be money in or money out.');
const id = v => /^\d{1,15}$/.test(v) ? Number(v) : fail(404, 'Not found.');

// Spreadsheet apps run cells starting with these as formulas
const csvCell = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };

export function createApp({ db = openDb(), appUrl = process.env.APP_URL || 'http://localhost:3000' } = {}) {
  appUrl = appUrl.replace(/\/$/, '');
  const secure = appUrl.startsWith('https://');
  const appOrigin = new URL(appUrl).origin;
  const signInLimit = rateLimiter({ limit: 10, windowMs: 15 * 60000 });
  const signUpLimit = rateLimiter({ limit: 20, windowMs: 60 * 60000 });
  const receiptLimit = rateLimiter({ limit: 120, windowMs: 60 * 60000 });

  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const cookie = (name, value, maxAgeSec) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  const sessionCookie = token => cookie('ll_sid', token, SESSION_DAYS * 86400);

  const firmOf = user => one('SELECT * FROM firms WHERE id = ?', user.firm_id);
  const me = user => {
    const firm = firmOf(user);
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      firm: { id: firm.id, name: firm.name },
      billing: billingState(firm),
      receipts: receiptsEnabled(),
      categories: { in: IN, out: OUT },
    };
  };
  const requireUser = ctx => ctx.user || fail(401, 'Please sign in.');
  const requireRole = (ctx, ...roles) => { requireUser(ctx); if (!roles.includes(ctx.user.role)) fail(403, 'You don’t have access to do that.'); };
  const requireWrite = ctx => {
    requireUser(ctx);
    if (!billingState(firmOf(ctx.user)).canWrite) fail(402, 'Your free trial has ended. Choose a plan to keep adding entries.');
  };
  const company = (ctx, rawId) => {
    requireUser(ctx);
    const c = one('SELECT * FROM companies WHERE id = ? AND firm_id = ?', id(rawId), ctx.user.firm_id);
    if (!c) fail(404, 'Company not found.');
    if (ctx.user.role === 'client' && !one('SELECT 1 FROM company_access WHERE user_id = ? AND company_id = ?', ctx.user.id, c.id)) fail(404, 'Company not found.');
    return c;
  };
  const txRow = t => ({ id: t.id, date: t.date, type: t.type, category: t.category, description: t.description, amount: t.amount_cents / 100 });
  const companyRow = c => ({ id: c.id, name: c.name, label: c.label, startDate: c.start_date });
  const cleanEntry = e => ({
    date: date(e?.date), type: txType(e?.type),
    category: str(e?.category, 40, 'Category'), description: str(e?.description, 120, 'Description'),
    amount_cents: cents(e?.amount),
  });
  const insertTx = (companyId, userId, e) => run(
    'INSERT INTO transactions (company_id, date, type, category, description, amount_cents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    companyId, e.date, e.type, e.category, e.description, e.amount_cents, userId, Date.now()).lastInsertRowid;
  const signIn = (ctx, userRow) => { ctx.setCookie = sessionCookie(createSession(db, userRow.id)); return me(one('SELECT * FROM users WHERE id = ?', userRow.id)); };
  const companyIdsFor = (firmId, ids) => {
    if (!Array.isArray(ids) || !ids.length) fail(400, 'Choose at least one company this person can see.');
    return ids.map(v => { const c = one('SELECT id FROM companies WHERE id = ? AND firm_id = ?', Number(v), firmId); return c ? c.id : fail(400, 'One of those companies was not found.'); });
  };

  const routes = [
    ['GET', '/healthz', () => ({ ok: true })],
    ['GET', '/api/public', () => ({ receipts: receiptsEnabled(), billing: billingEnabled(), trialDays: TRIAL_DAYS, priceLabel: process.env.PRICE_LABEL || null })],

    // ---- accounts
    ['POST', '/api/signup', ctx => {
      if (!signUpLimit(ctx.ip)) fail(429, 'Too many sign-ups from this network. Try again later.');
      const b = ctx.body, firmName = str(b.firm, 80, 'Firm name'), name = str(b.name, 80, 'Your name'), mail = email(b.email);
      const problem = passwordProblem(b.password); if (problem) fail(400, problem);
      if (one('SELECT 1 FROM users WHERE email = ?', mail)) fail(409, 'An account with this email already exists. Sign in instead.');
      const userId = tx(() => {
        const firmId = run('INSERT INTO firms (name, created_at, trial_ends_at) VALUES (?, ?, ?)', firmName, Date.now(), Date.now() + TRIAL_DAYS * DAY).lastInsertRowid;
        return run('INSERT INTO users (firm_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', firmId, mail, name, hashPassword(b.password), 'owner', Date.now()).lastInsertRowid;
      });
      return signIn(ctx, { id: userId });
    }],
    ['POST', '/api/login', ctx => {
      const mail = email(ctx.body.email), password = String(ctx.body.password || '');
      if (!signInLimit(ctx.ip + '|' + mail)) fail(429, 'Too many sign-in attempts. Wait 15 minutes, or reset your password.');
      const u = one('SELECT * FROM users WHERE email = ?', mail);
      const ok = verifyPassword(password, u ? u.password_hash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
      if (!u || !ok) fail(401, 'Email or password is incorrect.');
      return signIn(ctx, u);
    }],
    // Passwordless sign-in: a one-time link, valid for 15 minutes
    ['POST', '/api/login-link/request', async ctx => {
      const mail = email(ctx.body.email);
      if (!signInLimit('link|' + ctx.ip)) fail(429, 'Too many requests. Try again later.');
      const u = one('SELECT * FROM users WHERE email = ?', mail);
      if (u) {
        const token = newToken();
        run('INSERT INTO tokens (token_hash, kind, firm_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)', hashToken(token), 'login', u.firm_id, u.id, Date.now() + 15 * 60000);
        await sendMail({ to: u.email, subject: 'Your Ledgerline sign-in link', text: `Sign in with this link (it works once, for 15 minutes):\n${appUrl}/?login=${token}\n\nIf you didn't ask for this, you can ignore this email.` }).catch(e => console.error(e));
      }
      return { ok: true };
    }],
    ['POST', '/api/login-link', ctx => {
      const t = one("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'login' AND expires_at > ?", hashToken(String(ctx.body.token || '')), Date.now());
      if (!t) fail(400, 'This sign-in link has expired or was already used. Ask for a new one.');
      run('DELETE FROM tokens WHERE token_hash = ?', t.token_hash);
      return signIn(ctx, { id: t.user_id });
    }],
    ['POST', '/api/logout', ctx => { if (ctx.token) destroySession(db, ctx.token); ctx.setCookie = cookie('ll_sid', '', 0); return { ok: true }; }],
    ['GET', '/api/me', ctx => me(requireUser(ctx))],
    ['POST', '/api/password', ctx => {
      requireUser(ctx);
      const u = one('SELECT * FROM users WHERE id = ?', ctx.user.id);
      if (!verifyPassword(String(ctx.body.current || ''), u.password_hash)) fail(400, 'Your current password is incorrect.');
      const problem = passwordProblem(ctx.body.next); if (problem) fail(400, problem);
      run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(ctx.body.next), u.id);
      run('DELETE FROM sessions WHERE user_id = ?', u.id);
      return signIn(ctx, u);
    }],
    ['POST', '/api/password-reset/request', async ctx => {
      const mail = email(ctx.body.email);
      if (!signInLimit('reset|' + ctx.ip)) fail(429, 'Too many requests. Try again later.');
      const u = one('SELECT * FROM users WHERE email = ?', mail);
      if (u) {
        const token = newToken();
        run('INSERT INTO tokens (token_hash, kind, firm_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)', hashToken(token), 'reset', u.firm_id, u.id, Date.now() + 3600000);
        await sendMail({ to: u.email, subject: 'Reset your Ledgerline password', text: `Use this link within an hour to choose a new password:\n${appUrl}/?reset=${token}\n\nIf you didn't ask for this, you can ignore this email.` }).catch(e => console.error(e));
      }
      return { ok: true };
    }],
    ['POST', '/api/password-reset', ctx => {
      const t = one("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'reset' AND expires_at > ?", hashToken(String(ctx.body.token || '')), Date.now());
      if (!t) fail(400, 'This reset link has expired. Ask for a new one.');
      const problem = passwordProblem(ctx.body.password); if (problem) fail(400, problem);
      tx(() => {
        run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(ctx.body.password), t.user_id);
        run('DELETE FROM sessions WHERE user_id = ?', t.user_id);
        run("DELETE FROM tokens WHERE kind = 'reset' AND user_id = ?", t.user_id);
      });
      return signIn(ctx, { id: t.user_id });
    }],

    // ---- team
    ['GET', '/api/team', ctx => {
      requireRole(ctx, 'owner', 'admin');
      const members = q('SELECT id, name, email, role FROM users WHERE firm_id = ? ORDER BY role = \'owner\' DESC, name', ctx.user.firm_id)
        .map(m => ({ ...m, companyIds: m.role === 'client' ? q('SELECT company_id FROM company_access WHERE user_id = ?', m.id).map(r => r.company_id) : null }));
      const invites = q("SELECT rowid AS id, email, role, expires_at AS expiresAt FROM tokens WHERE firm_id = ? AND kind = 'invite' AND expires_at > ?", ctx.user.firm_id, Date.now());
      return { members, invites };
    }],
    ['POST', '/api/invites', async ctx => {
      requireRole(ctx, 'owner', 'admin');
      const role = ['admin', 'member', 'client'].includes(ctx.body.role) ? ctx.body.role : fail(400, 'Choose a role.');
      if (role === 'admin' && ctx.user.role !== 'owner') fail(403, 'Only the owner can invite admins.');
      const mail = ctx.body.email ? email(ctx.body.email) : null;
      if (mail && one('SELECT 1 FROM users WHERE email = ?', mail)) fail(409, 'Someone with that email already has a Ledgerline account.');
      const ids = role === 'client' ? companyIdsFor(ctx.user.firm_id, ctx.body.companyIds) : null;
      const token = newToken();
      run('INSERT INTO tokens (token_hash, kind, firm_id, email, role, company_ids, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        hashToken(token), 'invite', ctx.user.firm_id, mail, role, ids ? JSON.stringify(ids) : null, ctx.user.id, Date.now() + 7 * DAY);
      const link = `${appUrl}/?invite=${token}`;
      let emailed = false;
      if (mail) emailed = await sendMail({ to: mail, subject: `${ctx.user.name} invited you to ${firmOf(ctx.user).name} on Ledgerline`, text: `Join here (the link works for 7 days):\n${link}` }).catch(() => false);
      return { link, emailed };
    }],
    ['DELETE', /^\/api\/invites\/(\d+)$/, (ctx, [rowid]) => {
      requireRole(ctx, 'owner', 'admin');
      run("DELETE FROM tokens WHERE rowid = ? AND firm_id = ? AND kind = 'invite'", Number(rowid), ctx.user.firm_id);
      return { ok: true };
    }],
    ['GET', /^\/api\/invite-info\/([\w-]{20,})$/, (ctx, [token]) => {
      const t = one("SELECT t.*, f.name AS firm_name FROM tokens t JOIN firms f ON f.id = t.firm_id WHERE token_hash = ? AND kind = 'invite' AND expires_at > ?", hashToken(token), Date.now());
      if (!t) fail(404, 'This invitation has expired or was already used. Ask for a new link.');
      return { firm: t.firm_name, role: t.role, email: t.email };
    }],
    ['POST', /^\/api\/invite-info\/([\w-]{20,})\/accept$/, (ctx, [token]) => {
      if (!signUpLimit(ctx.ip)) fail(429, 'Too many sign-ups from this network. Try again later.');
      const t = one("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'invite' AND expires_at > ?", hashToken(token), Date.now());
      if (!t) fail(404, 'This invitation has expired or was already used. Ask for a new link.');
      const name = str(ctx.body.name, 80, 'Your name'), mail = t.email || email(ctx.body.email);
      const problem = passwordProblem(ctx.body.password); if (problem) fail(400, problem);
      if (one('SELECT 1 FROM users WHERE email = ?', mail)) fail(409, 'An account with this email already exists. Sign in with it, or use a different email.');
      const userId = tx(() => {
        const uid = run('INSERT INTO users (firm_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', t.firm_id, mail, name, hashPassword(ctx.body.password), t.role, Date.now()).lastInsertRowid;
        for (const cid of JSON.parse(t.company_ids || '[]')) if (one('SELECT 1 FROM companies WHERE id = ? AND firm_id = ?', cid, t.firm_id)) run('INSERT INTO company_access (user_id, company_id) VALUES (?, ?)', uid, cid);
        run('DELETE FROM tokens WHERE token_hash = ?', t.token_hash);
        return uid;
      });
      return signIn(ctx, { id: userId });
    }],
    ['PATCH', /^\/api\/members\/(\d+)$/, (ctx, [mid]) => {
      requireRole(ctx, 'owner', 'admin');
      const m = one('SELECT * FROM users WHERE id = ? AND firm_id = ?', Number(mid), ctx.user.firm_id) || fail(404, 'Person not found.');
      if (m.role === 'owner') fail(403, 'The owner’s access can’t be changed.');
      const role = ctx.body.role ?? m.role;
      if (!['admin', 'member', 'client'].includes(role)) fail(400, 'Choose a role.');
      if ((role === 'admin' || m.role === 'admin') && ctx.user.role !== 'owner') fail(403, 'Only the owner can change admins.');
      const ids = role === 'client' ? companyIdsFor(ctx.user.firm_id, ctx.body.companyIds ?? q('SELECT company_id FROM company_access WHERE user_id = ?', m.id).map(r => r.company_id)) : [];
      tx(() => {
        run('UPDATE users SET role = ? WHERE id = ?', role, m.id);
        run('DELETE FROM company_access WHERE user_id = ?', m.id);
        for (const cid of ids) run('INSERT INTO company_access (user_id, company_id) VALUES (?, ?)', m.id, cid);
      });
      return { ok: true };
    }],
    ['DELETE', /^\/api\/members\/(\d+)$/, (ctx, [mid]) => {
      requireRole(ctx, 'owner', 'admin');
      const m = one('SELECT * FROM users WHERE id = ? AND firm_id = ?', Number(mid), ctx.user.firm_id) || fail(404, 'Person not found.');
      if (m.role === 'owner' || m.id === ctx.user.id) fail(403, 'You can’t remove this person.');
      if (m.role === 'admin' && ctx.user.role !== 'owner') fail(403, 'Only the owner can remove admins.');
      run('DELETE FROM users WHERE id = ?', m.id);
      return { ok: true };
    }],
    ['POST', /^\/api\/members\/(\d+)\/reset-link$/, (ctx, [mid]) => {
      requireRole(ctx, 'owner', 'admin');
      const m = one('SELECT * FROM users WHERE id = ? AND firm_id = ?', Number(mid), ctx.user.firm_id) || fail(404, 'Person not found.');
      if (m.role === 'owner' || (m.role === 'admin' && ctx.user.role !== 'owner')) fail(403, 'You can’t reset this person’s password.');
      const token = newToken();
      run('INSERT INTO tokens (token_hash, kind, firm_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)', hashToken(token), 'reset', m.firm_id, m.id, Date.now() + 24 * 3600000);
      return { link: `${appUrl}/?reset=${token}` };
    }],

    // ---- companies and ledger
    ['GET', '/api/companies', ctx => {
      requireUser(ctx);
      const rows = ctx.user.role === 'client'
        ? q('SELECT c.* FROM companies c JOIN company_access a ON a.company_id = c.id WHERE a.user_id = ? ORDER BY c.name COLLATE NOCASE', ctx.user.id)
        : q('SELECT * FROM companies WHERE firm_id = ? ORDER BY name COLLATE NOCASE', ctx.user.firm_id);
      return rows.map(companyRow);
    }],
    ['POST', '/api/companies', ctx => {
      requireRole(ctx, 'owner', 'admin', 'member'); requireWrite(ctx);
      const b = ctx.body, name = str(b.name, 60, 'Company name'), label = str(b.label, 30, 'Label', false), asOf = date(b.asOf || '', 'The "as of" date');
      const cash = cents(b.cash ?? 0, 'Cash in the bank', { allowZero: true, allowNegative: true });
      const rev = cents(b.revenueYtd ?? 0, 'Revenue so far this year', { allowZero: true }), exp = cents(b.expensesYtd ?? 0, 'Expenses so far this year', { allowZero: true });
      const id = tx(() => {
        const cid = run('INSERT INTO companies (firm_id, name, label, start_date, created_at) VALUES (?, ?, ?, ?, ?)', ctx.user.firm_id, name, label, asOf, Date.now()).lastInsertRowid;
        const jan1 = asOf.slice(0, 4) + '-01-01';
        if (rev) insertTx(cid, ctx.user.id, { date: jan1, type: 'in', category: 'Revenue before tracking', description: 'Revenue earlier this year', amount_cents: rev });
        if (exp) insertTx(cid, ctx.user.id, { date: jan1, type: 'out', category: 'Expenses before tracking', description: 'Expenses earlier this year', amount_cents: exp });
        // Opening entry makes cash on hand equal the bank balance given, after the year-to-date totals
        const ob = cash - (rev - exp);
        if (ob) insertTx(cid, ctx.user.id, { date: asOf, type: ob > 0 ? 'in' : 'out', category: 'Opening balance', description: 'Opening cash balance', amount_cents: Math.abs(ob) });
        return cid;
      });
      return companyRow(one('SELECT * FROM companies WHERE id = ?', id));
    }],
    ['PATCH', /^\/api\/companies\/(\d+)$/, (ctx, [cid]) => {
      requireRole(ctx, 'owner', 'admin', 'member'); requireWrite(ctx);
      const c = company(ctx, cid);
      const name = ctx.body.name !== undefined ? str(ctx.body.name, 60, 'Company name') : c.name;
      const label = ctx.body.label !== undefined ? str(ctx.body.label, 30, 'Label', false) : c.label;
      run('UPDATE companies SET name = ?, label = ? WHERE id = ?', name, label, c.id);
      return companyRow(one('SELECT * FROM companies WHERE id = ?', c.id));
    }],
    ['DELETE', /^\/api\/companies\/(\d+)$/, (ctx, [cid]) => {
      requireRole(ctx, 'owner', 'admin');
      run('DELETE FROM companies WHERE id = ?', company(ctx, cid).id);
      return { ok: true };
    }],
    ['GET', /^\/api\/companies\/(\d+)\/transactions$/, (ctx, [cid]) =>
      q('SELECT * FROM transactions WHERE company_id = ? ORDER BY date DESC, id DESC', company(ctx, cid).id).map(txRow)],
    ['POST', /^\/api\/companies\/(\d+)\/transactions$/, (ctx, [cid]) => {
      requireWrite(ctx);
      const c = company(ctx, cid), list = Array.isArray(ctx.body.entries) ? ctx.body.entries : [ctx.body];
      if (!list.length || list.length > 1000) fail(400, 'Send between 1 and 1000 entries at a time.');
      const clean = list.map((e, i) => { try { return cleanEntry(e); } catch (err) { fail(400, list.length > 1 ? `Row ${i + 1}: ${err.message}` : err.message); } });
      const ids = tx(() => clean.map(e => insertTx(c.id, ctx.user.id, e)));
      return ids.map(i => txRow(one('SELECT * FROM transactions WHERE id = ?', i)));
    }],
    ['PATCH', /^\/api\/transactions\/(\d+)$/, (ctx, [tid]) => {
      requireWrite(ctx);
      const t = one('SELECT * FROM transactions WHERE id = ?', id(tid)) || fail(404, 'Entry not found.');
      company(ctx, t.company_id);
      const e = cleanEntry({ ...txRow(t), ...ctx.body });
      run('UPDATE transactions SET date = ?, type = ?, category = ?, description = ?, amount_cents = ? WHERE id = ?', e.date, e.type, e.category, e.description, e.amount_cents, t.id);
      return txRow(one('SELECT * FROM transactions WHERE id = ?', t.id));
    }],
    ['DELETE', /^\/api\/transactions\/(\d+)$/, (ctx, [tid]) => {
      requireWrite(ctx);
      const t = one('SELECT * FROM transactions WHERE id = ?', id(tid)) || fail(404, 'Entry not found.');
      company(ctx, t.company_id);
      run('DELETE FROM transactions WHERE id = ?', t.id);
      return { ok: true };
    }],
    ['GET', /^\/api\/companies\/(\d+)\/export\.csv$/, (ctx, [cid]) => {
      const c = company(ctx, cid);
      const rows = q('SELECT * FROM transactions WHERE company_id = ? ORDER BY date, id', c.id);
      ctx.raw = { type: 'text/csv; charset=utf-8', filename: `${c.name.replace(/[^\w.-]+/g, '-')}-ledger.csv`,
        body: 'date,type,category,description,amount\n' + rows.map(t => [t.date, t.type, csvCell(t.category), csvCell(t.description), (t.amount_cents / 100).toFixed(2)].join(',')).join('\n') + '\n' };
    }],
    ['POST', '/api/receipts/read', async ctx => {
      requireWrite(ctx);
      if (!receiptsEnabled()) fail(503, 'Receipt reading is not set up on this server.');
      if (!receiptLimit(String(ctx.user.firm_id))) fail(429, 'Too many receipts this hour. Try again shortly.');
      const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.image || ''));
      if (!m) fail(400, 'Upload a JPEG, PNG, WebP or GIF photo.');
      try { return await readReceipt({ mediaType: m[1], data: m[2] }); }
      catch (e) { if (e.status === 422) fail(422, e.message); console.error('receipt read failed', e); fail(502, 'The receipt could not be read right now. Try again, or enter it by hand.'); }
    }],

    // ---- billing
    ['POST', '/api/billing/checkout', async ctx => {
      requireRole(ctx, 'owner');
      if (!billingEnabled()) fail(400, 'Billing is not set up on this server.');
      return { url: await checkoutUrl(db, firmOf(ctx.user), ctx.user, appUrl) };
    }],
    ['POST', '/api/billing/portal', async ctx => {
      requireRole(ctx, 'owner');
      if (!billingEnabled()) fail(400, 'Billing is not set up on this server.');
      return { url: await portalUrl(firmOf(ctx.user), appUrl) };
    }],
    ['POST', '/api/stripe/webhook', ctx => {
      const event = verifyWebhook(ctx.rawBody, ctx.req.headers['stripe-signature']);
      if (!event) fail(400, 'Invalid signature.');
      applyWebhook(db, event);
      return { received: true };
    }],
  ];

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const headers = extra => ({
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}), ...extra,
  });

  function serveStatic(req, res, pathname) {
    let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    const ext = path.extname(file);
    res.writeHead(200, headers({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers()); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    const send = (status, body, extra = {}) => { res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra })); res.end(JSON.stringify(body)); };
    try {
      const route = routes.find(([m, p]) => m === req.method && (typeof p === 'string' ? p === pathname : p.test(pathname)));
      if (!route) fail(404, 'Not found.');
      const [, pattern, handler] = route;
      const params = typeof pattern === 'string' ? [] : pattern.exec(pathname).slice(1);
      const webhook = pathname === '/api/stripe/webhook';
      // Cross-site requests can't set this header without a CORS preflight, which this server never approves
      if (req.method !== 'GET' && !webhook) {
        if (req.headers['x-ledgerline'] !== '1') fail(403, 'Request blocked.');
        if (req.headers.origin && req.headers.origin !== appOrigin) fail(403, 'Request blocked.');
      }
      const rawBody = req.method === 'GET' ? '' : await readBody(req, pathname === '/api/receipts/read' ? 8e6 : webhook ? 1e6 : 2e6);
      let body = {};
      if (rawBody && !webhook) { try { body = JSON.parse(rawBody); } catch { fail(400, 'Malformed request.'); } }
      if (!body || typeof body !== 'object') body = {};
      const token = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('ll_sid='))?.slice(7) || null;
      const ctx = { req, body, rawBody, token, user: sessionUser(db, token), ip: req.socket.remoteAddress || '' };
      if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) ctx.ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
      const result = await handler(ctx, params);
      const extra = ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {};
      if (ctx.raw) {
        res.writeHead(200, headers({ 'Content-Type': ctx.raw.type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${ctx.raw.filename}"`, ...extra }));
        return res.end(ctx.raw.body);
      }
      send(200, result ?? { ok: true }, extra);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Something went wrong on our side. Try again.' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`Ledgerline running at ${process.env.APP_URL || `http://localhost:${port}`}`));
}
