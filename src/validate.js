function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

function isPassword(s) {
  return typeof s === 'string' && s.length >= 8 && s.length <= 128;
}

// Required non-empty string, trimmed and capped.
function str(s, max = 500) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.slice(0, max);
}

// Optional string; empty -> null.
function optStr(s, max = 2000) {
  if (s === undefined || s === null) return null;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t.slice(0, max) : null;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000000) return null;
  return Math.round(n * 100) / 100;
}

function intIn(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isSlug(s) {
  return typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

module.exports = { isEmail, isPassword, str, optStr, money, intIn, slugify, isSlug };
