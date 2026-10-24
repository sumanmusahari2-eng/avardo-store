const express = require('express');
const { optStr, str, intIn } = require('../validate');
const busan = require('../busan');
const { notifySupportMessage } = require('../notify');

const { tierOf, priceInCurrency: tierPriceInCurrency } = require('../tier-pricing');

module.exports = function (db) {
  const { wrapAsyncRouter } = require('../asyncwrap');
  const r = wrapAsyncRouter(express.Router());

  const tier = (req) => tierOf(req.user && req.user.role);

  // ---- Word-order search: every query word must prefix-match a word in the
  // ---- haystack, in the same order ("mobile legends" matches
  // ---- "Mobile Legends: Bang Bang"; "legends mobile" does not).
  const normText = (s) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const wordsInOrder = (hay, qWords) => {
    if (!qWords.length) return false;
    const hw = normText(hay).split(' ').filter(Boolean);
    let hi = 0;
    for (const q of qWords) {
      let found = -1;
      for (let i = hi; i < hw.length; i++) {
        if (hw[i].startsWith(q)) { found = i; break; }
      }
      if (found < 0) return false;
      hi = found + 1;
    }
    return true;
  };
  const searchScore = (p, catNames, qWords, qNorm) => {
    let score = 0;
    const bump = (s) => { if (s > score) score = s; };
    if (qNorm && normText(p.name).includes(qNorm)) bump(100); // exact phrase in name
    else if (wordsInOrder(p.name, qWords)) bump(60); // words in order in name
    for (const cn of catNames) {
      if (qNorm && normText(cn).includes(qNorm)) bump(50); // exact phrase in category
      else if (wordsInOrder(cn, qWords)) bump(40); // words in order in category
    }
    if (qNorm && normText(p.description).includes(qNorm)) bump(20);
    else if (wordsInOrder(p.description, qWords)) bump(10);
    return score;
  };
  async function scoredSearch(search, where, params, limit) {
    const qNorm = normText(search);
    const qWords = qNorm.split(' ').filter(Boolean);
    if (!qWords.length) return [];
    const cands = await db.prepare(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.featured DESC, p.id
       LIMIT 2000`
    ).all(...params);
    const cats = await db.prepare('SELECT id, name, parent_id FROM categories WHERE active = 1').all();
    const byId = new Map(cats.map((c) => [c.id, c]));
    const ancestry = (id) => {
      const names = [];
      let cur = byId.get(id);
      while (cur) { names.push(cur.name); cur = cur.parent_id ? byId.get(cur.parent_id) : null; }
      return names;
    };
    return cands
      .map((p) => ({ p, s: searchScore(p, ancestry(p.category_id), qWords, qNorm) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.p.featured ? 1 : 0) - (a.p.featured ? 1 : 0) || a.p.id - b.p.id)
      .slice(0, limit)
      .map((x) => x.p);
  }

  const mapProduct = (req) => (p, aux) => {
    const t = tier(req);
    const tiered = t === 'silver';
    const ratings = (aux && aux.ratings[p.id]) || [];
    const rating_average = ratings.length
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      image_url: p.image_url,
      price_mrp: p.price_mrp,
      price_regular: p.price_regular,
      // Tier price (gold/silver) when the viewer is a reseller, else null.
      price_tier: tiered ? t : null,
      price: tierPriceInCurrency(p, t, 'INR'),
      // USD price for the $ selector (null = auto-convert from INR at the fixed rate).
      // Tier-aware, mirroring `price`.
      price_usd: tierPriceInCurrency(p, t, 'USD'),
      // Per-currency availability: 1/true = sellable in that currency.
      available_inr: p.available_inr === 0 || p.available_inr === false ? false : true,
      available_usd: p.available_usd === 0 || p.available_usd === false ? false : true,
      stock_status: p.stock_status,
      stock_quantity: p.stock_quantity === null || p.stock_quantity === undefined ? null : Number(p.stock_quantity),
      // Per-product "How to order" override (null/blank = use the site default).
      how_to_order_text: p.how_to_order_text || null,
      how_to_order_image: p.how_to_order_image || null,
      rating_average,
      review_count: ratings.length,
      checkout_attributes: ((aux && aux.attrs[p.id]) || []).map((a) => ({
        id: a.id,
        label: a.label,
        field_type: a.field_type,
        required: !!a.required,
        sort_order: a.sort_order,
        options: (() => { try { return a.options ? JSON.parse(a.options) : null; } catch (_) { return null; } })(),
      })),
      featured: !!p.featured,
      is_voucher: !!p.is_voucher,
      chip_image_url: p.chip_image_url || null,
      chip_text: p.chip_text || null,
      category_slug: p.category_slug,
      category_name: p.category_name,
      id_check_mode: p.id_check_mode || 'auto',
      category_id_check_mode: p.category_id_check_mode || 'auto',
      variants: ((aux && aux.variants[p.id]) || []).map((v) => ({
        id: v.id,
        name: v.name,
        keyword: v.keyword || null,
        image_url: v.image_url || null,
        price_mrp: v.price_mrp,
        price_regular: v.price_regular,
        price_tier: tiered ? t : null,
        price: tierPriceInCurrency(v, t, 'INR'),
        price_usd: tierPriceInCurrency(v, t, 'USD'),
        stock_status: v.stock_status,
        sort_order: v.sort_order,
        busan_product_id: v.busan_product_id || null,
      })),
    };
  };

  // Bulk-load checkout attributes + approved ratings for a set of products.
  const loadProductAux = async (ids) => {
    const aux = { attrs: {}, ratings: {}, variants: {}};
    if (!ids.length) return aux;
    const ph = ids.map(() => '?').join(',');
    const attrs = await db.prepare(
      `SELECT id, product_id, label, field_type, required, sort_order, options
       FROM product_checkout_attributes WHERE product_id IN (${ph}) ORDER BY sort_order, id`
    ).all(...ids);
    for (const a of attrs) {
      (aux.attrs[a.product_id] = aux.attrs[a.product_id] || []).push(a);
    }
    const reviews = await db.prepare(
      `SELECT product_id, rating FROM reviews WHERE approved = 1 AND product_id IN (${ph})`
    ).all(...ids);
    for (const rv of reviews) {
      (aux.ratings[rv.product_id] = aux.ratings[rv.product_id] || []).push(Number(rv.rating));
    }
    const variants = await db.prepare(
      `SELECT id, product_id, name, keyword, image_url, price_mrp, price_regular, price_gold, price_silver, price_usd, price_usd_gold, price_usd_silver, stock_status, sort_order, busan_product_id
       FROM product_variants WHERE product_id IN (${ph}) AND active = 1 ORDER BY sort_order, id`
    ).all(...ids);
    for (const v of variants) {
      (aux.variants[v.product_id] = aux.variants[v.product_id] || []).push(v);
    }
    return aux;
  };

  r.get('/categories', async (req, res) => {
    const rows = await db.prepare(
      'SELECT id, name, slug, description, image_url, parent_id, show_in_menu, show_on_homepage, id_check_mode FROM categories WHERE active = 1 ORDER BY sort_order, name'
    ).all();
    // Build a nested tree (depth-safe, one level used by the storefront today).
    const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
    const roots = [];
    for (const r of rows) {
      const node = byId.get(r.id);
      if (r.parent_id && byId.has(r.parent_id) && r.parent_id !== r.id) {
        byId.get(r.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    }
    res.json(roots);
  });

  r.get('/banners', async (req, res) => {
    const pl = String(req.query.placement || 'hero').toLowerCase();
    const placement = pl === 'featured' ? 'featured' : pl === 'promo' ? 'promo' : 'hero';
    const rows = await db.prepare(
      'SELECT id, title, subtitle, image_url, link FROM banners WHERE active = 1 AND placement = ? ORDER BY sort_order, id'
    ).all(placement);
    res.json(rows);
  });

  r.get('/testimonials', async (req, res) => {
    const pid = intIn(req.query.product_id, 1, 2147483647);
    const rows = pid
      ? await db.prepare(
          `SELECT t.name, t.text, t.rating, p.name AS product_name
           FROM testimonials t LEFT JOIN products p ON p.id = t.product_id
           WHERE t.active = 1 AND (t.product_id IS NULL OR t.product_id = ?)
           ORDER BY t.sort_order, t.id`
        ).all(pid)
      : await db.prepare(
          'SELECT name, text, rating FROM testimonials WHERE active = 1 AND product_id IS NULL ORDER BY sort_order, id'
        ).all();
    res.json(rows);
  });

  r.get('/settings/public', async (req, res) => {
    const get = async (k) => {
      const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      return row ? row.value : '';
    };
    res.json({ site_name: (await get('site_name')) || 'Avardo Official', whatsapp_number: await get('whatsapp_number'), site_logo: await get('site_logo'), site_logo_text: await get('site_logo_text'), favicon: (await get('favicon')) || '', how_to_order_image: (await get('how_to_order_image')) || '/images/how-to-order.webp', social_youtube: await get('social_youtube'), social_instagram: await get('social_instagram'), social_x: await get('social_x'), social_whatsapp: await get('social_whatsapp'), support_whatsapp_url: await get('support_whatsapp_url'), support_telegram_url: await get('support_telegram_url'), support_wechat_id: await get('support_wechat_id'), category_image_ratio: (await get('category_image_ratio')) || 'square', featured_layout: (await get('featured_layout')) || 'grid' });
  });

  r.get('/products', async (req, res) => {
    const where = ['p.active = 1'];
    const params = [];
    const category = optStr(req.query.category, 80);
    if (category) {
      if (category === 'featured') {
        where.push('p.featured = 1');
      } else {
        // Resolve the slug at any level. A top-level slug includes products
        // from all of its descendant sub-categories; a sub-category slug
        // returns only its own products.
        const cat = await db.prepare('SELECT id FROM categories WHERE slug = ? AND active = 1').get(category);
        if (!cat) {
          where.push('1 = 0');
        } else {
          const all = await db.prepare('SELECT id, parent_id FROM categories WHERE active = 1').all();
          const ids = [cat.id];
          let frontier = [cat.id];
          while (frontier.length) {
            const next = all.filter((c) => frontier.includes(c.parent_id)).map((c) => c.id);
            for (const id of next) if (!ids.includes(id)) ids.push(id);
            frontier = next;
          }
          where.push(`p.category_id IN (${ids.map(() => '?').join(',')})`);
          params.push(...ids);
        }
      }
    }
    if (req.query.featured === '1') where.push('p.featured = 1');
    const search = optStr(req.query.search, 120);
    const limit = intIn(req.query.limit, 1, 100) || 50;
    let rows;
    if (search) {
      // Word-order relevance search across product + category names.
      rows = await scoredSearch(search, where, params, limit);
    } else {
      rows = await db.prepare(
        `SELECT p.*, c.name AS category_name, c.slug AS category_slug
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.featured DESC, p.id
         LIMIT ?`
      ).all(...params, limit);
    }
    const aux = await loadProductAux(rows.map((p) => p.id));
    res.json(rows.map((p) => mapProduct(req)(p, aux)));
  });

  r.get('/products/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').slice(0, 80);
    const p = await db.prepare(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.id_check_mode AS category_id_check_mode
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.slug = ? AND p.active = 1`
    ).get(slug);
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    // Cascade id_check_mode up the category tree: product's category -> parent
    // -> grandparent, first non-'auto' wins. Lets admins manage it from a
    // parent like "Games" instead of every sub-category.
    if ((p.category_id_check_mode || 'auto') === 'auto' && p.category_id) {
      let pid = null;
      try {
        const c0 = await db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(p.category_id);
        pid = c0 && c0.parent_id;
      } catch (e) { /* keep auto */ }
      let depth = 0;
      while (pid && depth < 6) {
        depth++;
        let row = null;
        try { row = await db.prepare('SELECT parent_id, id_check_mode FROM categories WHERE id = ?').get(pid); } catch (e) { break; }
        if (!row) break;
        if (row.id_check_mode && row.id_check_mode !== 'auto') { p.category_id_check_mode = row.id_check_mode; break; }
        pid = row.parent_id;
      }
    }
    const aux = await loadProductAux([p.id]);
    res.json(mapProduct(req)(p, aux));
  });

  r.get('/posts', async (req, res) => {
    const rows = await db.prepare(
      'SELECT id, slug, title, excerpt, image_url, created_at FROM posts WHERE published = 1 ORDER BY id DESC LIMIT 100'
    ).all();
    res.json(rows);
  });

  r.get('/posts/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').slice(0, 120);
    const p = await db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(slug);
    if (!p) return res.status(404).json({ error: 'Post not found.' });
    res.json(p);
  });

  // Approved product reviews, newest first.
  r.get('/reviews', async (req, res) => {
    const productId = intIn(req.query.product_id, 1, 2147483647);
    if (!productId) return res.status(400).json({ error: 'Invalid product.' });
    const rows = await db.prepare(
      `SELECT r.id, r.product_id, p.name AS product_name, u.name AS customer_name,
              r.rating, r.text, r.created_at
       FROM reviews r
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.product_id = ? AND r.approved = 1
       ORDER BY r.id DESC`
    ).all(productId);
    res.json(rows.map((rv) => ({
      id: rv.id,
      product_id: rv.product_id,
      product_name: rv.product_name || 'Product',
      customer_name: rv.customer_name || 'Customer',
      rating: rv.rating,
      text: rv.text,
      created_at: rv.created_at,
    })));
  });

  // ---------- support chat (customer side) ----------
  const supportOwnsThread = async (req, threadId) => {
    const id = intIn(threadId, 1, 2147483647);
    if (!id) return null;
    const t = await db.prepare('SELECT * FROM support_threads WHERE id = ?').get(id);
    if (!t) return null;
    if (req.user && t.user_id && Number(t.user_id) === Number(req.user.id)) return t;
    const gt = optStr(req.body && req.body.guest_token, 64) || optStr(req.query.guest_token, 64);
    if (gt && t.guest_token && t.guest_token === gt) return t;
    return null;
  };

  r.post('/support/start', async (req, res) => {
    const customerName = str((req.body && req.body.customer_name) || 'Guest', 80) || 'Guest';
    let thread = null;
    if (req.user) {
      thread = await db.prepare(
        "SELECT * FROM support_threads WHERE user_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1"
      ).get(req.user.id);
    }
    let guestToken = optStr(req.body && req.body.guest_token, 64);
    if (!thread && guestToken) {
      thread = await db.prepare(
        "SELECT * FROM support_threads WHERE guest_token = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1"
      ).get(guestToken);
    }
    if (!thread) {
      if (!guestToken) {
        guestToken = require('crypto').randomBytes(16).toString('hex');
      }
      const info = await db.prepare(
        'INSERT INTO support_threads (user_id, guest_token, customer_name, status) VALUES (?, ?, ?, ?)'
      ).run(req.user ? req.user.id : null, req.user ? null : guestToken, customerName, 'open');
      thread = await db.prepare('SELECT * FROM support_threads WHERE id = ?').get(info.lastInsertRowid);
      await db.prepare(
        "INSERT INTO support_messages (thread_id, sender, body, admin_read) VALUES (?, 'admin', ?, 1)"
      ).run(thread.id, `Hi ${customerName}! Thanks for reaching out. How can we help you today?`);
    } else if (req.user && !thread.user_id) {
      await db.prepare('UPDATE support_threads SET user_id = ?, guest_token = NULL WHERE id = ?')
        .run(req.user.id, thread.id);
      thread.user_id = req.user.id;
      thread.guest_token = null;
    }
    const messages = await db.prepare(
      'SELECT id, sender, body, attachment_url, created_at FROM support_messages WHERE thread_id = ? ORDER BY id ASC LIMIT 200'
    ).all(thread.id);
    res.json({
      thread: { id: thread.id, status: thread.status, customer_name: thread.customer_name },
      guest_token: thread.guest_token,
      messages,
    });
  });

  r.get('/support/thread/:id/messages', async (req, res) => {
    const t = await supportOwnsThread(req, req.params.id);
    if (!t) return res.status(404).json({ error: 'Chat not found.' });
    const after = intIn(req.query.after, 0, 2147483647) || 0;
    const messages = await db.prepare(
      'SELECT id, sender, body, attachment_url, created_at FROM support_messages WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT 200'
    ).all(t.id, after);
    res.json({ messages, status: t.status });
  });

  // Validate a chat attachment: image data URL, max ~1.5MB.
  const validAttachment = (u) => {
    if (!u) return null;
    const s = String(u);
    if (!s.startsWith('data:image/')) return null;
    if (s.length > 2000000) return null;
    return s.slice(0, 2000000);
  };

  r.post('/support/thread/:id/messages', async (req, res) => {
    const t = await supportOwnsThread(req, req.params.id);
    if (!t) return res.status(404).json({ error: 'Chat not found.' });
    if (t.status !== 'open') return res.status(400).json({ error: 'This chat is closed. Start a new one if you need help.' });
    const body = str(req.body && req.body.body, 2000);
    const attachment = validAttachment(req.body && req.body.attachment_url);
    if (!body && !attachment) return res.status(400).json({ error: 'Message cannot be empty.' });
    const info = await db.prepare(
      "INSERT INTO support_messages (thread_id, sender, body, admin_read, attachment_url) VALUES (?, 'customer', ?, 0, ?)"
    ).run(t.id, body || '', attachment);
    await db.prepare('UPDATE support_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(t.id);
    const msg = await db.prepare('SELECT id, sender, body, created_at FROM support_messages WHERE id = ?')
      .get(info.lastInsertRowid);
    notifySupportMessage({
      storeName: 'Avardo Official',
      adminUrl: 'https://www.mlbbstore.in/admin',
      customerName: t.customer_name,
      threadId: t.id,
      body,
    });
    res.status(201).json({ message: msg });
  });

  // ---------- Game ID nickname checker ----------
  // Proxies a lookup to the nickname provider so the browser never talks
  // to it directly. Rate-limited per IP to prevent abuse.
  const ID_CHECK_API = 'https://api.game-true-id.eu.cc';
  const ID_CHECK_GAMES = {
    'mobile-legends': { needsZone: true, label: 'Mobile Legends' },
    'free-fire': { needsZone: false, label: 'Free Fire' },
    'honor-of-kings': { needsZone: false, label: 'Honor of Kings' },
    'pubg-mobile': { needsZone: false, label: 'PUBG Mobile' },
    'magic-chess': { needsZone: true, label: 'Magic Chess' },
    'genshin-impact': { needsZone: false, label: 'Genshin Impact' },
  };
  const idCheckHits = new Map(); // ip -> { count, resetAt }
  r.post('/games/check-id', async (req, res) => {
    try {
      const ip = (req.ip || req.headers['x-forwarded-for'] || 'unknown').toString().split(',')[0].trim();
      const now = Date.now();
      const hit = idCheckHits.get(ip);
      if (hit && now < hit.resetAt) {
        if (hit.count >= 15) return res.status(429).json({ error: 'Too many checks. Try again in a minute.' });
        hit.count++;
      } else {
        idCheckHits.set(ip, { count: 1, resetAt: now + 60000 });
      }
      const b = req.body || {};
      const game = String(b.game || '').toLowerCase().trim();
      const userId = String(b.user_id || '').replace(/\D/g, '').slice(0, 32);
      const zoneId = String(b.zone_id || '').replace(/\D/g, '').slice(0, 16);
      const busanProductId = String(b.busan_product_id || '').trim();
      const cfg = ID_CHECK_GAMES[game];
      if (!cfg) return res.status(400).json({ error: 'Unsupported game.' });
      if (!userId) return res.status(400).json({ error: 'Enter a valid User ID.' });
      if (cfg.needsZone && !zoneId) return res.status(400).json({ error: 'Enter your Zone ID too.' });
      // Busan-linked check: validate directly against Busan's API for this product.
      // This is the same validation Busan will run at fulfilment time.
      if (busanProductId) {
        try {
          const v = await busan.validatePlayer(busanProductId, userId, zoneId || undefined);
          const vd = (v && v.data) || {};
          if (vd.valid && vd.username) {
            return res.json({ nickname: String(vd.username), region: '', game: cfg.label, via: 'busan' });
          }
          return res.status(404).json({ error: 'Account not found. Double-check your User ID and Zone ID.' });
        } catch (e) {
          console.error('[id-check] busan validate failed:', e && e.message);
          return res.status(500).json({ error: 'Could not verify right now. Try again.' });
        }
      }
      const qs = new URLSearchParams({ user_id: userId });
      if (zoneId) qs.set('zone_id', zoneId);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let data;
      try {
        const upstream = await fetch(`${ID_CHECK_API}/nickname/${game}?${qs.toString()}`, { signal: ctrl.signal });
        data = await upstream.json().catch(() => null);
      } catch (_) {
        data = null;
      } finally {
        clearTimeout(timer);
      }
      if (!data || !data.success || !data.data || !data.data.nickname) {
        return res.status(404).json({ error: 'Account not found. Double-check your User ID and Zone ID.' });
      }
      res.json({ nickname: String(data.data.nickname), region: data.data.region || '', game: cfg.label });
    } catch (e) {
      res.status(500).json({ error: 'Could not verify right now. Try again.' });
    }
  });

  // ---------- Game ID check for a store product (used at checkout) ----------
  // Same Busan player validation that fulfilment runs, but keyed by our
  // product/variant id so the browser never sees the Busan product mapping.
  // Body: { product_id, variant_id?, user_id, zone_id? }
  // -> { nickname } | 404 { error }.
  r.post('/games/check-id-for-product', async (req, res) => {
    try {
      const ip = (req.ip || req.headers['x-forwarded-for'] || 'unknown').toString().split(',')[0].trim();
      const now = Date.now();
      const hit = idCheckHits.get(ip);
      if (hit && now < hit.resetAt) {
        if (hit.count >= 15) return res.status(429).json({ error: 'Too many checks. Try again in a minute.' });
        hit.count++;
      } else {
        idCheckHits.set(ip, { count: 1, resetAt: now + 60000 });
      }
      const b = req.body || {};
      const productId = parseInt(b.product_id, 10);
      const variantId = parseInt(b.variant_id, 10) || 0;
      const userId = String(b.user_id || '').trim().slice(0, 64);
      const zoneId = String(b.zone_id || '').trim().slice(0, 32);
      if (!productId || !userId) return res.status(400).json({ error: 'Enter your game ID first.' });
      if (!busan.configured()) return res.status(503).json({ error: 'ID check is not available right now.' });
      let busanProductId = '';
      try {
        const prod = await db.prepare('SELECT busan_product_id, busan_auto_fulfil FROM products WHERE id = ?').get(productId);
        if (prod && prod.busan_product_id) busanProductId = String(prod.busan_product_id).trim();
        if (variantId) {
          const vrow = await db.prepare('SELECT busan_product_id FROM product_variants WHERE id = ? AND product_id = ?').get(variantId, productId);
          if (vrow && vrow.busan_product_id && String(vrow.busan_product_id).trim()) {
            busanProductId = String(vrow.busan_product_id).trim();
          }
        }
      } catch (_) { /* fall through to the not-available error */ }
      if (!busanProductId) return res.status(400).json({ error: 'ID check is not available for this product.' });
      try {
        const v = await busan.validatePlayer(busanProductId, userId, zoneId || undefined);
        const vd = (v && v.data) || {};
        if (vd.valid !== false && (vd.username || vd.valid === true)) {
          return res.json({ nickname: vd.username ? String(vd.username) : '' });
        }
        return res.status(404).json({ error: 'Account not found. Double-check your ID.' });
      } catch (e) {
        console.error('[id-check] product check failed:', e && e.message);
        return res.status(404).json({ error: 'Account not found. Double-check your ID.' });
      }
    } catch (e) {
      res.status(500).json({ error: 'Could not verify right now. Try again.' });
    }
  });

  return r;
};
