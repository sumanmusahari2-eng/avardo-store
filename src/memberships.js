// Paid reseller memberships: silver (₹49) packages with expiry.
// (Gold tier removed 2026-10-07.)
// A membership sets the user's role to the tier; when membership_expires_at
// passes, the role drops back to customer ("disconnected").

async function getSetting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value !== '' ? row.value : fallback;
}

async function membershipConfig(db) {
  const silver = Number(await getSetting(db, 'membership_silver_price', '49')) || 49;
  const days = Math.max(1, Math.floor(Number(await getSetting(db, 'membership_duration_days', '30')) || 30));
  return { silver_price: silver, duration_days: days };
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

// Downgrade silver users whose membership has expired. Returns true if
// a downgrade happened. Safe to call on every request (one UPDATE per expiry).
async function enforceExpiry(db, user) {
  if (!user) return false;
  if (user.role !== 'silver') return false;
  if (!isExpired(user.membership_expires_at)) return false;
  await db.prepare(
    "UPDATE users SET role = 'customer', membership_expires_at = NULL WHERE id = ?"
  ).run(user.id);
  user.role = 'customer';
  user.membership_expires_at = null;
  return true;
}

// Grant or extend a membership. Days are added onto the current expiry when
// the membership is still active, otherwise counted from now.
async function grantMembership(db, userId, tier, days, source, amount) {
  if (tier !== 'silver') throw new Error('Invalid tier.');
  days = Math.max(1, Math.floor(Number(days) || 0));
  const user = await db.prepare('SELECT id, role, membership_expires_at FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found.');
  if (user.role === 'admin') throw new Error('Admin accounts do not need memberships.');
  const base = user.membership_expires_at && !isExpired(user.membership_expires_at)
    ? new Date(user.membership_expires_at).getTime()
    : Date.now();
  const expiresAt = new Date(base + days * 24 * 3600 * 1000);
  const iso = expiresAt.toISOString();
  await db.prepare('UPDATE users SET role = ?, membership_expires_at = ? WHERE id = ?').run(tier, iso, userId);
  await db.prepare(
    'INSERT INTO membership_purchases (user_id, tier, amount, currency, days, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, tier, amount || 0, 'INR', days, source || 'admin');
  return { tier, expires_at: iso };
}

async function revokeMembership(db, userId) {
  const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found.');
  if (user.role !== 'silver') throw new Error('User has no active membership.');
  await db.prepare("UPDATE users SET role = 'customer', membership_expires_at = NULL WHERE id = ?").run(userId);
  return { revoked: true };
}

async function membershipStatus(db, userId) {
  const user = await db.prepare(
    'SELECT id, role, membership_expires_at FROM users WHERE id = ?'
  ).get(userId);
  if (!user) return { tier: null };
  await enforceExpiry(db, user);
  if (user.role !== 'silver') return { tier: null };
  return { tier: user.role, expires_at: user.membership_expires_at };
}

module.exports = {
  getSetting,
  membershipConfig,
  isExpired,
  enforceExpiry,
  grantMembership,
  revokeMembership,
  membershipStatus,
};
