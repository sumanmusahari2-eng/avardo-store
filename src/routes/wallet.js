// Wallet: balance, transaction history, gift-card redemption.
const express = require('express');
const { requireAuth } = require('../auth');
const { intIn } = require('../validate');
const {
  getBalance,
  creditWallet,
  normalizeVoucherCode,
} = require('../wallet');

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());
  r.use(requireAuth);

  // Balance + recent transactions (newest first, 20 per page).
  r.get('/', async (req, res) => {
    const page = intIn(req.query.page, 1, 1000) || 1;
    const per = 20;
    const balance = await getBalance(db, req.user.id, 'INR');
    const balanceUsd = await getBalance(db, req.user.id, 'USD');
    const transactions = await db.prepare(
      `SELECT id, type, amount, balance_after, reason, ref_type, ref_id, currency, created_at
       FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(req.user.id, per, (page - 1) * per);
    res.json({ balance, balance_usd: balanceUsd, transactions, page });
  });

  // Redeem a gift-card voucher code once -> credit the wallet.
  r.post('/redeem', async (req, res) => {
    const code = normalizeVoucherCode(req.body && req.body.code);
    if (!code) {
      return res.status(400).json({ error: 'Enter a valid gift-card code (e.g. MO-XXXX-XXXX-XXXX).' });
    }
    const v = await db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
    if (!v) {
      return res.status(400).json({ error: 'This gift-card code is invalid.' });
    }
    if (v.status === 'redeemed') {
      return res.status(400).json({ error: 'This code has already been redeemed.' });
    }
    if (v.status === 'disabled') {
      return res.status(400).json({ error: 'This code has been disabled. Contact support.' });
    }
    if (v.status !== 'active' && v.status !== 'assigned') {
      return res.status(400).json({ error: 'This gift-card code is invalid.' });
    }
    // An assigned code belongs to the buyer of its order — nobody else may use it.
    if (v.status === 'assigned') {
      const link = await db.prepare('SELECT order_id FROM order_vouchers WHERE voucher_id = ?').get(v.id);
      const ord = link
        ? await db.prepare('SELECT user_id FROM orders WHERE id = ?').get(link.order_id)
        : null;
      if (!ord || Number(ord.user_id) !== req.user.id) {
        return res.status(400).json({ error: 'This code is assigned to another order.' });
      }
    }
    if (v.expires_at) {
      const expStr = String(v.expires_at).trim();
      const exp = new Date(expStr.length <= 10 ? expStr + 'T23:59:59' : expStr);
      if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
        return res.status(400).json({ error: 'This code has expired.' });
      }
    }
    const now = new Date().toISOString();
    // Face value is locked to the voucher's currency — it never shifts with the
    // storefront display currency. Each currency credits its own wallet:
    // INR vouchers → INR wallet, USD vouchers → USD wallet. No conversion.
    const vCurrency = String(v.currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
    // A voucher can only be redeemed while the matching currency is active:
    // $ vouchers in $ mode, ₹ vouchers in ₹ mode.
    // NOTE: this check MUST run before the voucher is marked redeemed below —
    // otherwise a wrong-currency attempt would burn the code with no credit.
    const reqCurrency = String((req.body && req.body.currency) || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
    if (reqCurrency !== vCurrency) {
      const want = vCurrency === 'USD' ? '$ (USD)' : '₹ (INR)';
      return res.status(400).json({ error: `This is a ${want} gift card. Switch your currency to ${want} to redeem it.` });
    }
    const claimed = await db.prepare(
      `UPDATE vouchers SET status = 'redeemed', redeemed_by = ?, redeemed_at = ?
       WHERE id = ? AND status IN ('active', 'assigned')`
    ).run(req.user.id, now, v.id);
    if (!claimed.changes) {
      return res.status(400).json({ error: 'This code has already been redeemed.' });
    }
    const coins = Number(v.amount);
    const balance = await creditWallet(
      db, req.user.id, coins, `Gift-card redemption ${v.code}`, 'voucher', v.id, vCurrency
    );
    res.json({ balance, amount: Number(v.amount), currency: vCurrency, coins });
  });

  return r;
};
