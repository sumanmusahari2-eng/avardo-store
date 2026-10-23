const bcrypt = require('bcryptjs');

// Seeds defaults on first boot only (when no users exist).
// Settings defaults are inserted idempotently so admin edits are never overwritten.
// Works against both backends (SQLite and Postgres) via the shared statement API.
async function seed(db) {
  const settingDefaults = {
    site_name: process.env.BRAND_NAME || 'Meowji Official',
    whatsapp_number: '+91 93952 49459',
    upi_id: '',
    payment_instructions:
      "Pay the exact order total via UPI to the ID shown above. After paying, tap \"I've paid\" on your order page. If asked, share your payment screenshot on WhatsApp with your order ID. Your top-up, gift card or subscription will be delivered after payment is confirmed.",
    reseller_discount_default: '15',
    support_email: '',
    crypto_usd_rate: '88',
    busan_sync_enabled: '1',
    busan_sync_interval_min: '60',
    busan_margin_type: 'percent',
    busan_margin_value: '15',
    busan_auto_decrease: '0',
    how_to_order_image: '/images/how-to-order.webp',
    busan_last_sync_at: '',
    membership_silver_price: '49',
    membership_duration_days: '30',
    invoice_prefix: 'INV',
    invoice_seller_name: '',
    invoice_seller_address: '',
    invoice_seller_phone: '',
    invoice_seller_email: '',
    invoice_notes: 'Thank you for your purchase.',
  };
  const putSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(settingDefaults)) await putSetting.run(k, v);

  const userCount = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;
  if (userCount > 0) {
    console.log('[seed] users already exist, skipping content seed');
    return;
  }

  const adminHash = bcrypt.hashSync('ChangeMe123!', 12);
  await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
    'Store Admin',
    'admin@avardoofficial.in',
    adminHash
  );

  // Avardo catalogue: MLBB + BGMI top-ups with variants, Busan mappings and
  // checkout ID questions. seedCatalogIfEmpty creates its own categories
  // (Mobile Legends / BGMI) and no-ops when products already exist.
  await require('./avardo-catalog').seedCatalogIfEmpty(db);

  const insertBanner = db.prepare('INSERT INTO banners (title, subtitle, link, sort_order) VALUES (?, ?, ?, ?)');
  await insertBanner.run('MLBB Diamonds — Instant Top-Up', 'Diamonds delivered to your account in seconds, 24×7.', '/product.html?slug=mobile-legends-global', 0);
  await insertBanner.run('Weekly & Twilight Passes', 'Best-value passes for Mobile Legends, delivered fast.', '/product.html?slug=mobile-legends-global', 1);
  await insertBanner.run('Become a reseller', 'Unlock reseller pricing on every top-up pack.', '/register.html', 2);

  const insertT = db.prepare('INSERT INTO testimonials (name, text, rating, sort_order) VALUES (?, ?, ?, ?)');
  await insertT.run('Rahul S.', 'Diamonds credited within a minute of paying. The ID check before payment is reassuring.', 5, 0);
  await insertT.run('Priya M.', 'Weekly pass activated the same evening. Payment was simple via UPI and support replied fast on WhatsApp.', 5, 1);
  await insertT.run('Arjun K.', 'I resell MLBB top-ups through this store. Reseller prices leave me a clean margin on every pack.', 5, 2);

  const insertPost = db.prepare('INSERT OR IGNORE INTO posts (slug, title, excerpt, body, published) VALUES (?, ?, ?, ?, 1)');
  for (const p of require('./blog-seed-posts')) {
    await insertPost.run(p.slug, p.title, p.excerpt, p.body);
  }

  console.log('[seed] database seeded with admin, categories, products, banners, testimonials, posts');
}

module.exports = seed;
