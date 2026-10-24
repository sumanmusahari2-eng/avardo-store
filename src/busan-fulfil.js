// Busan auto-fulfilment: after an order becomes "paid", top up every order
// item whose product has a busan_product_id set, using the player ID / zone ID
// the buyer typed into that product's checkout questions ("User ID" / "Zone ID").
//
// Triggered from src/order-paid.js alongside Topzy fulfilment: each item is
// handled by whichever provider it is mapped to (busan_product_id wins over
// topzy_pack_id per item).
//
// Failure policy: validate the player first; only place the order when the
// player validates. Record the outcome on the order (busan_status), never
// throw into the payment flow, never mark the order delivered, no retry loops.
// A failed order can be retried from Admin -> Busan -> "Retry fulfilment".

const busan = require('./busan');
const { notifyOrderFailed } = require('./notify');

// Find the first checkout answer whose label contains one of the needles.
function findAnswer(answers, needles) {
  const list = Array.isArray(answers) ? answers : [];
  for (const n of needles) {
    const hit = list.find((a) => String((a && a.label) || '').toLowerCase().includes(n));
    if (hit && String(hit.value || '').trim()) return String(hit.value).trim();
  }
  return null;
}

// Player/game-account ID: try the known labels first, then fall back to any
// ID-labelled answer that isn't a zone/server/transaction question. This way a
// future product with an unforeseen label ("Account ID", "Open ID", ...) still
// fulfils instead of failing with "missing player ID".
const PLAYER_ID_NEEDLES = ['user id', 'userid', 'player id', 'playerid', 'game id', 'gameid',
  'uid', 'character id', 'characterid', 'character', 'account id', 'accountid',
  'open id', 'openid'];
function findPlayerId(answers) {
  const direct = findAnswer(answers, PLAYER_ID_NEEDLES);
  if (direct) return direct;
  const list = Array.isArray(answers) ? answers : [];
  for (const a of list) {
    const l = String((a && a.label) || '').toLowerCase();
    const v = String((a && a.value) || '').trim();
    if (!v || !l.includes('id')) continue;
    if (l.includes('zone') || l.includes('server') || l.includes('transaction') || l.includes('order')) continue;
    return v;
  }
  return null;
}

async function fulfilBusanOrder(db, orderId) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;
  if (String(order.status || '').toLowerCase() !== 'paid') return; // only fulfil paid orders
  if (String(order.busan_status || '').toLowerCase() === 'success') return; // idempotent: already done
  if (!busan.configured()) {
    console.log('[busan] order #' + orderId + ': skipped, BUSAN_API_KEY not configured');
    return;
  }

  let items = [];
  try { items = JSON.parse(order.items); } catch (e) { /* keep empty */ }
  if (!Array.isArray(items) || !items.length) return;

  // Per-line idempotency (2026-10-16): lines fulfilled by an earlier run are
  // stored as "itemIndex:unitIndex" keys in orders.busan_fulfilled and skipped
  // on retry, so a partial retry can never double-top-up an already-sent line
  // (real Busan wallet spend per duplicate).
  let doneKeys = [];
  try { doneKeys = JSON.parse(order.busan_fulfilled || '[]'); } catch (e) { doneKeys = []; }
  const done = new Set(Array.isArray(doneKeys) ? doneKeys : []);

  const createdIds = [];
  let failures = 0;
  let skippedDone = 0;
  const errorDetails = []; // surfaced in the Telegram alert so failures are diagnosable without server logs

  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    const prod = await db.prepare('SELECT busan_product_id, busan_auto_fulfil FROM products WHERE id = ?').get(it.product_id);
    if (!prod) continue;
    // Variant-level Busan mapping wins over product-level (each option can
    // map to a different Busan pack).
    let busanProductId = prod.busan_product_id ? String(prod.busan_product_id).trim() : '';
    const variantId = Number(it.variant_id) || 0;
    if (variantId) {
      try {
        const vrow = await db.prepare('SELECT busan_product_id FROM product_variants WHERE id = ? AND product_id = ?').get(variantId, it.product_id);
        if (vrow && vrow.busan_product_id && String(vrow.busan_product_id).trim()) {
          busanProductId = String(vrow.busan_product_id).trim();
        }
      } catch (e) { /* fall back to product-level mapping */ }
    }
    if (!busanProductId) continue; // product/option not mapped to a Busan product
    if (Number(prod.busan_auto_fulfil) !== 1) continue; // auto-fulfil explicitly disabled for this product

    const playerId = findPlayerId(it.checkout_answers);
    const zoneId = findAnswer(it.checkout_answers, ['zone', 'server id', 'server']);
    const qty = Math.max(1, Math.min(10, Number(it.qty) || 1));

    if (!playerId) {
      failures++;
      const seenLabels = (Array.isArray(it.checkout_answers) ? it.checkout_answers : []).map((a) => (a && a.label) || '?').join(', ');
      const msg = 'missing player ID in checkout answers (labels: ' + seenLabels + ')';
      errorDetails.push(msg);
      console.error('[busan] order #' + orderId + ' product ' + busanProductId + ': ' + msg);
      continue;
    }

    for (let n = 0; n < qty; n++) {
      const lineKey = ii + ':' + n;
      if (done.has(lineKey)) { skippedDone++; continue; } // topped up by an earlier run — never re-send
      try {
        // Validate first so we never burn wallet balance on a bad player ID.
        let username = '';
        try {
          const v = await busan.validatePlayer(busanProductId, playerId, zoneId || undefined);
          const vd = (v && v.data) || {};
          if (vd.valid === false) throw new Error('player validation failed');
          if (vd.username) username = String(vd.username);
        } catch (ve) {
          throw new Error('player validation failed: ' + ve.message);
        }
        const res = await busan.createOrder(busanProductId, playerId, zoneId || undefined);
        const d = (res && res.data) || {};
        const oid = d.orderId || d.order_id || res.orderId;
        if (oid) createdIds.push(String(oid));
        if (!busan.isSuccess(res)) {
          failures++;
          const detail = 'Busan non-success response: ' + JSON.stringify(res).slice(0, 200);
          errorDetails.push(detail);
          console.error('[busan] order #' + orderId + ' product ' + busanProductId + ' ' + detail);
        } else {
          done.add(lineKey); // record the fulfilled line before anything else can fail
          if (username) {
            console.log('[busan] order #' + orderId + ' topped up ' + username + ' (' + playerId + ')');
          }
        }
      } catch (e) {
        failures++;
        const detail = 'product ' + busanProductId + ': ' + (e && e.message ? e.message : 'unknown error');
        errorDetails.push(detail);
        // Never log the API key; e.message comes from our client and is key-free.
        console.error('[busan] order #' + orderId + ' failed: ' + detail);
      }
    }
  }

  // Merge this run's new Busan order IDs with any recorded by earlier runs.
  const prevIds = String(order.busan_order_id || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allIds = [...new Set([...prevIds, ...createdIds])];
  const doneJson = JSON.stringify([...done]);

  if (!createdIds.length && failures === 0) {
    if (skippedDone > 0 || done.size > 0) {
      // Everything mappable was already fulfilled by an earlier run — the
      // order is effectively complete.
      await db.prepare("UPDATE orders SET busan_status = 'success', busan_fulfilled = ? WHERE id = ? AND busan_status != 'success'")
        .run(doneJson, orderId).catch(() => {});
    }
    return; // nothing mapped to Busan (or nothing left to do)
  }

  const attempted = createdIds.length + failures;
  const status =
    failures === 0 && attempted > 0 ? 'success'
    : createdIds.length > 0 ? 'partial'
    : 'failed';

  await db.prepare('UPDATE orders SET busan_order_id = ?, busan_status = ?, busan_fulfilled = ? WHERE id = ?')
    .run(allIds.length ? allIds.join(',') : null, status, doneJson, orderId);

  if (status === 'success') {
    // Buyer-visible: shows up in their order timeline as "Top-up sent".
    await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)')
      .run(orderId, 'paid', 'Top-up sent — your game account has been topped up.');
  } else {
    console.error('[busan] order #' + orderId + ': fulfilment ' + status +
      ' (' + failures + '/' + attempted + ' failed). Admin attention needed; order left as paid, NOT delivered.');
    notifyOrderFailed({
      storeName: 'Avardo Official',
      adminUrl: 'https://www.mlbbstore.in/admin',
      order,
      kind: 'fulfilment_failed',
      reason: 'Busan auto-fulfilment ' + status + ' (' + failures + '/' + attempted + ' products failed).' +
        (errorDetails.length ? ' Error: ' + String(errorDetails[0]).slice(0, 300) : '') +
        ' Order left as paid, NOT delivered.',
    });
  }
}

module.exports = { fulfilBusanOrder };
