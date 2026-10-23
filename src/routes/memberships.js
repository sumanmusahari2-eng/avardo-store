// Customer-facing reseller memberships: buy the silver package with the
// AV COINS (INR) wallet. Memberships last membership_duration_days and
// auto-disconnect (role -> customer) when they expire.
const express = require('express');
const { requireAuth } = require('../auth');
const { debitWallet, getBalance } = require('../wallet');
const {
  membershipConfig,
  membershipStatus,
  grantMembership,
} = require('../memberships');

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());

  // Public package info (prices + duration) + the caller's membership status.
  r.get('/status', async (req, res) => {
    const cfg = await membershipConfig(db);
    const out = {
      silver_price: cfg.silver_price,
      duration_days: cfg.duration_days,
      currency: 'INR',
      tier: null,
      expires_at: null,
    };
    if (req.user) {
      const st = await membershipStatus(db, req.user.id);
      out.tier = st.tier;
      out.expires_at = st.expires_at || null;
    }
    res.json(out);
  });

  // Buy (or extend) a membership from the INR wallet.
  // NOTE (2026-10-06): the Gold plan is discontinued — only Silver can be bought.
  r.post('/buy', requireAuth, async (req, res) => {
    const tier = req.body && req.body.tier;
    if (tier === 'gold') {
      return res.status(400).json({ error: 'The Gold plan has been discontinued. Only Silver is available.' });
    }
    if (tier !== 'silver') {
      return res.status(400).json({ error: 'Choose the silver package.' });
    }
    if (req.user.role === 'admin') {
      return res.status(400).json({ error: 'Admin accounts already have full access.' });
    }
    const cfg = await membershipConfig(db);
    const price = cfg.silver_price;
    const balance = await getBalance(db, req.user.id, 'INR');
    if (balance < price) {
      return res.status(402).json({
        error: `Not enough AV COINS (INR). You need ₹${price} — top up your wallet first.`,
        price,
        balance,
      });
    }
    const tx = await debitWallet(
      db, req.user.id, price,
      `Silver reseller membership (${cfg.duration_days} days)`,
      'membership', null, 'INR'
    );
    if (!tx) return res.status(402).json({ error: 'Wallet debit failed. Please try again.' });
    try {
      const m = await grantMembership(db, req.user.id, tier, cfg.duration_days, 'wallet', price);
      res.json({ ok: true, tier: m.tier, expires_at: m.expires_at, price });
    } catch (e) {
      // Refund on grant failure so the user never pays for nothing.
      const { creditWallet } = require('../wallet');
      await creditWallet(db, req.user.id, price, 'Membership activation failed — refund', 'membership_refund', null, 'INR').catch(() => {});
      return res.status(500).json({ error: 'Could not activate the membership. Your wallet was refunded.' });
    }
  });

  return r;
};
