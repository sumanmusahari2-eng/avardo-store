// Busan wholesale-price sync.
//
// Protects the owner from selling at a loss: every run fetches the live
// Busan USD product list (converted to INR at the store rate), stores each
// raises the product's retail price whenever the cost + margin floor exceeds it.
//
// Wholesale price sync rules:
//   - Skipped entirely when busan_sync_enabled != '1' or BUSAN_API_KEY is missing.
//   - Product missing from Busan list -> warning; price NOT touched;
//     a history row is logged with note 'product unavailable'.
//   - Cost changed -> cost_price updated. floor = fixed ? cost + margin
//     : ceil(cost * (1 + margin/100)). Product-level margin overrides win,
//     otherwise the global defaults from settings apply.
//   - floor > current price -> price set to floor, note 'auto-increase'
//     (the core loss-protection).
//   - floor < current price -> price lowered only when busan_auto_decrease
//     is '1' (note 'auto-decrease'); otherwise note 'cost updated, price unchanged'.
//   - Every cost change writes a row to busan_price_history.
//   - Per-product try/catch: one bad row can never kill a run.

const busan = require('./busan');

// Busan wholesale costs arrive in BUSAN_CURRENCY (USD). The store's cost_price
// and price_regular columns are INR, so convert at the fixed store rate before
// doing any floor math — otherwise USD values would corrupt INR prices.
const USD_TO_INR = 105;
function busanCostToInr(usd) {
  if (usd === null || usd === undefined) return null;
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * USD_TO_INR * 100) / 100;
}

async function getSetting(db, key, fallback) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== undefined && row.value !== null ? String(row.value) : fallback;
  } catch (_) {
    return fallback;
  }
}

async function setSetting(db, key, value) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Minimum retail price that keeps the margin intact.
function computeFloor(cost, marginType, marginValue) {
  const c = Number(cost);
  const m = Math.max(0, Number(marginValue) || 0);
  if (!Number.isFinite(c) || c < 0) return null;
  if (marginType === 'fixed') return Math.ceil((c + m) * 100) / 100;
  return Math.ceil(c * (1 + m / 100));
}

async function logHistory(db, productId, productKey, oldCost, newCost, oldPrice, newPrice, note) {
  await db.prepare(
    'INSERT INTO busan_price_history (product_id, pack_id, old_cost, new_cost, old_price, new_price, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(productId, productKey || null, oldCost, newCost, oldPrice, newPrice, note);
}

async function runSync(db) {
  const summary = {
    checked: 0,
    costUpdates: 0,
    priceIncreases: 0,
    priceDecreases: 0,
    warnings: [],
    skipped: false,
    note: '',
  };

  const enabled = await getSetting(db, 'busan_sync_enabled', '1');
  if (enabled !== '1') {
    summary.skipped = true;
    summary.note = 'Price sync is disabled (busan_sync_enabled).';
    return summary;
  }
  if (!busan.configured()) {
    summary.skipped = true;
    summary.note = 'Busan not configured: set the BUSAN_API_KEY environment variable.';
    return summary;
  }

  let products;
  try {
    products = await busan.getProducts();
  } catch (e) {
    summary.skipped = true;
    summary.note = 'Could not fetch Busan products: ' + (e && e.message ? e.message : 'unknown error');
    return summary;
  }

  const byProductId = new Map();
  for (const p of products) {
    if (p && p.productId) {
      byProductId.set(String(p.productId), {
        cost: busanCostToInr(busan.parsePrice(p.price)),
        name: p.productName || '',
      });
    }
  }

  const gMarginType = (await getSetting(db, 'busan_margin_type', 'percent')) === 'fixed' ? 'fixed' : 'percent';
  const gMarginValue = Math.max(0, Number(await getSetting(db, 'busan_margin_value', '15')) || 0);
  const autoDecrease = (await getSetting(db, 'busan_auto_decrease', '0')) === '1';

  const rows = await db.prepare(
    "SELECT id, name, price_regular, cost_price, margin_type, margin_value, busan_product_id " +
    "FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''"
  ).all();

  for (const p of rows) {
    summary.checked++;
    try {
      const pid = String(p.busan_product_id);
      const svc = byProductId.get(pid);
      const oldCost = p.cost_price === null || p.cost_price === undefined ? null : Number(p.cost_price);
      const oldPrice = Number(p.price_regular);

      if (!svc) {
        summary.warnings.push({
          product: p.name,
          packId: pid,
          reason: 'product not found in Busan catalogue',
        });
        await logHistory(db, p.id, pid, oldCost, oldCost, oldPrice, oldPrice, 'product unavailable');
        continue;
      }

      const newCost = svc.cost;
      if (!Number.isFinite(newCost) || newCost < 0) {
        summary.warnings.push({ product: p.name, packId: pid, reason: 'invalid price from Busan: ' + svc.cost });
        continue;
      }
      if (oldCost !== null && oldCost === newCost) continue; // nothing changed

      summary.costUpdates++;
      const mType = p.margin_type === 'fixed' || p.margin_type === 'percent' ? p.margin_type : gMarginType;
      const mVal = p.margin_value === null || p.margin_value === undefined ? gMarginValue : Math.max(0, Number(p.margin_value) || 0);
      const floor = computeFloor(newCost, mType, mVal);

      let newPrice = oldPrice;
      let note = 'cost updated, price unchanged';
      if (floor !== null && floor > oldPrice) {
        newPrice = floor;
        note = 'auto-increase';
        summary.priceIncreases++;
      } else if (floor !== null && autoDecrease && floor < oldPrice) {
        newPrice = floor;
        note = 'auto-decrease';
        summary.priceDecreases++;
      }

      await db.prepare('UPDATE products SET cost_price = ?, price_regular = ? WHERE id = ?').run(newCost, newPrice, p.id);
      await logHistory(db, p.id, pid, oldCost, newCost, oldPrice, newPrice, note);
    } catch (e) {
      summary.warnings.push({
        product: p.name,
        packId: p.busan_product_id,
        reason: 'sync error: ' + (e && e.message ? e.message : 'unknown'),
      });
    }
  }

  await setSetting(db, 'busan_last_sync_at', new Date().toISOString());
  return summary;
}

module.exports = { runSync, computeFloor, getSetting, setSetting };
