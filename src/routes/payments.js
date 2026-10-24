// XtraGateway online payments (https://xtragateway.site).
// Flow:
//   1. Customer places an order (status: pending) via the normal checkout.
//   2. On the order page they tap "Pay online" -> POST /api/payments/xtra/create
//      creates a gateway order and returns a payment_url; the browser redirects there.
//   3. After paying, the gateway redirects back to /payment-return.html?oid=<id>.
//   4. That page polls GET /api/payments/xtra/status?order_id=<id>, which asks the
//      gateway for the real status and marks the order paid on COMPLETED.
//
// Env:
//   XTRA_USER_TOKEN  merchant token from XtraGateway (required to enable)
//   XTRA_BASE_URL    gateway base URL (default https://xtragateway.site)
//   PUBLIC_BASE_URL  this store's public URL, used for redirect_url
//                    (default https://www.mlbbstore.in)
const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { intIn } = require('../validate');
const { handleOrderPaid } = require('../order-paid');
const { refundWalletForOrder } = require('../wallet');
const { notifyOrderFailed } = require('../notify');

const XTRA_BASE = (process.env.XTRA_BASE_URL || 'https://xtragateway.site').replace(/\/+$/, '');
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://www.mlbbstore.in').replace(/\/+$/, '');

// CryptoPay (https://cryptopay.bluebuff.in) — non-custodial USDT gateway.
// UNVERIFIED: base URL default, signed-payload scheme (raw-body HMAC), and the
// absence of a public invoice status-check endpoint all come from the public
// marketing site and must be confirmed with a live test.
//
// Env:
//   CRYPTOPAY_API_KEY        merchant API key (required to enable)
//   CRYPTOPAY_WEBHOOK_SECRET webhook HMAC secret (required for webhooks)
//   CRYPTOPAY_BASE_URL       gateway base URL (default https://cryptopay.bluebuff.in)
// Flow:
//   1. Order page "Pay with Crypto — USDT" -> POST /api/payments/crypto/create
//      creates an invoice and returns checkout_url; the browser redirects there.
//   2. CryptoPay POSTs payment.confirmed to /api/payments/crypto/webhook,
//      which verifies the HMAC signature and marks the order paid.
const CRYPTO_BASE = (process.env.CRYPTOPAY_BASE_URL || 'https://cryptopay.bluebuff.in').replace(/\/+$/, '');

function cryptoEnabled() {
  return !!((process.env.CRYPTOPAY_API_KEY || '').trim());
}

async function getCryptoRate(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get('crypto_usd_rate');
    const v = parseFloat(row && row.value);
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) {}
  return 88;
}

async function cryptoPost(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(CRYPTO_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.CRYPTOPAY_API_KEY || '').trim(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return { http: res.status, json: JSON.parse(text) };
    } catch (_) {
      return { http: res.status, json: null, raw: text.slice(0, 500) };
    }
  } catch (e) {
    return { http: 0, json: null, error: 'Could not reach the crypto gateway. Please try again.' };
  } finally {
    clearTimeout(timer);
  }
}

// Verify the X-Cryptopay-Signature header ("t=<ts>,v1=<hex>") as HMAC-SHA256
// over the RAW request body. UNVERIFIED: exact signed-payload scheme taken from
// the public site; verification failures are logged in full for diagnosis.
function verifyCryptoSignature(rawBody, sigHeader) {
  const m = String(sigHeader || '').match(/t=(\d+)\s*,\s*v1=([0-9a-fA-F]+)/);
  if (!m) return { ok: false, reason: 'bad_header' };
  const ts = parseInt(m[1], 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 600) return { ok: false, reason: 'stale_timestamp' };
  const expected = crypto.createHmac('sha256', (process.env.CRYPTOPAY_WEBHOOK_SECRET || '').trim())
    .update(rawBody)
    .digest();
  let actual;
  try {
    actual = Buffer.from(m[2], 'hex');
  } catch (_) {
    return { ok: false, reason: 'bad_hex' };
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

//
// DivineXPay — non-custodial USDT (BEP20) gateway (https://divinexpay.com).
// Env:
//   DIVINEXPAY_API_KEY       merchant API key (required to enable)
//   DIVINEXPAY_WEBHOOK_SECRET webhook HMAC secret (required for webhooks)
//   DIVINEXPAY_BASE_URL      gateway base URL (default https://divinexpay.com)
// Flow:
//   1. Order page "Pay with Crypto — USDT (BEP20)" -> POST /api/payments/divinex/create
//      creates a payment, returns walletAddress + exact amount; the customer
//      sends EXACTLY that amount in USDT on BNB Chain to the address.
//   2. DivineXPay POSTs payment.confirmed to /api/payments/divinex/webhook,
//      which verifies the HMAC signature and marks the order paid.
//   3. The order page can also poll GET /api/payments/divinex/status.
const DIVINEX_BASE = (process.env.DIVINEXPAY_BASE_URL || 'https://divinexpay.com').replace(/\/+$/, '');

function divinexEnabled() {
  return !!((process.env.DIVINEXPAY_API_KEY || '').trim());
}

async function divinexPost(path, body, idempotencyKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': (process.env.DIVINEXPAY_API_KEY || '').trim(),
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(DIVINEX_BASE + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return { http: res.status, json: JSON.parse(text) };
    } catch (_) {
      return { http: res.status, json: null, raw: text.slice(0, 500) };
    }
  } catch (e) {
    return { http: 0, json: null, error: 'Could not reach the crypto gateway. Please try again.' };
  } finally {
    clearTimeout(timer);
  }
}

async function divinexGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(DIVINEX_BASE + path, {
      method: 'GET',
      headers: { 'x-api-key': (process.env.DIVINEXPAY_API_KEY || '').trim() },
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return { http: res.status, json: JSON.parse(text) };
    } catch (_) {
      return { http: res.status, json: null, raw: text.slice(0, 500) };
    }
  } catch (e) {
    return { http: 0, json: null, error: 'Could not reach the crypto gateway. Please try again.' };
  } finally {
    clearTimeout(timer);
  }
}

// Verify the X-Gateway-Signature header ("t=<unix>,v1=<hex>") as HMAC-SHA256
// over "<t>.<raw_body>" per DivineXPay docs.
function verifyDivinexSignature(rawBody, sigHeader) {
  const m = String(sigHeader || '').match(/t=(\d+)\s*,\s*v1=([0-9a-fA-F]+)/);
  if (!m) return { ok: false, reason: 'bad_header' };
  const ts = parseInt(m[1], 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return { ok: false, reason: 'stale_timestamp' };
  const expected = crypto.createHmac('sha256', (process.env.DIVINEXPAY_WEBHOOK_SECRET || '').trim())
    .update(m[1] + '.' + rawBody.toString('utf8'))
    .digest();
  let actual;
  try {
    actual = Buffer.from(m[2], 'hex');
  } catch (_) {
    return { ok: false, reason: 'bad_hex' };
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

function xtraEnabled() {
  return !!((process.env.XTRA_USER_TOKEN || '').trim());
}

function cleanMobile(s) {
  if (typeof s !== 'string') return null;
  let d = s.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2); // tolerate +91 prefix
  return /^\d{10}$/.test(d) ? d : null;
}

async function xtraPost(path, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const body = new URLSearchParams({
      user_token: (process.env.XTRA_USER_TOKEN || '').trim(),
      ...params,
    });
    const res = await fetch(XTRA_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      return { status: 'ERROR', message: 'Invalid response from payment gateway.' };
    }
  } catch (e) {
    return { status: 'ERROR', message: 'Could not reach the payment gateway. Please try again.' };
  } finally {
    clearTimeout(timer);
  }
}

function isCompleted(gw) {
  const s = String(gw.status || '').toUpperCase();
  const txn = String((gw.result && gw.result.txnStatus) || gw.txnStatus || '').toUpperCase();
  return s === 'COMPLETED' || s === 'SUCCESS' || txn === 'COMPLETED' || txn === 'SUCCESS';
}

function isFailed(gw) {
  const s = String(gw.status || '').toUpperCase();
  const txn = String((gw.result && gw.result.txnStatus) || gw.txnStatus || '').toUpperCase();
  return s === 'FAILED' || s === 'ERROR' || txn === 'FAILED' || txn === 'ERROR';
}

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());

  r.use(requireAuth);

  // Create (or reuse) a gateway payment for one of the caller's pending orders.
  r.post('/xtra/create', async (req, res) => {
    if (!xtraEnabled()) {
      return res.status(503).json({ error: 'Online payment is not enabled on this store yet.' });
    }
    const orderId = intIn(req.body && req.body.order_id, 1, 2147483647);
    if (!orderId) return res.status(400).json({ error: 'Invalid order.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending orders can be paid online.' });
    }
    if (order.currency === 'USD') {
      return res.status(400).json({ error: 'Online UPI payment is available for INR orders only. Please pay with crypto or via WhatsApp.' });
    }
    const mobile = cleanMobile(req.body && req.body.customer_mobile);
    if (!mobile) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    }
    if (mobile !== order.customer_mobile) {
      await db.prepare('UPDATE orders SET customer_mobile = ? WHERE id = ?').run(mobile, orderId);
    }

    // Reuse the existing gateway order if we already created one.
    if (order.xtra_order_id && order.xtra_payment_url) {
      return res.json({ payment_url: order.xtra_payment_url, order_id: orderId, reused: true });
    }

    const gwOrderId = 'MDS' + orderId + Date.now().toString().slice(-8);
    // The gateway collects only what the wallet didn't cover.
    const walletApplied = Math.round(Number(order.wallet_applied || 0) * 100) / 100;
    const amount = String(Math.round((Number(order.total) - walletApplied) * 100) / 100);

    const gw = await xtraPost('/api/create-order', {
      customer_mobile: mobile,
      amount,
      order_id: gwOrderId,
      redirect_url: PUBLIC_BASE + '/payment-return.html?oid=' + orderId,
      remark1: ((req.app && req.app.get('brand') && req.app.get('brand').name) || 'Avardo Official') + ' order #' + orderId,
      remark2: req.user.email || '',
    });

    if (gw.status !== true || !gw.result || !gw.result.payment_url) {
      const msg = String((gw && gw.message) || 'Payment gateway did not create the order.').slice(0, 200);
      return res.status(502).json({ error: msg });
    }

    await db.prepare(
      'UPDATE orders SET xtra_order_id = ?, xtra_payment_url = ?, xtra_status = ? WHERE id = ?'
    ).run(String(gw.result.orderId || gwOrderId), String(gw.result.payment_url), 'created', orderId);

    res.json({ payment_url: String(gw.result.payment_url), order_id: orderId });
  });

  // Ask the gateway for the real status; mark the order paid on COMPLETED.
  r.get('/xtra/status', async (req, res) => {
    if (!xtraEnabled()) {
      return res.status(503).json({ error: 'Online payment is not enabled on this store yet.' });
    }
    const orderId = intIn(req.query.order_id, 1, 2147483647);
    if (!orderId) return res.status(400).json({ error: 'Invalid order.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    if (order.status === 'paid' || order.status === 'delivered') {
      return res.json({ order_id: orderId, status: order.status, gateway: order.xtra_status || null, utr: order.xtra_utr || null });
    }
    if (!order.xtra_order_id) {
      return res.json({ order_id: orderId, status: order.status, gateway: null });
    }

    const gw = await xtraPost('/api/check-order-status', { order_id: order.xtra_order_id });

    if (isCompleted(gw)) {
      const utr = (gw.result && gw.result.utr) || gw.utr || null;
      // Race-safe: only THIS poll may flip pending → paid. A cancelled order
      // (wallet already refunded) must never be resurrected by a late gateway
      // callback — same pattern as the crypto webhooks below.
      const upd = await db.prepare(
        "UPDATE orders SET status = 'paid', paid_claimed = 1, xtra_status = ?, xtra_utr = ? WHERE id = ? AND status = 'pending'"
      ).run('COMPLETED', utr, orderId);
      if (upd.changes > 0) {
        // Paid pipeline: Busan auto-fulfil + gift-card code assignment.
        // Fire-and-forget: fulfilment records its own outcome on the order and
        // must never break the payment flow.
        handleOrderPaid(db, orderId);
        return res.json({ order_id: orderId, status: 'paid', gateway: 'COMPLETED', utr });
      }
      const cur = await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
      return res.json({ order_id: orderId, status: cur ? cur.status : 'unknown', gateway: 'COMPLETED', utr });
    }

    const failed = isFailed(gw);
    await db.prepare('UPDATE orders SET xtra_status = ? WHERE id = ?')
      .run(failed ? 'FAILED' : 'PENDING', orderId);
    if (failed) {
      // The gateway won't collect this payment — return any wallet money applied.
      await refundWalletForOrder(db, order).catch((e) => console.error('[wallet]', e && e.message));
      await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)').run(
        orderId, order.status, 'Online payment failed. Any wallet balance applied was refunded.'
      ).catch(() => {});
      // Notify once: the status poller runs repeatedly, so only alert when the
      // gateway status newly flipped to FAILED.
      if (order.xtra_status !== 'FAILED') {
        notifyOrderFailed({
          storeName: 'Avardo Official',
          adminUrl: 'https://www.mlbbstore.in/admin',
          order,
          kind: 'payment_failed',
          reason: 'Online payment failed at the gateway. Any wallet balance applied was refunded.',
        });
      }
    }
    res.json({
      order_id: orderId,
      status: order.status,
      gateway: failed ? 'FAILED' : 'PENDING',
      message: typeof gw.message === 'string' ? gw.message.slice(0, 200) : null,
    });
  });

  // ---------- CryptoPay (USDT, all countries) ----------

  // Create (or reuse) a crypto invoice for one of the caller's pending orders.
  // The customer pays the unique exact USDT amount on the hosted checkout page.
  r.post('/crypto/create', async (req, res) => {
    if (!cryptoEnabled()) {
      return res.status(503).json({ error: 'Crypto payment is not enabled on this store yet.' });
    }
    const orderId = intIn(req.body && req.body.order_id, 1, 2147483647);
    if (!orderId) return res.status(400).json({ error: 'Invalid order.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending orders can be paid online.' });
    }

    // Reuse the existing invoice if we already created one.
    if (order.crypto_order_ref && order.crypto_checkout_url) {
      return res.json({
        checkout_url: order.crypto_checkout_url,
        order_id: orderId,
        exact_amount: order.crypto_exact_amount,
        reused: true,
      });
    }

    // The gateway collects only what the wallet didn't cover, in USD.
    // INR orders convert at the crypto rate; USD orders are already in USD.
    const rate = await getCryptoRate(db);
    const walletApplied = Math.round(Number(order.wallet_applied || 0) * 100) / 100;
    const due = Math.round((Number(order.total) - walletApplied) * 100) / 100;
    if (due <= 0) {
      return res.status(400).json({ error: 'Nothing left to pay on this order.' });
    }
    const usd = order.currency === 'USD' ? due : Math.round((due / rate) * 100) / 100;
    const amount = usd.toFixed(2);
    const cryptoRef = 'GR' + orderId + Date.now().toString().slice(-8);

    const gw = await cryptoPost('/api/v1/payments', { amount, currency: 'USD', orderId: cryptoRef });
    if (gw.error) {
      return res.status(502).json({ error: gw.error });
    }
    const invData = gw.json && gw.json.invoice && gw.json.invoice.data;
    const checkoutUrl = invData && invData.checkoutUrl;
    const exactAmount = invData && invData.exactAmount;
    if (!checkoutUrl || !exactAmount) {
      // UNVERIFIED response shape: fail loudly and log what we got so the
      // field mapping can be fixed, rather than guessing silently.
      console.error('[crypto] unexpected invoice response shape (http=' + gw.http + '):',
        JSON.stringify(gw.json || gw.raw || null).slice(0, 1000));
      return res.status(502).json({ error: 'Crypto gateway returned an unexpected response. Please try again.' });
    }

    await db.prepare(
      'UPDATE orders SET crypto_order_ref = ?, crypto_checkout_url = ?, crypto_exact_amount = ?, crypto_status = ? WHERE id = ?'
    ).run(cryptoRef, String(checkoutUrl), String(exactAmount), 'created', orderId);

    res.json({ checkout_url: String(checkoutUrl), order_id: orderId, exact_amount: String(exactAmount) });
  });

  // UNVERIFIED: CryptoPay documents no public invoice status-check endpoint, so
  // this returns our own DB state (updated by the webhook) for the storefront.
  r.get('/crypto/status', async (req, res) => {
    if (!cryptoEnabled()) {
      return res.status(503).json({ error: 'Crypto payment is not enabled on this store yet.' });
    }
    const orderId = intIn(req.query.order_id, 1, 2147483647);
    if (!orderId) return res.status(400).json({ error: 'Invalid order.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    return res.json({
      order_id: orderId,
      status: order.status,
      crypto_status: order.crypto_status || null,
      exact_amount: order.crypto_exact_amount || null,
      checkout_url: order.crypto_checkout_url || null,
    });
  });

  // DivineXPay: create a USDT (BEP20) payment for a pending order.
  r.post('/divinex/create', async (req, res) => {
    if (!divinexEnabled()) {
      return res.status(503).json({ error: 'Crypto payment (USDT) is not enabled on this store yet.' });
    }
    const orderId = intIn(req.body && req.body.order_id, 1, 2147483647);
    if (!orderId) return res.status(400).json({ error: 'Invalid order.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending orders can be paid online.' });
    }

    // Reuse the existing payment if we already created one and it hasn't expired.
    if (order.divinex_payment_id && order.divinex_wallet && Number(order.divinex_expires_at) > Date.now()) {
      return res.json({
        payment_id: order.divinex_payment_id,
        wallet_address: order.divinex_wallet,
        exact_amount: order.crypto_exact_amount,
        expires_at: Number(order.divinex_expires_at),
        order_id: orderId,
        reused: true,
      });
    }

    const rate = await getCryptoRate(db);
    const walletApplied = Math.round(Number(order.wallet_applied || 0) * 100) / 100;
    const due = Math.round((Number(order.total) - walletApplied) * 100) / 100;
    if (due <= 0) {
      return res.status(400).json({ error: 'Nothing left to pay on this order.' });
    }
    const usd = order.currency === 'USD' ? due : Math.round((due / rate) * 100) / 100;
    if (usd <= 0) {
      return res.status(400).json({ error: 'Nothing left to pay on this order.' });
    }
    const divinexRef = 'DX' + orderId + Date.now().toString().slice(-8);

    const gw = await divinexPost('/api/v1/payments',
      { amount: Number(usd.toFixed(2)), orderId: divinexRef, metadata: { store_order_id: orderId } },
      divinexRef);
    if (gw.error) {
      return res.status(502).json({ error: gw.error });
    }
    if (gw.http === 401) {
      console.error('[divinex] create payment: 401 — check DIVINEXPAY_API_KEY');
      return res.status(502).json({ error: 'Crypto gateway rejected the request. Please try again later.' });
    }
    const d = gw.json || {};
    const paymentId = d.paymentId, walletAddress = d.walletAddress, exactAmount = d.amount;
    if (gw.http !== 201 || !paymentId || !walletAddress || exactAmount == null) {
      console.error('[divinex] unexpected create-payment response (http=' + gw.http + '):',
        JSON.stringify(d).slice(0, 1000));
      const msg = (d && d.error) ? String(d.error).slice(0, 200) : 'Crypto gateway returned an unexpected response. Please try again.';
      return res.status(502).json({ error: msg });
    }

    await db.prepare(
      'UPDATE orders SET crypto_order_ref = ?, crypto_exact_amount = ?, crypto_status = ?, divinex_payment_id = ?, divinex_wallet = ?, divinex_expires_at = ? WHERE id = ?'
    ).run(divinexRef, String(exactAmount), 'created', String(paymentId), String(walletAddress), Number(d.expiresAt) || 0, orderId);

    res.json({
      payment_id: String(paymentId),
      wallet_address: String(walletAddress),
      exact_amount: String(exactAmount),
      expires_at: Number(d.expiresAt) || 0,
      network: d.network || 'BEP20',
      order_id: orderId,
    });
  });

  // DivineXPay: poll payment status (also updated by webhook).
  r.get('/divinex/status', async (req, res) => {
    if (!divinexEnabled()) {
      return res.status(503).json({ error: 'Crypto payment (USDT) is not enabled on this store yet.' });
    }
    const orderId = intIn(req.query.order_id, 1, 2147483647);
    if (!orderId) return res.status(400).json({ error: 'Invalid order.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    // If our webhook already marked it paid, report that without hitting the gateway.
    if (order.status === 'paid' || order.status === 'delivered') {
      return res.json({ order_id: orderId, status: order.status, gateway_status: 'confirmed' });
    }
    if (!order.divinex_payment_id) {
      return res.json({ order_id: orderId, status: order.status, gateway_status: order.crypto_status || null });
    }
    const gw = await divinexGet('/api/v1/payments/' + encodeURIComponent(order.divinex_payment_id));
    if (gw.error || !gw.json) {
      return res.json({ order_id: orderId, status: order.status, gateway_status: order.crypto_status || null });
    }
    const gs = String(gw.json.status || '').toLowerCase();
    // Opportunistic: if the gateway says confirmed but the webhook hasn't landed yet, mark paid now.
    if (gs === 'confirmed' && order.status === 'pending') {
      const upd = await db.prepare(
        "UPDATE orders SET status = 'paid', paid_claimed = 1, crypto_status = ?, crypto_tx_hash = ? WHERE id = ? AND status = 'pending'"
      ).run('CONFIRMED', (gw.json.txHash && String(gw.json.txHash)) || null, order.id);
      if (upd.changes > 0) {
        await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)')
          .run(order.id, 'paid', 'USDT (BEP20) payment confirmed via DivineXPay.').catch(() => {});
        handleOrderPaid(db, order.id);
      }
      return res.json({ order_id: orderId, status: 'paid', gateway_status: 'confirmed' });
    }
    if (gs === 'expired' && order.crypto_status !== 'EXPIRED') {
      await db.prepare('UPDATE orders SET crypto_status = ? WHERE id = ?').run('EXPIRED', order.id).catch(() => {});
    }
    return res.json({
      order_id: orderId,
      status: order.status,
      gateway_status: gs || order.crypto_status || null,
      exact_amount: order.crypto_exact_amount || null,
      wallet_address: order.divinex_wallet || null,
      expires_at: order.divinex_expires_at ? Number(order.divinex_expires_at) : null,
    });
  });

  return r;
};

// CryptoPay webhook handler factory. Mounted directly in server.js (before the
// authenticated /api routers) because the shop router's global requireAuth
// would otherwise 401 the gateway's unauthenticated callbacks. The webhook
// carries no session — trust comes from the HMAC-SHA256 signature, verified
// over the RAW request body (express.raw mount in server.js).
function cryptoWebhookHandler(db) {
  return async (req, res, next) => {
    try {
      const secret = (process.env.CRYPTOPAY_WEBHOOK_SECRET || '').trim();
      if (!secret) {
        console.error('[crypto] webhook received but CRYPTOPAY_WEBHOOK_SECRET is not set — set it on the server to enable crypto payments');
        return res.status(401).json({ error: 'Webhook not configured.' });
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sigHeader = req.get('X-Cryptopay-Signature');
      const v = verifyCryptoSignature(raw, sigHeader);
      if (!v.ok) {
        console.error('[crypto] webhook signature verification failed:', v.reason,
          '| sig header:', sigHeader ? 'present' : 'missing',
          '| body bytes:', raw.length);
        return res.status(401).json({ error: 'Invalid signature.' });
      }
      let evt;
      try {
        evt = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        return res.status(400).json({ error: 'Invalid JSON body.' });
      }
      if (evt.event !== 'payment.confirmed') {
        return res.json({ ok: true, ignored: evt.event || null });
      }
      const d = evt.data || {};
      const ref = String(d.order_id || '');
      if (!ref) return res.status(400).json({ error: 'Missing order_id.' });
      const order = await db.prepare('SELECT * FROM orders WHERE crypto_order_ref = ?').get(ref);
      if (!order) {
        console.error('[crypto] webhook for unknown order ref:', ref);
        return res.status(404).json({ error: 'Order not found.' });
      }
      // Idempotent: already paid/delivered → acknowledge without re-running fulfilment.
      if (order.status === 'paid' || order.status === 'delivered') {
        return res.json({ ok: true, status: order.status });
      }
      // The gateway must have collected (approximately) the exact USDT amount we invoiced.
      const expected = Number(order.crypto_exact_amount);
      const received = Number(d.amount_received);
      if (Number.isFinite(expected) && Number.isFinite(received) && received < expected - 0.01) {
        console.error(`[crypto] underpaid ref=${ref}: expected ${order.crypto_exact_amount}, received ${d.amount_received}`);
        // Notify only when THIS call flips the status — the guarded UPDATE
        // makes repeat underpaid webhooks no-ops instead of re-alerting.
        const updUnder = await db.prepare(
          "UPDATE orders SET crypto_status = 'UNDERPAID' WHERE id = ? AND (crypto_status IS NULL OR crypto_status != 'UNDERPAID')"
        ).run(order.id);
        if (updUnder.changes > 0) {
          notifyOrderFailed({
            storeName: 'Avardo Official',
            adminUrl: 'https://www.mlbbstore.in/admin',
            order,
            kind: 'underpaid',
            reason: `Crypto payment underpaid: expected ${order.crypto_exact_amount} USDT, received ${d.amount_received} USDT.`,
          });
        }
        return res.json({ ok: true, underpaid: true });
      }
      // Race-safe: only the first webhook (or admin action) flips pending → paid.
      const upd = await db.prepare(
        "UPDATE orders SET status = 'paid', paid_claimed = 1, crypto_status = ?, crypto_tx_hash = ?, crypto_chain = ? WHERE id = ? AND status = 'pending'"
      ).run('CONFIRMED', d.tx_hash || null, d.chain || null, order.id);
      if (upd.changes > 0) {
        await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)')
          .run(order.id, 'paid', 'Crypto payment confirmed (USDT).').catch(() => {});
        // Paid pipeline: Busan auto-fulfil + gift-card code assignment (same as Xtra).
        handleOrderPaid(db, order.id);
      }
      return res.json({ ok: true, status: 'paid' });
    } catch (e) {
      next(e);
    }
  };
}

// DivineXPay webhook handler factory. Mounted directly in server.js (before the
// authenticated /api routers) because the shop router's global requireAuth
// would otherwise 401 the gateway's unauthenticated callbacks. Trust comes
// from the HMAC-SHA256 signature (X-Gateway-Signature: t=<unix>,v1=<hex>)
// over "<t>.<raw_body>", verified over the RAW request body (express.raw
// mount in server.js).
function divinexWebhookHandler(db) {
  return async (req, res, next) => {
    try {
      const secret = (process.env.DIVINEXPAY_WEBHOOK_SECRET || '').trim();
      if (!secret) {
        console.error('[divinex] webhook received but DIVINEXPAY_WEBHOOK_SECRET is not set');
        return res.status(401).json({ error: 'Webhook not configured.' });
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const v = verifyDivinexSignature(raw, req.get('X-Gateway-Signature'));
      if (!v.ok) {
        console.error('[divinex] webhook signature verification failed:', v.reason,
          '| body bytes:', raw.length);
        return res.status(401).json({ error: 'Invalid signature.' });
      }
      let evt;
      try {
        evt = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        return res.status(400).json({ error: 'Invalid JSON body.' });
      }
      const event = String(evt.event || '');
      if (event !== 'payment.confirmed' && event !== 'payment.expired') {
        return res.json({ ok: true, ignored: event || null });
      }
      const d = evt.data || {};
      const ref = String(d.orderId || '');
      if (!ref) return res.status(400).json({ error: 'Missing orderId.' });
      const order = await db.prepare('SELECT * FROM orders WHERE crypto_order_ref = ?').get(ref);
      if (!order) {
        console.error('[divinex] webhook for unknown order ref:', ref);
        return res.status(404).json({ error: 'Order not found.' });
      }
      if (event === 'payment.expired') {
        await db.prepare('UPDATE orders SET crypto_status = ? WHERE id = ?').run('EXPIRED', order.id).catch(() => {});
        return res.json({ ok: true, expired: true });
      }
      // payment.confirmed — idempotent: already paid/delivered → acknowledge.
      if (order.status === 'paid' || order.status === 'delivered') {
        return res.json({ ok: true, status: order.status });
      }
      // The gateway must have collected (approximately) the exact USDT amount
      // we invoiced — same underpayment guard as the CryptoPay webhook above.
      // Fail closed: an unverifiable amount is treated as underpaid, never paid.
      const expected = Number(order.crypto_exact_amount);
      const received = [d.amount_received, d.amount, d.received_amount, d.value]
        .map(Number).find(Number.isFinite);
      if (Number.isFinite(expected) && (!Number.isFinite(received) || received < expected - 0.01)) {
        console.error(`[divinex] underpaid ref=${ref}: expected ${order.crypto_exact_amount}, received ${received}`);
        const updUnder = await db.prepare(
          "UPDATE orders SET crypto_status = 'UNDERPAID' WHERE id = ? AND (crypto_status IS NULL OR crypto_status != 'UNDERPAID')"
        ).run(order.id);
        if (updUnder.changes > 0) {
          notifyOrderFailed({
            storeName: 'Avardo Official',
            adminUrl: 'https://www.mlbbstore.in/admin',
            order,
            kind: 'underpaid',
            reason: `DivineXPay payment underpaid: expected ${order.crypto_exact_amount} USDT, received ${received} USDT.`,
          });
        }
        return res.json({ ok: true, underpaid: true });
      }
      const upd = await db.prepare(
        "UPDATE orders SET status = 'paid', paid_claimed = 1, crypto_status = ?, crypto_tx_hash = ? WHERE id = ? AND status = 'pending'"
      ).run('CONFIRMED', (d.txHash && String(d.txHash)) || null, order.id);
      if (upd.changes > 0) {
        await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)')
          .run(order.id, 'paid', 'USDT (BEP20) payment confirmed via DivineXPay.').catch(() => {});
        handleOrderPaid(db, order.id);
      }
      return res.json({ ok: true, status: 'paid' });
    } catch (e) {
      next(e);
    }
  };
}

module.exports.divinexWebhookHandler = divinexWebhookHandler;

module.exports.cryptoWebhookHandler = cryptoWebhookHandler;

// Busan order-notification webhook handler factory. Mounted directly in
// server.js (before the authenticated /api routers) because it carries no
// session — trust comes from the HMAC-SHA256 signature, verified over the
// canonical string "{orderId}|{status}|{timestamp}" with BUSAN_API_KEY as the
// secret, base64-encoded. Sent in the JSON body as `signature` and also as
// the X-Busan-Signature header.
//
// These are fulfilment notifications (order completed/failed), not payments:
// they update orders.busan_status on orders we already fulfilled via Busan.
// Idempotent: repeated deliveries of the same event are acknowledged without
// side effects.
function busanWebhookHandler(db) {
  return async (req, res) => {
    try {
      const key = (process.env.BUSAN_API_KEY || '').trim();
      if (!key) {
        console.error('[busan] webhook received but BUSAN_API_KEY is not set — set it on the server to enable Busan webhooks');
        return res.status(401).json({ error: 'Webhook not configured.' });
      }
      const b = req.body || {};
      const orderId = String(b.orderId || '');
      const status = String(b.status || '');
      const timestamp = String(b.timestamp || '');
      if (!orderId || !status || !timestamp) {
        return res.status(400).json({ error: 'Missing orderId, status or timestamp.' });
      }
      const provided = String(b.signature || req.get('X-Busan-Signature') || '');
      const expected = crypto
        .createHmac('sha256', key)
        .update(`${orderId}|${status}|${timestamp}`)
        .digest('base64');
      const a = Buffer.from(provided, 'utf8');
      const e = Buffer.from(expected, 'utf8');
      const ok = a.length === e.length && a.length > 0 && crypto.timingSafeEqual(a, e);
      if (!ok) {
        console.error('[busan] webhook signature verification failed for orderId=' + orderId);
        return res.status(401).json({ error: 'Invalid signature.' });
      }
      // Find the order by its Busan order id (we may store several, comma-joined).
      const order = await db.prepare(
        "SELECT * FROM orders WHERE busan_order_id = ? OR busan_order_id LIKE ? OR busan_order_id LIKE ? OR busan_order_id LIKE ?"
      ).get(orderId, orderId + ',%', '%,' + orderId, '%,' + orderId + ',%');
      if (!order) {
        console.error('[busan] webhook for unknown Busan order id:', orderId);
        return res.status(404).json({ error: 'Order not found.' });
      }
      const norm = String(status).toLowerCase();
      const busanStatus = ['completed', 'success', 'delivered'].includes(norm) ? 'success'
        : ['failed', 'failure', 'error', 'cancelled', 'rejected'].includes(norm) ? 'failed'
        : ['pending', 'processing', 'in_progress', 'queued'].includes(norm) ? 'processing'
        : norm || 'unknown';
      // Idempotent: same status already recorded → acknowledge quietly.
      if (String(order.busan_status || '') === busanStatus) {
        return res.json({ ok: true, status: busanStatus, replay: true });
      }
      await db.prepare('UPDATE orders SET busan_status = ? WHERE id = ?').run(busanStatus, order.id);
      await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)')
        .run(order.id, order.status || 'paid', 'Busan update: top-up ' + busanStatus + ' (ref ' + orderId + ').')
        .catch(() => {});
      console.log('[busan] webhook: order #' + order.id + ' busan_status -> ' + busanStatus);
      if (busanStatus === 'failed') {
        notifyOrderFailed({
          storeName: 'Avardo Official',
          adminUrl: 'https://www.mlbbstore.in/admin',
          order,
          kind: 'fulfilment_failed',
          reason: 'Busan reported the top-up as failed (ref ' + orderId + '). Customer paid but was not topped up.',
        });
      }
      return res.json({ ok: true, status: busanStatus });
    } catch (e) {
      console.error('[busan] webhook error:', e && e.message);
      return res.status(500).json({ error: 'Webhook processing failed.' });
    }
  };
}

module.exports.busanWebhookHandler = busanWebhookHandler;
