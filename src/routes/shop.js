const express = require('express');
const { requireAuth } = require('../auth');
const { optStr, str, intIn } = require('../validate');
const { verifyTurnstile } = require('../turnstile');
const { handleOrderPaid } = require('../order-paid');
const { notifyManualPaidClaimed } = require('../notify');
const { getBalance, debitWallet, creditWallet, voucherCodesForOrder } = require('../wallet');
const { tierOf, priceInCurrency: tierPriceInCurrency } = require('../tier-pricing');
const { buildInvoicePayload } = require('../invoices');

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());
  r.use(requireAuth);

  const tier = (req) => tierOf(req.user && req.user.role);

  const paymentInfo = async () => {
    const get = async (k) => {
      const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      return row ? row.value : '';
    };
    const cryptoRateRaw = await get('crypto_usd_rate');
    const cryptoRateParsed = parseFloat(cryptoRateRaw);
    return {
      upi_id: await get('upi_id'),
      whatsapp_number: await get('whatsapp_number'),
      instructions: await get('payment_instructions'),
      xtra_enabled: !!((process.env.XTRA_USER_TOKEN || '').trim()),
      crypto_enabled: !!((process.env.CRYPTOPAY_API_KEY || '').trim()),
      divinex_enabled: !!((process.env.DIVINEXPAY_API_KEY || '').trim()),
      crypto_usd_rate: (Number.isFinite(cryptoRateParsed) && cryptoRateParsed > 0) ? cryptoRateParsed : 88,
    };
  };

  // Resolve a coupon against a computed subtotal.
  // Returns { coupon, discount } or { error } — never throws.
  // Flat (fixed-amount) coupons are stored in INR; converted for USD orders.
  const resolveCoupon = async (rawCode, subtotal, currency) => {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return { error: 'Enter a coupon code.' };
    const coupon = await db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
    if (!coupon || !coupon.active) return { error: 'This coupon is invalid or inactive.' };
    if (coupon.expires_at) {
      const expStr = String(coupon.expires_at).trim();
      const exp = new Date(expStr.length <= 10 ? expStr + 'T23:59:59' : expStr);
      if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
        return { error: 'This coupon has expired.' };
      }
    }
    if (coupon.usage_limit !== null && coupon.usage_limit !== undefined &&
        Number(coupon.used_count) >= Number(coupon.usage_limit)) {
      return { error: 'This coupon has reached its usage limit.' };
    }
    const raw = coupon.discount_type === 'percent'
      ? (subtotal * Number(coupon.discount_value)) / 100
      : (currency === 'USD' ? toUsd(coupon.discount_value) : Number(coupon.discount_value));
    const discount = Math.round(Math.min(subtotal, Math.max(0, raw)) * 100) / 100;
    return { coupon, discount };
  };

  // Fixed store rate for INR<->USD conversion (matches the storefront CURRENCIES table).
  const USD_RATE = 103;
  const toUsd = (inr) => Math.round((Number(inr) / USD_RATE) * 100) / 100;
  const orderCurrency = (req) =>
    String((req.body && req.body.currency) || '').toUpperCase() === 'USD' ? 'USD' : 'INR';

  // Unit price of a product/variant row for the buyer's tier in the
  // requested currency. Shared tier engine (gold -> silver -> regular).
  const priceInCurrency = (row, t, currency) => tierPriceInCurrency(row, t, currency);

  // Compute the cart subtotal server-side (no coupon).
  // Items may carry variant_id; when a product has active variants the variant
  // price applies, otherwise the base product price applies.
  const resolveLinePrice = async (req, productId, variantId, currency) => {
    const t = tier(req);
    const p = await db.prepare(
      'SELECT id, name, price_regular, price_gold, price_silver, price_usd, price_usd_gold, price_usd_silver, cost_price, stock_status, stock_quantity, active, available_inr, available_usd FROM products WHERE id = ?'
    ).get(productId);
    if (!p || !p.active) return { error: 'A product in your cart is no longer available.' };
    // Per-product currency availability: block checkout in a currency the product isn't sold in.
    if (currency === 'USD' ? (p.available_usd === 0) : (p.available_inr === 0)) {
      return { error: `${p.name} is not available in ${currency === 'USD' ? 'USD' : 'INR'}.` };
    }
    let variant = null;
    if (variantId) {
      variant = await db.prepare(
        'SELECT id, name, price_regular, price_gold, price_silver, price_usd, price_usd_gold, price_usd_silver, cost_price, stock_status, active FROM product_variants WHERE id = ? AND product_id = ?'
      ).get(variantId, productId);
      if (!variant || !variant.active) return { error: `A selected option for ${p.name} is no longer available.` };
      if (variant.stock_status === 'out_of_stock') {
        return { error: `${p.name} (${variant.name}) is sold out.` };
      }
    } else {
      const hasVariants = await db.prepare(
        'SELECT id FROM product_variants WHERE product_id = ? AND active = 1 LIMIT 1'
      ).get(productId);
      if (hasVariants) return { error: `Please select an option for ${p.name}.` };
    }
    const src = variant || p;
    const unit = priceInCurrency(src, t, currency);
    // Snapshot the cost at purchase time so profit stays accurate even if the
    // product's cost price changes later. null = unknown cost.
    const costSrc = variant && variant.cost_price !== null && variant.cost_price !== undefined
      ? variant.cost_price : p.cost_price;
    const unitCost = costSrc === null || costSrc === undefined ? null : Number(costSrc);
    return { product: p, variant, unit, unitCost };
  };

  const cartSubtotal = async (req, items, currency) => {
    let subtotal = 0;
    for (const it of items) {
      const productId = intIn(it && it.product_id, 1, 2147483647);
      const variantId = intIn(it && it.variant_id, 1, 2147483647);
      const qty = intIn(it && it.qty, 1, 10);
      if (!productId || !qty) return { error: 'Invalid cart items.' };
      const line = await resolveLinePrice(req, productId, variantId, currency);
      if (line.error) return { error: line.error };
      subtotal += line.unit * qty;
    }
    return { subtotal: Math.round(subtotal * 100) / 100 };
  };

  // Validate a coupon against the current cart.
  r.post('/coupons/validate', async (req, res) => {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }
    const currency = orderCurrency(req);
    const cart = await cartSubtotal(req, items, currency);
    if (cart.error) return res.status(400).json({ error: cart.error });
    const cr = await resolveCoupon(req.body && req.body.code, cart.subtotal, currency);
    if (cr.error) return res.status(400).json({ error: cr.error });
    res.json({
      code: cr.coupon.code,
      subtotal: cart.subtotal,
      discount: cr.discount,
      total: Math.round((cart.subtotal - cr.discount) * 100) / 100,
    });
  });

  // Create an order (status: pending). Prices are always computed server-side.
  r.post('/checkout', async (req, res) => {
    const ts = await verifyTurnstile(req.body && req.body.turnstile_token, req.ip);
    if (!ts.ok) return res.status(400).json({ error: ts.error });
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }
    const t = tier(req);
    const currency = orderCurrency(req);
    const answers = Array.isArray(req.body && req.body.checkout_answers) ? req.body.checkout_answers : [];
    const couponCode = req.body && typeof req.body.coupon_code === 'string' ? req.body.coupon_code.trim() : '';

    // Buyer details: compulsory for every checkout.
    const buyer = (req.body && req.body.buyer) || {};
    const buyerName = str(buyer.name, 120);
    const buyerPhoneCc = str(buyer.phone_cc, 8);
    const buyerPhoneNum = str(buyer.phone, 20).replace(/[\s\-()]/g, '');
    const buyerEmail = str(buyer.email, 160).toLowerCase();
    const buyerAge = intIn(buyer.age, 1, 150);
    const buyerAgreed = buyer.agreed === true;
    if (!buyerName) return res.status(400).json({ error: 'Please enter your full name.' });
    if (!/^\+\d{1,5}$/.test(buyerPhoneCc)) return res.status(400).json({ error: 'Please select your country code.' });
    if (!/^\d{6,15}$/.test(buyerPhoneNum)) return res.status(400).json({ error: 'Please enter a valid phone number.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(buyerEmail)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!buyerAge || buyerAge < 18) return res.status(400).json({ error: 'You must be at least 18 years old to place an order.' });
    if (!buyerAgreed) return res.status(400).json({ error: 'Please tick the agreement box to confirm your purchase.' });
    const buyerPhone = buyerPhoneCc + buyerPhoneNum;

    const snapshot = [];
    const lines = [];
    let subtotal = 0;
    for (const it of items) {
      const productId = intIn(it && it.product_id, 1, 2147483647);
      const variantId = intIn(it && it.variant_id, 1, 2147483647);
      const qty = intIn(it && it.qty, 1, 10);
      if (!productId || !qty) return res.status(400).json({ error: 'Invalid cart items.' });
      const line = await resolveLinePrice(req, productId, variantId, currency);
      if (line.error) return res.status(400).json({ error: line.error });
      const p = line.product, variant = line.variant, unit = line.unit, unitCost = line.unitCost;
      if (!(unit > 0)) {
        return res.status(400).json({ error: `${p.name} is not priced yet — please contact support on WhatsApp.` });
      }
      const stock = p.stock_quantity === null || p.stock_quantity === undefined ? null : Number(p.stock_quantity);
      if (p.stock_status === 'out_of_stock' || stock === 0) {
        return res.status(400).json({ error: `${p.name} is sold out.` });
      }
      if (stock !== null && qty > stock) {
        return res.status(400).json({ error: `${p.name} only has ${stock} left in stock.` });
      }
      snapshot.push({
        product_id: p.id, variant_id: variant ? variant.id : null, variant_name: variant ? variant.name : null,
        name: p.name, qty, unit_price: unit, unit_cost: unitCost, checkout_answers: [],
      });
      lines.push({ product: p, qty });
      subtotal += unit * qty;
    }
    subtotal = Math.round(subtotal * 100) / 100;

    // Coupon: validate strictly — an invalid code is a 400, never silently ignored.
    let coupon = null;
    let discount = 0;
    if (couponCode) {
      const cr = await resolveCoupon(couponCode, subtotal, currency);
      if (cr.error) return res.status(400).json({ error: cr.error });
      coupon = cr.coupon;
      discount = cr.discount;
    }
    const total = Math.round((subtotal - discount) * 100) / 100;

    // Validate required checkout attributes per product, and attach answers to the snapshot.
    for (const line of lines) {
      const p = line.product;
      const attrs = await db.prepare(
        'SELECT id, label, field_type, required, sort_order, options FROM product_checkout_attributes WHERE product_id = ? ORDER BY sort_order, id'
      ).all(p.id);
      for (const a of attrs) {
        if (!a.required) continue;
        const ans = answers.find(
          (x) => Number(x && x.product_id) === p.id && Number(x && x.attribute_id) === a.id
        );
        const val = ans && typeof ans.value === 'string' ? ans.value.trim() : '';
        if (!val) {
          return res.status(400).json({ error: `Please fill in "${a.label}" for ${p.name}.` });
        }
        // Dropdown answers must be one of the configured options.
        if (a.field_type === 'select' && a.options) {
          let opts = null;
          try { opts = JSON.parse(a.options); } catch (_) { opts = null; }
          if (Array.isArray(opts) && opts.length && !opts.includes(val)) {
            return res.status(400).json({ error: `Invalid choice for "${a.label}".` });
          }
        }
      }
      const item = snapshot.find((s) => s.product_id === p.id);
      item.checkout_answers = answers
        .filter((x) => Number(x && x.product_id) === p.id)
        .map((x) => {
          const a = attrs.find((at) => at.id === Number(x.attribute_id));
          return {
            label: a ? a.label : 'Note',
            value: String(x && x.value ? x.value : '').slice(0, 500),
          };
        });
    }

    // Wallet: separate INR and USD balances. The order's currency decides
    // which wallet is used — no conversion between them.
    const walletUse = !!(req.body && req.body.wallet_use);
    let walletApplied = 0;
    if (walletUse && total > 0) {
      const bal = await getBalance(db, req.user.id, currency);
      walletApplied = Math.min(bal, total);
      walletApplied = Math.round(walletApplied * 100) / 100;
    }
    // Debit first (atomic, guarded by the balance check inside debitWallet).
    // If anything below fails, the debit is refunded before the error propagates.
    if (walletApplied > 0) {
      const debited = await debitWallet(
        db, req.user.id, walletApplied,
        'Wallet payment (order pending)', 'order', null, currency
      );
      if (debited === null) {
        return res.status(400).json({ error: 'Insufficient wallet balance.' });
      }
    }

    try {
      const paymentNote = optStr(req.body.payment_note, 500);
      const info = await db.prepare(
        'INSERT INTO orders (user_id, items, subtotal, discount, coupon_code, total, wallet_applied, currency, payment_note, buyer_name, buyer_phone, buyer_email, buyer_age, buyer_agreed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.user.id, JSON.stringify(snapshot), subtotal, discount, coupon ? coupon.code : null, total, walletApplied, currency, paymentNote,
        buyerName, buyerPhone, buyerEmail, buyerAge, 1);
      const orderId = info.lastInsertRowid;

      // NOTE: no manual ledger insert here — debitWallet() already records
      // the wallet_transactions entry (an extra insert double-counts, and
      // the old block referenced an undefined variable that 500'd checkout).

      // Decrement stock; mark out_of_stock when it hits zero.
      for (const line of lines) {
        const stock = line.product.stock_quantity === null || line.product.stock_quantity === undefined
          ? null : Number(line.product.stock_quantity);
        if (stock !== null) {
          const next = Math.max(0, stock - line.qty);
          await db.prepare(
            "UPDATE products SET stock_quantity = ?, stock_status = CASE WHEN ? = 0 THEN 'out_of_stock' ELSE stock_status END WHERE id = ?"
          ).run(next, next, line.product.id);
        }
      }
      // Coupon usage.
      if (coupon) {
        await db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(coupon.id);
      }

      const remaining = Math.round((total - walletApplied) * 100) / 100;
      if (remaining <= 0) {
        // Wallet covered everything: the order is paid right away.
        await db.prepare("UPDATE orders SET status = 'paid', paid_claimed = 1 WHERE id = ?").run(orderId);
        await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)').run(
          orderId, 'paid', `Paid in full with wallet balance (${walletApplied.toFixed(2)}).`
        );
        handleOrderPaid(db, orderId);
        return res.status(201).json({
          id: orderId,
          subtotal,
          discount,
          coupon_code: coupon ? coupon.code : null,
          total,
          wallet_applied: walletApplied,
          remaining: 0,
          status: 'paid',
        });
      }

      // First order update.
      await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)').run(
        orderId, 'pending',
        walletApplied > 0
          ? `Order placed. ${walletApplied.toFixed(2)} paid from wallet — complete the remaining payment to continue.`
          : 'Order placed. Complete the manual payment instructions to continue.'
      );

      res.status(201).json({
        id: orderId,
        subtotal,
        discount,
        coupon_code: coupon ? coupon.code : null,
        total,
        wallet_applied: walletApplied,
        remaining,
        status: 'pending',
      });
    } catch (e) {
      if (walletApplied > 0) {
        await creditWallet(db, req.user.id, walletApplied, 'Wallet refund — order could not be placed', 'refund', null, currency)
          .catch(() => {});
      }
      throw e;
    }
  });

  r.get('/orders', async (req, res) => {
    const rows = await db.prepare(
      `SELECT id, total, status, paid_claimed, created_at,
              json_array_length(items) AS item_count
       FROM orders WHERE user_id = ? ORDER BY id DESC`
    ).all(req.user.id);
    res.json(rows);
  });

  r.get('/orders/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid order id.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    let items = [];
    try { items = JSON.parse(order.items); } catch (e) { /* keep empty */ }
    const updates = await db.prepare(
      'SELECT id, status, message, created_at FROM order_updates WHERE order_id = ? ORDER BY id ASC'
    ).all(order.id);
    // Gift-card codes delivered with this order (buyer + admin visibility only).
    let voucherCodes = [];
    try { voucherCodes = await voucherCodesForOrder(db, order.id); } catch (e) { /* keep empty */ }
    res.json({
      id: order.id,
      items,
      subtotal: order.subtotal || 0,
      discount: order.discount || 0,
      coupon_code: order.coupon_code || null,
      total: order.total,
      currency: order.currency || 'INR',
      wallet_applied: order.wallet_applied || 0,
      voucher_shortage: !!order.voucher_shortage,
      voucher_codes: voucherCodes,
      status: order.status,
      topzy_status: order.topzy_status || null,
      payment_note: order.payment_note,
      paid_claimed: !!order.paid_claimed,
      delivery_note: order.delivery_note,
      updates,
      created_at: order.created_at,
      payment: await paymentInfo(),
    });
  });

  // Invoice for an order (owner or admin). Issued lazily for paid/delivered orders.
  r.get('/invoices/:orderId', async (req, res) => {
    const id = intIn(req.params.orderId, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid order id.' });
    const order = await db.prepare('SELECT id, user_id FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isAdmin && order.user_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    try {
      res.json(await buildInvoicePayload(db, id));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message || 'Could not generate invoice.' });
    }
  });

  // Customer confirms they have paid; admin still has to verify.
  r.post('/orders/:id/mark-paid', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid order id.' });
    const order = await db.prepare(
      'SELECT id, status, paid_claimed, user_id, items, total, currency, buyer_name, buyer_phone, buyer_email FROM orders WHERE id = ?'
    ).get(id);
    if (!order || order.user_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending orders can be marked as paid.' });
    }
    const firstClaim = !order.paid_claimed;
    await db.prepare('UPDATE orders SET paid_claimed = 1 WHERE id = ?').run(id);
    // Telegram ping so the admin knows to verify this manual payment.
    if (firstClaim) {
      notifyManualPaidClaimed({
        storeName: 'Avardo Official',
        adminUrl: 'https://www.mlbbstore.in/admin',
        order,
      });
    }
    res.json({ ok: true, paid_claimed: 1 });
  });

  // Has this user had a delivered order containing this product?
  const userPurchasedDelivered = async (userId, productId) => {
    const orders = await db.prepare(
      "SELECT items FROM orders WHERE user_id = ? AND status = 'delivered'"
    ).all(userId);
    for (const o of orders) {
      try {
        const items = JSON.parse(o.items);
        if (Array.isArray(items) && items.some((it) => Number(it && it.product_id) === productId)) {
          return true;
        }
      } catch (e) { /* ignore malformed snapshots */ }
    }
    return false;
  };

  // Submit a review (moderated: approved = 0 until an admin approves).
  r.post('/reviews', async (req, res) => {
    const productId = intIn(req.body && req.body.product_id, 1, 2147483647);
    const rating = intIn(req.body && req.body.rating, 1, 5);
    const text = str(req.body && req.body.text, 400);
    if (!productId) return res.status(400).json({ error: 'Invalid product.' });
    if (!rating) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    if (!text || text.length < 10) return res.status(400).json({ error: 'Please write at least 10 characters.' });
    const product = await db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    const existing = await db.prepare('SELECT id FROM reviews WHERE user_id = ? AND product_id = ?')
      .get(req.user.id, productId);
    if (existing) return res.status(409).json({ error: 'You have already reviewed this product.' });
    if (!await userPurchasedDelivered(req.user.id, productId)) {
      return res.status(403).json({ error: 'You can review this product after its order is delivered.' });
    }
    await db.prepare('INSERT INTO reviews (user_id, product_id, rating, text, approved) VALUES (?, ?, ?, ?, 0)')
      .run(req.user.id, productId, rating, text);
    res.status(201).json({ ok: true });
  });

  // Can the current user review this product?
  r.get('/reviews/status', async (req, res) => {
    const productId = intIn(req.query.product_id, 1, 2147483647);
    if (!productId) return res.status(400).json({ error: 'Invalid product.' });
    const existing = await db.prepare('SELECT id FROM reviews WHERE user_id = ? AND product_id = ?')
      .get(req.user.id, productId);
    const alreadyReviewed = !!existing;
    let canReview = false;
    if (!alreadyReviewed) {
      canReview = await userPurchasedDelivered(req.user.id, productId);
    }
    res.json({ can_review: canReview, already_reviewed: alreadyReviewed });
  });

  return r;
};
