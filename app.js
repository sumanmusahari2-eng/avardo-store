require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');

const { initDb } = require('./src/db');
const seed = require('./src/seed');
const { optionalAuth } = require('./src/auth');
const { runSync: runBusanPriceSync, getSetting: getBusanSetting } = require('./src/busan-sync');

// Busan wholesale-price sync scheduler: first run
// 6 minutes after boot, then re-reads the interval from settings on every
// tick (min 5 minutes). Fire-and-forget; failures are logged, never crash.
function scheduleBusanPriceSync(db) {
  const tick = async () => {
    try {
      const s = await runBusanPriceSync(db);
      if (s.skipped) {
        console.log('[busan-sync] skipped:', s.note);
      } else {
        console.log(
          `[busan-sync] checked=${s.checked} costUpdates=${s.costUpdates} ` +
          `increases=${s.priceIncreases} decreases=${s.priceDecreases} warnings=${s.warnings.length}`
        );
      }
    } catch (e) {
      console.error('[busan-sync] failed:', e && e.message);
    }
  };
  const readIntervalMs = async () => {
    const v = parseInt(await getBusanSetting(db, 'busan_sync_interval_min', '60'), 10);
    const m = Number.isFinite(v) && v >= 5 ? v : 60;
    return m * 60 * 1000;
  };
  const loop = async () => {
    await tick();
    setTimeout(loop, await readIntervalMs());
  };
  setTimeout(loop, 6 * 60 * 1000);
}

async function buildApp() {
  // Picks Postgres when DATABASE_URL is set, otherwise the local SQLite file.
  const db = await initDb();
  await seed(db);

  const app = express();
  app.set('trust proxy', 1);

  // Security headers. CSP is disabled because the frontend uses CDN scripts
  // (Tailwind, Google Fonts, Google Identity Services).
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  // Raw body for the CryptoPay webhook: its HMAC-SHA256 signature is computed
  // over the raw request bytes, so this must run BEFORE the JSON parser for
  // this one path. (Signature scheme itself is UNVERIFIED — confirm on first live test.)
  app.use('/api/payments/crypto/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  // HMAC-verified webhook, no session: mounted BEFORE the /api routers below,
  // because the shop router's global requireAuth would otherwise 401 the
  // gateway's unauthenticated callbacks.
  app.post('/api/payments/crypto/webhook', require('./src/routes/payments').cryptoWebhookHandler(db));
  // DivineXPay USDT (BEP20) webhook: HMAC-SHA256 over "<t>.<raw_body>", raw body
  // required for signature verification — mounted before the JSON parser.
  app.use('/api/payments/divinex/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  app.post('/api/payments/divinex/webhook', require('./src/routes/payments').divinexWebhookHandler(db));
  // Busan order-notification webhook (HMAC over JSON fields, verified in the
  // handler). Same reason: no session, must run before authenticated routers.
  // Signature is over JSON field VALUES (orderId|status|timestamp), not the raw
  // body, so route-specific JSON parsing is safe here.
  app.post('/api/payments/busan/webhook', express.json({ limit: '256kb' }), require('./src/routes/payments').busanWebhookHandler(db));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.use(optionalAuth(db));

  app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
  }));

  app.use('/api/auth', require('./src/routes/auth')(db));
  // Key-authenticated reseller API: mounted before the /api routers because
  // the shop router applies requireAuth globally (same reason as the webhooks above).
  app.use('/api/v1', require('./src/routes/reseller-api')(db));
  // Memberships likewise: the public /status endpoint must not hit the shop router's global auth.
  app.use('/api/memberships', require('./src/routes/memberships')(db));
  app.use('/api', require('./src/routes/public')(db));
  app.use('/api', require('./src/routes/shop')(db));
  app.use('/api/wallet', require('./src/routes/wallet')(db));
  app.use('/api/payments', require('./src/routes/payments')(db));
  app.use('/api/reseller', require('./src/routes/reseller')(db));
  app.use('/api/admin', require('./src/routes/admin')(db));

  // ---- White-label branding ----
  // Brand name comes from the DB site_name setting (fresh DBs seed it from the
  // BRAND_NAME env var); brand domain comes from PUBLIC_BASE_URL. Text assets
  // in public/ are served with "Meowji Official" / "www.mlbbstore.in" replaced,
  // so one codebase can serve a rebranded storefront. On the existing
  // deployment both resolve to the current values, so output is unchanged.
  let brandName = (process.env.BRAND_NAME || 'Meowji Official').trim() || 'Meowji Official';
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get('site_name');
    if (row && row.value && String(row.value).trim()) brandName = String(row.value).trim();
  } catch (e) { console.warn('[brand] could not read site_name:', e.message); }
  const publicBase = (process.env.PUBLIC_BASE_URL || 'https://www.mlbbstore.in').trim();
  const brandDomain = (publicBase.replace(/^https?:\/\//, '').split('/')[0] || 'www.mlbbstore.in').toLowerCase();
  const brand = { name: brandName, domain: brandDomain };
  app.set('brand', brand);
  console.log('[brand]', brand.name, '|', brand.domain);

  const fs = require('fs');
  const PUBLIC_DIR = path.join(__dirname, 'public');
  const BRANDABLE_RE = /\.(html|js|webmanifest)$/i;
  const brandedCache = new Map();
  function brandedContent(absPath) {
    let content = brandedCache.get(absPath);
    if (content === undefined) {
      content = fs.readFileSync(absPath, 'utf8');
      if (brand.name !== 'Meowji Official') content = content.split('Meowji Official').join(brand.name);
      if (brand.domain !== 'www.mlbbstore.in') {
        content = content.split('www.mlbbstore.in').join(brand.domain);
        content = content.split('mlbbstore.in').join(brand.domain);
      }
      brandedCache.set(absPath, content);
    }
    return content;
  }
  // Serve brandable text assets with white-label replacements, before the plain static handler.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel = req.path;
    if (rel.endsWith('/')) rel += 'index.html';
    if (!BRANDABLE_RE.test(rel)) return next();
    const abs = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!abs.startsWith(PUBLIC_DIR + path.sep)) return next();
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) return next();
      try {
        res.type(path.extname(abs));
        res.send(brandedContent(abs));
      } catch (e) { next(e); }
    });
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // Digital Asset Links — verifies the Meowji Official Android app (TWA).
  app.get('/.well-known/assetlinks.json', (req, res) => {
    res.json([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'in.mlbbstore.app',
        sha256_cert_fingerprints: [
          '09:F7:24:DA:9E:3D:8B:07:4D:80:D8:95:2D:45:96:46:F2:DA:DF:92:7C:39:66:71:2B:03:97:F7:8D:27:C8:1B'
        ]
      }
    }]);
  });

  const pages = {
    '/': 'index.html',
    '/product': 'product.html',
    '/cart': 'cart.html',
    '/checkout': 'checkout.html',
    '/order': 'order.html',
    '/login': 'login.html',
    '/register': 'register.html',
    '/account': 'account.html',
    '/wallet': 'wallet.html',
    '/payment-return': 'payment-return.html',
    '/reseller': 'reseller.html',
    '/admin': 'admin.html',
  };
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
  }
  // Clean blog-post URLs: /post/<slug> (old /post.html?slug= still works).
  app.get('/post/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'post.html')));

  // ---- SEO: robots.txt + sitemap.xml ----
  const SITE_URL = (process.env.PUBLIC_BASE_URL || 'https://www.mlbbstore.in').replace(/\/+$/, '');
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      'User-agent: *\n' +
      'Allow: /\n' +
      'Disallow: /admin.html\n' +
      'Disallow: /account.html\n' +
      'Disallow: /cart.html\n' +
      'Disallow: /checkout.html\n' +
      'Disallow: /wallet.html\n' +
      'Disallow: /order.html\n' +
      'Disallow: /login.html\n' +
      'Disallow: /register.html\n' +
      'Disallow: /payment-return.html\n' +
      `\nSitemap: ${SITE_URL}/sitemap.xml\n`
    );
  });
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  app.get('/sitemap.xml', async (req, res) => {
    try {
      const posts = await db.prepare(
        'SELECT slug, created_at FROM posts WHERE published = 1 ORDER BY id DESC'
      ).all();
      let products = [];
      let categories = [];
      try {
        products = await db.prepare(
          'SELECT slug, created_at FROM products WHERE active = 1 AND slug IS NOT NULL AND slug <> \'\' ORDER BY id DESC'
        ).all();
      } catch (_) { /* products table may not exist yet */ }
      try {
        categories = await db.prepare(
          'SELECT slug FROM categories WHERE slug IS NOT NULL AND slug <> \'\' AND (show_in_menu = 1 OR show_on_homepage = 1)'
        ).all();
      } catch (_) { /* categories table may not exist yet */ }
      const urls = [
        { loc: `${SITE_URL}/`, priority: '1.0', changefreq: 'daily' },
        { loc: `${SITE_URL}/blog.html`, priority: '0.8', changefreq: 'daily' },
      ];
      for (const c of categories) {
        urls.push({
          loc: `${SITE_URL}/?category=${encodeURIComponent(c.slug)}`,
          priority: '0.7',
          changefreq: 'weekly',
        });
      }
      for (const p of products) {
        let lastmod = '';
        if (p.created_at) {
          const d = new Date(p.created_at);
          if (!Number.isNaN(d.getTime())) lastmod = d.toISOString().slice(0, 10);
        }
        urls.push({
          loc: `${SITE_URL}/product.html?slug=${encodeURIComponent(p.slug)}`,
          priority: '0.9',
          changefreq: 'weekly',
          lastmod,
        });
      }
      for (const p of posts) {
        let lastmod = '';
        if (p.created_at) {
          const d = new Date(p.created_at);
          if (!Number.isNaN(d.getTime())) lastmod = d.toISOString().slice(0, 10);
        }
        urls.push({
          loc: `${SITE_URL}/post/${encodeURIComponent(p.slug)}`,
          priority: '0.7',
          changefreq: 'weekly',
          lastmod,
        });
      }
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((u) =>
          `  <url>\n    <loc>${escXml(u.loc)}</loc>\n` +
          (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
          `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
        ).join('\n') +
        `\n</urlset>`;
      res.type('application/xml').send(xml);
    } catch (e) {
      console.error('[sitemap]', e && e.message);
      res.status(500).type('text/plain').send('sitemap error');
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  // Render injects PORT; default 3000 for local dev.
  const PORT = process.env.PORT || 3000;
  return { app, db, PORT };
}

async function main() {
  const { app, db, PORT } = await buildApp();
  app.listen(PORT, () => {
    console.log(`GameRefill running at http://localhost:${PORT} (db: ${db.backend})`); // deploy 2026-09-29 search-v2
  });
  scheduleBusanPriceSync(db);
}

// Only auto-boot when run directly (node server.js). When required as a
// module (e.g. Vercel's api/index.js), the importer calls buildApp() itself.
if (require.main === module) {
  main().catch((err) => {
    console.error('[fatal] failed to start:', err);
    process.exit(1);
  });
}

// Vercel's Express preset loads this file directly as the function entry and
// requires the default export to be a (req, res) handler — delegate to the
// lazily built Express app (built once per cold start, rejection not cached).
// api/index.js keeps working via the .buildApp property.
let appPromise = null;
module.exports = async (req, res) => {
  try {
    if (!appPromise) {
      appPromise = buildApp().then(({ app }) => app);
      appPromise.catch(() => { appPromise = null; });
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    console.error('[app] boot failed:', err && err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
};
module.exports.buildApp = buildApp;
