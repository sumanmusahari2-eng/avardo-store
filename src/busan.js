// Busan API Service client (https://1gamestopup.com/api/v1).
//
// Auth: x-api-key header, read ONLY from process.env.BUSAN_API_KEY.
// The key is never logged, never returned to the browser, and never written
// to any file. When it is missing every call throws a clear "not configured"
// error so callers can degrade gracefully (e.g. skip auto-fulfilment).

const BASE = 'https://1gamestopup.com/api/v1';
const TIMEOUT_MS = 25000;

// Busan API currency for balance checks, the product catalogue and order
// placement. The merchant's Busan wallet is USD-funded, so every Busan call
// uses USD. (Switched from INR on 2026-10-16 at the owner's request.)
const BUSAN_CURRENCY = 'USD';

function configured() {
  return !!((process.env.BUSAN_API_KEY || '').trim());
}

function ensureKey() {
  const k = (process.env.BUSAN_API_KEY || '').trim();
  if (!k) throw new Error('Busan not configured: set the BUSAN_API_KEY environment variable.');
  return k;
}

async function busanFetch(path, { method = 'GET', body } = {}) {
  const key = ensureKey(); // throws when not configured
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(`Busan returned a non-JSON response (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      const msg = data && (data.message || data.error);
      const err = new Error(
        'Busan request failed (HTTP ' + res.status + ')' +
        (msg ? ': ' + String(msg).slice(0, 200) : '.')
      );
      err.upstreamStatus = res.status;
      throw err;
    }
    if (data && data.success === false) {
      const msg = data.message || data.error;
      const err = new Error('Busan request failed' + (msg ? ': ' + String(msg).slice(0, 200) : '.'));
      err.upstreamStatus = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Busan request timed out.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// "Rs.102.00" | "102.00 USD" | 102 -> 102 (number). null when unparseable.
function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// GET /api-service/balance?currency=USD -> { data: { balance: "50.00 USD" } }
async function getBalance() {
  const d = await busanFetch('/api-service/balance?currency=' + BUSAN_CURRENCY);
  const raw = d && d.data && d.data.balance;
  return { balance: raw != null ? String(raw) : null, currency: BUSAN_CURRENCY };
}

// GET /api-service/products?currency=USD -> { data: [{ productId, productName, price }] }
// NOTE: product prices come back in BUSAN_CURRENCY (USD).
let productsCache = null;
let productsCacheAt = 0;
const PRODUCTS_CACHE_MS = 10 * 60 * 1000;

async function getProducts() {
  const now = Date.now();
  if (productsCache && now - productsCacheAt < PRODUCTS_CACHE_MS) return productsCache;
  const d = await busanFetch('/api-service/products?currency=' + BUSAN_CURRENCY);
  const list = Array.isArray(d && d.data) ? d.data : [];
  productsCache = list;
  productsCacheAt = now;
  return list;
}

function clearProductsCache() {
  productsCache = null;
  productsCacheAt = 0;
}

// POST /api-service/validate { productId, playerId, zoneId? }
// -> { data: { valid, username, playerId, zoneId } }
async function validatePlayer(productId, playerId, zoneId) {
  if (!productId || !playerId) throw new Error('productId and playerId are required to validate a player.');
  const body = { productId: String(productId), playerId: String(playerId) };
  if (zoneId !== undefined && zoneId !== null && String(zoneId).trim() !== '') {
    body.zoneId = String(zoneId).trim();
  }
  return busanFetch('/api-service/validate', { method: 'POST', body });
}

// POST /api-service/order { productId, playerId, zoneId?, currency: "USD" }
// -> { data: { orderId, status: "success", ... } }
async function createOrder(productId, playerId, zoneId) {
  if (!productId || !playerId) throw new Error('productId and playerId are required to create a Busan order.');
  const body = { productId: String(productId), playerId: String(playerId), currency: BUSAN_CURRENCY };
  if (zoneId !== undefined && zoneId !== null && String(zoneId).trim() !== '') {
    body.zoneId = String(zoneId).trim();
  }
  return busanFetch('/api-service/order', { method: 'POST', body });
}

// POST /api-service/check-double-bonus { id, zone }
async function checkDoubleBonus(id, zone) {
  if (!id || !zone) throw new Error('id and zone are required to check the double bonus.');
  return busanFetch('/api-service/check-double-bonus', {
    method: 'POST',
    body: { id: String(id), zone: String(zone) },
  });
}

// POST /api-service/webhook { webhookUrl } — register/update the callback URL.
async function registerWebhook(webhookUrl) {
  if (!webhookUrl || !/^https:\/\//i.test(String(webhookUrl))) {
    throw new Error('A valid HTTPS webhook URL is required.');
  }
  return busanFetch('/api-service/webhook', { method: 'POST', body: { webhookUrl: String(webhookUrl) } });
}

// True when a Busan order response means the top-up went through.
function isSuccess(data) {
  if (!data || typeof data !== 'object') return false;
  const d = data.data || data;
  const s = String(d.status || '').toLowerCase();
  return d.success === true || ['success', 'completed', 'delivered'].includes(s);
}

// Normalize a Busan order status to 'success' | 'processing' | 'failed' | null.
function normalizeStatus(data) {
  if (!data || typeof data !== 'object') return null;
  if (isSuccess(data)) return 'success';
  const d = data.data || data;
  const s = String(d.status || '').toLowerCase();
  if (['pending', 'processing', 'in_progress', 'queued'].includes(s)) return 'processing';
  if (['failed', 'failure', 'error', 'cancelled', 'rejected'].includes(s)) return 'failed';
  if (d.success === false) return 'failed';
  return null;
}

module.exports = {
  configured,
  BUSAN_CURRENCY,
  getBalance,
  getProducts,
  clearProductsCache,
  validatePlayer,
  createOrder,
  checkDoubleBonus,
  registerWebhook,
  parsePrice,
  isSuccess,
  normalizeStatus,
};
