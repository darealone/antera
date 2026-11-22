// Password hashing (scrypt), sessions and API tokens. Only hashes are stored.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const SESSION_DAYS = 7;

export function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new Error('Password must have at least 10 characters');
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || typeof pw !== 'string') return false;
  const key = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && timingSafeEqual(key, want);
}

export const sha = s => createHash('sha256').update(s).digest('hex');
export const newToken = (prefix = '') => prefix + randomBytes(24).toString('base64url');

export function createSession(db, userId, now = Date.now()) {
  const token = newToken();
  db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', sha(token), userId, now + SESSION_DAYS * 864e5);
  db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  return token;
}

export function userFromRequest(db, req, now = Date.now()) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const row = db.get(`SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.disabled = 0`, sha(auth.slice(7).trim()));
    if (row) { db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now, row.token_id); return { ...strip(row), via: 'token' }; }
    return null;
  }
  const token = parseCookies(req.headers.cookie).antera_session;
  if (!token) return null;
  const row = db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`, sha(token), now);
  return row ? { ...strip(row), via: 'session', sessionToken: token } : null;
}

export function strip(u) {
  return u && { id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled };
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

export function sessionCookie(token, { secure, clear } = {}) {
  const parts = [`antera_session=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear ? 0 : SESSION_DAYS * 86400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const can = {
  manageUsers: u => u.role === 'admin',
  // Definitions are shared by marketing and sales; only admins change them, and only as new versions.
  manageDefinitions: u => u.role === 'admin',
  // Starting or restarting spend: a named human with approval rights, logged in personally (not an API token).
  startSpend: u => (u.role === 'admin' || u.role === 'approver') && u.via !== 'token',
  edit: u => !!u
};
