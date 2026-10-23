// Postgres backend (production: Render free web service + free Neon Postgres).
// Exposes the same async statement API as the SQLite backend:
//   db.prepare(sql) -> { get(...p): row|null, all(...p): rows[], run(...p): {lastInsertRowid, changes} }
// All queries stay parameterized. Dialect differences vs SQLite are handled here:
//   ? placeholders      -> $1, $2, ...
//   LIKE (case-insens.)  -> ILIKE
//   INSERT OR IGNORE    -> ON CONFLICT DO NOTHING
//   json_array_length() -> needs a ::json cast on TEXT columns
//   INSERT ...          -> appends RETURNING id so lastInsertRowid works
const { Pool, types } = require('pg');

// node-pg parses int8 and numeric as strings by default; coerce to JS numbers
// so COUNT(*), SUM() and REAL columns behave exactly like the SQLite backend.
types.setTypeParser(20, (v) => (v === null || v === undefined ? v : parseInt(v, 10)));
types.setTypeParser(1700, (v) => (v === null || v === undefined ? v : parseFloat(v)));

// Slugs of the 3 launch posts, eligible for a one-time interlink upgrade
// (only when their body was never edited — see initPg).
const LEGACY_POST_SLUGS = new Set([
  'youtube-premium-1-year-300-promo',
  'spotify-premium-1-year-400',
  'how-buying-works',
]);

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin','silver','customer')),
  balance REAL NOT NULL DEFAULT 0,
  balance_usd REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
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
  how_to_order_text TEXT,
  how_to_order_image TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS banners (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  image_url TEXT,
  link TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  placement TEXT NOT NULL DEFAULT 'hero'
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  items TEXT NOT NULL,
  total REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','delivered','cancelled')),
  payment_note TEXT,
  paid_claimed INTEGER NOT NULL DEFAULT 0,
  delivery_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reseller_api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  requests_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS testimonials (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 5,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  product_id INTEGER
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS membership_purchases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('silver')),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  days INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'wallet',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  discount_value REAL NOT NULL,
  usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  text TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_updates (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_checkout_attributes (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  required INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  options TEXT
);

-- Product options (variants): e.g. gift-card denominations. When a product
-- has active variants, buyers must pick one; its price applies instead of
-- the base product price.
CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS topzy_price_history (
  id SERIAL PRIMARY KEY,
  product_id INTEGER,
  pack_id TEXT,
  old_cost REAL,
  new_cost REAL,
  old_price REAL,
  new_price REAL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS busan_price_history (
  id SERIAL PRIMARY KEY,
  product_id INTEGER,
  pack_id TEXT,
  old_cost REAL,
  new_cost REAL,
  old_price REAL,
  new_price REAL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('credit','debit')),
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vouchers (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','assigned','redeemed','disabled')),
  created_by INTEGER,
  redeemed_by INTEGER,
  redeemed_at TIMESTAMP,
  expires_at TEXT,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_vouchers (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  product_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Invoices: one row per invoiced order; invoice_no generated from the id (2026-10-17).
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Support chat: customer threads + messages.
CREATE TABLE IF NOT EXISTS support_threads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  guest_token TEXT,
  customer_name TEXT NOT NULL DEFAULT 'Guest',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL DEFAULT 'customer',
  body TEXT NOT NULL,
  admin_read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  attachment_url TEXT
);

-- Feature parity: coupons, reviews, order updates, stock, checkout attributes.
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity INTEGER;
-- Product option (variant) keyword + image (2026-09-30).
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS keyword TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS image_url TEXT;
-- Sub-category hierarchy: parent_id NULL = top-level category.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS show_in_menu INTEGER NOT NULL DEFAULT 1;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS show_on_homepage INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS id_check_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE categories ADD COLUMN IF NOT EXISTS id_check_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
-- Gift-card currency lock (2026-09-30): vouchers keep their face-value currency.
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE products ADD COLUMN IF NOT EXISTS voucher_currency TEXT NOT NULL DEFAULT 'INR';
-- Per-currency pricing (2026-09-30): optional USD prices, NULL = auto-convert from INR.
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_usd REAL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_usd REAL;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE banners ADD COLUMN IF NOT EXISTS placement TEXT DEFAULT 'hero';
ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
ALTER TABLE product_checkout_attributes ADD COLUMN IF NOT EXISTS options TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_usd_reseller REAL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS price_usd REAL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS price_usd_reseller REAL;
-- Gold/Silver reseller tiers (2026-10-05): per-tier prices, NULL = fall back
-- (gold -> silver -> regular).
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_gold REAL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_silver REAL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_usd_gold REAL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_usd_silver REAL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS price_gold REAL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS price_silver REAL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS price_usd_gold REAL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS price_usd_silver REAL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','gold','silver','customer'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','silver','customer'));
-- Paid reseller memberships (2026-10-06): silver/gold packages with expiry.
ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_expires_at TIMESTAMP;
ALTER TABLE membership_purchases DROP CONSTRAINT IF EXISTS membership_purchases_tier_check;
ALTER TABLE membership_purchases ADD CONSTRAINT membership_purchases_tier_check CHECK (tier IN ('silver'));
-- Card chip image override (2026-10-01): custom image shown in the listing-card chip circle.
ALTER TABLE products ADD COLUMN IF NOT EXISTS chip_image_url TEXT;
-- Card chip custom text (2026-10-01): shown in the chip circle when no chip image is set.
ALTER TABLE products ADD COLUMN IF NOT EXISTS chip_text TEXT;
-- Per-product currency availability (2026-09-30): 1 = sellable in that currency.
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_inr INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_usd INTEGER NOT NULL DEFAULT 1;
-- Order currency: 'INR' or 'USD' — totals stored in this currency.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;

-- XtraGateway payment columns (idempotent for existing DBs).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xtra_order_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xtra_payment_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xtra_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xtra_utr TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_mobile TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_email TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_age INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_agreed INTEGER NOT NULL DEFAULT 0;

-- CryptoPay (USDT) payment columns (idempotent for existing DBs).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_order_ref TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_checkout_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_exact_amount TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_tx_hash TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_chain TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS divinex_payment_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS divinex_wallet TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS divinex_expires_at BIGINT;

-- Topzy auto-fulfilment columns (idempotent for existing DBs).
ALTER TABLE products ADD COLUMN IF NOT EXISTS topzy_pack_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS topzy_auto_fulfil INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS topzy_order_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS topzy_status TEXT;

-- Busan auto-fulfilment columns (idempotent for existing DBs).
ALTER TABLE products ADD COLUMN IF NOT EXISTS busan_product_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS busan_auto_fulfil INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS how_to_order_text TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS how_to_order_image TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS busan_product_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS busan_order_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS busan_status TEXT;

-- Topzy price-sync columns + history (idempotent for existing DBs).
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price REAL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin_value REAL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin_type_reseller TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin_value_reseller REAL;

-- Wallet + gift-card vouchers (idempotent for existing DBs).
-- NOTE: the wallet balance reuses the existing users.balance column.
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_voucher INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS voucher_amount REAL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wallet_applied REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_shortage INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON reseller_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON reseller_api_keys(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_user_product ON reviews (user_id, product_id);
CREATE INDEX IF NOT EXISTS order_updates_order_id ON order_updates (order_id);
CREATE INDEX IF NOT EXISTS pca_product_id ON product_checkout_attributes (product_id);
CREATE INDEX IF NOT EXISTS pv_product_id ON product_variants (product_id);
CREATE INDEX IF NOT EXISTS wt_user_id ON wallet_transactions (user_id);
CREATE INDEX IF NOT EXISTS vouchers_code ON vouchers (code);
CREATE INDEX IF NOT EXISTS vouchers_status ON vouchers (status);
CREATE INDEX IF NOT EXISTS ov_order_id ON order_vouchers (order_id);
CREATE INDEX IF NOT EXISTS st_user_id ON support_threads (user_id);
CREATE INDEX IF NOT EXISTS st_guest_token ON support_threads (guest_token);
CREATE INDEX IF NOT EXISTS sm_thread_id ON support_messages (thread_id);
-- Rebrand: GameRefill -> Meowji Official (only touches the default value).
UPDATE settings SET value = 'Meowji Official' WHERE key = 'site_name' AND value = 'GameRefill';
-- Migrate existing reseller prices into the gold tier.
UPDATE products SET price_gold = price_reseller WHERE price_gold IS NULL AND price_reseller IS NOT NULL;
UPDATE products SET price_usd_gold = price_usd_reseller WHERE price_usd_gold IS NULL AND price_usd_reseller IS NOT NULL;
UPDATE product_variants SET price_gold = price_reseller WHERE price_gold IS NULL AND price_reseller IS NOT NULL;
UPDATE product_variants SET price_usd_gold = price_usd_reseller WHERE price_usd_gold IS NULL AND price_usd_reseller IS NOT NULL;
-- Migrate roles: reseller -> gold, user -> customer.
-- (Drop the old role CHECK first, whatever its auto-generated name is,
--  so the new values are accepted.)
DO $$
DECLARE cname TEXT;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'users'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%role%IN%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', cname);
  END IF;
END $$;
UPDATE users SET role = 'gold' WHERE role = 'reseller';
UPDATE users SET role = 'customer' WHERE role = 'user';
-- Remove Gold reseller tier entirely (2026-10-07): every gold account becomes silver.
UPDATE users SET role = 'silver' WHERE role = 'gold';
-- Remove Gold tier data (2026-10-07): runs after the table exists.
UPDATE membership_purchases SET tier = 'silver' WHERE tier = 'gold';

-- Default product artwork (idempotent; only fills blanks so admin uploads win).
UPDATE products SET image_url = '/img/products/youtube-premium-1-year.gif' WHERE slug = 'youtube-premium-1-year' AND (image_url IS NULL OR image_url = '');
UPDATE products SET image_url = '/img/products/spotify-premium-1-year.gif' WHERE slug = 'spotify-premium-1-year' AND (image_url IS NULL OR image_url = '');
UPDATE products SET image_url = '/img/products/apple-music-6-months.gif' WHERE slug = 'apple-music-6-months' AND (image_url IS NULL OR image_url = '');
UPDATE products SET image_url = '/img/products/netflix-1-month.gif' WHERE slug = 'netflix-1-month' AND (image_url IS NULL OR image_url = '');
UPDATE products SET image_url = '/img/products/chatgpt-plus-1-month.gif' WHERE slug = 'chatgpt-plus-1-month' AND (image_url IS NULL OR image_url = '');
UPDATE products SET image_url = '/img/products/google-gemini-18-months.gif' WHERE slug = 'google-gemini-18-months' AND (image_url IS NULL OR image_url = '');

`;

// Rewrite SQLite-isms to Postgres before converting placeholders.
function rewriteForPg(sql) {
  let s = sql;
  // Seed uses INSERT OR IGNORE for idempotent settings.
  s = s.replace(
    /INSERT OR IGNORE INTO settings \(key, value\) VALUES \(\?, \?\)/i,
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING'
  );
  // Seed/backfill use INSERT OR IGNORE for idempotent posts.
  s = s.replace(
    /INSERT OR IGNORE INTO posts \(slug, title, excerpt, body, published\) VALUES \(\?, \?, \?, \?, 1\)/i,
    'INSERT INTO posts (slug, title, excerpt, body, published) VALUES (?, ?, ?, ?, 1) ON CONFLICT (slug) DO NOTHING'
  );
  // SQLite LIKE is case-insensitive for ASCII; Postgres LIKE is not — use ILIKE.
  s = s.replace(/\bLIKE\b/gi, 'ILIKE');
  // items is a TEXT column holding a JSON array; Postgres needs the cast.
  s = s.replace(/json_array_length\(items\)/gi, 'json_array_length(items::json)');
  return s;
}

// Convert ? placeholders to $1, $2, ... (no ? appears in string literals here).
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

class PgStatement {
  constructor(pool, sql) {
    const rewritten = rewriteForPg(sql);
    this.pool = pool;
    // Only the settings upsert lacks an id column; everything else INSERTed gets RETURNING id.
    this.isInsert = /^\s*insert\s+into\s+(?!settings\b)/i.test(rewritten);
    let finalSql = toPgPlaceholders(rewritten);
    if (this.isInsert && !/\breturning\b/i.test(rewritten)) {
      finalSql += ' RETURNING id';
    }
    this.sql = finalSql;
  }
  async get(...params) {
    const res = await this.pool.query(this.sql, params);
    return res.rows[0] || null;
  }
  async all(...params) {
    const res = await this.pool.query(this.sql, params);
    return res.rows;
  }
  async run(...params) {
    const res = await this.pool.query(this.sql, params);
    const lastInsertRowid = this.isInsert && res.rows[0] ? res.rows[0].id : undefined;
    return { lastInsertRowid, changes: res.rowCount };
  }
}

class PgDb {
  constructor(pool) {
    this.pool = pool;
    this.backend = 'postgres';
  }
  prepare(sql) {
    return new PgStatement(this.pool, sql);
  }
  async close() {
    await this.pool.end();
  }
}

async function initPg() {
  // Neon requires SSL; rejectUnauthorized:false matches Neon's pooled endpoints.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  // No parameters -> simple query protocol, so the multi-statement schema runs in one go.
  await pool.query(PG_SCHEMA);
  // Blog posts: per-slug idempotent — new posts are picked up, admin posts never touched.
  const BLOG_SEED_POSTS = require('./blog-seed-posts');
  for (const p of BLOG_SEED_POSTS) {
    await pool.query(
      'INSERT INTO posts (slug, title, excerpt, body, published) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (slug) DO NOTHING',
      [p.slug, p.title, p.excerpt, p.body]
    );
  }
  // Upgrade the 3 launch posts with interlinks — only when never edited (no internal links yet).
  for (const p of BLOG_SEED_POSTS.filter((x) => LEGACY_POST_SLUGS.has(x.slug))) {
    await pool.query(
      "UPDATE posts SET title = $1, excerpt = $2, body = $3 WHERE slug = $4 AND body NOT LIKE '%/post.html?slug=%'",
      [p.title, p.excerpt, p.body, p.slug]
    );
  }
  return new PgDb(pool);
}

module.exports = { initPg, PgStatement, rewriteForPg, toPgPlaceholders };
