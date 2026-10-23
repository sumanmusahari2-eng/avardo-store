const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!global.__jwtTmpWarned) {
    console.warn('[warn] JWT_SECRET is not set. Using a random per-boot secret; sessions will not survive restarts. Set JWT_SECRET in .env for production.');
    global.__jwtTmpWarned = true;
  }
  if (!global.__jwtTmp) global.__jwtTmp = crypto.randomBytes(32).toString('hex');
  return global.__jwtTmp;
}

function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, getSecret(), { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie('mds_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie('mds_token', { path: '/' });
}

// Attaches req.user when a valid cookie is present; never rejects.
function optionalAuth(db) {
  const { enforceExpiry } = require('./memberships');
  return async (req, res, next) => {
    const token = req.cookies && req.cookies.mds_token;
    if (token) {
      try {
        const payload = jwt.verify(token, getSecret());
        const user = await db.prepare('SELECT id, name, email, role, balance, balance_usd, blocked, avatar_url, membership_expires_at FROM users WHERE id = ?').get(payload.uid);
        if (user) {
          // Paid memberships auto-disconnect when they expire.
          await enforceExpiry(db, user).catch(() => {});
          req.user = user;
        }
      } catch (e) {
        // invalid/expired token or db hiccup -> treat as logged out
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (req.user.blocked) return res.status(403).json({ error: 'Your account has been blocked.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
    if (req.user.blocked) return res.status(403).json({ error: 'Your account has been blocked.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden: insufficient permissions.' });
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  optionalAuth,
  requireAuth,
  requireRole,
};
