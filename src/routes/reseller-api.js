// Reseller API v1 — key-based access for third-party resellers.
//
// Auth: Authorization: Bearer mk_live_<key>
// Keys are issued in Admin -> API Keys and linked to a reseller's account.
// Orders are paid from the reseller's AV COINS wallet at reseller prices,
// so the reseller must top up their wallet (via the site or admin credit)
// before placing orders. Fulfilment stays manual unless the product has
// Busan auto-fulfil enabled (handleOrderPaid handles it like any paid order).

const express = require('express');
const crypto = require('crypto');
const { intIn, str, optStr } = require('../validate');
const { getBalance, debitWallet, creditWallet } = require('../wallet');
const { handleOrderPaid } = require('../order-paid');
const { tierOf, priceInCurrency: tierPriceInCurrency, toUsd } = require('../tier-pricing');

// In-memory per-key rate limiting: key id -> { count, resetAt }.
const rateBuckets = new Map();
function rateLimited(key) {
  const limit = key.rate_limit_per_min || 60;
  const now = Date.now();
  let b = rateBuckets.get(key.id);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(key.id, b);
  }
  b.count += 1;
  return b.count > limit;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());

  // ---- API key auth ----
  r.use(async (req, res, next) => {
    const hdr = String(req.headers.authorization || '');
    const m = hdr.match(/^Bearer\s+(mk_live_[0-9a-f]{32,})$/i);
    if (!m) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer mk_live_<key>.' });
    }
    const key = await db.prepare(
      `SELECT k.*, u.id AS uid, u.name AS uname, u.email AS uemail, u.role AS urole
       FROM reseller_api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ? AND k.active = 1`
    ).get(hashKey(m[1]));
    if (!key) {
      return res.status(401).json({ error: 'Invalid or revoked API key.' });
    }
    if (rateLimited(key)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Slow down and retry.' });
    }
    req.apiKey = key;
    req.apiUser = { id: key.uid, name: key.uname, email: key.uemail, role: key.urole };
    // Fire-and-forget usage stats.
    db.prepare('UPDATE reseller_api_keys SET last_used_at = ?, requests_count = requests_count + 1 WHERE id = ?')
      .run(new Date().toISOString(), key.id).catch(() => {});
    next();
  });

  const currencyOf = (req) =>
    String((req.query && req.query.currency) || (req.body && req.body.currency) || '').toUpperCase() === 'USD' ? 'USD' : 'INR';

  // Tier price of a product/variant row in the requested currency.
  // Gold falls back to silver, silver to regular (shared tier engine).
  const priceInCurrency = (row, tier, currency) => tierPriceInCurrency(row, tier, currency);

  const stockOf = (p) => {
    if (p.stock_status === 'out_of_stock') return 0;
    const q = p.stock_quantity === null || p.stock_quantity === undefined ? null : Number(p.stock_quantity);
    return q === null ? null : q; // null = unlimited
  };

  async function productPayload(p, tier, currency) {
    const variants = await db.prepare(
      `SELECT id, name, price_regular, price_silver, price_usd, price_usd_silver,
              cost_price, stock_status, sort_order, active
       FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY sort_order, id`
    ).all(p.id);
    const attrs = await db.prepare(
      `SELECT id, label, field_type, required, options, sort_order
       FROM product_checkout_attributes WHERE product_id = ? ORDER BY sort_order, id`
    ).all(p.id);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      image: p.image_url || null,
      category: p.category_name || null,
      currency,
      tier, // 'silver' — the reseller tier this key is priced at (gold removed 2026-10-07)
      price: priceInCurrency(p, tier, currency),
      price_regular: currency === 'USD'
        ? (p.price_usd != null ? Number(p.price_usd) : toUsd(p.price_regular))
        : Number(p.price_regular || 0),
      in_stock: stockOf(p) !== 0,
      stock: stockOf(p), // null = unlimited
      available_inr: p.available_inr !== 0,
      available_usd: p.available_usd !== 0,
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        price: priceInCurrency(v, tier, currency),
        in_stock: v.stock_status !== 'out_of_stock',
      })),
      required_fields: attrs.filter((a) => a.required).map((a) => ({
        attribute_id: a.id,
        label: a.label,
        type: a.field_type, // text | textarea | select
        options: a.field_type === 'select' && a.options ? JSON.parse(a.options) : undefined,
      })),
    };
  }

  // ---- GET /api/v1/products ----
  r.get('/products', async (req, res) => {
    const currency = currencyOf(req);
    const tier = tierOf(req.apiUser.role);
    const rows = await db.prepare(
      `SELECT p.id, p.name, p.slug, p.image_url, p.price_regular, p.p.price_silver,
              p.price_usd, p.p.price_usd_silver, p.stock_status, p.stock_quantity,
              p.active, p.available_inr, p.available_usd, c.name AS category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1 ORDER BY p.id`
    ).all();
    const out = [];
    for (const p of rows) out.push(await productPayload(p, tier, currency));
    res.json({ currency, count: out.length, products: out });
  });

  // ---- GET /api/v1/products/:id ----
  r.get('/products/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid product id.' });
    const currency = currencyOf(req);
    const p = await db.prepare(
      `SELECT p.id, p.name, p.slug, p.image_url, p.price_regular, p.p.price_silver,
              p.price_usd, p.p.price_usd_silver, p.stock_status, p.stock_quantity,
              p.active, p.available_inr, p.available_usd, c.name AS category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ? AND p.active = 1`
    ).get(id);
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    res.json(await productPayload(p, tier, currency));
  });

  // ---- GET /api/v1/balance ----
  r.get('/balance', async (req, res) => {
    res.json({
      currency_note: 'AV COINS wallets are separate per currency; 1 coin = 1 unit of that currency.',
      inr: await getBalance(db, req.apiUser.id, 'INR'),
      usd: await getBalance(db, req.apiUser.id, 'USD'),
    });
  });

  // ---- POST /api/v1/orders ----
  // Body: { currency?, customer?: {name, phone, email},
  //         items: [{ product_id, variant_id?, qty?, answers?: {attribute_id: value} | [{attribute_id, value}] }] }
  // The full total is debited from the reseller's wallet; the order is
  // created as paid and queued for (manual or auto) fulfilment.
  r.post('/orders', async (req, res) => {
    const b = req.body || {};
    const currency = currencyOf(req);
    const items = b.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: 'items must be a non-empty array (max 50).' });
    }

    const snapshot = [];
    const decrements = [];
    let subtotal = 0;
    for (const it of items) {
      const productId = intIn(it && it.product_id, 1, 2147483647);
      const variantId = intIn(it && it.variant_id, 1, 2147483647);
      const qty = intIn(it && it.qty, 1, 10);
      if (!productId || !qty) return res.status(400).json({ error: 'Each item needs product_id and qty (1-10).' });

      const tier = tierOf(req.apiUser.role);
      const p = await db.prepare(
        `SELECT id, name, price_regular, price_silver, price_usd, price_usd_silver,
                cost_price, stock_status, stock_quantity, active, available_inr, available_usd
         FROM products WHERE id = ?`
      ).get(productId);
      if (!p || !p.active) return res.status(400).json({ error: `Product ${productId} is not available.` });
      if (currency === 'USD' ? p.available_usd === 0 : p.available_inr === 0) {
        return res.status(400).json({ error: `${p.name} is not sold in ${currency}.` });
      }
      const stock = stockOf(p);
      if (stock === 0) return res.status(400).json({ error: `${p.name} is sold out.` });
      if (stock !== null && qty > stock) {
        return res.status(400).json({ error: `${p.name} only has ${stock} left in stock.` });
      }

      let variant = null;
      if (variantId) {
        variant = await db.prepare(
          `SELECT id, name, price_regular, price_silver, price_usd, price_usd_silver,
                  cost_price, stock_status, active
           FROM product_variants WHERE id = ? AND product_id = ?`
        ).get(variantId, productId);
        if (!variant || !variant.active) {
          return res.status(400).json({ error: `Option ${variantId} for ${p.name} is not available.` });
        }
        if (variant.stock_status === 'out_of_stock') {
          return res.status(400).json({ error: `${p.name} (${variant.name}) is sold out.` });
        }
      } else {
        const hasVariants = await db.prepare(
          'SELECT id FROM product_variants WHERE product_id = ? AND active = 1 LIMIT 1'
        ).get(productId);
        if (hasVariants) {
          return res.status(400).json({ error: `Please choose a variant_id for ${p.name}.` });
        }
      }

      // Required checkout fields (e.g. Character ID).
      const attrs = await db.prepare(
        'SELECT id, label, field_type, required, options FROM product_checkout_attributes WHERE product_id = ? ORDER BY sort_order, id'
      ).all(p.id);
      let answers = (it && it.answers) || {};
      if (Array.isArray(answers)) {
        const map = {};
        for (const a of answers) if (a && a.attribute_id != null) map[a.attribute_id] = a.value;
        answers = map;
      }
      const checkoutAnswers = [];
      for (const a of attrs) {
        const val = String(answers[a.id] != null ? answers[a.id] : answers[String(a.id)] || '').trim();
        if (a.required && !val) {
          return res.status(400).json({ error: `Missing required field "${a.label}" (attribute_id ${a.id}) for ${p.name}.` });
        }
        if (val && a.field_type === 'select' && a.options) {
          let opts = null;
          try { opts = JSON.parse(a.options); } catch (_) { opts = null; }
          if (Array.isArray(opts) && opts.length && !opts.includes(val)) {
            return res.status(400).json({ error: `Invalid choice for "${a.label}".` });
          }
        }
        if (val) checkoutAnswers.push({ label: a.label, value: val.slice(0, 500) });
      }

      const src = variant || p;
      const unit = priceInCurrency(src, tier, currency);
      // Same ₹0-price guard: reseller orders debit the wallet, so a ₹0 line
      // would mean free fulfilment.
      if (!(Number(unit) > 0)) return res.status(400).json({ error: `${p.name} is not priced yet — please contact support on WhatsApp.` });
      const costSrc = variant && variant.cost_price !== null && variant.cost_price !== undefined
        ? variant.cost_price : p.cost_price;
      snapshot.push({
        product_id: p.id, variant_id: variant ? variant.id : null,
        variant_name: variant ? variant.name : null, name: p.name, qty,
        unit_price: unit,
        unit_cost: costSrc === null || costSrc === undefined ? null : Number(costSrc),
        checkout_answers: checkoutAnswers,
      });
      subtotal += unit * qty;

      decrements.push({ product_id: p.id, stock, qty });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const total = subtotal;
    // ₹0 guard: debitWallet throws on 0 and a free order must never be created.
    if (!(total > 0)) return res.status(400).json({ error: 'Order total must be greater than zero.' });

    // Customer details for fulfilment; default to the reseller's own account.
    const customer = b.customer || {};
    const buyerName = str(customer.name, 120) || req.apiUser.name || 'Reseller customer';
    const buyerPhone = str(customer.phone, 24) || '';
    const buyerEmail = (str(customer.email, 160) || '').toLowerCase() || req.apiUser.email || '';
    const buyerAge = intIn(customer.age, 1, 150) || null;

    // Full wallet debit — resellers prepay from their AV COINS wallet.
    const bal = await getBalance(db, req.apiUser.id, currency);
    if (bal < total) {
      return res.status(402).json({
        error: `Insufficient ${currency} wallet balance. Need ${total}, have ${bal}. Top up your wallet first.`,
        need: total, have: bal, currency,
      });
    }
    const debited = await debitWallet(
      db, req.apiUser.id, total, 'Reseller API order', 'order', null, currency
    );
    if (debited === null) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    let orderId;
    try {
      const info = await db.prepare(
        `INSERT INTO orders (user_id, items, subtotal, discount, coupon_code, total, wallet_applied,
                            currency, buyer_name, buyer_phone, buyer_email, buyer_age, buyer_agreed,
                            status, paid_claimed, payment_note)
         VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'paid', 1, 'Reseller API order')`
      ).run(req.apiUser.id, JSON.stringify(snapshot), subtotal, total, total, currency,
        buyerName, buyerPhone, buyerEmail, buyerAge);
      orderId = info.lastInsertRowid;
      for (const d of decrements) {
        if (d.stock !== null) {
          // Atomic decrement: race-safe for the last units — the loser gets
          // changes === 0 and the catch below refunds + cancels cleanly.
          const dec = await db.prepare(
            "UPDATE products SET stock_quantity = stock_quantity - ?, stock_status = CASE WHEN stock_quantity - ? <= 0 THEN 'out_of_stock' ELSE stock_status END WHERE id = ? AND stock_quantity >= ?"
          ).run(d.qty, d.qty, d.product_id, d.qty);
          if (!dec.changes) {
            throw Object.assign(new Error('An item just sold out. Please retry with available stock.'), { code: 'STOCK_RACE' });
          }
        }
      }
      await db.prepare(
        "INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reason, ref_type, ref_id) VALUES (?, 'debit', ?, ?, ?, 'order', ?)"
      ).run(req.apiUser.id, total, await getBalance(db, req.apiUser.id, currency),
        `Wallet payment for reseller API order #${orderId}`, orderId).catch(() => {});
      await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)')
        .run(orderId, 'paid', `Paid in full from reseller wallet (${total} ${currency}).`);
    } catch (e) {
      // Never leave a reseller charged without an order: refund the debit.
      await creditWallet(db, req.apiUser.id, total, `Refund: reseller API order failed`, 'order', null, currency).catch(() => {});
      console.error('[reseller-api] order failed after debit, refunded:', e && e.message);
      if (orderId) {
        // Fail closed: the row was INSERTed as 'paid' before the failure — a
        // paid row with refunded money must never be deliverable. Cancel it
        // (wallet_applied zeroed so a later admin cancel can't double-refund)
        // with an audit note.
        await db.prepare("UPDATE orders SET status = 'cancelled', wallet_applied = 0 WHERE id = ? AND status = 'paid'").run(orderId).catch(() => {});
        await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)')
          .run(orderId, 'cancelled', 'Order failed after wallet debit — wallet refunded and order auto-cancelled; do not fulfil.').catch(() => {});
      }
      if (e && e.code === 'STOCK_RACE') {
        return res.status(400).json({ error: e.message });
      }
      return res.status(500).json({ error: 'Order could not be created; your wallet was refunded.' });
    }
    handleOrderPaid(db, orderId);

    res.status(201).json({
      id: orderId,
      status: 'paid',
      currency,
      total,
      items: snapshot.map((s) => ({
        product_id: s.product_id, variant_id: s.variant_id, variant_name: s.variant_name,
        name: s.name, qty: s.qty, unit_price: s.unit_price,
      })),
    });
  });

  const orderPayload = (o) => {
    let items = [];
    try { items = JSON.parse(o.items || '[]'); } catch (_) { items = []; }
    return {
      id: o.id,
      status: o.status,
      currency: o.currency,
      total: o.total,
      paid_claimed: !!o.paid_claimed,
      delivery_note: o.delivery_note || null,
      created_at: o.created_at,
      items: items.map((s) => ({
        product_id: s.product_id, variant_id: s.variant_id, variant_name: s.variant_name,
        name: s.name, qty: s.qty, unit_price: s.unit_price,
        answers: s.checkout_answers || [],
      })),
    };
  };

  // ---- GET /api/v1/orders ----
  r.get('/orders', async (req, res) => {
    const status = str(req.query.status, 20);
    const limit = Math.min(intIn(req.query.limit, 1, 100) || 20, 100);
    const page = Math.max(intIn(req.query.page, 1, 100000) || 1, 1);
    const where = status ? 'AND status = ?' : '';
    const params = status ? [req.apiUser.id, status, limit, (page - 1) * limit] : [req.apiUser.id, limit, (page - 1) * limit];
    const rows = await db.prepare(
      `SELECT * FROM orders WHERE user_id = ? ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(...params);
    const total = await db.prepare(
      `SELECT COUNT(*) AS c FROM orders WHERE user_id = ? ${where}`
    ).get(...(status ? [req.apiUser.id, status] : [req.apiUser.id]));
    res.json({ page, limit, total: total.c, orders: rows.map(orderPayload) });
  });

  // ---- GET /api/v1/orders/:id ----
  r.get('/orders/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid order id.' });
    const o = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.apiUser.id);
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    res.json(orderPayload(o));
  });

  return r;
};
