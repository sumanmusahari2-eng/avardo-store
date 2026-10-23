// Wallet + gift-card voucher helpers shared by routes.
// Money convention matches the rest of the codebase: REAL columns, rounded to
// 2 decimals (Math.round(n*100)/100). Balance mutations are single UPDATE
// statements with a balance guard so concurrent requests can't overdraw.
const crypto = require('crypto');

// Voucher codes look like GR-XXXX-XXXX-XXXX. Alphabet excludes 0/O/1/I/L so
// codes read clearly when the owner prints or messages them.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

function generateVoucherCode() {
  const bytes = crypto.randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  let raw = '';
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    groups.push(raw.slice(g * CODE_GROUP_LEN, (g + 1) * CODE_GROUP_LEN));
  }
  return 'MO-' + groups.join('-');
}

// Accepts "MO-XXXX-XXXX-XXXX" (and legacy "GR-" codes), with or without dashes/spaces, any case.
// Returns the canonical dashed form with the original prefix, or null when the shape is wrong.
function normalizeVoucherCode(input) {
  if (typeof input !== 'string') return null;
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^(MO|GR)([A-Z2-9]{12})$/.exec(clean);
  if (!m) return null;
  const raw = m[2];
  return m[1] + '-' + raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Separate INR and USD wallet balances. currency is 'INR' or 'USD';
// defaults to 'INR' for backward compatibility.
function balCol(currency) {
  return String(currency || 'INR').toUpperCase() === 'USD' ? 'balance_usd' : 'balance';
}

async function getBalance(db, userId, currency) {
  const col = balCol(currency);
  const row = await db.prepare(`SELECT ${col} AS b FROM users WHERE id = ?`).get(userId);
  return row ? round2(row.b || 0) : 0;
}

async function recordTransaction(db, userId, type, amount, reason, refType, refId, currency) {
  const cur = String(currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
  const bal = await getBalance(db, userId, cur);
  await db.prepare(
    `INSERT INTO wallet_transactions
       (user_id, type, amount, balance_after, reason, ref_type, ref_id, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, type, round2(amount), bal, reason, refType || null, refId || null, cur);
  return bal;
}

async function creditWallet(db, userId, amount, reason, refType, refId, currency) {
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid credit amount.');
  const col = balCol(currency);
  const r = await db.prepare(
    `UPDATE users SET ${col} = ROUND((COALESCE(${col}, 0) + ?) * 100) / 100 WHERE id = ?`
  ).run(amt, userId);
  // Fail closed: crediting a nonexistent user must not write a phantom ledger row.
  if (!r.changes) throw new Error('Wallet user not found.');
  return recordTransaction(db, userId, 'credit', amt, reason, refType, refId, currency);
}

// Returns the new balance, or null when funds are insufficient.
async function debitWallet(db, userId, amount, reason, refType, refId, currency) {
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid debit amount.');
  const col = balCol(currency);
  const r = await db.prepare(
    `UPDATE users SET ${col} = ROUND((COALESCE(${col}, 0) - ?) * 100) / 100 WHERE id = ? AND COALESCE(${col}, 0) >= ?`
  ).run(amt, userId, amt);
  if (!r.changes) return null;
  return recordTransaction(db, userId, 'debit', amt, reason, refType, refId, currency);
}

// Refund the wallet portion of an order (gateway failure or admin cancel).
// Idempotent: the UPDATE guard means a second call refunds nothing.
// wallet_applied is stored in the order's currency; the refund goes back
// to the same currency's wallet.
async function refundWalletForOrder(db, order) {
  const applied = round2(order.wallet_applied || 0);
  if (applied <= 0) return 0;
  const r = await db.prepare(
    'UPDATE orders SET wallet_applied = 0 WHERE id = ? AND wallet_applied > 0'
  ).run(order.id);
  if (!r.changes) return 0;
  const cur = String(order.currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
  await creditWallet(
    db, order.user_id, applied,
    `Wallet refund for order #${order.id}`, 'refund', order.id, cur
  );
  return applied;
}

// Assign gift-card codes to a paid order for every voucher product in it.
// Claims the oldest active voucher of the matching amount, atomically, so two
// concurrent orders can never receive the same code. When the pool runs dry,
// the order is flagged with voucher_shortage = 1 and the admin is expected to
// generate more codes and deliver them manually.
// Backend-safe expiry comparison: SQLite stores dates as 'YYYY-MM-DD' text,
// the pg driver returns DATE columns as JS Date objects.
function notExpired(expiresAt, today) {
  if (!expiresAt) return true;
  const s = expiresAt instanceof Date
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  return s >= today;
}

async function assignVoucherCodes(db, orderId) {
  const order = await db.prepare('SELECT id, user_id FROM orders WHERE id = ?').get(orderId);
  if (!order) return;
  let items = [];
  try {
    const full = await db.prepare('SELECT items FROM orders WHERE id = ?').get(orderId);
    items = JSON.parse(full.items);
  } catch (e) { return; }
  if (!Array.isArray(items)) return;

  let shortage = 0;
  for (const it of items) {
    const p = await db.prepare(
      'SELECT id, is_voucher, voucher_amount, voucher_currency FROM products WHERE id = ?'
    ).get(it && it.product_id);
    if (!p || !p.is_voucher || !(Number(p.voucher_amount) > 0)) continue;
    const amount = round2(p.voucher_amount);
    const currency = String(p.voucher_currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
    const qty = Math.max(1, parseInt(it && it.qty, 10) || 1);
    const already = await db.prepare(
      'SELECT COUNT(*) AS c FROM order_vouchers WHERE order_id = ? AND product_id = ?'
    ).get(orderId, p.id);
    let need = qty - Number(already.c || 0);
    // Expiry is compared in JS (YYYY-MM-DD text) so this works on both backends.
    const today = new Date().toISOString().slice(0, 10);
    let guard = 0;
    while (need > 0 && guard < qty + 50) {
      guard += 1;
      const cands = await db.prepare(
        `SELECT id, code, expires_at FROM vouchers
         WHERE status = 'active' AND ROUND(amount, 2) = ROUND(?, 2)
           AND UPPER(COALESCE(currency, 'INR')) = ?
         ORDER BY id ASC LIMIT 50`
      ).all(amount, currency);
      const v = cands.find((c) => notExpired(c.expires_at, today));
      if (!v) { shortage = 1; break; } // pool exhausted (or only expired codes left)
      const claimed = await db.prepare(
        `UPDATE vouchers SET status = 'assigned', note = ?
         WHERE id = ? AND status = 'active'`
      ).run(`Assigned to order #${orderId}`, v.id);
      if (!claimed.changes) continue; // lost the race — try the next code
      await db.prepare(
        'INSERT INTO order_vouchers (order_id, voucher_id, product_id) VALUES (?, ?, ?)'
      ).run(orderId, v.id, p.id);
      need -= 1;
    }
    if (need > 0) shortage = 1;
  }
  if (shortage) {
    await db.prepare('UPDATE orders SET voucher_shortage = 1 WHERE id = ?').run(orderId);
  }
}

// Codes delivered to one order's buyer (buyer + admin visibility only).
async function voucherCodesForOrder(db, orderId) {
  return db.prepare(
    `SELECT v.code, v.amount, v.currency, ov.product_id
     FROM order_vouchers ov JOIN vouchers v ON v.id = ov.voucher_id
     WHERE ov.order_id = ? ORDER BY ov.id ASC`
  ).all(orderId);
}

module.exports = {
  generateVoucherCode,
  normalizeVoucherCode,
  round2,
  getBalance,
  creditWallet,
  debitWallet,
  refundWalletForOrder,
  assignVoucherCodes,
  voucherCodesForOrder,
};
