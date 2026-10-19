import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';

let server, base, db;
before(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_PRICE_ID = 'price_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  db = openDb(':memory:');
  server = createApp({ db, appUrl: 'http://localhost' }).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// A tiny browser: keeps its own session cookie
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Ledgerline': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get cookie() { return cookie; } };
}
let n = 0;
async function firm(name = 'Firm') {
  const c = client(); n++;
  const r = await c.call('POST', '/api/signup', { firm: name, name: 'Owner ' + n, email: `owner${n}@example.com`, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('sign up, sign out, sign in, wrong password', async () => {
  const c = await firm('Acme Accounting');
  const me = await c.call('GET', '/api/me');
  assert.equal(me.data.firm.name, 'Acme Accounting');
  assert.equal(me.data.user.role, 'owner');
  assert.equal(me.data.billing.inTrial, true);
  const email = me.data.user.email;
  await c.call('POST', '/api/logout');
  assert.equal((await c.call('GET', '/api/me')).status, 401);
  assert.equal((await c.call('POST', '/api/login', { email, password: 'wrong password!!' })).status, 401);
  const ok = await c.call('POST', '/api/login', { email: email.toUpperCase(), password: 'correct horse battery' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
});

test('duplicate email and weak password are rejected', async () => {
  const c = client();
  assert.equal((await c.call('POST', '/api/signup', { firm: 'X', name: 'Y', email: 'owner1@example.com', password: 'correct horse battery' })).status, 409);
  assert.equal((await c.call('POST', '/api/signup', { firm: 'X', name: 'Y', email: 'new@example.com', password: 'short' })).status, 400);
});

test('company setup creates opening entries that match the bank balance', async () => {
  const c = await firm();
  const co = (await c.call('POST', '/api/companies', { name: 'Bakery', label: 'Retail', asOf: '2026-10-19', cash: 10000, revenueYtd: 40000, expensesYtd: 31000 })).data;
  const tx = (await c.call('GET', `/api/companies/${co.id}/transactions`)).data;
  const cash = tx.reduce((s, t) => s + (t.type === 'in' ? t.amount : -t.amount), 0);
  assert.equal(cash, 10000);
  assert.deepEqual(tx.map(t => t.category).sort(), ['Expenses before tracking', 'Opening balance', 'Revenue before tracking']);
});

test('one firm cannot see or change another firm’s books', async () => {
  const a = await firm('A'), b = await firm('B');
  const co = (await a.call('POST', '/api/companies', { name: 'Secret Co', asOf: '2026-10-01', cash: 500 })).data;
  const [t] = (await a.call('GET', `/api/companies/${co.id}/transactions`)).data;
  assert.equal((await b.call('GET', `/api/companies/${co.id}/transactions`)).status, 404);
  assert.equal((await b.call('PATCH', `/api/transactions/${t.id}`, { amount: 1 })).status, 404);
  assert.equal((await b.call('DELETE', `/api/companies/${co.id}`)).status, 404);
  assert.deepEqual((await b.call('GET', '/api/companies')).data, []);
});

test('entries are validated and edited', async () => {
  const c = await firm();
  const co = (await c.call('POST', '/api/companies', { name: 'Co', asOf: '2026-10-01' })).data;
  const bad = await c.call('POST', `/api/companies/${co.id}/transactions`, { date: '2026-10-01<img src=x onerror=alert(1)>', type: 'out', category: 'Rent', description: 'x', amount: 5 });
  assert.equal(bad.status, 400);
  assert.equal((await c.call('POST', `/api/companies/${co.id}/transactions`, { date: '2026-02-30', type: 'out', category: 'Rent', description: 'x', amount: 5 })).status, 400);
  assert.equal((await c.call('POST', `/api/companies/${co.id}/transactions`, { date: '2026-10-02', type: 'out', category: 'Rent', description: 'x', amount: -5 })).status, 400);
  const [t] = (await c.call('POST', `/api/companies/${co.id}/transactions`, { date: '2026-10-02', type: 'out', category: 'Rent', description: 'Office', amount: '1200.555' })).data;
  assert.equal(t.amount, 1200.56);
  const e = await c.call('PATCH', `/api/transactions/${t.id}`, { amount: 1250, description: 'Office rent' });
  assert.equal(e.data.amount, 1250); assert.equal(e.data.description, 'Office rent');
  const batch = await c.call('POST', `/api/companies/${co.id}/transactions`, { entries: [{ date: '2026-10-03', type: 'in', category: 'Sales', description: 'A', amount: 10 }, { date: 'nope', type: 'in', category: 'Sales', description: 'B', amount: 10 }] });
  assert.equal(batch.status, 400); assert.match(batch.data.error, /^Row 2:/);
  assert.equal((await c.call('GET', `/api/companies/${co.id}/transactions`)).data.length, 1, 'failed batch adds nothing');
});

test('CSV export neutralizes spreadsheet formulas', async () => {
  const c = await firm();
  const co = (await c.call('POST', '/api/companies', { name: 'Co', asOf: '2026-10-01' })).data;
  await c.call('POST', `/api/companies/${co.id}/transactions`, { date: '2026-10-02', type: 'out', category: 'Rent', description: '=HYPERLINK("http://evil")', amount: 5 });
  const csv = (await c.call('GET', `/api/companies/${co.id}/export.csv`)).data;
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
});

test('requests without the app header or from another site are blocked', async () => {
  const c = await firm();
  assert.equal((await c.call('POST', '/api/companies', { name: 'X', asOf: '2026-10-01' }, { 'X-Ledgerline': '' })).status, 403);
  assert.equal((await c.call('POST', '/api/companies', { name: 'X', asOf: '2026-10-01' }, { Origin: 'https://evil.example' })).status, 403);
});

test('invites: staff see everything, clients only their companies', async () => {
  const owner = await firm('Invite Firm');
  const a = (await owner.call('POST', '/api/companies', { name: 'Alpha', asOf: '2026-10-01' })).data;
  const b = (await owner.call('POST', '/api/companies', { name: 'Beta', asOf: '2026-10-01' })).data;
  const inv = (await owner.call('POST', '/api/invites', { role: 'client', companyIds: [a.id] })).data;
  const token = new URL(inv.link).searchParams.get('invite');
  const anon = client();
  assert.equal((await anon.call('GET', `/api/invite-info/${token}`)).data.firm, 'Invite Firm');
  const joined = await anon.call('POST', `/api/invite-info/${token}/accept`, { name: 'Client', email: 'client@example.com', password: 'another good password' });
  assert.equal(joined.data.user.role, 'client');
  assert.deepEqual((await anon.call('GET', '/api/companies')).data.map(c => c.name), ['Alpha']);
  assert.equal((await anon.call('GET', `/api/companies/${b.id}/transactions`)).status, 404);
  assert.equal((await anon.call('POST', '/api/companies', { name: 'Z', asOf: '2026-10-01' })).status, 403);
  assert.equal((await anon.call('GET', '/api/team')).status, 403);
  assert.equal((await client().call('POST', `/api/invite-info/${token}/accept`, { name: 'Again', email: 'again@example.com', password: 'another good password' })).status, 404, 'invite is single use');
  const team = (await owner.call('GET', '/api/team')).data;
  assert.equal(team.members.length, 2);
});

test('password reset link signs in once and old sessions end', async () => {
  const owner = await firm();
  const staffInv = (await owner.call('POST', '/api/invites', { role: 'member' })).data;
  const staff = client();
  const joined = await staff.call('POST', `/api/invite-info/${new URL(staffInv.link).searchParams.get('invite')}/accept`, { name: 'Sam', email: 'sam@example.com', password: 'sams first password' });
  const link = (await owner.call('POST', `/api/members/${joined.data.user.id}/reset-link`)).data.link;
  const token = new URL(link).searchParams.get('reset');
  const other = client();
  assert.equal((await other.call('POST', '/api/password-reset', { token, password: 'sams new password' })).status, 200);
  assert.equal((await staff.call('GET', '/api/me')).status, 401, 'old session ended');
  assert.equal((await other.call('POST', '/api/password-reset', { token, password: 'again again again' })).status, 400, 'link used up');
  assert.equal((await client().call('POST', '/api/login', { email: 'sam@example.com', password: 'sams new password' })).status, 200);
});

test('after the trial, books are read-only until a plan is active', async () => {
  const c = await firm();
  const co = (await c.call('POST', '/api/companies', { name: 'Co', asOf: '2026-10-01', cash: 100 })).data;
  const firmId = (await c.call('GET', '/api/me')).data.firm.id;
  db.prepare('UPDATE firms SET trial_ends_at = ? WHERE id = ?').run(Date.now() - 1000, firmId);
  assert.equal((await c.call('GET', `/api/companies/${co.id}/transactions`)).status, 200);
  assert.equal((await c.call('POST', `/api/companies/${co.id}/transactions`, { date: '2026-10-02', type: 'out', category: 'Rent', description: 'x', amount: 5 })).status, 402);
  db.prepare('UPDATE firms SET stripe_customer_id = ? WHERE id = ?').run('cus_123', firmId);
  const payload = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_123', status: 'active' } } });
  const t = Math.floor(Date.now() / 1000), sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
  const forged = await fetch(base + '/api/stripe/webhook', { method: 'POST', body: payload, headers: { 'Stripe-Signature': `t=${t},v1=${'0'.repeat(64)}` } });
  assert.equal(forged.status, 400);
  const real = await fetch(base + '/api/stripe/webhook', { method: 'POST', body: payload, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } });
  assert.equal(real.status, 200);
  assert.equal((await c.call('POST', `/api/companies/${co.id}/transactions`, { date: '2026-10-02', type: 'out', category: 'Rent', description: 'x', amount: 5 })).status, 200);
});

test('pages are served with a strict content security policy', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal((await fetch(base + '/../src/server.js')).headers.get('content-type'), 'text/html; charset=utf-8');
});

test('email sign-in links work once and expire', async () => {
  const owner = await firm();
  const mail = (await owner.call('GET', '/api/me')).data.user.email;
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { assert.equal((await client().call('POST', '/api/login-link/request', { email: mail })).status, 200); } finally { console.log = orig; }
  const token = /\?login=([\w-]+)/.exec(logs.join('\n'))[1];
  const c = client();
  assert.equal((await c.call('POST', '/api/login-link', { token })).status, 200);
  assert.equal((await c.call('GET', '/api/me')).data.user.email, mail);
  assert.equal((await client().call('POST', '/api/login-link', { token })).status, 400, 'single use');
  assert.equal((await client().call('POST', '/api/login-link/request', { email: 'nobody@example.com' })).status, 200, 'does not reveal accounts');
});
