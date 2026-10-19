import crypto from 'node:crypto';

const DAY = 86400000;
export const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

export function createSession(db, userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, Date.now() + SESSION_DAYS * DAY);
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.firm_id, u.email, u.name, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) { destroySession(db, token); return null; }
  return row;
}

export const destroySession = (db, token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));

// Simple fixed-window limiter for sign-in and reset attempts
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    h.n++;
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return h.n <= limit;
  };
}

export function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 10) return 'Use at least 10 characters for the password.';
  if (p.length > 200) return 'That password is too long.';
  return null;
}
