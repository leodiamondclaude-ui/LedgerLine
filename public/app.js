'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const usd = (n, d = 0) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const cmp = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const iso = o => { const d = new Date(); d.setDate(d.getDate() + o); return fmt(d); };
const today = iso(0);
const sum = a => a.reduce((t, x) => t + x.amount, 0);
const ym = d => d.slice(0, 7);
const OB = 'Opening balance';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

async function api(method, url, body) {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Ledgerline': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && ME) { ME = null; showAuth('signin'); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status });
  return data;
}

let ME = null, COS = [], CUR = null, TX = [], view = 'app', tab = 'overview', LF = store.get('ll-lf') || '', PER = 'm', EDIT = null, Q = [], LABELS = [];
const role = () => ME?.user.role;
const canManage = () => role() === 'owner' || role() === 'admin';
const isClient = () => role() === 'client';
const canWrite = () => !!ME?.billing.canWrite;
const lc = l => l ? 'c' + (Math.max(0, LABELS.indexOf(l)) % 6) : '';
function twice(btn, label, fn) {
  if (btn.dataset.arm) { clearTimeout(+btn.dataset.arm); delete btn.dataset.arm; btn.textContent = btn.dataset.orig; fn(); return; }
  btn.dataset.orig = btn.textContent; btn.textContent = label;
  btn.dataset.arm = setTimeout(() => { delete btn.dataset.arm; btn.textContent = btn.dataset.orig; }, 3000);
}
let pending = 0;
async function saving(p) {
  pending++; $('#sync').textContent = 'Saving…';
  try { const r = await p; $('#sync').textContent = 'All changes saved'; return r; }
  catch (e) { $('#sync').textContent = ''; throw e; }
  finally { pending--; }
}
// Messages share one slot per form; good news shows in green
const say = (el, text, good = false) => { el.textContent = text; el.classList.toggle('good', good); };
const sizeBars = root => root.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });

// ---------- signed out
function showAuth(name) {
  $('#auth').hidden = false; $('#app').hidden = true; $('#topnav').hidden = true; $('#banner').hidden = true; $('#firmname').textContent = ''; $('#sync').textContent = '';
  $$('[data-auth]').forEach(s => { s.hidden = s.dataset.auth !== name; });
  const first = $(`[data-auth="${name}"] input:not([readonly])`); if (first) first.focus();
}
async function submitForm(form, fn) {
  const btn = form.querySelector('button:not([type=button])'), err = form.querySelector('.err');
  if (err) err.textContent = '';
  btn.disabled = true;
  try { await fn(Object.fromEntries(new FormData(form))); }
  catch (e) { if (err) err.textContent = e.message; }
  finally { btn.disabled = false; }
}
const params = new URLSearchParams(location.search);
const INVITE = params.get('invite'), RESET = params.get('reset'), BILL = params.get('billing'), LOGIN = params.get('login');
if (INVITE || RESET || BILL || LOGIN) history.replaceState(null, '', '/');

$('#f-signin').addEventListener('submit', e => { e.preventDefault(); submitForm(e.target, async d => { ME = await api('POST', '/api/login', d); enterApp(); }); });
$('#f-signup').addEventListener('submit', e => { e.preventDefault(); submitForm(e.target, async d => { ME = await api('POST', '/api/signup', d); enterApp(); }); });
$('#f-forgot').addEventListener('submit', e => { e.preventDefault(); submitForm(e.target, async d => { await api('POST', '/api/password-reset/request', d); e.target.querySelector('.err').textContent = ''; $('[data-auth=forgot] .lead').textContent = 'If that email has an account, a reset link is on its way. It works for one hour.'; }); });
$('#f-reset').addEventListener('submit', e => { e.preventDefault(); submitForm(e.target, async d => { ME = await api('POST', '/api/password-reset', { token: RESET, password: d.password }); enterApp(); }); });
$('#f-join').addEventListener('submit', e => { e.preventDefault(); submitForm(e.target, async d => { ME = await api('POST', `/api/invite-info/${encodeURIComponent(INVITE)}/accept`, d); enterApp(); }); });
document.addEventListener('click', e => { const g = e.target.closest('[data-goauth]'); if (g) showAuth(g.dataset.goauth); });
$('#send-link').addEventListener('click', async () => {
  const err = $('#f-signin .err'), mail = $('#si-email').value.trim();
  if (!mail) { say(err, 'Enter your email first, then press this again.'); $('#si-email').focus(); return; }
  try { await api('POST', '/api/login-link/request', { email: mail }); say(err, 'If that email has an account, a sign-in link is on its way. It works once, for 15 minutes.', true); }
  catch (e) { say(err, e.message); }
});
$('#signout').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); ME = null; showAuth('signin'); });

// ---------- signed in
async function enterApp() {
  $('#auth').hidden = true; $('#app').hidden = false; $('#topnav').hidden = false;
  $('#firmname').textContent = ME.firm.name;
  $('#go-settings').textContent = canManage() ? 'Team & billing' : 'Account';
  $('#scan').hidden = !ME.receipts;
  banner(); cats();
  COS = await api('GET', '/api/companies');
  const last = COS.find(c => c.id === Number(store.get('ll-co'))) || COS[0];
  if (last) await openCo(last.id);
  else { CUR = null; view = isClient() ? 'empty' : 'setup'; layout(); }
  if (BILL === 'done') $('#sync').textContent = 'Thanks! Your plan is active.';
}
function banner() {
  const b = ME.billing, el = $('#banner');
  if (!b.enabled || (b.status === 'active')) { el.hidden = true; return; }
  const days = Math.max(0, Math.ceil((b.trialEndsAt - Date.now()) / 86400000));
  const owner = role() === 'owner';
  el.className = 'banner' + (b.canWrite ? '' : ' bad'); el.hidden = false;
  el.textContent = b.canWrite ? `${days} day${days === 1 ? '' : 's'} left in your free trial.` : (owner ? 'Your free trial has ended. Choose a plan to keep adding entries. Your books are safe and still readable.' : 'This firm’s free trial has ended. Ask the account owner to choose a plan.');
  if (owner) { const btn = document.createElement('button'); btn.className = 'btn sm'; btn.textContent = 'Choose a plan'; btn.addEventListener('click', checkout); el.append(btn); }
}
function layout() {
  const app = view === 'app';
  $('#setup').hidden = view !== 'setup'; $('#empty').hidden = view !== 'empty'; $('#settings').hidden = view !== 'settings';
  $('#nav').hidden = !app;
  ['overview', 'ledger', 'reports'].forEach(s => { $('#' + s).hidden = !(app && tab === s); });
  $$('#nav button').forEach(b => b.setAttribute('aria-current', b.dataset.v === tab));
  $('#sf-cancel').hidden = !CUR;
  if (view === 'empty') $('#empty-msg').textContent = 'Your firm hasn’t given you access to any companies yet. Ask them to add you to one.';
  coBar();
  if (app) render();
}
async function openCo(cid) {
  CUR = COS.find(c => c.id === cid); if (!CUR) return;
  store.set('ll-co', String(cid));
  TX = []; Q = []; EDIT = null; resetTxForm(); rq(); $('#rst').textContent = '';
  view = 'app'; layout();
  TX = await api('GET', `/api/companies/${cid}/transactions`);
  if (CUR && CUR.id === cid) render();
}
function coBar() {
  LABELS = [...new Set(COS.map(c => c.label).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (LF && !LABELS.includes(LF)) LF = '';
  $('#coband').hidden = !COS.length && isClient();
  $('#lfilter').hidden = !LABELS.length;
  $('#lfilter').innerHTML = LABELS.length ? `<button class="lf" data-lf="" aria-pressed="${!LF}">All companies</button>` + LABELS.map(l => `<button class="lf" data-lf="${esc(l)}" aria-pressed="${LF === l}"><i class="dot ${lc(l)}"></i>${esc(l)}</button>`).join('') : '';
  $('#lablist').innerHTML = LABELS.map(l => `<option value="${esc(l)}">`).join('');
  const on = c => !!CUR && CUR.id === c.id && view === 'app';
  $('#cotabs').innerHTML = COS.filter(c => !LF || c.label === LF || (CUR && c.id === CUR.id)).map(c =>
    `<button class="ftab" role="tab" aria-selected="${on(c)}" data-co="${c.id}"><span><i class="dot ${lc(c.label)}"></i>${esc(c.name)}</span><small>${c.label ? esc(c.label) : 'No label'}</small></button>`).join('')
    + (isClient() ? '' : `<button class="ftab add" id="conew" aria-selected="${view === 'setup'}">+ New company</button>`);
  const sel = $('#cotabs [aria-selected="true"]'); if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function render() { if (!CUR) return; overview(); ledger(); reports(); }

function overview() {
  const cash = sum(TX.filter(t => t.type === 'in')) - sum(TX.filter(t => t.type === 'out'));
  const mt = TX.filter(t => ym(t.date) === ym(today) && t.category !== OB);
  const mi = sum(mt.filter(t => t.type === 'in')), mo = sum(mt.filter(t => t.type === 'out')), net = mi - mo;
  const k = (l, v, c = '') => `<div class="kpi"><small>${l}</small><b class="${c}">${v}</b></div>`;
  $('#kpis').innerHTML = k('Cash on hand', usd(cash), cash < 0 ? 'neg' : '') + k('Net profit this month', usd(net), net >= 0 ? 'pos' : 'neg') + k('Money in this month', usd(mi)) + k('Money out this month', usd(mo));
  const d = new Date(); d.setDate(1);
  const ms = [...Array(6)].map((_, i) => { const x = new Date(d.getFullYear(), d.getMonth() - 5 + i, 1); return fmt(x).slice(0, 7); });
  const vals = ms.map(m => ({ m, i: sum(TX.filter(t => t.type === 'in' && t.category !== OB && ym(t.date) === m)), o: sum(TX.filter(t => t.type === 'out' && t.category !== OB && ym(t.date) === m)) }));
  const mx = Math.max(1, ...vals.map(v => Math.max(v.i, v.o)));
  let g = '';
  vals.forEach((v, j) => {
    const x = 20 + j * 95, hi = v.i / mx * 150, ho = v.o / mx * 150;
    g += `<rect x="${x}" y="${170 - hi}" width="30" height="${hi}" rx="2" fill="var(--in)"><title>Income ${usd(v.i)}</title></rect><rect x="${x + 34}" y="${170 - ho}" width="30" height="${ho}" rx="2" fill="var(--out)"><title>Expenses ${usd(v.o)}</title></rect><text x="${x + 32}" y="190" text-anchor="middle" font-size="12">${MONTHS[+v.m.slice(5) - 1]}</text>`;
  });
  $('#chart').innerHTML = `<svg viewBox="0 0 600 198" width="100%" role="img" aria-label="Monthly income and expenses">${g}</svg><p class="note"><span class="pos">Green</span> is income, <span class="neg">red</span> is expenses. Hover a bar for the total.</p>`;
  const by = {}; mt.filter(t => t.type === 'out').forEach(t => { by[t.category] = (by[t.category] || 0) + t.amount; });
  const e = Object.entries(by).sort((a, b) => b[1] - a[1]), top = e.length ? e[0][1] : 1;
  $('#cats').innerHTML = e.length ? e.map(([c, v]) => `<div class="bar"><span>${esc(c)}</span><i data-w="${(v / top * 100).toFixed(1)}"></i><span class="r">${usd(v)}</span></div>`).join('') : '<p class="mute">No expenses recorded this month yet. Add a receipt or record one in the Ledger tab.</p>';
  sizeBars($('#cats'));
}
function ledger() {
  const rows = [...TX].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id), w = canWrite();
  $('#txb').innerHTML = rows.length ? rows.map(t => `<tr><td class="nowrap">${esc(t.date)}</td><td>${esc(t.description)}</td><td><span class="tag">${esc(t.category)}</span></td><td class="r nowrap ${t.type === 'in' ? 'pos' : 'neg'}">${t.type === 'in' ? '+' : '−'}${usd(t.amount, 2)}</td><td class="r nowrap">${w ? `<button class="link" data-edit="${t.id}">Edit</button> <button class="x" data-del="${t.id}" aria-label="Delete transaction">×</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="5" class="mute">No transactions yet. Add a receipt or record one above.</td></tr>';
  $('#csv').href = `/api/companies/${CUR.id}/export.csv`;
  $('#cocard').hidden = isClient(); $('#go-edit').hidden = isClient();
  $('#co-del').hidden = !canManage();
  if (document.activeElement !== $('#co-name')) $('#co-name').value = CUR.name;
  if (document.activeElement !== $('#co-label')) $('#co-label').value = CUR.label || '';
  $('#f-tx').hidden = !w; $('#imp').hidden = !w;
}
function cats() { const f = $('#f-tx'), keep = f.category.value; f.category.innerHTML = (f.type.value === 'in' ? ME.categories.in : ME.categories.out).map(c => `<option>${esc(c)}</option>`).join(''); if (keep) f.category.value = keep; }
function resetTxForm() {
  const f = $('#f-tx'); EDIT = null; f.reset(); f.date.value = today; cats();
  $('#txf-title').textContent = 'Record a transaction'; $('#tx-save').textContent = 'Add transaction'; $('#tx-cancel').hidden = true; $('#tx-err').textContent = '';
}
$('#f-tx').type.addEventListener('change', cats);
$('#tx-cancel').addEventListener('click', resetTxForm);
$('#f-tx').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, d = Object.fromEntries(new FormData(f)); $('#tx-err').textContent = '';
  try {
    if (EDIT) { const t = await saving(api('PATCH', `/api/transactions/${EDIT}`, d)); TX = TX.map(x => x.id === t.id ? t : x); resetTxForm(); }
    else { const [t] = await saving(api('POST', `/api/companies/${CUR.id}/transactions`, d)); TX.push(t); f.description.value = ''; f.amount.value = ''; f.description.focus(); }
    render();
  } catch (err) { $('#tx-err').textContent = err.message; }
});
$('#f-co').addEventListener('submit', async e => {
  e.preventDefault();
  try { const c = await saving(api('PATCH', `/api/companies/${CUR.id}`, Object.fromEntries(new FormData(e.target)))); Object.assign(CUR, c); COS.sort((a, b) => a.name.localeCompare(b.name)); coBar(); }
  catch (err) { $('#sync').textContent = err.message; }
});
$('#f-setup').addEventListener('submit', e => { e.preventDefault(); submitForm(e.target, async d => {
  const c = await saving(api('POST', '/api/companies', d)); COS.push(c); COS.sort((a, b) => a.name.localeCompare(b.name)); e.target.reset(); tab = 'overview'; await openCo(c.id);
}); });

// Plain CSV with optional quotes; header row skipped
function parseCsv(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^date\s*,/i.test(l)).map(l => {
    const c = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { c.push(cur); cur = ''; } else cur += ch; }
    c.push(cur);
    const [date, type, category, description, amount] = c.map(x => x.trim());
    return { date, type, category: category || (type === 'in' ? 'Other income' : 'Other expense'), description: description || 'Imported', amount: parseFloat(String(amount).replace(/[$,]/g, '')) };
  });
}

// ---------- receipts
async function shrink(file) {
  const b = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(b.width, b.height));
  const c = document.createElement('canvas'); c.width = Math.round(b.width * k); c.height = Math.round(b.height * k);
  c.getContext('2d').drawImage(b, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
function rq() {
  const opt = q => (q.type === 'in' ? ME?.categories.in : ME?.categories.out || []).map(c => `<option${c === q.category ? ' selected' : ''}>${esc(c)}</option>`).join('');
  $('#rq').innerHTML = Q.map((q, i) => `<tr class="rowedit"><td><input type="date" value="${esc(q.date)}" data-q="${i}" data-f="date" aria-label="Date"></td><td><input value="${esc(q.description)}" data-q="${i}" data-f="description" aria-label="Description"></td><td><select data-q="${i}" data-f="category" aria-label="Category">${opt(q)}</select></td><td><input type="number" step="0.01" value="${esc(q.amount)}" data-q="${i}" data-f="amount" class="amt" aria-label="Amount"></td><td><button class="x" data-qx="${i}" aria-label="Remove">×</button></td></tr>`).join('');
  $('#ract').hidden = !Q.length;
}
document.addEventListener('input', e => { const t = e.target; if (t.dataset.q !== undefined && Q[+t.dataset.q]) Q[+t.dataset.q][t.dataset.f] = t.value; });
async function readAll() {
  const files = [...$('#rf').files]; if (!files.length) { $('#rst').textContent = 'Choose one or more photos first.'; return; }
  const cid = CUR.id; let bad = 0, lastErr = '';
  for (let i = 0; i < files.length; i++) {
    $('#rst').textContent = `Reading ${i + 1} of ${files.length}…`;
    try {
      const r = await api('POST', '/api/receipts/read', { image: await shrink(files[i]) });
      if (!CUR || CUR.id !== cid) return;
      Q.push({ ...r, date: r.date || today }); rq();
    } catch (e) { bad++; lastErr = e.message; if (e.status === 402 || e.status === 503) break; }
  }
  $('#rst').textContent = `${files.length - bad} read${bad ? `, ${bad} could not be read (${lastErr})` : ''}. Check each row.`;
  $('#rf').value = '';
}

// ---------- reports
function reports() {
  const N = new Date(), Y = N.getFullYear(), M = N.getMonth();
  const D = (y, m) => new Date(y, m, 1), F = x => fmt(x).slice(0, 8) + '01';
  const R = { m: [D(Y, M), D(Y, M + 1), D(Y, M - 1)], q: [D(Y, M - 2), D(Y, M + 1), D(Y, M - 5)], y: [D(Y, 0), D(Y + 1, 0), D(Y - 1, 0)], a: [D(2000, 0), D(Y, M + 1), null] }[PER];
  const sa = F(R[0]), sb = F(R[1]), sp = R[2] ? F(R[2]) : null;
  const base = TX.filter(t => t.category !== OB);
  const cur = base.filter(t => t.date >= sa && t.date < sb), prv = sp ? base.filter(t => t.date >= sp && t.date < sa) : null;
  const st = l => { const rev = sum(l.filter(t => t.type === 'in')), exp = sum(l.filter(t => t.type === 'out')), cg = sum(l.filter(t => t.category === 'Cost of goods')), gp = rev - cg; return { rev, exp, gp, net: rev - exp, gm: rev ? gp / rev * 100 : 0 }; };
  const c = st(cur), pv = prv ? st(prv) : null;
  const chip = (a, b, inv) => { if (!pv || !b) return '<span class="chip mute">no prior data</span>'; const x = (a - b) / Math.abs(b) * 100, up = x >= 0, good = inv ? !up : up; return `<span class="chip ${good ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(x))}%</span>`; };
  const gmChip = !pv || !pv.rev ? '<span class="chip mute">no prior data</span>' : (() => { const d = c.gm - pv.gm; return `<span class="chip ${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts</span>`; })();
  const n = PER === 'y' ? M + 1 : PER === 'a' ? 12 : 6;
  const keys = [...Array(n)].map((_, i) => F(D(Y, M - (n - 1 - i))).slice(0, 7));
  const per = keys.map(k => st(base.filter(t => t.date.slice(0, 7) === k)));
  const bars = (vals, pc, nc) => {
    const mp = Math.max(0, ...vals), mn = Math.max(0, ...vals.map(v => -v)), sc = 90 / ((mp + mn) || 1), bl = 18 + mp * sc, w = 600 / keys.length, bw = Math.min(46, w * 0.6); let g = '';
    vals.forEach((v, j) => { const h = Math.max(Math.abs(v) * sc, 1), x = j * w + (w - bw) / 2, y = v >= 0 ? bl - h : bl;
      g += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${v >= 0 ? pc : nc}"><title>${usd(v)}</title></rect><text x="${x + bw / 2}" y="${v >= 0 ? y - 5 : y + h + 13}" text-anchor="middle" font-size="11">${cmp(v)}</text><text x="${x + bw / 2}" y="146" text-anchor="middle" font-size="12">${MONTHS[+keys[j].slice(5) - 1]}</text>`; });
    return `<svg viewBox="0 0 600 152" width="100%" role="img">${g}</svg>`;
  };
  const grp = ty => { const o = {}; cur.filter(t => t.type === ty).forEach(t => { o[t.category] = (o[t.category] || 0) + t.amount; }); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  const ec = grp('out'), ic = grp('in'), tp = ec.length ? ec[0][1] : 1;
  const lab = { m: 'This month', q: 'Last 3 months', y: 'This year', a: 'All time' }[PER];
  const rw = (a, b, cl = '', t = '') => `<div class="row ${t}"><span>${a}</span><span class="${cl}">${b}</span></div>`;
  const cash = sum(TX.filter(t => t.type === 'in')) - sum(TX.filter(t => t.type === 'out'));
  const noCogs = !base.some(t => t.category === 'Cost of goods');
  $('#rep').innerHTML = `<div class="card hero"><small class="mute">${esc(CUR.name)} · Net profit · ${lab}</small><div class="big ${c.net >= 0 ? 'pos' : 'neg'}">${usd(c.net)}</div><div class="chips">${chip(c.net, pv && pv.net)}<span class="mute">vs previous period</span></div></div>
  <div class="tiles"><div class="tile"><small>Revenue</small><b>${usd(c.rev)}</b>${chip(c.rev, pv && pv.rev)}</div><div class="tile"><small>Expenses</small><b>${usd(c.exp)}</b>${chip(c.exp, pv && pv.exp, 1)}</div><div class="tile"><small>Gross profit</small><b>${usd(c.gp)}</b>${chip(c.gp, pv && pv.gp)}</div><div class="tile"><small>Gross margin</small><b>${Math.round(c.gm)}%</b>${gmChip}</div></div>
  <div class="card"><h2>Gross profit</h2><p class="sub">Revenue minus cost of goods, by month${noCogs ? '. Record product costs under “Cost of goods” to separate this from revenue.' : ''}</p>${bars(per.map(x => x.gp), 'var(--acc)', 'var(--out)')}</div>
  <div class="card"><h2>Net profit</h2><p class="sub">Revenue minus all expenses, by month</p>${bars(per.map(x => x.net), 'var(--in)', 'var(--out)')}</div>
  <div class="card"><h2>Where the money goes</h2><p class="sub">${lab}</p>${ec.length ? ec.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><i data-w="${(v / tp * 100).toFixed(1)}"></i><span class="r">${usd(v)} · ${Math.round(v / c.exp * 100)}%</span></div>`).join('') : '<p class="mute">No expenses in this period yet.</p>'}</div>
  <div class="card"><details><summary>Profit and loss statement</summary><div class="detail">${ic.map(([k, v]) => rw(esc(k), usd(v))).join('')}${rw('Total income', usd(c.rev), 'pos', 't')}${ec.map(([k, v]) => rw(esc(k), usd(v))).join('')}${rw('Total expenses', usd(c.exp), 'neg', 't')}${rw('Net profit', usd(c.net), c.net >= 0 ? 'pos' : 'neg', 't')}</div></details></div>
  <div class="card">${rw('Cash on hand (all time)', usd(cash, 2))}</div>`;
  sizeBars($('#rep'));
}

// ---------- team, billing, account
const roleText = r => ({ owner: 'Owner', admin: 'Admin: all companies and team', member: 'Staff: all companies', client: 'Client: chosen companies' }[r] || r);
async function settings() {
  view = 'settings'; layout();
  $('#acct').textContent = `${ME.user.name} · ${ME.user.email} · ${roleText(ME.user.role)}`;
  const b = ME.billing, owner = role() === 'owner';
  $('#billing').hidden = !(owner && b.enabled);
  if (owner && b.enabled) {
    const days = Math.max(0, Math.ceil((b.trialEndsAt - Date.now()) / 86400000));
    $('#bill-status').textContent = b.status === 'active' ? 'Your plan is active.' : b.status ? `Subscription status: ${b.status}.` : b.inTrial ? `Free trial, ${days} day${days === 1 ? '' : 's'} left.` : 'Your free trial has ended.';
    $('#bill-checkout').hidden = b.status === 'active' || b.status === 'trialing';
    $('#bill-portal').hidden = !b.status;
  }
  $('#team').hidden = !canManage();
  if (canManage()) await loadTeam();
}
async function loadTeam() {
  const { members, invites } = await api('GET', '/api/team');
  const names = Object.fromEntries(COS.map(c => [c.id, c.name]));
  $('#members').innerHTML = members.map(m => {
    const editable = m.role !== 'owner' && m.id !== ME.user.id && (m.role !== 'admin' || role() === 'owner');
    const access = m.role === 'client' ? `Client: ${esc((m.companyIds || []).map(i => names[i] || 'Removed company').join(', ') || 'no companies')}`
      : editable && m.role !== 'client' ? `<select data-role="${m.id}" aria-label="Access for ${esc(m.name)}"><option value="member"${m.role === 'member' ? ' selected' : ''}>Staff: all companies</option>${role() === 'owner' ? `<option value="admin"${m.role === 'admin' ? ' selected' : ''}>Admin: all companies and team</option>` : ''}</select>` : esc(roleText(m.role));
    return `<tr><td>${esc(m.name)}<br><span class="mute">${esc(m.email)}</span></td><td>${access}</td><td class="r nowrap">${editable ? `<button class="link" data-reset="${m.id}">Reset link</button> <button class="x" data-rm="${m.id}" aria-label="Remove ${esc(m.name)}">×</button>` : ''}</td></tr>`;
  }).join('');
  $('#invites').innerHTML = invites.length ? `<h2 class="sub2">Waiting to join</h2><table><tbody>${invites.map(i => `<tr><td>${esc(i.email || 'Link only')}</td><td>${esc(roleText(i.role))}</td><td class="r"><button class="link" data-uninvite="${i.id}">Cancel</button></td></tr>`).join('')}</tbody></table>` : '';
  $('#iv-cos').innerHTML = COS.map(c => `<label><input type="checkbox" value="${c.id}"> ${esc(c.name)}</label>`).join('') || '<span class="mute">Add a company first.</span>';
}
$('#iv-role').addEventListener('change', e => { $('#iv-cos').hidden = e.target.value !== 'client'; });
$('#f-invite').addEventListener('submit', async e => {
  e.preventDefault(); $('#iv-err').textContent = ''; $('#iv-out').hidden = true;
  const d = Object.fromEntries(new FormData(e.target));
  if (d.role === 'client') d.companyIds = $$('#iv-cos input:checked').map(i => Number(i.value));
  if (!d.email) delete d.email;
  try {
    const r = await api('POST', '/api/invites', d);
    $('#iv-link').value = r.link; $('#iv-out').hidden = false;
    say($('#iv-err'), r.emailed ? 'Invite emailed. You can also send the link yourself.' : 'Send this link to the person you’re inviting.', true);
    e.target.reset(); $('#iv-cos').hidden = true; await loadTeam();
  } catch (err) { say($('#iv-err'), err.message); }
});
$('#iv-copy').addEventListener('click', async () => { const i = $('#iv-link'); try { await navigator.clipboard.writeText(i.value); $('#iv-copy').textContent = 'Copied'; } catch { i.select(); } setTimeout(() => { $('#iv-copy').textContent = 'Copy link'; }, 1500); });
$('#f-pass').addEventListener('submit', e => { e.preventDefault(); const f = e.target; $('#pw-err').textContent = ''; api('POST', '/api/password', Object.fromEntries(new FormData(f))).then(r => { ME = r; f.reset(); say($('#pw-err'), 'Password changed. Other devices were signed out.', true); }, err => { say($('#pw-err'), err.message); }); });
async function checkout() { try { location.href = (await api('POST', '/api/billing/checkout')).url; } catch (e) { $('#bill-err').textContent = e.message; $('#sync').textContent = e.message; } }
$('#bill-checkout').addEventListener('click', checkout);
$('#bill-portal').addEventListener('click', async () => { try { location.href = (await api('POST', '/api/billing/portal')).url; } catch (e) { $('#bill-err').textContent = e.message; } });

// ---------- clicks
document.addEventListener('click', async e => {
  const t = e.target, co = t.closest('[data-co]'), lf = t.closest('[data-lf]');
  if (co) { tab = view === 'app' ? tab : 'overview'; await openCo(Number(co.dataset.co)); return; }
  if (lf) { LF = lf.dataset.lf; store.set('ll-lf', LF); coBar(); return; }
  if (t.id === 'conew') { view = 'setup'; $('#f-setup').reset(); $('#sf-asof').value = today; if (LF) $('#sf-label').value = LF; layout(); $('#sf-name').focus(); return; }
  if (t.id === 'sf-cancel' && CUR) { view = 'app'; layout(); return; }
  if (t.dataset.v) { tab = t.dataset.v; layout(); return; }
  if (t.dataset.p) { PER = t.dataset.p; $$('.pill').forEach(b => b.setAttribute('aria-pressed', b === t)); reports(); return; }
  if (t.id === 'go-settings') { settings().catch(err => { $('#sync').textContent = err.message; }); return; }
  if (t.id === 'back') { view = CUR ? 'app' : isClient() ? 'empty' : 'setup'; layout(); return; }
  if (t.id === 'go-edit') { tab = 'ledger'; layout(); const i = $('#co-name'); i.scrollIntoView({ block: 'center' }); i.focus(); i.select(); return; }
  if (t.id === 'go-scan') { tab = 'ledger'; layout(); if (ME.receipts) $('#rf').click(); else $('#tx-desc').focus(); return; }
  if (t.dataset.edit) {
    const x = TX.find(y => y.id === Number(t.dataset.edit)); if (!x) return; const f = $('#f-tx');
    EDIT = x.id; f.date.value = x.date; f.type.value = x.type; cats(); f.category.value = x.category; f.description.value = x.description; f.amount.value = x.amount;
    $('#txf-title').textContent = 'Edit transaction'; $('#tx-save').textContent = 'Save changes'; $('#tx-cancel').hidden = false;
    f.scrollIntoView({ block: 'center' }); f.description.focus(); return;
  }
  if (t.dataset.del) { const idn = Number(t.dataset.del); twice(t, 'Delete?', async () => { try { await saving(api('DELETE', `/api/transactions/${idn}`)); TX = TX.filter(x => x.id !== idn); if (EDIT === idn) resetTxForm(); render(); } catch (err) { $('#tx-err').textContent = err.message; } }); return; }
  if (t.id === 'co-del') { twice(t, `Click again to delete ${CUR.name} and all its entries`, async () => { await saving(api('DELETE', `/api/companies/${CUR.id}`)); COS = COS.filter(c => c.id !== CUR.id); CUR = null; if (COS[0]) await openCo(COS[0].id); else { view = 'setup'; layout(); } }); return; }
  if (t.id === 'imp') {
    const a = $('#ib'); if (a.hidden) { a.hidden = false; a.focus(); return; }
    $('#imp-err').textContent = '';
    try { const rows = parseCsv(a.value); if (!rows.length) throw new Error('Paste at least one row first.'); const added = await saving(api('POST', `/api/companies/${CUR.id}/transactions`, { entries: rows })); TX.push(...added); a.value = ''; a.hidden = true; say($('#imp-err'), `${added.length} imported.`, true); render(); }
    catch (err) { say($('#imp-err'), err.message); }
    return;
  }
  if (t.id === 'rgo') { readAll(); return; }
  if (t.dataset.qx !== undefined) { Q.splice(+t.dataset.qx, 1); rq(); return; }
  if (t.id === 'rclr') { Q = []; rq(); return; }
  if (t.id === 'radd') {
    try { const added = await saving(api('POST', `/api/companies/${CUR.id}/transactions`, { entries: Q })); TX.push(...added); Q = []; rq(); $('#rst').textContent = `${added.length} added to the ledger.`; render(); }
    catch (err) { $('#rst').textContent = err.message; }
    return;
  }
  if (t.dataset.reset) { try { const r = await api('POST', `/api/members/${t.dataset.reset}/reset-link`); $('#iv-link').value = r.link; $('#iv-out').hidden = false; say($('#iv-err'), 'Send this one-day password reset link to that person.', true); } catch (err) { say($('#iv-err'), err.message); } return; }
  if (t.dataset.rm) { const mid = t.dataset.rm; twice(t, 'Remove?', async () => { try { await api('DELETE', `/api/members/${mid}`); await loadTeam(); } catch (err) { say($('#iv-err'), err.message); } }); return; }
  if (t.dataset.uninvite) { await api('DELETE', `/api/invites/${t.dataset.uninvite}`).catch(() => {}); await loadTeam(); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.role) { try { await saving(api('PATCH', `/api/members/${t.dataset.role}`, { role: t.value })); } catch (err) { say($('#iv-err'), err.message); await loadTeam(); } }
});

// ---------- start
(async () => {
  $('#sf-asof').value = today;
  api('GET', '/api/public').then(p => { $('#price').textContent = p.billing ? `Free for ${p.trialDays} days, no card needed.${p.priceLabel ? ' Then ' + p.priceLabel + '.' : ''}` : ''; }).catch(() => {});
  if (LOGIN) {
    try { ME = await api('POST', '/api/login-link', { token: LOGIN }); return await enterApp(); }
    catch (e) { showAuth('signin'); say($('#f-signin .err'), e.message); return; }
  }
  if (RESET) return showAuth('reset');
  if (INVITE) {
    try {
      const i = await api('GET', `/api/invite-info/${encodeURIComponent(INVITE)}`);
      $('#join-title').textContent = `Join ${i.firm}`; $('#join-lead').textContent = `You’ve been invited with this access: ${roleText(i.role)}. Create your sign-in below.`;
      if (i.email) { $('#jn-email').value = i.email; $('#jn-email').readOnly = true; }
      return showAuth('join');
    } catch (e) { showAuth('signin'); $('[data-auth=signin] .err').textContent = e.message; return; }
  }
  try { ME = await api('GET', '/api/me'); await enterApp(); } catch { showAuth('signin'); }
})();
