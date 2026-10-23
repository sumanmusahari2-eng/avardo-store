const express = require('express');
const multer = require('multer');
const { requireRole } = require('../auth');
const { str, optStr, money, intIn, slugify, isSlug, isEmail } = require('../validate');

// ID checker mode: 'auto' (show when a game is detected), 'show' (always),
// 'hide' (never). Used on both products and categories.
function idCheckMode(v, fallback = 'auto') {
  const m = String(v || '').toLowerCase().trim();
  return m === 'show' || m === 'hide' ? m : fallback;
}

// ---------- site logo upload ----------
// The logo is stored as a base64 data URL in settings.site_logo (not as a
// file on disk), so it survives Render free-tier redeploys, which wipe the
// ephemeral filesystem.
const LOGO_MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const extOk = /\.(png|jpe?g|webp|svg)$/i.test(file.originalname || '');
    if (LOGO_MIME_TO_EXT[file.mimetype] && extOk) return cb(null, true);
    cb(new Error('Only PNG, JPG, WebP or SVG images are allowed (max 2MB).'));
  },
});

const TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  paid: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};
const STOCK = ['in_stock', 'low_stock', 'out_of_stock'];
const ROLES = ['admin', 'silver', 'customer'];
const busan = require('../busan');
const { fulfilBusanOrder } = require('../busan-fulfil');
const { handleOrderPaid } = require('../order-paid');
const {
  getBalance,
  creditWallet,
  debitWallet,
  refundWalletForOrder,
  generateVoucherCode,
  round2,
} = require('../wallet');

// Supplier pack ids are short, no spaces. Lenient on purpose.
function cleanPackId(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().slice(0, 100);
  return s ? s : null;
}

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());
  r.use(requireRole('admin'));

  // ---------- Supplier category groups ----------
  // Supplier products live under their own parent categories (e.g. "Busan",
  // a child of Game Top-Ups) so the shop can group them distinctly.
  async function supplierParentId(slug, name, blurb) {
    const hit = await db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
    if (hit) return Number(hit.id);
    let s = slugify(name) || slug;
    let n = 2;
    const base = s;
    while (await db.prepare('SELECT id FROM categories WHERE slug = ?').get(s)) {
      s = (base + '-' + (n++)).slice(0, 90);
    }
    const info = await db.prepare(
      'INSERT INTO categories (name, slug, description, sort_order, active, parent_id, image_url, show_in_menu, show_on_homepage, id_check_mode) VALUES (?, ?, ?, 0, 1, 5, NULL, 1, 1, ?)'
    ).run(name, s, blurb, idCheckMode('auto'));
    const row = (info && info.lastInsertRowid)
      ? { id: info.lastInsertRowid }
      : await db.prepare('SELECT id FROM categories WHERE slug = ?').get(s);
    if (!row) throw new Error('supplier parent insert failed: ' + name);
    return Number(row.id);
  }

  // All game categories live under a single "Games" sub-category (child of
  // Game Top-Ups). Customers never see supplier names.
  async function gamesParentId() {
    return supplierParentId('games', 'Games', 'All games — top-ups for every title in one place.');
  }
  // Clean game name for Busan products: strips trailing parenthesized pack
  // descriptors so each real game gets ONE category instead of one per pack.
  // "Arena Breakout (13640)" -> "Arena Breakout"
  // "Dragonheir: Silent Gods (Account Evaluation Pack(SS))" -> "Dragonheir: Silent Gods"
  function cleanSupplierGameName(p) {
    const g = p.gameName || p.game || p.categoryName || p.category || '';
    if (g) return String(g).trim().slice(0, 80);
    const nm = String(p.productName || p.name || '');
    let base = nm.split(/\s[-|]\s/)[0].trim();
    // Strip trailing balanced parenthesized groups (handles nesting).
    for (;;) {
      if (!base.endsWith(')')) break;
      let depth = 0, i = base.length - 1;
      for (; i >= 0; i--) {
        const ch = base[i];
        if (ch === ')') depth++;
        else if (ch === '(') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0 || i <= 0) break;
      base = base.slice(0, i).trim();
    }
    // Also strip a trailing UNbalanced "(..." (messy supplier data, e.g.
    // "Freefire Brazil (Level Up Package").
    base = base.replace(/\s*\([^()]*$/, '').trim();
    return (base || 'Other').slice(0, 80) || 'Other';
  }

  // ---------- coupons ----------
  const normalizeCoupon = async (b, selfId) => {
    const code = String(b.code || '').trim().toUpperCase();
    if (code.length < 2 || code.length > 40 || !/^[A-Z0-9._-]+$/.test(code)) {
      return { error: 'Coupon code must be 2-40 characters (letters, numbers, -, _ or .).' };
    }
    const dup = await db.prepare('SELECT id FROM coupons WHERE code = ?').get(code);
    if (dup && dup.id !== selfId) {
      return { error: 'A coupon with this code already exists.' };
    }
    const discountType = String(b.discount_type || '');
    if (discountType !== 'percent' && discountType !== 'flat') {
      return { error: 'Discount type must be percent or flat.' };
    }
    const discountValue = money(b.discount_value);
    if (discountValue === null || discountValue <= 0) {
      return { error: 'Discount value must be greater than 0.' };
    }
    if (discountType === 'percent' && discountValue > 100) {
      return { error: 'Percent discount cannot exceed 100.' };
    }
    let usageLimit = null;
    if (b.usage_limit !== undefined && b.usage_limit !== null && String(b.usage_limit).trim() !== '') {
      usageLimit = intIn(b.usage_limit, 1, 2147483647);
      if (!usageLimit) return { error: 'Usage limit must be a positive whole number.' };
    }
    let expiresAt = null;
    if (b.expires_at !== undefined && b.expires_at !== null && String(b.expires_at).trim() !== '') {
      const d = String(b.expires_at).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d + 'T23:59:59').getTime())) {
        return { error: 'Expiry date must be YYYY-MM-DD.' };
      }
      expiresAt = d;
    }
    const active = b.active === false || b.active === 0 || b.active === '0' ? 0 : 1;
    return { coupon: { code, discount_type: discountType, discount_value: discountValue, usage_limit: usageLimit, expires_at: expiresAt, active } };
  };

  r.get('/coupons', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM coupons ORDER BY id DESC').all());
  });

  r.post('/coupons', async (req, res) => {
    const norm = await normalizeCoupon(req.body || {}, null);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const c = norm.coupon;
    const info = await db.prepare(
      'INSERT INTO coupons (code, discount_type, discount_value, usage_limit, expires_at, active) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(c.code, c.discount_type, c.discount_value, c.usage_limit, c.expires_at, c.active);
    res.status(201).json(await db.prepare('SELECT * FROM coupons WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/coupons/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM coupons WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Coupon not found.' });
    const b = req.body || {};
    const merged = {
      code: b.code !== undefined ? b.code : cur.code,
      discount_type: b.discount_type !== undefined ? b.discount_type : cur.discount_type,
      discount_value: b.discount_value !== undefined ? b.discount_value : cur.discount_value,
      usage_limit: b.usage_limit !== undefined ? b.usage_limit : cur.usage_limit,
      expires_at: b.expires_at !== undefined ? b.expires_at : cur.expires_at,
      active: b.active !== undefined ? b.active : cur.active,
    };
    const norm = await normalizeCoupon(merged, id);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const c = norm.coupon;
    await db.prepare(
      'UPDATE coupons SET code = ?, discount_type = ?, discount_value = ?, usage_limit = ?, expires_at = ?, active = ? WHERE id = ?'
    ).run(c.code, c.discount_type, c.discount_value, c.usage_limit, c.expires_at, c.active, id);
    res.json(await db.prepare('SELECT * FROM coupons WHERE id = ?').get(id));
  });

  r.delete('/coupons/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const info = await db.prepare('DELETE FROM coupons WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'Coupon not found.' });
    res.json({ ok: true });
  });

  // ---------- reviews ----------
  r.get('/reviews', async (req, res) => {
    res.json(await db.prepare(
      `SELECT r.id, r.product_id, r.user_id, r.rating, r.text, r.approved, r.created_at,
              p.name AS product_name, u.name AS customer_name
       FROM reviews r
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.approved ASC, r.id DESC`
    ).all());
  });

  r.put('/reviews/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Review not found.' });
    const b = req.body || {};
    if (b.remove) {
      await db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
      return res.json({ ok: true });
    }
    const approved = b.approved ? 1 : 0;
    await db.prepare('UPDATE reviews SET approved = ? WHERE id = ?').run(approved, id);
    res.json(await db.prepare('SELECT * FROM reviews WHERE id = ?').get(id));
  });

  // ---------- stats ----------
  r.get('/stats', async (req, res) => {
    const q = async (sql, ...p) => db.prepare(sql).get(...p);
    res.json({
      users: (await q('SELECT COUNT(*) AS c FROM users')).c,
      products: (await q('SELECT COUNT(*) AS c FROM products WHERE active = 1')).c,
      orders: (await q('SELECT COUNT(*) AS c FROM orders')).c,
      pending_orders: (await q("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'")).c,
      revenue: (await q("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status IN ('paid','delivered')")).s,
    });
  });

  // ---------- sales dashboard ----------
  // GET /api/admin/dashboard/stats?range=today|24h|7d|30d
  // Revenue = sum(order.total) for paid/delivered orders in range.
  // Profit  = sum(order.total - COGS); COGS comes from the per-item unit_cost
  // snapshotted at checkout. Orders with any item missing cost data are
  // excluded from profit and reported via orders_missing_cost.
  // All ranges are computed in IST (the store's timezone).
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;
  const tsMillis = (v) => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    }
    return 0;
  };
  const utcStamp = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const istParts = (ms) => {
    const d = new Date(ms + IST_OFFSET_MS);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), h: d.getUTCHours() };
  };

  r.get('/dashboard/stats', async (req, res) => {
    const range = ['today', '24h', '7d', '30d'].includes(req.query.range) ? req.query.range : '7d';
    const now = Date.now();
    const nowIst = istParts(now);
    let startMs, buckets;
    if (range === 'today') {
      // IST midnight → now, hourly buckets.
      startMs = Date.UTC(nowIst.y, nowIst.mo, nowIst.day) - IST_OFFSET_MS;
      buckets = Array.from({ length: 24 }, (_, i) => {
        const h = i;
        const ampm = h < 12 ? 'am' : 'pm';
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return { start: startMs + i * 3600e3, end: startMs + (i + 1) * 3600e3, label: `${h12}${ampm}`, revenue: 0, profit: 0, orders: 0 };
      });
    } else if (range === '24h') {
      // Rolling 24 hours, hourly buckets.
      startMs = now - 24 * 3600e3;
      buckets = Array.from({ length: 24 }, (_, i) => {
        const bStart = startMs + i * 3600e3;
        const p = istParts(bStart);
        const ampm = p.h < 12 ? 'am' : 'pm';
        const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
        return { start: bStart, end: bStart + 3600e3, label: `${h12}${ampm}`, revenue: 0, profit: 0, orders: 0 };
      });
    } else {
      // 7d / 30d: daily IST buckets.
      const days = range === '7d' ? 7 : 30;
      const istMidnight = Date.UTC(nowIst.y, nowIst.mo, nowIst.day) - IST_OFFSET_MS;
      startMs = istMidnight - (days - 1) * 86400e3;
      buckets = Array.from({ length: days }, (_, i) => {
        const bStart = startMs + i * 86400e3;
        const p = istParts(bStart);
        return { start: bStart, end: bStart + 86400e3, label: `${MONTHS[p.mo]} ${p.day}`, revenue: 0, profit: 0, orders: 0 };
      });
    }

    const rows = await db.prepare(
      `SELECT id, total, currency, items, created_at FROM orders
       WHERE status IN ('paid','delivered') AND created_at >= ? ORDER BY created_at ASC`
    ).all(utcStamp(startMs));

    let revenue = 0, profit = 0, orders = 0, profitOrders = 0, missingCost = 0;
    // Dashboard reports in INR; USD order totals convert at the fixed store rate.
    const USD_RATE = 103;
    for (const o of rows) {
      const t = tsMillis(o.created_at);
      if (t < startMs) continue;
      const total = Number(o.total) || 0;
      const totalInr = o.currency === 'USD' ? total * USD_RATE : total;
      revenue += totalInr;
      orders += 1;
      // COGS from checkout-time cost snapshot.
      let cogs = 0, known = true;
      try {
        const items = JSON.parse(o.items || '[]');
        for (const it of (Array.isArray(items) ? items : [])) {
          const qty = Number(it.qty) || 0;
          const c = it.unit_cost;
          if (c === null || c === undefined || !Number.isFinite(Number(c))) { known = false; break; }
          cogs += Number(c) * qty;
        }
      } catch (_) { known = false; }
      const oProfit = known ? totalInr - cogs : null;
      if (oProfit === null) missingCost += 1;
      else { profit += oProfit; profitOrders += 1; }
      // Bucket it.
      const b = buckets.find((x) => t >= x.start && t < x.end) || buckets[buckets.length - 1];
      b.revenue += totalInr;
      b.orders += 1;
      if (oProfit !== null) b.profit += oProfit;
    }
    const round2 = (n) => Math.round(n * 100) / 100;
    res.json({
      range,
      revenue: round2(revenue),
      profit: round2(profit),
      profit_orders: profitOrders,
      orders_missing_cost: missingCost,
      orders,
      avg_order_value: orders ? round2(revenue / orders) : 0,
      buckets: buckets.map((b) => ({
        label: b.label, revenue: round2(b.revenue), profit: round2(b.profit), orders: b.orders,
      })),
    });
  });

  // ---------- categories ----------
  r.get('/categories', async (req, res) => {
    res.json(await db.prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count,
         (SELECT COUNT(*) FROM categories k WHERE k.parent_id = c.id) AS child_count
       FROM categories c ORDER BY c.sort_order, c.id`
    ).all());
  });

  // Validate a parent_id for create/update. Returns { parentId } or { error }.
  const resolveParent = async (rawParentId, selfId) => {
    if (rawParentId === undefined || rawParentId === null || rawParentId === '') return { parentId: null };
    const parentId = intIn(rawParentId, 1, 2147483647);
    if (!parentId) return { error: 'Invalid parent category.' };
    if (selfId && parentId === selfId) return { error: 'A category cannot be its own parent.' };
    const parent = await db.prepare('SELECT id, parent_id FROM categories WHERE id = ?').get(parentId);
    if (!parent) return { error: 'Parent category not found.' };
    if (parent.parent_id !== null && parent.parent_id !== undefined) {
      return { error: 'Sub-categories cannot have their own sub-categories (max 2 levels).' };
    }
    if (selfId) {
      const kids = (await db.prepare('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?').get(selfId)).c;
      if (kids > 0) return { error: 'This category has sub-categories, so it cannot be moved under another category.' };
    }
    return { parentId };
  };

  r.post('/categories', async (req, res) => {
    const name = str(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Category name is required.' });
    const slug = isSlug(req.body.slug) ? req.body.slug : slugify(name);
    if (!slug) return res.status(400).json({ error: 'Could not derive a valid slug.' });
    if (await db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)) {
      return res.status(409).json({ error: 'A category with this slug already exists.' });
    }
    const rp = await resolveParent(req.body.parent_id, null);
    if (rp.error) return res.status(400).json({ error: rp.error });
    const info = await db.prepare(
      'INSERT INTO categories (name, slug, description, sort_order, active, parent_id, image_url, show_in_menu, show_on_homepage, id_check_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, slug, optStr(req.body.description, 500), intIn(req.body.sort_order, 0, 9999) || 0,
      req.body.active === false || req.body.active === 0 ? 0 : 1, rp.parentId,
      optStr(req.body.image_url, 4000000),
      req.body.show_in_menu === false || req.body.show_in_menu === 0 ? 0 : 1,
      req.body.show_on_homepage === false || req.body.show_on_homepage === 0 ? 0 : 1,
      idCheckMode(req.body.id_check_mode));
    res.status(201).json(await db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/categories/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Category not found.' });
    const name = req.body.name !== undefined ? str(req.body.name, 120) : cur.name;
    if (!name) return res.status(400).json({ error: 'Category name is required.' });
    let slug = cur.slug;
    if (req.body.slug !== undefined) {
      slug = isSlug(req.body.slug) ? req.body.slug : slugify(req.body.slug || name);
      const clash = await db.prepare('SELECT id FROM categories WHERE slug = ? AND id != ?').get(slug, id);
      if (clash) return res.status(409).json({ error: 'Another category already uses this slug.' });
    }
    let parentId = cur.parent_id;
    if (req.body.parent_id !== undefined) {
      const rp = await resolveParent(req.body.parent_id, id);
      if (rp.error) return res.status(400).json({ error: rp.error });
      parentId = rp.parentId;
    }
    await db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ?, active = ?, parent_id = ?, image_url = ?, show_in_menu = ?, show_on_homepage = ?, id_check_mode = ? WHERE id = ?').run(
      name, slug,
      req.body.description !== undefined ? optStr(req.body.description, 500) : cur.description,
      req.body.sort_order !== undefined ? (intIn(req.body.sort_order, 0, 9999) || 0) : cur.sort_order,
      req.body.active !== undefined ? (req.body.active ? 1 : 0) : cur.active,
      parentId,
      req.body.image_url !== undefined ? optStr(req.body.image_url, 4000000) : cur.image_url,
      req.body.show_in_menu !== undefined ? (req.body.show_in_menu ? 1 : 0) : (cur.show_in_menu ?? 1),
      req.body.show_on_homepage !== undefined ? (req.body.show_on_homepage ? 1 : 0) : (cur.show_on_homepage ?? 1),
      req.body.id_check_mode !== undefined ? idCheckMode(req.body.id_check_mode, cur.id_check_mode || 'auto') : (cur.id_check_mode || 'auto'),
      id
    );
    res.json(await db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  });

  r.delete('/categories/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const used = (await db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ?').get(id)).c;
    if (used > 0) return res.status(400).json({ error: `Cannot delete: ${used} product(s) use this category.` });
    const kids = (await db.prepare('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?').get(id)).c;
    if (kids > 0) return res.status(400).json({ error: `Cannot delete: this category has ${kids} sub-categor${kids === 1 ? 'y' : 'ies'}. Move or delete them first.` });
    const info = await db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'Category not found.' });
    res.json({ ok: true });
  });

  // ---------- products ----------
  const productRow = async (id) => {
    const p = await db.prepare(
      `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`
    ).get(id);
    if (p) {
      p.checkout_attributes = await db.prepare(
        'SELECT id, product_id, label, field_type, required, sort_order, options FROM product_checkout_attributes WHERE product_id = ? ORDER BY sort_order, id'
      ).all(id);
    }
    return p;
  };

  // Validate + normalize a stock_quantity body value. undefined = leave as-is.
  const parseStockQuantity = (v) => {
    if (v === undefined) return { ok: true, skip: true };
    if (v === null || v === '') return { ok: true, value: null };
    const n = intIn(v, 0, 2147483647);
    if (n === null) return { ok: false, error: 'Stock quantity must be 0 or more (blank = unlimited).' };
    return { ok: true, value: n };
  };

  // Validate + normalize checkout_attributes. undefined = leave as-is.
  const parseCheckoutAttributes = (v) => {
    if (v === undefined) return { ok: true, skip: true };
    if (!Array.isArray(v)) return { ok: false, error: 'Checkout attributes must be a list.' };
    if (v.length > 20) return { ok: false, error: 'Too many checkout attributes (max 20).' };
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const a = v[i] || {};
      const label = str(a.label, 100);
      if (!label) return { ok: false, error: `Checkout question ${i + 1}: label is required.` };
      const fieldType = String(a.field_type || 'text');
      if (fieldType !== 'text' && fieldType !== 'textarea' && fieldType !== 'select') {
        return { ok: false, error: `Checkout question "${label}": type must be text, textarea, or dropdown.` };
      }
      // Dropdown options: newline or comma separated list.
      let options = null;
      if (fieldType === 'select') {
        const raw = String(a.options || '');
        const list = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
        if (!list.length) return { ok: false, error: `Checkout question "${label}": dropdown needs at least one option.` };
        options = JSON.stringify(list);
      }
      out.push({ label, field_type: fieldType, required: a.required === false || a.required === 0 ? 0 : 1, sort_order: i, options });
    }
    return { ok: true, value: out };
  };

  const replaceCheckoutAttributes = async (productId, attrs) => {
    await db.prepare('DELETE FROM product_checkout_attributes WHERE product_id = ?').run(productId);
    for (const a of attrs) {
      await db.prepare(
        'INSERT INTO product_checkout_attributes (product_id, label, field_type, required, sort_order, options) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(productId, a.label, a.field_type, a.required, a.sort_order, a.options);
    }
  };

  r.get('/products', async (req, res) => {
    res.json(await db.prepare(
      `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC`
    ).all());
  });

  r.get('/products/:id', async (req, res) => {
    const p = await productRow(req.params.id);
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    res.json(p);
  });

  r.post('/products', async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 200);
    const priceRegular = money(b.price_regular) ?? 0;
    const priceGold = (b.price_gold === null || b.price_gold === undefined || b.price_gold === '') ? null : money(b.price_gold);
    if (priceGold === null && b.price_gold !== null && b.price_gold !== undefined && b.price_gold !== '') return res.status(400).json({ error: 'Invalid gold price.' });
    const priceSilver = (b.price_silver === null || b.price_silver === undefined || b.price_silver === '') ? null : money(b.price_silver);
    if (priceSilver === null && b.price_silver !== null && b.price_silver !== undefined && b.price_silver !== '') return res.status(400).json({ error: 'Invalid silver price.' });
    if (!name) return res.status(400).json({ error: 'Product name is required.' });
    const slug = isSlug(b.slug) ? b.slug : slugify(name);
    if (await db.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) {
      return res.status(409).json({ error: 'A product with this slug already exists.' });
    }
    let categoryId = null;
    if (b.category_id !== undefined && b.category_id !== null && b.category_id !== '') {
      categoryId = intIn(b.category_id, 1, 2147483647);
      if (!categoryId || !await db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
        return res.status(400).json({ error: 'Invalid category.' });
      }
    }
    const priceMrp = b.price_mrp === undefined || b.price_mrp === null || b.price_mrp === '' ? null : money(b.price_mrp);
    if (b.price_mrp !== undefined && b.price_mrp !== null && b.price_mrp !== '' && priceMrp === null) {
      return res.status(400).json({ error: 'Invalid MRP.' });
    }
    const stockStatus = STOCK.includes(b.stock_status) ? b.stock_status : 'in_stock';
    const sq = parseStockQuantity(b.stock_quantity);
    if (!sq.ok) return res.status(400).json({ error: sq.error });
    const ca = parseCheckoutAttributes(b.checkout_attributes);
    if (!ca.ok) return res.status(400).json({ error: ca.error });
    const isVoucher = b.is_voucher ? 1 : 0;
    const voucherAmount = b.voucher_amount === undefined || b.voucher_amount === null || b.voucher_amount === ''
      ? null : money(b.voucher_amount);
    if (isVoucher && !(voucherAmount > 0)) {
      return res.status(400).json({ error: 'Voucher products need a gift-card amount greater than 0.' });
    }
    if (!isVoucher && b.voucher_amount !== undefined && b.voucher_amount !== null && b.voucher_amount !== '' && voucherAmount === null) {
      return res.status(400).json({ error: 'Invalid voucher amount.' });
    }
    // Voucher face-value currency (locked — never converts with display currency).
    const voucherCurrency = String(b.voucher_currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
    // Cost price: what you pay per unit (supplier/wholesale). Used for profit reporting.
    // Blank = unknown (profit for those sales shows as "n/a" until set).
    const costPrice = b.cost_price === undefined || b.cost_price === null || b.cost_price === ''
      ? null : money(b.cost_price);
    if (b.cost_price !== undefined && b.cost_price !== null && b.cost_price !== '' && costPrice === null) {
      return res.status(400).json({ error: 'Invalid cost price.' });
    }
    // Optional USD prices (blank = auto-converted from the INR price at the fixed rate).
    const priceUsd = b.price_usd === undefined || b.price_usd === null || b.price_usd === '' ? null : money(b.price_usd);
    if (b.price_usd !== undefined && b.price_usd !== null && b.price_usd !== '' && priceUsd === null) {
      return res.status(400).json({ error: 'Invalid USD price.' });
    }
    const priceUsdGold = b.price_usd_gold === undefined || b.price_usd_gold === null || b.price_usd_gold === '' ? null : money(b.price_usd_gold);
    if (b.price_usd_gold !== undefined && b.price_usd_gold !== null && b.price_usd_gold !== '' && priceUsdGold === null) {
      return res.status(400).json({ error: 'Invalid USD gold price.' });
    }
    const priceUsdSilver = b.price_usd_silver === undefined || b.price_usd_silver === null || b.price_usd_silver === '' ? null : money(b.price_usd_silver);
    if (b.price_usd_silver !== undefined && b.price_usd_silver !== null && b.price_usd_silver !== '' && priceUsdSilver === null) {
      return res.status(400).json({ error: 'Invalid USD silver price.' });
    }
    // Per-currency availability: default available in both.
    const availInr = (b.available_inr === false || b.available_inr === 0 || b.available_inr === '0') ? 0 : 1;
    const availUsd = (b.available_usd === false || b.available_usd === 0 || b.available_usd === '0') ? 0 : 1;
    const info = await db.prepare(
      `INSERT INTO products
       (category_id, name, slug, description, image_url, chip_image_url, chip_text, price_mrp, price_regular, price_gold, price_silver, price_reseller, price_usd, price_usd_gold, price_usd_silver, price_usd_reseller, available_inr, available_usd, cost_price, stock_status, stock_quantity, topzy_pack_id, topzy_auto_fulfil, busan_product_id, busan_auto_fulfil, is_voucher, voucher_amount, voucher_currency, featured, active, id_check_mode, how_to_order_text, how_to_order_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      categoryId, name, slug, optStr(b.description, 5000), optStr(b.image_url, 400000), optStr(b.chip_image_url, 400000), optStr(b.chip_text, 40),
      priceMrp, priceRegular, priceGold, priceSilver, priceGold ?? priceSilver ?? priceRegular, priceUsd, priceUsdGold, priceUsdSilver, priceUsdGold ?? priceUsdSilver ?? priceUsd, availInr, availUsd, costPrice, stockStatus, sq.skip ? null : sq.value,
      cleanPackId(b.topzy_pack_id),
      (b.topzy_auto_fulfil === 0 || b.topzy_auto_fulfil === '0' || b.topzy_auto_fulfil === false) ? 0 : 1,
      cleanPackId(b.busan_product_id),
      (b.busan_auto_fulfil === 1 || b.busan_auto_fulfil === '1' || b.busan_auto_fulfil === true) ? 1 : 0,
      isVoucher, isVoucher ? voucherAmount : null, voucherCurrency,
      b.featured ? 1 : 0, b.active === false || b.active === 0 ? 0 : 1,
      idCheckMode(b.id_check_mode),
      optStr(b.how_to_order_text, 5000), optStr(b.how_to_order_image, 400000)
    );
    const newId = info.lastInsertRowid;
    if (!ca.skip) await replaceCheckoutAttributes(newId, ca.value);
    res.status(201).json(await productRow(newId));
  });

  r.put('/products/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Product not found.' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const name = str(b.name, 200);
      if (!name) return res.status(400).json({ error: 'Product name is required.' });
      patch.name = name;
    }
    if (b.slug !== undefined) {
      const slug = isSlug(b.slug) ? b.slug : slugify(b.slug);
      if (await db.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').get(slug, id)) {
        return res.status(409).json({ error: 'Another product already uses this slug.' });
      }
      patch.slug = slug;
    }
    if (b.price_regular !== undefined) {
      const v = money(b.price_regular);
      if (v === null) return res.status(400).json({ error: 'Invalid regular price.' });
      patch.price_regular = v;
    }
    if (b.price_gold !== undefined) {
      const v = (b.price_gold === null || b.price_gold === '') ? null : money(b.price_gold);
      if (b.price_gold !== null && b.price_gold !== '' && v === null) return res.status(400).json({ error: 'Invalid gold price.' });
      patch.price_gold = v;
    }
    if (b.price_silver !== undefined) {
      const v = (b.price_silver === null || b.price_silver === '') ? null : money(b.price_silver);
      if (b.price_silver !== null && b.price_silver !== '' && v === null) return res.status(400).json({ error: 'Invalid silver price.' });
      patch.price_silver = v;
    }
    if (b.price_usd !== undefined) {
      const v = (b.price_usd === null || b.price_usd === '') ? null : money(b.price_usd);
      if (b.price_usd !== null && b.price_usd !== '' && v === null) {
        return res.status(400).json({ error: 'Invalid USD price.' });
      }
      patch.price_usd = v;
    }
    if (b.price_usd_gold !== undefined) {
      const v = (b.price_usd_gold === null || b.price_usd_gold === '') ? null : money(b.price_usd_gold);
      if (b.price_usd_gold !== null && b.price_usd_gold !== '' && v === null) {
        return res.status(400).json({ error: 'Invalid USD gold price.' });
      }
      patch.price_usd_gold = v;
    }
    if (b.price_usd_silver !== undefined) {
      const v = (b.price_usd_silver === null || b.price_usd_silver === '') ? null : money(b.price_usd_silver);
      if (b.price_usd_silver !== null && b.price_usd_silver !== '' && v === null) {
        return res.status(400).json({ error: 'Invalid USD silver price.' });
      }
      patch.price_usd_silver = v;
    }
    if (b.available_inr !== undefined) {
      patch.available_inr = (b.available_inr === false || b.available_inr === 0 || b.available_inr === '0') ? 0 : 1;
    }
    if (b.available_usd !== undefined) {
      patch.available_usd = (b.available_usd === false || b.available_usd === 0 || b.available_usd === '0') ? 0 : 1;
    }
    if (b.price_mrp !== undefined) {
      patch.price_mrp = (b.price_mrp === null || b.price_mrp === '') ? null : money(b.price_mrp);
      if (b.price_mrp !== null && b.price_mrp !== '' && patch.price_mrp === null) {
        return res.status(400).json({ error: 'Invalid MRP.' });
      }
    }
    if (b.cost_price !== undefined) {
      patch.cost_price = (b.cost_price === null || b.cost_price === '') ? null : money(b.cost_price);
      if (b.cost_price !== null && b.cost_price !== '' && patch.cost_price === null) {
        return res.status(400).json({ error: 'Invalid cost price.' });
      }
    }
    if (b.category_id !== undefined) {
      if (b.category_id === null || b.category_id === '') patch.category_id = null;
      else {
        const cid = intIn(b.category_id, 1, 2147483647);
        if (!cid || !await db.prepare('SELECT id FROM categories WHERE id = ?').get(cid)) {
          return res.status(400).json({ error: 'Invalid category.' });
        }
        patch.category_id = cid;
      }
    }
    if (b.stock_status !== undefined) {
      if (!STOCK.includes(b.stock_status)) return res.status(400).json({ error: 'Invalid stock status.' });
      patch.stock_status = b.stock_status;
    }
    if (b.stock_quantity !== undefined) {
      const sq = parseStockQuantity(b.stock_quantity);
      if (!sq.ok) return res.status(400).json({ error: sq.error });
      patch.stock_quantity = sq.value;
    }
    if (b.checkout_attributes !== undefined) {
      const ca = parseCheckoutAttributes(b.checkout_attributes);
      if (!ca.ok) return res.status(400).json({ error: ca.error });
      await replaceCheckoutAttributes(id, ca.value);
    }
    if (b.description !== undefined) patch.description = optStr(b.description, 5000);
    if (b.how_to_order_text !== undefined) patch.how_to_order_text = optStr(b.how_to_order_text, 5000);
    if (b.how_to_order_image !== undefined) patch.how_to_order_image = optStr(b.how_to_order_image, 400000);
    if (b.image_url !== undefined) patch.image_url = optStr(b.image_url, 400000);
    if (b.chip_image_url !== undefined) patch.chip_image_url = optStr(b.chip_image_url, 400000);
    if (b.chip_text !== undefined) patch.chip_text = optStr(b.chip_text, 40);
    if (b.topzy_pack_id !== undefined) patch.topzy_pack_id = cleanPackId(b.topzy_pack_id);
    if (b.topzy_auto_fulfil !== undefined) patch.topzy_auto_fulfil = (b.topzy_auto_fulfil === 0 || b.topzy_auto_fulfil === '0' || b.topzy_auto_fulfil === false) ? 0 : 1;
    if (b.busan_auto_fulfil !== undefined) patch.busan_auto_fulfil = (b.busan_auto_fulfil === 1 || b.busan_auto_fulfil === '1' || b.busan_auto_fulfil === true) ? 1 : 0;
    if (b.busan_product_id !== undefined) patch.busan_product_id = cleanPackId(b.busan_product_id);
    if (b.id_check_mode !== undefined) patch.id_check_mode = idCheckMode(b.id_check_mode, cur.id_check_mode || 'auto');
    if (b.is_voucher !== undefined || b.voucher_amount !== undefined || b.voucher_currency !== undefined) {
      const newIsVoucher = b.is_voucher !== undefined ? (b.is_voucher ? 1 : 0) : Number(cur.is_voucher || 0);
      let newAmount = cur.voucher_amount;
      if (b.voucher_amount !== undefined) {
        newAmount = (b.voucher_amount === null || b.voucher_amount === '') ? null : money(b.voucher_amount);
        if (b.voucher_amount !== null && b.voucher_amount !== '' && newAmount === null) {
          return res.status(400).json({ error: 'Invalid voucher amount.' });
        }
      }
      if (newIsVoucher && !(Number(newAmount) > 0)) {
        return res.status(400).json({ error: 'Voucher products need a gift-card amount greater than 0.' });
      }
      patch.is_voucher = newIsVoucher;
      patch.voucher_amount = newIsVoucher ? newAmount : null;
      patch.voucher_currency = String(b.voucher_currency || cur.voucher_currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
    }
    if (b.margin_type !== undefined) {
      patch.margin_type = (b.margin_type === 'percent' || b.margin_type === 'fixed') ? b.margin_type : null;
    }
    if (b.margin_value !== undefined) {
      if (b.margin_value === null || b.margin_value === '') {
        patch.margin_value = null;
      } else {
        const mv = money(b.margin_value);
        if (mv === null || mv < 0) return res.status(400).json({ error: 'Invalid margin value.' });
        patch.margin_value = mv;
      }
    }
    if (b.featured !== undefined) patch.featured = b.featured ? 1 : 0;
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;

    const keys = Object.keys(patch);
    if (keys.length) {
      const set = keys.map((k) => `${k} = ?`).join(', ');
      await db.prepare(`UPDATE products SET ${set} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
    }
    res.json(await productRow(id));
  });

  // ---------- product variants (options) ----------
  const variantRow = async (id) =>
    db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id);
  const parseVariant = (b) => {
    const name = str(b.name, 200);
    if (!name) return { error: 'Option name is required.' };
    const priceRegular = money(b.price_regular);
    if (priceRegular === null) return { error: 'A valid regular price is required.' };
    const priceGold = (b.price_gold === null || b.price_gold === undefined || b.price_gold === '') ? null : money(b.price_gold);
    if (priceGold === null && b.price_gold !== null && b.price_gold !== undefined && b.price_gold !== '') return res.status(400).json({ error: 'Invalid gold price.' });
    const priceSilver = (b.price_silver === null || b.price_silver === undefined || b.price_silver === '') ? null : money(b.price_silver);
    if (priceSilver === null && b.price_silver !== null && b.price_silver !== undefined && b.price_silver !== '') return res.status(400).json({ error: 'Invalid silver price.' });
    const priceMrp = b.price_mrp === undefined || b.price_mrp === null || b.price_mrp === ''
      ? null : money(b.price_mrp);
    if (b.price_mrp !== undefined && b.price_mrp !== null && b.price_mrp !== '' && priceMrp === null)
      return { error: 'Invalid MRP.' };
    const costPrice = b.cost_price === undefined || b.cost_price === null || b.cost_price === ''
      ? null : money(b.cost_price);
    if (b.cost_price !== undefined && b.cost_price !== null && b.cost_price !== '' && costPrice === null)
      return { error: 'Invalid cost price.' };
    const priceUsd = b.price_usd === undefined || b.price_usd === null || b.price_usd === ''
      ? null : money(b.price_usd);
    if (b.price_usd !== undefined && b.price_usd !== null && b.price_usd !== '' && priceUsd === null)
      return { error: 'Invalid USD price.' };
    const priceUsdGold = b.price_usd_gold === undefined || b.price_usd_gold === null || b.price_usd_gold === ''
      ? null : money(b.price_usd_gold);
    if (b.price_usd_gold !== undefined && b.price_usd_gold !== null && b.price_usd_gold !== '' && priceUsdGold === null)
      return { error: 'Invalid USD gold price.' };
    const priceUsdSilver = b.price_usd_silver === undefined || b.price_usd_silver === null || b.price_usd_silver === ''
      ? null : money(b.price_usd_silver);
    if (b.price_usd_silver !== undefined && b.price_usd_silver !== null && b.price_usd_silver !== '' && priceUsdSilver === null)
      return { error: 'Invalid USD silver price.' };
    const stockStatus = ['in_stock', 'low_stock', 'out_of_stock'].includes(b.stock_status)
      ? b.stock_status : 'in_stock';
    const sortOrder = b.sort_order === undefined || b.sort_order === null || b.sort_order === ''
      ? 0 : (Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : null);
    if (sortOrder === null) return { error: 'Invalid sort order.' };
    const busanProductId = str(b.busan_product_id, 200) || null;
    return {
      value: {
        name, keyword: str(b.keyword, 120) || null, image_url: str(b.image_url, 2000) || null,
        price_mrp: priceMrp, price_regular: priceRegular, price_gold: priceGold, price_silver: priceSilver,
        price_usd: priceUsd, price_usd_gold: priceUsdGold, price_usd_silver: priceUsdSilver,
        cost_price: costPrice, stock_status: stockStatus, sort_order: sortOrder,
        active: b.active === false || b.active === 0 ? 0 : 1,
        busan_product_id: busanProductId,
      },
    };
  };

  r.get('/products/:id/variants', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    res.json(await db.prepare(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id'
    ).all(id));
  });

  r.post('/products/:id/variants', async (req, res) => {
    const productId = intIn(req.params.id, 1, 2147483647);
    if (!productId) return res.status(400).json({ error: 'Invalid id.' });
    if (!await db.prepare('SELECT id FROM products WHERE id = ?').get(productId))
      return res.status(404).json({ error: 'Product not found.' });
    const pv = parseVariant(req.body || {});
    if (pv.error) return res.status(400).json({ error: pv.error });
    const v = pv.value;
    const info = await db.prepare(
      `INSERT INTO product_variants
       (product_id, name, keyword, image_url, price_mrp, price_regular, price_gold, price_silver, price_reseller, price_usd, price_usd_gold, price_usd_silver, price_usd_reseller, cost_price, stock_status, sort_order, active, busan_product_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(productId, v.name, v.keyword, v.image_url, v.price_mrp, v.price_regular, v.price_gold, v.price_silver, v.price_gold ?? v.price_silver ?? v.price_regular, v.price_usd, v.price_usd_gold, v.price_usd_silver, v.price_usd_gold ?? v.price_usd_silver ?? v.price_usd, v.cost_price, v.stock_status, v.sort_order, v.active, v.busan_product_id);
    res.status(201).json(await variantRow(info.lastInsertRowid));
  });

  r.put('/variants/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await variantRow(id);
    if (!cur) return res.status(404).json({ error: 'Option not found.' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const name = str(b.name, 200);
      if (!name) return res.status(400).json({ error: 'Option name is required.' });
      patch.name = name;
    }
    if (b.keyword !== undefined) patch.keyword = str(b.keyword, 120) || null;
    if (b.image_url !== undefined) patch.image_url = str(b.image_url, 2000) || null;
    if (b.price_regular !== undefined) {
      const v = money(b.price_regular);
      if (v === null) return res.status(400).json({ error: 'Invalid regular price.' });
      patch.price_regular = v;
    }
    if (b.price_gold !== undefined) {
      const v = (b.price_gold === null || b.price_gold === '') ? null : money(b.price_gold);
      if (b.price_gold !== null && b.price_gold !== '' && v === null) return res.status(400).json({ error: 'Invalid gold price.' });
      patch.price_gold = v;
    }
    if (b.price_silver !== undefined) {
      const v = (b.price_silver === null || b.price_silver === '') ? null : money(b.price_silver);
      if (b.price_silver !== null && b.price_silver !== '' && v === null) return res.status(400).json({ error: 'Invalid silver price.' });
      patch.price_silver = v;
    }
    if (b.price_usd !== undefined) {
      const v = (b.price_usd === null || b.price_usd === '') ? null : money(b.price_usd);
      if (b.price_usd !== null && b.price_usd !== '' && v === null)
        return res.status(400).json({ error: 'Invalid USD price.' });
      patch.price_usd = v;
    }
    if (b.price_usd_gold !== undefined) {
      const v = (b.price_usd_gold === null || b.price_usd_gold === '') ? null : money(b.price_usd_gold);
      if (b.price_usd_gold !== null && b.price_usd_gold !== '' && v === null)
        return res.status(400).json({ error: 'Invalid USD gold price.' });
      patch.price_usd_gold = v;
    }
    if (b.price_usd_silver !== undefined) {
      const v = (b.price_usd_silver === null || b.price_usd_silver === '') ? null : money(b.price_usd_silver);
      if (b.price_usd_silver !== null && b.price_usd_silver !== '' && v === null)
        return res.status(400).json({ error: 'Invalid USD silver price.' });
      patch.price_usd_silver = v;
    }
    if (b.price_mrp !== undefined) {
      patch.price_mrp = (b.price_mrp === null || b.price_mrp === '') ? null : money(b.price_mrp);
      if (b.price_mrp !== null && b.price_mrp !== '' && patch.price_mrp === null)
        return res.status(400).json({ error: 'Invalid MRP.' });
    }
    if (b.cost_price !== undefined) {
      patch.cost_price = (b.cost_price === null || b.cost_price === '') ? null : money(b.cost_price);
      if (b.cost_price !== null && b.cost_price !== '' && patch.cost_price === null)
        return res.status(400).json({ error: 'Invalid cost price.' });
    }
    if (b.stock_status !== undefined) {
      if (!['in_stock', 'low_stock', 'out_of_stock'].includes(b.stock_status))
        return res.status(400).json({ error: 'Invalid stock status.' });
      patch.stock_status = b.stock_status;
    }
    if (b.sort_order !== undefined) {
      const so = b.sort_order === null || b.sort_order === '' ? 0 : Number(b.sort_order);
      if (!Number.isInteger(so)) return res.status(400).json({ error: 'Invalid sort order.' });
      patch.sort_order = so;
    }
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.busan_product_id !== undefined) {
      patch.busan_product_id = str(b.busan_product_id, 200) || null;
    }
    const keys = Object.keys(patch);
    if (keys.length) {
      const set = keys.map((k) => `${k} = ?`).join(', ');
      await db.prepare(`UPDATE product_variants SET ${set} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
    }
    res.json(await variantRow(id));
  });

  r.delete('/variants/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    await db.prepare('DELETE FROM product_variants WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  r.delete('/products/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const info = await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'Product not found.' });
    await db.prepare('DELETE FROM product_checkout_attributes WHERE product_id = ?').run(id);
    res.json({ ok: true });
  });

  // ---------- support chat (admin inbox) ----------
  r.get('/support/threads', async (req, res) => {
    const threads = await db.prepare(
      `SELECT t.*, u.name AS user_name, u.email AS user_email,
              (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id = t.id AND m.sender = 'customer' AND m.admin_read = 0) AS unread_count,
              (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM support_threads t LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.updated_at DESC LIMIT 200`
    ).all();
    res.json(threads);
  });

  r.get('/support/threads/:id/messages', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const t = await db.prepare('SELECT * FROM support_threads WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'Thread not found.' });
    const messages = await db.prepare(
      'SELECT id, sender, body, attachment_url, created_at FROM support_messages WHERE thread_id = ? ORDER BY id ASC LIMIT 500'
    ).all(id);
    await db.prepare("UPDATE support_messages SET admin_read = 1 WHERE thread_id = ? AND sender = 'customer'").run(id);
    res.json({ thread: t, messages });
  });

  r.post('/support/threads/:id/messages', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const t = await db.prepare('SELECT * FROM support_threads WHERE id = ?').get(id);
    if (!t) return res.status(404).json({ error: 'Thread not found.' });
    const body = str(req.body && req.body.body, 2000);
    let attachment = null;
    const au = req.body && req.body.attachment_url;
    if (au && String(au).startsWith('data:image/') && String(au).length <= 2000000) {
      attachment = String(au).slice(0, 2000000);
    }
    if (!body && !attachment) return res.status(400).json({ error: 'Message cannot be empty.' });
    const info = await db.prepare(
      "INSERT INTO support_messages (thread_id, sender, body, admin_read, attachment_url) VALUES (?, 'admin', ?, 1, ?)"
    ).run(id, body || '', attachment);
    await db.prepare("UPDATE support_threads SET updated_at = CURRENT_TIMESTAMP, status = 'open' WHERE id = ?").run(id);
    const msg = await db.prepare('SELECT id, sender, body, attachment_url, created_at FROM support_messages WHERE id = ?')
      .get(info.lastInsertRowid);
    res.status(201).json({ message: msg });
  });

  r.put('/support/threads/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const status = String((req.body && req.body.status) || '');
    if (status !== 'open' && status !== 'closed') return res.status(400).json({ error: 'Status must be open or closed.' });
    const info = await db.prepare('UPDATE support_threads SET status = ? WHERE id = ?').run(status, id);
    if (!info.changes) return res.status(404).json({ error: 'Thread not found.' });
    res.json({ ok: true, status });
  });

  // ---------- banners ----------
  r.get('/banners', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM banners ORDER BY sort_order, id').all());
  });

  r.post('/banners', async (req, res) => {
    const b = req.body || {};
    const title = str(b.title, 200) || '';
    const info = await db.prepare(
      'INSERT INTO banners (title, subtitle, image_url, link, sort_order, active, placement) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(title, optStr(b.subtitle, 500), optStr(b.image_url, 1000), optStr(b.link, 1000),
      intIn(b.sort_order, 0, 9999) || 0, b.active === false || b.active === 0 ? 0 : 1,
      (() => { const pl = String(b.placement || 'hero').toLowerCase(); return pl === 'featured' ? 'featured' : pl === 'promo' ? 'promo' : 'hero'; })());
    res.status(201).json(await db.prepare('SELECT * FROM banners WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/banners/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM banners WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Banner not found.' });
    const b = req.body || {};
    const title = b.title !== undefined ? (str(b.title, 200) || '') : cur.title;
    await db.prepare('UPDATE banners SET title = ?, subtitle = ?, image_url = ?, link = ?, sort_order = ?, active = ?, placement = ? WHERE id = ?').run(
      title,
      b.subtitle !== undefined ? optStr(b.subtitle, 500) : cur.subtitle,
      b.image_url !== undefined ? optStr(b.image_url, 1000) : cur.image_url,
      b.link !== undefined ? optStr(b.link, 1000) : cur.link,
      b.sort_order !== undefined ? (intIn(b.sort_order, 0, 9999) || 0) : cur.sort_order,
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
      b.placement !== undefined ? (() => { const pl = String(b.placement).toLowerCase(); return pl === 'featured' ? 'featured' : pl === 'promo' ? 'promo' : 'hero'; })() : (cur.placement || 'hero'),
      id
    );
    res.json(await db.prepare('SELECT * FROM banners WHERE id = ?').get(id));
  });

  r.delete('/banners/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const info = await db.prepare('DELETE FROM banners WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'Banner not found.' });
    res.json({ ok: true });
  });

  // ---------- blog posts ----------
  r.get('/posts', async (req, res) => {
    const rows = await db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT 200').all();
    res.json(rows);
  });

  r.post('/posts', async (req, res) => {
    const b = req.body || {};
    const title = str(b.title, 200);
    if (!title) return res.status(400).json({ error: 'Post title is required.' });
    let slug = b.slug ? String(b.slug).trim().toLowerCase() : slugify(title);
    if (!isSlug(slug)) return res.status(400).json({ error: 'Invalid slug.' });
    const dup = await db.prepare('SELECT id FROM posts WHERE slug = ?').get(slug);
    if (dup) return res.status(400).json({ error: 'A post with this slug already exists.' });
    const info = await db.prepare(
      'INSERT INTO posts (slug, title, excerpt, body, image_url, published) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(slug, title, optStr(b.excerpt, 500) || '', optStr(b.body, 200000) || '',
      optStr(b.image_url, 1000), b.published === false || b.published === 0 ? 0 : 1);
    res.status(201).json(await db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/posts/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Post not found.' });
    const b = req.body || {};
    const title = b.title !== undefined ? str(b.title, 200) : cur.title;
    if (!title) return res.status(400).json({ error: 'Post title is required.' });
    let slug = cur.slug;
    if (b.slug !== undefined && String(b.slug).trim() !== cur.slug) {
      slug = String(b.slug).trim().toLowerCase() || slugify(title);
      if (!isSlug(slug)) return res.status(400).json({ error: 'Invalid slug.' });
      const dup = await db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').get(slug, id);
      if (dup) return res.status(400).json({ error: 'A post with this slug already exists.' });
    }
    await db.prepare(
      "UPDATE posts SET slug = ?, title = ?, excerpt = ?, body = ?, image_url = ?, published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(
      slug, title,
      b.excerpt !== undefined ? (optStr(b.excerpt, 500) || '') : cur.excerpt,
      b.body !== undefined ? (optStr(b.body, 200000) || '') : cur.body,
      b.image_url !== undefined ? optStr(b.image_url, 1000) : cur.image_url,
      b.published !== undefined ? (b.published ? 1 : 0) : cur.published,
      id
    );
    res.json(await db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
  });

  r.delete('/posts/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const info = await db.prepare('DELETE FROM posts WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'Post not found.' });
    res.json({ ok: true });
  });

  // ---------- users ----------
  r.get('/users', async (req, res) => {
    res.json(await db.prepare('SELECT id, name, email, role, balance, blocked, membership_expires_at, created_at FROM users ORDER BY id DESC').all());
  });

  // ---------- reseller memberships ----------
  r.get('/memberships', async (req, res) => {
    const { membershipConfig } = require('../memberships');
    const active = await db.prepare(
      `SELECT id, name, email, role, membership_expires_at FROM users
       WHERE role = 'silver' ORDER BY membership_expires_at ASC`
    ).all();
    const history = await db.prepare(
      `SELECT mp.*, u.name AS user_name, u.email AS user_email FROM membership_purchases mp
       LEFT JOIN users u ON u.id = mp.user_id ORDER BY mp.id DESC LIMIT 100`
    ).all();
    res.json({ config: await membershipConfig(db), active, history });
  });

  r.post('/memberships/grant', async (req, res) => {
    const { grantMembership, membershipConfig } = require('../memberships');
    const b = req.body || {};
    const userId = intIn(b.user_id, 1, 2147483647);
    const tier = b.tier;
    if (!userId || tier !== 'silver') {
      return res.status(400).json({ error: 'Select a user and the silver package.' });
    }
    const cfg = await membershipConfig(db);
    const days = b.days !== undefined ? Math.max(1, Math.floor(Number(b.days) || 0)) : cfg.duration_days;
    if (!days) return res.status(400).json({ error: 'Days must be at least 1.' });
    try {
      const m = await grantMembership(db, userId, tier, days, 'admin', 0);
      res.json({ ok: true, ...m });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not grant the membership.' });
    }
  });

  r.post('/memberships/revoke', async (req, res) => {
    const { revokeMembership } = require('../memberships');
    const userId = intIn((req.body || {}).user_id, 1, 2147483647);
    if (!userId) return res.status(400).json({ error: 'Invalid user.' });
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot revoke your own access.' });
    try {
      res.json(await revokeMembership(db, userId));
    } catch (e) {
      res.status(400).json({ error: e.message || 'Could not revoke the membership.' });
    }
  });

  r.put('/users/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'User not found.' });
    if (id === req.user.id && req.body.role && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'You cannot demote your own admin account.' });
    }
    const b = req.body || {};
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role.' });
      await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
    }
    if (b.balance !== undefined) {
      const bal = money(b.balance);
      if (bal === null) return res.status(400).json({ error: 'Invalid balance.' });
      const oldBal = round2(cur.balance || 0);
      await db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(bal, id);
      const delta = round2(bal - oldBal);
      if (delta !== 0) {
        await db.prepare(
          `INSERT INTO wallet_transactions
             (user_id, type, amount, balance_after, reason, ref_type, ref_id)
           VALUES (?, ?, ?, ?, ?, 'admin_adjust', ?)`
        ).run(id, delta > 0 ? 'credit' : 'debit', Math.abs(delta), bal,
          'Admin set balance directly', req.user.id);
      }
    }
    if (b.blocked !== undefined) {
      if (id === req.user.id && b.blocked) {
        return res.status(400).json({ error: 'You cannot block your own admin account.' });
      }
      await db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(b.blocked ? 1 : 0, id);
    }
    res.json(await db.prepare('SELECT id, name, email, role, balance, blocked, created_at FROM users WHERE id = ?').get(id));
  });

  // ---------- orders ----------
  const ORDER_UPDATE_MESSAGES = {
    pending: 'Your order is waiting for payment confirmation.',
    paid: 'Payment confirmed. Your order is being processed.',
    delivered: 'Your order has been delivered.',
    cancelled: 'Your order has been cancelled. Contact support if you need help.',
  };
  // ---------- reseller API keys ----------
  r.get('/api-keys', async (req, res) => {
    const rows = await db.prepare(
      `SELECT k.id, k.user_id, k.name, k.key_prefix, k.active, k.rate_limit_per_min,
              k.requests_count, k.last_used_at, k.created_at, u.name AS user_name, u.email AS user_email
       FROM reseller_api_keys k JOIN users u ON u.id = k.user_id
       ORDER BY k.id DESC`
    ).all();
    res.json(rows);
  });

  r.post('/api-keys', async (req, res) => {
    const crypto = require('crypto');
    const userId = intIn(req.body && req.body.user_id, 1, 2147483647);
    const name = str(req.body && req.body.name, 120);
    if (!userId) return res.status(400).json({ error: 'Select a reseller account.' });
    const user = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!['silver', 'admin'].includes(user.role)) {
      return res.status(400).json({ error: 'That account is not a reseller. Change its role to silver first.' });
    }
    const raw = 'mk_live_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
    const info = await db.prepare(
      'INSERT INTO reseller_api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)'
    ).run(userId, name || (user.name || user.email), raw.slice(0, 15), keyHash);
    // The full key is shown exactly once — it cannot be retrieved later.
    res.status(201).json({
      id: info.lastInsertRowid,
      api_key: raw,
      key_prefix: raw.slice(0, 15),
      user_id: userId,
      user_email: user.email,
    });
  });

  r.post('/api-keys/:id/revoke', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    await db.prepare('UPDATE reseller_api_keys SET active = 0 WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  r.post('/api-keys/:id/restore', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    await db.prepare('UPDATE reseller_api_keys SET active = 1 WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  r.delete('/api-keys/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    await db.prepare('DELETE FROM reseller_api_keys WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---------- wallets ----------
  // Users with their wallet balances (search by name or email).
  r.get('/wallets', async (req, res) => {
    const s = String(req.query.search || '').trim();
    let sql = 'SELECT id, name, email, role, balance, created_at FROM users';
    const params = [];
    if (s) {
      sql += ' WHERE name LIKE ? OR email LIKE ?';
      params.push(`%${s}%`, `%${s}%`);
    }
    sql += ' ORDER BY balance DESC, id DESC LIMIT 100';
    res.json(await db.prepare(sql).all(...params));
  });

  // Manually adjust a user's wallet (+/-). Every adjustment hits the ledger.
  r.post('/wallets/adjust', async (req, res) => {
    const b = req.body || {};
    const userId = intIn(b.user_id, 1, 2147483647);
    if (!userId) return res.status(400).json({ error: 'Invalid user.' });
    const raw = Number(b.amount);
    if (!Number.isFinite(raw) || raw === 0 || Math.abs(raw) > 10000000) {
      return res.status(400).json({ error: 'Amount must be a non-zero number.' });
    }
    const amount = round2(raw);
    const reason = str(b.reason, 500);
    if (!reason) return res.status(400).json({ error: 'A reason is required.' });
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const wCurrency = String(b.currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
    let balance;
    if (amount > 0) {
      balance = await creditWallet(db, userId, amount, `Admin adjustment: ${reason}`, 'admin_adjust', null, wCurrency);
    } else {
      balance = await debitWallet(db, userId, -amount, `Admin adjustment: ${reason}`, 'admin_adjust', null, wCurrency);
      if (balance === null) {
        return res.status(400).json({ error: 'Insufficient wallet balance for this adjustment.' });
      }
    }
    res.json({ balance });
  });

  r.get('/wallets/:id/transactions', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const user = await db.prepare('SELECT id, name, email, balance FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const txns = await db.prepare(
      `SELECT id, type, amount, balance_after, reason, ref_type, ref_id, created_at
       FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100`
    ).all(id);
    res.json({ user, transactions: txns });
  });

  // ---------- gift-card vouchers ----------
  const VOUCHER_STATUSES = ['active', 'assigned', 'redeemed', 'disabled'];

  // Generate a batch of voucher codes.
  r.post('/vouchers/generate', async (req, res) => {
    const b = req.body || {};
    const count = intIn(b.count, 1, 500);
    if (!count) return res.status(400).json({ error: 'Count must be between 1 and 500.' });
    const amount = money(b.amount);
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0.' });
    // Gift-card face value is locked to its currency — it never converts with
    // the storefront display currency.
    const currency = String(b.currency || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
    let expiresAt = null;
    if (b.expires_at !== undefined && b.expires_at !== null && String(b.expires_at).trim() !== '') {
      const d = String(b.expires_at).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d + 'T23:59:59').getTime())) {
        return res.status(400).json({ error: 'Expiry date must be YYYY-MM-DD.' });
      }
      expiresAt = d;
    }
    const note = optStr(b.note, 500);
    const codes = [];
    for (let i = 0; i < count; i++) {
      let inserted = false;
      for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
        const code = generateVoucherCode();
        try {
          await db.prepare(
            'INSERT INTO vouchers (code, amount, currency, status, created_by, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(code, amount, currency, 'active', req.user.id, expiresAt, note);
          codes.push(code);
          inserted = true;
        } catch (e) {
          // Code collision (UNIQUE) — regenerate and retry.
          if (!/unique|duplicate/i.test(e && e.message || '')) throw e;
        }
      }
      if (!inserted) {
        return res.status(500).json({ error: `Generated ${codes.length} of ${count} codes — please try again for the rest.` });
      }
    }
    res.status(201).json({ created: codes.length, amount, currency, codes });
  });

  r.get('/vouchers', async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      if (!VOUCHER_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: 'Invalid status filter.' });
      }
      where.push('v.status = ?');
      params.push(req.query.status);
    }
    const s = String(req.query.search || '').trim();
    if (s) {
      where.push('(v.code LIKE ? OR v.note LIKE ?)');
      params.push(`%${s}%`, `%${s}%`);
    }
    const rows = await db.prepare(
      `SELECT v.*, u.email AS redeemed_email, u.name AS redeemed_name
       FROM vouchers v LEFT JOIN users u ON u.id = v.redeemed_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY v.id DESC LIMIT 200`
    ).all(...params);
    res.json(rows);
  });

  // Orders whose gift-card pool ran dry — admin must deliver codes manually.
  r.get('/vouchers/shortages', async (req, res) => {
    const rows = await db.prepare(
      `SELECT o.id, o.user_id, u.name AS user_name, u.email AS user_email,
              o.total, o.status, o.created_at
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE o.voucher_shortage = 1 ORDER BY o.id DESC LIMIT 100`
    ).all();
    res.json(rows);
  });

  r.post('/vouchers/:id/disable', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const r2 = await db.prepare(
      "UPDATE vouchers SET status = 'disabled' WHERE id = ? AND status = 'active'"
    ).run(id);
    if (!r2.changes) return res.status(400).json({ error: 'Only active vouchers can be disabled.' });
    res.json({ ok: true });
  });

  r.post('/vouchers/:id/enable', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const r2 = await db.prepare(
      "UPDATE vouchers SET status = 'active' WHERE id = ? AND status = 'disabled'"
    ).run(id);
    if (!r2.changes) return res.status(400).json({ error: 'Only disabled vouchers can be re-enabled.' });
    res.json({ ok: true });
  });

  r.delete('/vouchers/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const r2 = await db.prepare(
      "DELETE FROM vouchers WHERE id = ? AND status IN ('active', 'disabled')"
    ).run(id);
    if (!r2.changes) {
      return res.status(400).json({ error: 'Only vouchers that were never redeemed can be deleted.' });
    }
    res.json({ ok: true });
  });

  r.get('/orders', async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      if (!Object.keys(TRANSITIONS).includes(req.query.status)) {
        return res.status(400).json({ error: 'Invalid status filter.' });
      }
      where.push('o.status = ?');
      params.push(req.query.status);
    }
    const rows = await db.prepare(
      `SELECT o.id, o.user_id, u.name AS user_name, u.email AS user_email, o.subtotal, o.discount,
              o.coupon_code, o.total, o.currency, o.wallet_applied, o.voucher_shortage, o.status,
              o.topzy_order_id, o.topzy_status, o.busan_order_id, o.busan_status,
              o.paid_claimed, o.payment_note, o.delivery_note, o.created_at,
              o.buyer_name, o.buyer_phone, o.buyer_email, o.buyer_age
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY o.id DESC LIMIT 200`
    ).all(...params);
    res.json(rows);
  });

  r.put('/orders/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const b = req.body || {};
    if (b.status !== undefined) {
      if (!TRANSITIONS[order.status].includes(b.status)) {
        return res.status(400).json({ error: `Cannot move order from ${order.status} to ${b.status}.` });
      }
      await db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(b.status, id);
      await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)').run(
        id, b.status, ORDER_UPDATE_MESSAGES[b.status] || `Order status changed to ${b.status}.`
      );
      if (b.status === 'paid') {
        // Paid pipeline: supplier auto-fulfil + gift-card code assignment.
        // Fire-and-forget: fulfilment records its own outcome on the order and
        // must never break this admin action.
        handleOrderPaid(db, id);
      }
      if (b.status === 'cancelled') {
        // Return any wallet money the buyer applied to this order.
        const refunded = await refundWalletForOrder(db, order).catch((e) => {
          console.error('[wallet]', e && e.message);
          return 0;
        });
        if (refunded > 0) {
          await db.prepare('INSERT INTO order_updates (order_id, status, message) VALUES (?, ?, ?)').run(
            id, 'cancelled', `Wallet refund of ${refunded.toFixed(2)} issued for the cancelled order.`
          );
        }
      }
    }
    if (b.delivery_note !== undefined) {
      await db.prepare('UPDATE orders SET delivery_note = ? WHERE id = ?').run(optStr(b.delivery_note, 5000), id);
    }
    const updated = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    try { updated.items = JSON.parse(updated.items); } catch (e) { updated.items = []; }
    res.json(updated);
  });

  // ---------- busan auto-fulfilment ----------
  // The API key is NEVER exposed to the browser: no endpoint returns it.
  r.get('/busan/status', async (req, res) => {
    if (!busan.configured()) return res.json({ configured: false });
    try {
      const bal = await busan.getBalance();
      res.json({ configured: true, balance: bal.balance, currency: bal.currency });
    } catch (e) {
      res.json({ configured: true, error: e.message });
    }
  });

  // ---------- busan game import ----------
  // List Busan's INR catalogue, flagging productIds already mapped to a
  // product. The API key is NEVER exposed: only product metadata + wholesale
  // prices go to the browser.
  r.get('/busan/products', async (req, res) => {
    if (!busan.configured()) {
      return res.status(503).json({ error: 'Busan not configured: set the BUSAN_API_KEY environment variable (Render → Environment) and redeploy.' });
    }
    let list;
    try {
      list = await busan.getProducts();
    } catch (e) {
      const msg = (e && e.message) || 'unknown error';
      console.error('[busan] GET /api/admin/busan/products failed:', msg);
      return res.status(502).json({ error: 'Busan API error: ' + msg, upstreamStatus: (e && e.upstreamStatus) || null });
    }
    const mapped = await db.prepare("SELECT busan_product_id FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''").all();
    const imported = new Set(mapped.map((x) => String(x.busan_product_id)));
    const products = [];
    for (const p of list) {
      if (!p || !p.productId) continue;
      const pid = String(p.productId);
      const cost = busan.parsePrice(p.price);
      products.push({
        productId: pid,
        name: p.productName || pid,
        cost,
        costRaw: p.price != null ? String(p.price) : '',
        alreadyImported: imported.has(pid),
      });
    }
    products.sort((a, b) => (Number.isFinite(a.cost) ? a.cost : 0) - (Number.isFinite(b.cost) ? b.cost : 0));
    res.json({ products });
  });

  // Import Busan products as store products: retail = ceil(wholesale + margin),
  // busan_product_id mapping set, MLBB checkout questions attached automatically.
  // Idempotent: re-importing the same productId is counted as skipped.
  r.post('/busan/import', async (req, res) => {
    if (!busan.configured()) {
      return res.status(503).json({ error: 'Busan not configured: set the BUSAN_API_KEY environment variable (Render → Environment) and redeploy.' });
    }
    const b = req.body || {};
    const productIds = Array.isArray(b.productIds) ? b.productIds.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!productIds.length) return res.status(400).json({ error: 'Select at least one product to import.' });
    const categoryId = intIn(b.categoryId, 1, 2147483647);
    if (!categoryId || !await db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
      return res.status(400).json({ error: 'Choose a valid target category.' });
    }
    let marginPct = b.marginPct === undefined || b.marginPct === null || b.marginPct === ''
      ? 15 : Number(b.marginPct);
    if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct > 100) {
      return res.status(400).json({ error: 'Margin must be a number between 0 and 100.' });
    }

    let list;
    try {
      list = await busan.getProducts();
    } catch (e) {
      const msg = (e && e.message) || 'unknown error';
      console.error('[busan] POST /api/admin/busan/import failed:', msg);
      return res.status(502).json({ error: 'Busan API error: ' + msg, upstreamStatus: (e && e.upstreamStatus) || null });
    }
    const byId = new Map();
    for (const p of list) if (p && p.productId) byId.set(String(p.productId), p);

    const slugTaken = new Set((await db.prepare('SELECT slug FROM products').all()).map((x) => x.slug));
    const idTaken = new Set((await db.prepare("SELECT busan_product_id FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''").all()).map((x) => String(x.busan_product_id)));

    const uniqueSlug = (name, pid) => {
      let slug = slugify(name) || 'pack';
      slug = (slug + '-' + String(pid).toLowerCase().replace(/[^a-z0-9]+/g, '')).slice(0, 90) || 'pack';
      let n = 2;
      const base = slug;
      while (slugTaken.has(slug)) slug = (base + '-' + (n++)).slice(0, 90);
      slugTaken.add(slug);
      return slug;
    };

    const products = [];
    const skipped = [];

    for (const pid of productIds) {
      const svc = byId.get(pid);
      if (!svc) { skipped.push({ productId: pid, reason: 'product not found in Busan catalogue' }); continue; }
      if (idTaken.has(pid)) { skipped.push({ productId: pid, reason: 'already imported' }); continue; }
      const cost = busan.parsePrice(svc.price);
      if (!Number.isFinite(cost) || cost < 0) { skipped.push({ productId: pid, reason: 'invalid wholesale price from Busan' }); continue; }

      const name = str(svc.productName, 200) || pid;
      const price = Math.ceil(cost * (1 + marginPct / 100)); // retail always derives from live cost + margin
      const desc = name + ' — delivered directly to your game account/ID.';

      const info = await db.prepare(
        `INSERT INTO products
         (category_id, name, slug, description, image_url, price_regular, price_gold, price_silver,
          cost_price, margin_type, margin_value, stock_status, stock_quantity,
          busan_product_id, busan_auto_fulfil, is_voucher, featured, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'percent', ?, 'in_stock', NULL, ?, 0, 0, 0, 1)`
      ).run(
        categoryId, name, uniqueSlug(name, pid), desc, null,
        price, price, price, cost, marginPct, pid
      );
      const productId = info.lastInsertRowid;

      // MLBB products need User ID / Zone ID at checkout — attach automatically.
      const nm = String(svc.productName || '').toLowerCase();
      if (nm.includes('mobile legends') || nm.includes('mlbb')) {
        await replaceCheckoutAttributes(productId, [
          { label: 'User ID', field_type: 'text', required: 1, sort_order: 0 },
          { label: 'Zone ID', field_type: 'text', required: 1, sort_order: 1 },
        ]);
      }

      idTaken.add(pid);
      products.push({ id: productId, name, price });
    }

    res.json({ imported: products.length, skipped, products });
  });

  // Validate a player ID against Busan (username lookup tool).
  r.post('/busan/validate', async (req, res) => {
    if (!busan.configured()) {
      return res.status(503).json({ error: 'Busan not configured: set the BUSAN_API_KEY environment variable (Render → Environment) and redeploy.' });
    }
    const b = req.body || {};
    const productId = String(b.productId || '').trim();
    const playerId = String(b.playerId || '').trim();
    const zoneId = String(b.zoneId || '').trim();
    if (!productId || !playerId) return res.status(400).json({ error: 'productId and playerId are required.' });
    try {
      const v = await busan.validatePlayer(productId, playerId, zoneId || undefined);
      res.json(v);
    } catch (e) {
      res.status(502).json({ error: 'Busan API error: ' + ((e && e.message) || 'unknown error') });
    }
  });

  // POST /api/admin/busan/import-all
  // One-shot bulk import of the FULL Busan catalogue, minus BGMI (user's
  // standing exclusion).
  // Creates one clean category per game (reusing existing matches) under the
  // "Games" sub-category. All imports are MANUAL delivery (busan_auto_fulfil=0):
  // paid orders never trigger Busan auto-fulfil.
  // Pricing: 10% customer margin, 5% reseller.
  // Idempotent: re-running only imports new products.
  // ---------- Busan bulk import (background) ----------
  // The catalogue is ~6.6k products: too big for one request and too fragile
  // to drive chunk-by-chunk from the browser. POST /busan/import-all with
  // { background: true } starts a server-side run and returns immediately;
  // GET /busan/import-status polls progress. Idempotent: re-running only
  // imports new products. A second start while one is running is ignored.
  let busanBg = { running: false, imported: 0, skipped: 0, total: 0, done: false, error: null, startedAt: 0 };

  // Games to skip: BGMI only.
  const busanIsSkippedGame = (name) => {
    const n = String(name || '').toLowerCase();
    return /bgmi|battlegrounds(\smobile|\s_india)?/i.test(n);
  };

  const busanGameOf = (p) => cleanSupplierGameName(p);

  async function busanFindOrCreateCategory(name, parentId) {
    // Match by (name, parent): Busan game categories live under the "Busan"
    // supplier parent.
    const hit = await db.prepare(
      'SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND COALESCE(parent_id, -1) = COALESCE(?, -1) LIMIT 1'
    ).get(name, parentId);
    if (hit) return Number(hit.id);
    let slug = slugify(name) || 'category';
    let n = 2;
    const base = slug;
    while (await db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)) {
      slug = (base + '-' + (n++)).slice(0, 90);
    }
    await db.prepare(
      'INSERT INTO categories (name, slug, description, sort_order, active, parent_id, image_url, show_in_menu, show_on_homepage, id_check_mode) VALUES (?, ?, ?, 0, 1, ?, NULL, 1, 1, ?)'
    ).run(name, slug, 'Top-ups for ' + name + ' via Busan.', parentId || null, idCheckMode('auto'));
    const row = await db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
    if (!row) throw new Error('Category insert failed for ' + name);
    return Number(row.id);
  }

  // Import one slice of { svc, game } items. ctx carries the shared dedupe
  // sets and margins. Never throws for a single bad product.
  async function busanImportSlice(slice, ctx) {
    const byGame = new Map();
    for (const it of slice) {
      if (!byGame.has(it.game)) byGame.set(it.game, []);
      byGame.get(it.game).push(it.svc);
    }
    let imported = 0, skipped = 0;
    for (const [game, items] of byGame) {
      let categoryId;
      try {
        categoryId = await busanFindOrCreateCategory(game, await gamesParentId()); // under Games
      } catch (e) {
        console.error(`[busan] category creation failed for "${game}":`, (e && e.message) || e);
        skipped += items.length;
        continue;
      }
      for (const svc of items) {
        // Yield to event loop so health checks stay responsive.
        await new Promise((resolve) => setImmediate(resolve));
        const pid = String(svc.productId);
        try {
          if (ctx.idTaken.has(pid)) { skipped++; continue; }
          const cost = busan.parsePrice(svc.price);
          if (!Number.isFinite(cost) || cost < 0) { skipped++; continue; }
          const name = str(svc.productName, 200) || pid;
          const price = Math.ceil(cost * (1 + ctx.marginPct / 100));
          const priceR = Math.ceil(cost * (1 + ctx.resellerMarginPct / 100));
          const desc = name + ' for ' + game + ' — delivered directly to your game account/ID.';
          let slug = slugify(name) || 'pack';
          slug = (slug + '-' + pid.toLowerCase().replace(/[^a-z0-9]+/g, '')).slice(0, 90) || 'pack';
          let n = 2;
          const base = slug;
          while (ctx.slugTaken.has(slug)) slug = (base + '-' + (n++)).slice(0, 90);
          ctx.slugTaken.add(slug);
          await db.prepare(
            `INSERT INTO products
             (category_id, name, slug, description, image_url, price_regular, price_gold, price_silver,
              cost_price, margin_type, margin_value, margin_type_reseller, margin_value_reseller,
              stock_status, stock_quantity,
              busan_product_id, busan_auto_fulfil, is_voucher, featured, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'percent', ?, 'percent', ?, 'in_stock', NULL, ?, 0, 0, 0, 1)`
          ).run(
            categoryId, name, slug, desc, null,
            price, priceR, priceR, cost, ctx.marginPct, ctx.resellerMarginPct, pid
          );
          ctx.idTaken.add(pid);
          imported++;
        } catch (e) {
          console.error(`[busan] bg import: product ${pid} failed:`, (e && e.message) || e);
          skipped++;
        }
      }
    }
    return { imported, skipped };
  }

  async function runBusanBackgroundImport(marginPct, resellerMarginPct) {
    const list = await busan.getProducts();
    const flat = [];
    for (const p of list) {
      if (!p || !p.productId) continue;
      const game = busanGameOf(p);
      if (busanIsSkippedGame(game) || busanIsSkippedGame(p.productName)) continue;
      flat.push({ svc: p, game });
    }
    const ctx = {
      marginPct, resellerMarginPct,
      slugTaken: new Set((await db.prepare('SELECT slug FROM products').all()).map((x) => x.slug)),
      idTaken: new Set((await db.prepare("SELECT busan_product_id FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''").all()).map((x) => String(x.busan_product_id))),
    };
    busanBg.total = flat.length;
    console.log(`[busan] bg import started: ${flat.length} products`);
    const CHUNK = 300;
    for (let offset = 0; offset < flat.length; offset += CHUNK) {
      const r = await busanImportSlice(flat.slice(offset, offset + CHUNK), ctx);
      busanBg.imported += r.imported;
      busanBg.skipped += r.skipped;
      console.log(`[busan] bg import progress: ${Math.min(offset + CHUNK, flat.length)}/${flat.length} (imported=${busanBg.imported})`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    busanBg.done = true;
    busanBg.running = false;
    console.log(`[busan] bg import complete: imported=${busanBg.imported} skipped=${busanBg.skipped}`);
  }

  // POST /api/admin/busan/import-all
  // { background: true } -> starts a server-side run, returns immediately.
  // Without it, imports a single chunk ({ offset, limit }) synchronously.
  r.post('/busan/import-all', async (req, res) => {
    console.log('[busan] import-all POST body:', JSON.stringify(req.body || {}).slice(0, 300));
    if (!busan.configured()) {
      return res.status(503).json({ error: 'Busan not configured: set the BUSAN_API_KEY environment variable (Render → Environment) and redeploy.' });
    }
    const b = req.body || {};
    let marginPct = b.marginPct === undefined || b.marginPct === null || b.marginPct === ''
      ? 10 : Number(b.marginPct);
    if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct > 100) {
      return res.status(400).json({ error: 'Margin must be a number between 0 and 100.' });
    }
    let resellerMarginPct = b.resellerMarginPct === undefined || b.resellerMarginPct === null || b.resellerMarginPct === ''
      ? 5 : Number(b.resellerMarginPct);
    if (!Number.isFinite(resellerMarginPct) || resellerMarginPct < 0 || resellerMarginPct > 100) {
      return res.status(400).json({ error: 'Reseller margin must be a number between 0 and 100.' });
    }

    if (b.background) {
      console.log('[busan] bg import requested: starting background run');
      if (busanBg.running) return res.json({ started: true, alreadyRunning: true });
      busanBg = { running: true, imported: 0, skipped: 0, total: 0, done: false, error: null, startedAt: Date.now() };
      runBusanBackgroundImport(marginPct, resellerMarginPct).catch((e) => {
        busanBg.running = false;
        busanBg.error = String((e && e.message) || e).slice(0, 300);
        console.error('[busan] bg import failed:', busanBg.error);
      });
      return res.json({ started: true });
    }

    // Synchronous single-chunk mode (offset/limit).
    let offset = b.offset === undefined || b.offset === null || b.offset === '' ? 0 : Number(b.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    offset = Math.floor(offset);
    let limit = b.limit === undefined || b.limit === null || b.limit === '' ? 400 : Number(b.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 400;
    limit = Math.min(Math.floor(limit), 1000);

    let list;
    try {
      list = await busan.getProducts();
    } catch (e) {
      const msg = (e && e.message) || 'unknown error';
      console.error('[busan] POST /api/admin/busan/import-all failed:', msg);
      return res.status(502).json({ error: 'Busan API error: ' + msg, upstreamStatus: (e && e.upstreamStatus) || null });
    }
    const flat = [];
    const skippedGames = new Set();
    for (const p of list) {
      if (!p || !p.productId) continue;
      const game = busanGameOf(p);
      if (busanIsSkippedGame(game) || busanIsSkippedGame(p.productName)) { skippedGames.add(game); continue; }
      flat.push({ svc: p, game });
    }
    const slice = flat.slice(offset, offset + limit);
    const ctx = {
      marginPct, resellerMarginPct,
      slugTaken: new Set((await db.prepare('SELECT slug FROM products').all()).map((x) => x.slug)),
      idTaken: new Set((await db.prepare("SELECT busan_product_id FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''").all()).map((x) => String(x.busan_product_id))),
    };
    const r2 = await busanImportSlice(slice, ctx);
    res.json({
      imported: r2.imported, skipped: r2.skipped,
      catalogueTotal: flat.length, offset, limit,
      done: offset + slice.length >= flat.length,
      skippedGames: [...skippedGames],
    });
  });

  // POST /api/admin/busan/import-next — import the next batch of UNIMPORTED products.
  // Robust: finds products not yet in DB (no offset assumptions). Returns remaining count.
  r.post('/busan/import-next', async (req, res) => {
    console.log('[busan] import-next POST received');
    if (!busan.configured()) {
      return res.status(503).json({ error: 'Busan not configured.' });
    }
    const b = req.body || {};
    let marginPct = b.marginPct === undefined || b.marginPct === null || b.marginPct === '' ? 10 : Number(b.marginPct);
    if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct > 100) marginPct = 10;
    let resellerMarginPct = b.resellerMarginPct === undefined || b.resellerMarginPct === null || b.resellerMarginPct === '' ? 5 : Number(b.resellerMarginPct);
    if (!Number.isFinite(resellerMarginPct) || resellerMarginPct < 0 || resellerMarginPct > 100) resellerMarginPct = 5;
    const batchSize = 10;

    let list;
    try {
      list = await busan.getProducts();
    } catch (e) {
      return res.status(502).json({ error: 'Busan API error: ' + ((e && e.message) || 'unknown') });
    }
    const idTaken = new Set((await db.prepare("SELECT busan_product_id FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''").all()).map((x) => String(x.busan_product_id)));
    const flat = [];
    let totalCandidates = 0;
    // Count ALL importable candidates first (separate pass — the batch
    // collection below breaks early after batchSize, which must not truncate
    // the total).
    for (const p of list) {
      if (!p || !p.productId) continue;
      const game = busanGameOf(p);
      if (busanIsSkippedGame(game) || busanIsSkippedGame(p.productName)) continue;
      const cost = busan.parsePrice(p.price);
      if (!Number.isFinite(cost) || cost < 0) continue;
      totalCandidates++;
    }
    for (const p of list) {
      if (!p || !p.productId) continue;
      const pid = String(p.productId);
      const game = busanGameOf(p);
      if (busanIsSkippedGame(game) || busanIsSkippedGame(p.productName)) continue;
      if (idTaken.has(pid)) continue;
      const cost = busan.parsePrice(p.price);
      if (!Number.isFinite(cost) || cost < 0) continue;
      flat.push({ svc: p, game });
      if (flat.length >= batchSize) break;
    }
    if (!flat.length) {
      const inDb = idTaken.size;
      return res.json({ imported: 0, skipped: 0, remaining: 0, inDb, done: true });
    }
    const ctx = {
      marginPct, resellerMarginPct,
      slugTaken: new Set((await db.prepare('SELECT slug FROM products').all()).map((x) => x.slug)),
      idTaken,
    };
    let r2;
    try {
      r2 = await busanImportSlice(flat, ctx);
    } catch (e) {
      console.error('[busan] import-next slice threw:', (e && e.message) || e);
      return res.status(500).json({ error: 'Import batch failed: ' + ((e && e.message) || 'unknown error') });
    }
    const inDb = (await db.prepare("SELECT COUNT(*) AS c FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''").get()).c;
    console.log(`[busan] import-next: batch done: imported=${r2.imported} skipped=${r2.skipped} inDb=${inDb} flatLen=${flat.length}`);
    // remaining = candidates - inDb (approximate)
    res.json({
      imported: r2.imported, skipped: r2.skipped,
      remaining: Math.max(0, totalCandidates - Number(inDb)),
      inDb: Number(inDb),
      totalCandidates,
      done: false,
    });
  });



  // POST /api/admin/games-usd-only — ONE-TIME (Oct 2026): set every product
  // under the Games category tree to USD-only (available_inr = 0). Products
  // then show as out of stock when the store is in INR mode.
  r.post('/games-usd-only', async (req, res) => {
    try {
      const games = await db.prepare(
        "SELECT id FROM categories WHERE slug = 'games' AND active = 1"
      ).get();
      if (!games) return res.status(404).json({ error: 'Games category not found' });
      const all = await db.prepare('SELECT id, parent_id FROM categories WHERE active = 1').all();
      const ids = [games.id];
      let frontier = [games.id];
      while (frontier.length) {
        const next = all.filter((c) => frontier.includes(c.parent_id)).map((c) => c.id);
        for (const id of next) if (!ids.includes(id)) ids.push(id);
        frontier = next;
      }
      const r2 = await db.prepare(
        `UPDATE products SET available_inr = 0 WHERE category_id IN (${ids.map(() => '?').join(',')})`
      ).run(...ids);
      const cnt = await db.prepare(
        `SELECT COUNT(*) AS c FROM products WHERE category_id IN (${ids.map(() => '?').join(',')}) AND available_inr = 0`
      ).get(...ids);
      res.json({ ok: true, categories: ids.length, productsUpdated: r2.changes, usdOnlyNow: cnt.c });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // GET /api/admin/busan/import-status — progress of the background import.
  r.get('/busan/import-status', async (req, res) => {
    let inDb = 0;
    try {
      const row = await db.prepare("SELECT COUNT(*) AS c FROM products WHERE busan_product_id IS NOT NULL AND busan_product_id != ''").get();
      inDb = Number(row && row.c) || 0;
    } catch (e) { /* ignore */ }
    const mu = process.memoryUsage();
    res.json({ ...busanBg, inDb, commit: process.env.RENDER_GIT_COMMIT || 'unknown',
      memory: { rss: Math.round(mu.rss / 1048576), heapUsed: Math.round(mu.heapUsed / 1048576), heapTotal: Math.round(mu.heapTotal / 1048576) } });
  });

  // Register the Busan order-notification webhook with Busan.
  r.post('/busan/webhook', async (req, res) => {
    if (!busan.configured()) {
      return res.status(503).json({ error: 'Busan not configured: set the BUSAN_API_KEY environment variable (Render → Environment) and redeploy.' });
    }
    const url = String((req.body || {}).webhookUrl || '').trim() || 'https://www.mlbbstore.in/api/payments/busan/webhook';
    try {
      const r2 = await busan.registerWebhook(url);
      res.json({ ok: true, url, response: r2 });
    } catch (e) {
      res.status(502).json({ error: 'Busan API error: ' + ((e && e.message) || 'unknown error') });
    }
  });

  // Recent orders with Busan fulfilment activity (the fulfilment log).
  r.get('/busan/orders', async (req, res) => {
    const rows = await db.prepare(
      `SELECT o.id, o.user_id, u.name AS user_name, u.email AS user_email, o.total, o.status,
              o.busan_order_id, o.busan_status, o.created_at
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE o.busan_order_id IS NOT NULL OR o.busan_status IS NOT NULL
       ORDER BY o.id DESC LIMIT 100`
    ).all();
    res.json(rows);
  });

  // Retry Busan fulfilment for one order, then report stored status.
  // (Busan has no order-status lookup endpoint; live updates arrive via webhook.)
  r.post('/busan/orders/:id/refresh', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (String(order.status || '').toLowerCase() === 'paid' && !order.busan_order_id) {
      await fulfilBusanOrder(db, id);
    }
    const fresh = await db.prepare('SELECT busan_order_id, busan_status FROM orders WHERE id = ?').get(id);
    res.json({ id, busan_order_id: fresh.busan_order_id, busan_status: fresh.busan_status });
  });

  // ---------- busan price sync ----------
  // Never expose the API key; cost/price sync only.
  const { runSync: runBusanSync } = require('../busan-sync');
  r.get('/busan/sync-config', async (req, res) => {
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'busan_%'").all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    res.json({
      enabled: out.busan_sync_enabled === '1',
      interval_min: parseInt(out.busan_sync_interval_min || '60', 10),
      margin_type: out.busan_margin_type === 'fixed' ? 'fixed' : 'percent',
      margin_value: Number(out.busan_margin_value === undefined ? '15' : out.busan_margin_value),
      auto_decrease: out.busan_auto_decrease === '1',
      last_sync_at: out.busan_last_sync_at || '',
    });
  });
  r.put('/busan/sync-config', async (req, res) => {
    const b = req.body || {};
    const put = await db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    if (b.enabled !== undefined) put.run('busan_sync_enabled', b.enabled ? '1' : '0');
    if (b.interval_min !== undefined) {
      const m = intIn(b.interval_min, 5, 1440);
      if (!m) return res.status(400).json({ error: 'Interval must be 5–1440 minutes.' });
      put.run('busan_sync_interval_min', String(m));
    }
    if (b.margin_type !== undefined) {
      if (b.margin_type !== 'percent' && b.margin_type !== 'fixed') {
        return res.status(400).json({ error: 'Margin type must be percent or fixed.' });
      }
      put.run('busan_margin_type', b.margin_type);
    }
    if (b.margin_value !== undefined) {
      const v = money(b.margin_value);
      if (v === null || v < 0) return res.status(400).json({ error: 'Invalid margin value.' });
      put.run('busan_margin_value', String(v));
    }
    if (b.auto_decrease !== undefined) put.run('busan_auto_decrease', b.auto_decrease ? '1' : '0');
    res.json({ ok: true });
  });
  // Run a price sync on demand; returns the summary.
  r.post('/busan/sync-now', async (req, res) => {
    try {
      res.json(await runBusanSync(db));
    } catch (e) {
      res.status(500).json({ error: e && e.message ? e.message : 'Sync failed.' });
    }
  });
  // Latest price-sync history (latest 100).
  r.get('/busan/price-history', async (req, res) => {
    res.json(await db.prepare(
      `SELECT h.*, p.name AS product_name
       FROM busan_price_history h LEFT JOIN products p ON p.id = h.product_id
       ORDER BY h.id DESC LIMIT 100`
    ).all());
  });

  // ---------- settings ----------
  r.get('/settings', async (req, res) => {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    res.json(out);
  });

  r.put('/settings', async (req, res) => {
    const b = req.body || {};
    const allowed = ['site_name', 'whatsapp_number', 'upi_id', 'payment_instructions', 'reseller_discount_default', 'support_email', 'social_youtube', 'social_instagram', 'social_x', 'social_whatsapp', 'crypto_usd_rate', 'support_whatsapp_url', 'support_telegram_url', 'support_wechat_id', 'category_image_ratio', 'featured_layout', 'site_logo_text', 'membership_silver_price', 'membership_duration_days'];
    const stmt = await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const key of allowed) {
      if (b[key] !== undefined) {
        const v = typeof b[key] === 'string' ? b[key].slice(0, 5000) : String(b[key]).slice(0, 5000);
        if (key === 'support_email' && v && !isEmail(v)) {
          return res.status(400).json({ error: 'Invalid support email.' });
        }
        stmt.run(key, v);
      }
    }
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    res.json(out);
  });

  // ---------- site logo ----------
  r.post('/settings/logo', (req, res, next) => {
    logoUpload.single('logo')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'Logo must be 2MB or smaller.'
          : (err.message || 'Invalid file.');
        return res.status(400).json({ error: msg });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      (async () => {
        // Store as a data URL in the settings table — no files are written
        // to disk, so the logo survives redeploys on ephemeral hosting.
        const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        await db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run('site_logo', dataUrl);
        res.json({ site_logo: dataUrl });
      })().catch(next);
    });
  });

  // "How to order" illustration shown on every product page.
  // Stored as a data URL in settings; reset restores the bundled default.
  const HOWTO_DEFAULT = '/images/how-to-order.webp';
  r.post('/settings/howto-image', (req, res, next) => {
    logoUpload.single('image')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 2MB or smaller.'
          : (err.message || 'Invalid file.');
        return res.status(400).json({ error: msg });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      (async () => {
        const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        await db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run('how_to_order_image', dataUrl);
        res.json({ how_to_order_image: dataUrl });
      })().catch(next);
    });
  });

  r.delete('/settings/howto-image', async (req, res) => {
    await db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('how_to_order_image', HOWTO_DEFAULT);
    res.json({ how_to_order_image: HOWTO_DEFAULT });
  });

  r.delete('/settings/logo', async (req, res) => {
    await db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('site_logo', '');
    res.json({ site_logo: '' });
  });

  // ---------- favicon ----------
  // Uploaded favicon stored as a data URL in the settings table (survives
  // redeploys). Served via /api/settings/public; the storefront JS swaps the
  // <link rel="icon"> href when set. Falls back to /favicon.ico when empty.
  r.post('/settings/favicon', (req, res, next) => {
    logoUpload.single('favicon')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'Favicon must be 2MB or smaller.'
          : (err.message || 'Invalid file.');
        return res.status(400).json({ error: msg });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      (async () => {
        const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        await db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run('favicon', dataUrl);
        res.json({ favicon: dataUrl });
      })().catch(next);
    });
  });

  r.delete('/settings/favicon', async (req, res) => {
    await db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('favicon', '');
    res.json({ favicon: '' });
  });

  // ---------- testimonials ----------
  r.get('/testimonials', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM testimonials ORDER BY sort_order, id').all());
  });

  r.post('/testimonials', async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 120);
    const text = str(b.text, 2000);
    if (!name || !text) return res.status(400).json({ error: 'Name and text are required.' });
    const rating = intIn(b.rating, 1, 5) || 5;
    const productId = intIn(b.product_id, 1, 2147483647) || null;
    const info = await db.prepare(
      'INSERT INTO testimonials (name, text, rating, sort_order, active, product_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, text, rating, intIn(b.sort_order, 0, 9999) || 0, b.active === false || b.active === 0 ? 0 : 1, productId);
    res.status(201).json(await db.prepare('SELECT * FROM testimonials WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/testimonials/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const cur = await db.prepare('SELECT * FROM testimonials WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Testimonial not found.' });
    const b = req.body || {};
    const name = b.name !== undefined ? str(b.name, 120) : cur.name;
    const text = b.text !== undefined ? str(b.text, 2000) : cur.text;
    if (!name || !text) return res.status(400).json({ error: 'Name and text are required.' });
    await db.prepare('UPDATE testimonials SET name = ?, text = ?, rating = ?, sort_order = ?, active = ?, product_id = ? WHERE id = ?').run(
      name, text,
      b.rating !== undefined ? (intIn(b.rating, 1, 5) || 5) : cur.rating,
      b.sort_order !== undefined ? (intIn(b.sort_order, 0, 9999) || 0) : cur.sort_order,
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
      b.product_id !== undefined ? (intIn(b.product_id, 1, 2147483647) || null) : cur.product_id,
      id
    );
    res.json(await db.prepare('SELECT * FROM testimonials WHERE id = ?').get(id));
  });

  r.delete('/testimonials/:id', async (req, res) => {
    const id = intIn(req.params.id, 1, 2147483647);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const info = await db.prepare('DELETE FROM testimonials WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'Testimonial not found.' });
    res.json({ ok: true });
  });

  return r;
};
