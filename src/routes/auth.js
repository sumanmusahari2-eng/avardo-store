const express = require('express');
const {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} = require('../auth');
const { isEmail, isPassword, str, optStr } = require('../validate');
const { turnstileEnabled, verifyTurnstile } = require('../turnstile');

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, avatar_url: u.avatar_url || null });

  r.get('/google-config', async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    res.json({ enabled: !!clientId, client_id: clientId });
  });

  r.get('/turnstile-config', async (req, res) => {
    const siteKey = (process.env.TURNSTILE_SITE_KEY || '').trim();
    res.json({ enabled: !!siteKey && turnstileEnabled(), site_key: siteKey });
  });

  r.post('/register', async (req, res) => {
    const ts = await verifyTurnstile(req.body && req.body.turnstile_token, req.ip);
    if (!ts.ok) return res.status(400).json({ error: ts.error });
    const name = str(req.body && req.body.name, 120);
    const email = (req.body && req.body.email || '').trim().toLowerCase();
    const password = req.body && req.body.password;
    if (!name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!isPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return res.status(409).json({ error: 'An account with this email already exists.' });

    try {
      const passwordHash = await hashPassword(password);
      const info = await db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
        name, email, passwordHash, 'customer'
      );
      const user = await db.prepare('SELECT id, name, email, role, avatar_url FROM users WHERE id = ?').get(info.lastInsertRowid);
      setAuthCookie(res, signToken(user));
      res.status(201).json({ user: publicUser(user) });
    } catch (e) {
      res.status(500).json({ error: 'Could not create account. Please try again.' });
    }
  });

  r.post('/login', async (req, res) => {
    const ts = await verifyTurnstile(req.body && req.body.turnstile_token, req.ip);
    if (!ts.ok) return res.status(400).json({ error: ts.error });
    const email = (req.body && req.body.email || '').trim().toLowerCase();
    const password = req.body && req.body.password;
    if (!isEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'Please enter your email and password.' });
    }
    const user = await db.prepare('SELECT id, name, email, role, password_hash, blocked, avatar_url FROM users WHERE email = ?').get(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (user.blocked) {
      return res.status(403).json({ error: 'Your account has been blocked.' });
    }
    setAuthCookie(res, signToken(user));
    res.json({ user: publicUser(user) });
  });

  r.post('/google', async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    if (!clientId) {
      return res.status(503).json({ error: 'Google login is not configured on this server yet. Please use email and password.' });
    }
    const credential = req.body && req.body.credential;
    if (typeof credential !== 'string' || !credential) {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }
    try {
      const { OAuth2Client } = require('google-auth-library');
      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload || !payload.email || !payload.email_verified || !payload.sub) {
        return res.status(401).json({ error: 'Google verification failed.' });
      }
      const email = payload.email.trim().toLowerCase();
      let user = await db.prepare('SELECT id, name, email, role, blocked FROM users WHERE google_id = ?').get(payload.sub);
      if (!user) user = await db.prepare('SELECT id, name, email, role, blocked FROM users WHERE email = ?').get(email);
      if (!user) {
        const info = await db.prepare('INSERT INTO users (name, email, google_id, role) VALUES (?, ?, ?, ?)').run(
          str(payload.name, 120) || email.split('@')[0], email, payload.sub, 'customer'
        );
        user = await db.prepare('SELECT id, name, email, role, blocked FROM users WHERE id = ?').get(info.lastInsertRowid);
      } else {
        const row = await db.prepare('SELECT google_id FROM users WHERE id = ?').get(user.id);
        if (!row.google_id) await db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(payload.sub, user.id);
      }
      if (user.blocked) {
        return res.status(403).json({ error: 'Your account has been blocked.' });
      }
      setAuthCookie(res, signToken(user));
      res.json({ user: publicUser(user) });
    } catch (e) {
      res.status(401).json({ error: 'Google verification failed. Please try again.' });
    }
  });

  r.post('/logout', async (req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, async (req, res) => {
    res.json({
      user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, balance: req.user.balance, balance_usd: req.user.balance_usd || 0, avatar_url: req.user.avatar_url || null },
    });
  });

  // Update own profile (currently: profile photo).
  r.put('/profile', requireAuth, async (req, res) => {
    const avatarUrl = optStr(req.body && req.body.avatar_url, 400000);
    await db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);
    const user = await db.prepare('SELECT id, name, email, role, balance, balance_usd, avatar_url FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: publicUser(user) });
  });

  return r;
};
