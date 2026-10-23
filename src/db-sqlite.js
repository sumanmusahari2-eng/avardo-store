// SQLite backend (local dev). Keeps the original schema and better-sqlite3,
// exposed through the same async statement API as the Postgres backend so the
// routes never need to know which database is in use.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Slugs of the 3 launch posts, eligible for a one-time interlink upgrade
// (only when their body was never edited — see initSqlite).
const LEGACY_POST_SLUGS = new Set([
  'youtube-premium-1-year-300-promo',
  'spotify-premium-1-year-400',
  'how-buying-works',
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin','silver','customer')),
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  membership_expires_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  how_to_order_text TEXT,
  how_to_order_image TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  image_url TEXT,
  price_mrp REAL,
  price_regular REAL NOT NULL,
  price_reseller REAL NOT NULL,
  price_usd REAL,
  price_usd_reseller REAL,
  available_inr INTEGER NOT NULL DEFAULT 1,
  available_usd INTEGER NOT NULL DEFAULT 1,
  stock_status TEXT NOT NULL DEFAULT 'in_stock'
    CHECK (stock_status IN ('in_stock','low_stock','out_of_stock')),
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subtitle TEXT,
  image_url TEXT,
  link TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  placement TEXT NOT NULL DEFAULT 'hero');

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  items TEXT NOT NULL,
  total REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','delivered','cancelled')),
  payment_note TEXT,
  paid_claimed INTEGER NOT NULL DEFAULT 0,
  delivery_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 5,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  product_id INTEGER);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  discount_value REAL NOT NULL,
  usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  text TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_user_product ON reviews (user_id, product_id);

CREATE TABLE IF NOT EXISTS order_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS order_updates_order_id ON order_updates (order_id);

CREATE TABLE IF NOT EXISTS product_checkout_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  required INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  options TEXT);
CREATE INDEX IF NOT EXISTS pca_product_id ON product_checkout_attributes (product_id);

-- Product options (variants): e.g. gift-card denominations. When a product
-- has active variants, buyers must pick one; its price applies instead of
-- the base product price.
CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  keyword TEXT,
  image_url TEXT,
  price_mrp REAL,
  price_regular REAL NOT NULL,
  price_reseller REAL NOT NULL,
  price_usd REAL,
  price_usd_reseller REAL,
  cost_price REAL,
  stock_status TEXT NOT NULL DEFAULT 'in_stock',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS pv_product_id ON product_variants (product_id);

-- Wallet + gift-card vouchers.
CREATE TABLE IF NOT EXISTS reseller_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  requests_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON reseller_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON reseller_api_keys(user_id);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('credit','debit')),
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS wt_user_id ON wallet_transactions (user_id);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','assigned','redeemed','disabled')),
  created_by INTEGER,
  redeemed_by INTEGER,
  redeemed_at TEXT,
  expires_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS vouchers_code ON vouchers (code);
CREATE INDEX IF NOT EXISTS vouchers_status ON vouchers (status);

CREATE TABLE IF NOT EXISTS order_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  product_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ov_order_id ON order_vouchers (order_id);

CREATE TABLE IF NOT EXISTS support_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  guest_token TEXT,
  customer_name TEXT NOT NULL DEFAULT 'Guest',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS st_user_id ON support_threads (user_id);
CREATE INDEX IF NOT EXISTS st_guest_token ON support_threads (guest_token);
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  sender TEXT NOT NULL DEFAULT 'customer',
  body TEXT NOT NULL,
  admin_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  attachment_url TEXT
);
CREATE INDEX IF NOT EXISTS sm_thread_id ON support_messages (thread_id);
`;

class SqliteStatement {
  constructor(stmt) {
    this.stmt = stmt;
  }
  // .get() returns a row object or null (better-sqlite3 returns undefined).
  async get(...params) {
    const row = this.stmt.get(...params);
    return row === undefined ? null : row;
  }
  async all(...params) {
    return this.stmt.all(...params);
  }
  // .run() resolves to { lastInsertRowid, changes }, mirroring better-sqlite3 info.
  async run(...params) {
    const info = this.stmt.run(...params);
    return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
  }
}

class SqliteDb {
  constructor(native) {
    this.native = native;
    this.backend = 'sqlite';
  }
  // Synchronous prepare, like better-sqlite3 — only get/all/run are async.
  prepare(sql) {
    return new SqliteStatement(this.native.prepare(sql));
  }
  async close() {
    this.native.close();
  }
}

async function initSqlite(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const native = new Database(dbPath);
  native.pragma('journal_mode = WAL');
  native.exec(SCHEMA);
  // XtraGateway payment columns (idempotent migration for existing DBs).
  const existing = new Set(
    native.prepare('PRAGMA table_info(orders)').all().map((c) => c.name)
  );
  for (const [col, type] of [
    ['xtra_order_id', 'TEXT'],
    ['xtra_payment_url', 'TEXT'],
    ['xtra_status', 'TEXT'],
    ['xtra_utr', 'TEXT'],
    ['customer_mobile', 'TEXT'],
    ['buyer_name', 'TEXT'],
    ['buyer_phone', 'TEXT'],
    ['buyer_email', 'TEXT'],
    ['buyer_age', 'INTEGER'],
    ['buyer_agreed', 'INTEGER'],
    ['topzy_order_id', 'TEXT'],
    ['topzy_status', 'TEXT'],
    ['busan_order_id', 'TEXT'],
    ['busan_status', 'TEXT'],
    ['busan_fulfilled', 'TEXT'],
    // CryptoPay (USDT) payment columns.
    ['crypto_order_ref', 'TEXT'],
    ['crypto_checkout_url', 'TEXT'],
    ['crypto_exact_amount', 'TEXT'],
    ['crypto_status', 'TEXT'],
    ['crypto_tx_hash', 'TEXT'],
    ['crypto_chain', 'TEXT'],
    ['divinex_payment_id', 'TEXT'],
    ['divinex_wallet', 'TEXT'],
    ['divinex_expires_at', 'INTEGER'],
  ]) {
    if (!existing.has(col)) native.exec(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
  }
  // Stock, coupons, reviews, order updates & checkout attributes (idempotent).
  const productCols = new Set(
    native.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
  );
  if (!productCols.has('stock_quantity')) native.exec('ALTER TABLE products ADD COLUMN stock_quantity INTEGER');
  if (!productCols.has('topzy_pack_id')) native.exec('ALTER TABLE products ADD COLUMN topzy_pack_id TEXT');
  if (!productCols.has('topzy_auto_fulfil')) native.exec('ALTER TABLE products ADD COLUMN topzy_auto_fulfil INTEGER NOT NULL DEFAULT 1');
  if (!productCols.has('busan_product_id')) native.exec('ALTER TABLE products ADD COLUMN busan_product_id TEXT');
  if (!productCols.has('busan_auto_fulfil')) native.exec('ALTER TABLE products ADD COLUMN busan_auto_fulfil INTEGER NOT NULL DEFAULT 0');
  if (!productCols.has('how_to_order_text')) native.exec('ALTER TABLE products ADD COLUMN how_to_order_text TEXT');
  if (!productCols.has('how_to_order_image')) native.exec('ALTER TABLE products ADD COLUMN how_to_order_image TEXT');
  const userCols2 = new Set(
    native.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  );
  if (!userCols2.has('balance_usd')) native.exec('ALTER TABLE users ADD COLUMN balance_usd REAL NOT NULL DEFAULT 0');
  const wtCols2 = new Set(
    native.prepare('PRAGMA table_info(wallet_transactions)').all().map((c) => c.name)
  );
  const bCols = new Set(
    native.prepare('PRAGMA table_info(banners)').all().map((c) => c.name)
  );
  const tCols = new Set(
    native.prepare('PRAGMA table_info(testimonials)').all().map((c) => c.name)
  );
  const smCols = new Set(
    native.prepare('PRAGMA table_info(support_messages)').all().map((c) => c.name)
  );
  const pcaCols = new Set(
    native.prepare('PRAGMA table_info(product_checkout_attributes)').all().map((c) => c.name)
  );
  if (!pcaCols.has('options')) native.exec('ALTER TABLE product_checkout_attributes ADD COLUMN options TEXT');
if (!smCols.has('attachment_url')) native.exec('ALTER TABLE support_messages ADD COLUMN attachment_url TEXT');
if (!tCols.has('product_id')) native.exec('ALTER TABLE testimonials ADD COLUMN product_id INTEGER');
if (!bCols.has('placement')) native.exec("ALTER TABLE banners ADD COLUMN placement TEXT DEFAULT 'hero'");
if (!wtCols2.has('currency')) native.exec("ALTER TABLE wallet_transactions ADD COLUMN currency TEXT DEFAULT 'INR'");
  // Topzy price-sync columns (idempotent).
  if (!productCols.has('cost_price')) native.exec('ALTER TABLE products ADD COLUMN cost_price REAL');
  if (!productCols.has('margin_type')) native.exec('ALTER TABLE products ADD COLUMN margin_type TEXT');
  if (!productCols.has('margin_value')) native.exec('ALTER TABLE products ADD COLUMN margin_value REAL');
  // Split customer/reseller margins (2026-10-01): customer margin drives
  // price_regular, reseller margin drives price_reseller.
  if (!productCols.has('margin_type_reseller')) native.exec('ALTER TABLE products ADD COLUMN margin_type_reseller TEXT');
  if (!productCols.has('margin_value_reseller')) native.exec('ALTER TABLE products ADD COLUMN margin_value_reseller REAL');
  // Sub-category hierarchy: categories.parent_id self-reference (NULL = top-level).
  const categoryCols = new Set(
    native.prepare('PRAGMA table_info(categories)').all().map((c) => c.name)
  );
  if (!categoryCols.has('parent_id')) native.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER');
  if (!categoryCols.has('image_url')) native.exec('ALTER TABLE categories ADD COLUMN image_url TEXT');
  if (!categoryCols.has('show_in_menu')) native.exec('ALTER TABLE categories ADD COLUMN show_in_menu INTEGER NOT NULL DEFAULT 1');
  if (!categoryCols.has('show_on_homepage')) native.exec('ALTER TABLE categories ADD COLUMN show_on_homepage INTEGER NOT NULL DEFAULT 1');
  if (!productCols.has('id_check_mode')) native.exec("ALTER TABLE products ADD COLUMN id_check_mode TEXT NOT NULL DEFAULT 'auto'");
  if (!categoryCols.has('id_check_mode')) native.exec("ALTER TABLE categories ADD COLUMN id_check_mode TEXT NOT NULL DEFAULT 'auto'");
  // Product option (variant) keyword + image (2026-09-30, idempotent).
  const variantCols = new Set(
    native.prepare('PRAGMA table_info(product_variants)').all().map((c) => c.name)
  );
  if (!variantCols.has('keyword')) native.exec('ALTER TABLE product_variants ADD COLUMN keyword TEXT');
  if (!variantCols.has('image_url')) native.exec('ALTER TABLE product_variants ADD COLUMN image_url TEXT');
  if (!variantCols.has('busan_product_id')) native.exec('ALTER TABLE product_variants ADD COLUMN busan_product_id TEXT');
  // Gift-card currency lock (2026-09-30, idempotent).
  const voucherCols = new Set(
    native.prepare('PRAGMA table_info(vouchers)').all().map((c) => c.name)
  );
  if (!voucherCols.has('currency')) native.exec("ALTER TABLE vouchers ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR'");
  if (!productCols.has('voucher_currency')) native.exec("ALTER TABLE products ADD COLUMN voucher_currency TEXT NOT NULL DEFAULT 'INR'");
  // Card chip image override (2026-10-01, idempotent): custom image shown in the listing-card chip circle.
  if (!productCols.has('chip_image_url')) native.exec('ALTER TABLE products ADD COLUMN chip_image_url TEXT');
  // Card chip custom text (2026-10-01, idempotent): shown in the chip circle when no chip image is set.
  if (!productCols.has('chip_text')) native.exec('ALTER TABLE products ADD COLUMN chip_text TEXT');
  // Per-currency pricing: optional USD prices (NULL = auto-convert from INR at the fixed rate).
  if (!productCols.has('price_usd')) native.exec('ALTER TABLE products ADD COLUMN price_usd REAL');
  if (!productCols.has('price_usd_reseller')) native.exec('ALTER TABLE products ADD COLUMN price_usd_reseller REAL');
  if (!productCols.has('available_inr')) native.exec('ALTER TABLE products ADD COLUMN available_inr INTEGER NOT NULL DEFAULT 1');
  if (!productCols.has('available_usd')) native.exec('ALTER TABLE products ADD COLUMN available_usd INTEGER NOT NULL DEFAULT 1');
  if (!variantCols.has('price_usd')) native.exec('ALTER TABLE product_variants ADD COLUMN price_usd REAL');
  if (!variantCols.has('price_usd_reseller')) native.exec('ALTER TABLE product_variants ADD COLUMN price_usd_reseller REAL');
  // Gold/Silver reseller tiers (2026-10-05): per-tier prices, NULL = fall back
  // (silver -> regular; gold tier removed 2026-10-07).
  if (!productCols.has('price_gold')) native.exec('ALTER TABLE products ADD COLUMN price_gold REAL');
  if (!productCols.has('price_silver')) native.exec('ALTER TABLE products ADD COLUMN price_silver REAL');
  if (!productCols.has('price_usd_gold')) native.exec('ALTER TABLE products ADD COLUMN price_usd_gold REAL');
  if (!productCols.has('price_usd_silver')) native.exec('ALTER TABLE products ADD COLUMN price_usd_silver REAL');
  if (!variantCols.has('price_gold')) native.exec('ALTER TABLE product_variants ADD COLUMN price_gold REAL');
  if (!variantCols.has('price_silver')) native.exec('ALTER TABLE product_variants ADD COLUMN price_silver REAL');
  if (!variantCols.has('price_usd_gold')) native.exec('ALTER TABLE product_variants ADD COLUMN price_usd_gold REAL');
  if (!variantCols.has('price_usd_silver')) native.exec('ALTER TABLE product_variants ADD COLUMN price_usd_silver REAL');
  // Migrate existing reseller prices into the (now silver) tier columns.
  native.exec(`UPDATE products SET price_gold = price_reseller WHERE price_gold IS NULL AND price_reseller IS NOT NULL`);
  native.exec(`UPDATE products SET price_usd_gold = price_usd_reseller WHERE price_usd_gold IS NULL AND price_usd_reseller IS NOT NULL`);
  native.exec(`UPDATE product_variants SET price_gold = price_reseller WHERE price_gold IS NULL AND price_reseller IS NOT NULL`);
  native.exec(`UPDATE product_variants SET price_usd_gold = price_usd_reseller WHERE price_usd_gold IS NULL AND price_usd_reseller IS NOT NULL`);
  // Order currency: 'INR' or 'USD' — totals are stored in this currency.
  const orderCols = new Set(
    native.prepare('PRAGMA table_info(orders)').all().map((c) => c.name)
  );
  if (!orderCols.has('currency')) native.exec("ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR'");
  native.exec(`CREATE TABLE IF NOT EXISTS topzy_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    pack_id TEXT,
    old_cost REAL,
    new_cost REAL,
    old_price REAL,
    new_price REAL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  native.exec(`CREATE TABLE IF NOT EXISTS busan_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    pack_id TEXT,
    old_cost REAL,
    new_cost REAL,
    old_price REAL,
    new_price REAL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const userCols = new Set(
    native.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  );
  if (!userCols.has('blocked')) native.exec('ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  if (!userCols.has('avatar_url')) native.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  // Gold/Silver reseller tiers (2026-10-05): SQLite can't ALTER a CHECK
  // constraint, so rebuild the users table once when the old check is found.
  {
    const usersSql = native.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
    if (usersSql && usersSql.sql && usersSql.sql.includes(`'admin','reseller','user'`)) {
      native.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        google_id TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin','silver','customer')),
        balance REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        blocked INTEGER NOT NULL DEFAULT 0,
        avatar_url TEXT,
        balance_usd REAL NOT NULL DEFAULT 0,
        membership_expires_at TEXT
      )`);
      native.exec(`INSERT INTO users_new (id, name, email, password_hash, google_id, role, balance, created_at, blocked, avatar_url, balance_usd)
        SELECT id, name, email, password_hash, google_id,
          CASE role WHEN 'reseller' THEN 'silver' WHEN 'gold' THEN 'silver' WHEN 'user' THEN 'customer' ELSE role END,
          balance, created_at, blocked, avatar_url, balance_usd FROM users`);
      native.exec(`DROP TABLE users`);
      native.exec(`ALTER TABLE users_new RENAME TO users`);
    }
  }
  // Paid reseller memberships (2026-10-06): expiry column + purchase history.
  const userCols3 = new Set(
    native.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  );
  if (!userCols3.has('membership_expires_at')) native.exec('ALTER TABLE users ADD COLUMN membership_expires_at TEXT');
  native.exec(`CREATE TABLE IF NOT EXISTS membership_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier TEXT NOT NULL CHECK (tier IN ('silver')),
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    days INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'wallet',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Remove Gold tier (2026-10-07): every gold account becomes silver.
  native.exec(`UPDATE users SET role = 'silver' WHERE role = 'gold'`);
  native.exec(`UPDATE membership_purchases SET tier = 'silver' WHERE tier = 'gold'`);
  // Voucher products: is_voucher flags the product, voucher_amount is the
  // gift-card face value assigned from the voucher pool on payment.
  if (!productCols.has('is_voucher')) native.exec('ALTER TABLE products ADD COLUMN is_voucher INTEGER NOT NULL DEFAULT 0');
  if (!productCols.has('voucher_amount')) native.exec('ALTER TABLE products ADD COLUMN voucher_amount REAL');
  // Wallet portion applied to an order + gift-card pool shortage flag.
  if (!existing.has('wallet_applied')) native.exec('ALTER TABLE orders ADD COLUMN wallet_applied REAL NOT NULL DEFAULT 0');
  if (!existing.has('voucher_shortage')) native.exec('ALTER TABLE orders ADD COLUMN voucher_shortage INTEGER NOT NULL DEFAULT 0');
  const orderNewCols = [
    ['subtotal', 'REAL NOT NULL DEFAULT 0'],
    ['discount', 'REAL NOT NULL DEFAULT 0'],
    ['coupon_code', 'TEXT'],
  ];
  for (const [col, type] of orderNewCols) {
    if (!existing.has(col)) native.exec(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
  }
  // Default product artwork (idempotent; only fills blanks so admin uploads win).
  const art = [
    ['youtube-premium-1-year', '/img/products/youtube-premium-1-year.gif'],
    ['spotify-premium-1-year', '/img/products/spotify-premium-1-year.gif'],
    ['apple-music-6-months', '/img/products/apple-music-6-months.gif'],
    ['netflix-1-month', '/img/products/netflix-1-month.gif'],
    ['chatgpt-plus-1-month', '/img/products/chatgpt-plus-1-month.gif'],
    ['google-gemini-18-months', '/img/products/google-gemini-18-months.gif'],
  ];
  const setArt = native.prepare(
    "UPDATE products SET image_url = ? WHERE slug = ? AND (image_url IS NULL OR image_url = '')"
  );
  for (const [slug, url] of art) setArt.run(url, slug);
  // Blog posts: per-slug idempotent — new posts are picked up, admin posts never touched.
  const seedPosts = require('./blog-seed-posts');
  const insPost = native.prepare(
    'INSERT OR IGNORE INTO posts (slug, title, excerpt, body, published) VALUES (?, ?, ?, ?, 1)'
  );
  for (const p of seedPosts) insPost.run(p.slug, p.title, p.excerpt, p.body);
  // Upgrade the 3 launch posts with interlinks — only when never edited (no internal links yet).
  const upPost = native.prepare(
    "UPDATE posts SET title = ?, excerpt = ?, body = ? WHERE slug = ? AND body NOT LIKE '%/post.html?slug=%'"
  );
  for (const p of seedPosts.filter((x) => LEGACY_POST_SLUGS.has(x.slug))) {
    upPost.run(p.title, p.excerpt, p.body, p.slug);
  }
  return new SqliteDb(native);
}

module.exports = { initSqlite };
