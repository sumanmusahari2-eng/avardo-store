// Telegram admin notifications for new customer support messages.
//
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID from the environment
// (Render → Environment). Fire-and-forget: a failure to reach Telegram is
// logged and never breaks the request that triggered it. The token is never
// logged, never returned to the browser, and never written to any file.
//
// Throttle: at most one notification per thread every 90 seconds, so a
// customer sending several messages in a row does not flood the admin's
// Telegram. Unread badges in Admin → Support still show every message.

const TIMEOUT_MS = 10000;
const THROTTLE_MS = 90 * 1000;
const lastSentByThread = new Map();

// Order-failure alerts: at most one ping per order per kind every 12 hours,
// so polling loops (e.g. the payment-status poller) can't spam the admin.
// DB-level guards at each call site (e.g. "only when the status actually
// changed") provide the primary dedup; this is the backstop.
const ORDER_THROTTLE_MS = 12 * 3600 * 1000;
const lastOrderAlert = new Map();

function tgConfig() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  return token && chatId ? { token, chatId } : null;
}

function sendTelegram(text) {
  const cfg = tgConfig();
  if (!cfg) return; // not configured — stay silent
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text }),
    signal: ctrl.signal,
  })
    .then(async (res) => {
      if (!res.ok) console.error('[notify] telegram send failed: HTTP', res.status);
    })
    .catch((e) => console.error('[notify] telegram send failed:', e.message))
    .finally(() => clearTimeout(timer));
}

function configured() {
  return !!((process.env.TELEGRAM_BOT_TOKEN || '').trim() && (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim());
}

function notifySupportMessage({ storeName, adminUrl, customerName, threadId, body }) {
  if (!tgConfig()) return; // not configured — stay silent
  const now = Date.now();
  const last = lastSentByThread.get(threadId) || 0;
  if (now - last < THROTTLE_MS) return; // throttled
  lastSentByThread.set(threadId, now);

  const snippet = String(body || '').slice(0, 300);
  const text =
    `\u{1F4AC} New support message \u2014 ${storeName}\n` +
    `From: ${customerName || 'Customer'} (thread #${threadId})\n\n` +
    `${snippet}\n\n` +
    `Reply: ${adminUrl}`;
  sendTelegram(text);
}

const ORDER_ALERT_TITLES = {
  payment_failed: '\u26A0\uFE0F Payment failed',
  fulfilment_failed: '\u26A0\uFE0F Fulfilment failed \u2014 needs attention',
  underpaid: '\u26A0\uFE0F Crypto underpaid',
  manual_paid_claimed: '\u{1F4B0} Customer says paid \u2014 verify payment',
};

function money(order) {
  const sym = order.currency === 'USD' ? '$' : '\u20B9';
  return sym + order.total;
}

function itemsSummary(order) {
  try {
    const items = JSON.parse(order.items || '[]');
    if (!Array.isArray(items) || !items.length) return '';
    return items.slice(0, 2).map((it) => it.name || it.title || ('#' + (it.product_id || '?'))).join(', ');
  } catch (_) {
    return '';
  }
}

// kind: 'payment_failed' | 'fulfilment_failed' | 'underpaid'.
// Call sites must only call this when the failure is newly observed
// (e.g. the status actually changed), the throttle here is a backstop.
function notifyOrderFailed({ storeName, adminUrl, order, kind, reason }) {
  if (!tgConfig()) return; // not configured — stay silent
  const key = kind + ':' + order.id;
  const now = Date.now();
  if (now - (lastOrderAlert.get(key) || 0) < ORDER_THROTTLE_MS) return;
  lastOrderAlert.set(key, now);

  const title = ORDER_ALERT_TITLES[kind] || '\u26A0\uFE0F Order issue';
  const customer = [order.buyer_name, order.buyer_phone].filter(Boolean).join(' ');
  const items = itemsSummary(order);
  const text =
    `${title} \u2014 ${storeName}\n` +
    `Order #${order.id} \u00B7 \u20B9${order.total}` +
    (items ? `\nItems: ${items}` : '') + '\n' +
    (customer ? `Customer: ${customer}\n` : '') +
    `${reason}\n\n` +
    `View: ${adminUrl}`;
  sendTelegram(text);
}

// Customer tapped "I've paid" on a manual (WhatsApp) order — admin must
// verify the payment before delivering. Call only when paid_claimed
// newly flips to 1; throttle backstops double taps.
function notifyManualPaidClaimed({ storeName, adminUrl, order }) {
  if (!tgConfig()) return; // not configured — stay silent
  const key = 'manual_paid_claimed:' + order.id;
  const now = Date.now();
  if (now - (lastOrderAlert.get(key) || 0) < ORDER_THROTTLE_MS) return;
  lastOrderAlert.set(key, now);

  const title = ORDER_ALERT_TITLES.manual_paid_claimed;
  const customer = [order.buyer_name, order.buyer_phone, order.buyer_email].filter(Boolean).join(' ');
  const items = itemsSummary(order);
  const text =
    `${title} \u2014 ${storeName}\n` +
    `Order #${order.id} \u00B7 ${money(order)}` +
    (items ? `\nItems: ${items}` : '') + '\n' +
    (customer ? `Customer: ${customer}\n` : '') +
    `Payment NOT yet verified \u2014 check and mark paid/delivered.\n\n` +
    `View: ${adminUrl}`;
  sendTelegram(text);
}

module.exports = { configured, notifySupportMessage, notifyOrderFailed, notifyManualPaidClaimed };
