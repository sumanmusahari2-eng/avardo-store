const express = require('express');
const { requireRole } = require('../auth');

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());
  r.use(requireRole('silver', 'admin'));

  r.get('/summary', async (req, res) => {
    const stats = await db.prepare(
      `SELECT COUNT(*) AS orders_count,
              COALESCE(SUM(CASE WHEN status IN ('paid','delivered') THEN total ELSE 0 END), 0) AS total_spent
       FROM orders WHERE user_id = ?`
    ).get(req.user.id);
    const me = await db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
    res.json({
      balance: me ? me.balance : 0,
      orders_count: stats.orders_count,
      total_spent: Math.round(stats.total_spent * 100) / 100,
    });
  });

  return r;
};
