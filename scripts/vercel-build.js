// Vercel build step:
// 1. Initialize the database schema (so cold starts are fast).
// 2. Apply white-label branding to static HTML files (Vercel serves
//    public/ directly, bypassing the runtime branded middleware).
(async () => {
  const { initDb } = require('../src/db');
  const seed = require('../src/seed');
  const db = await initDb();
  await seed(db);
  console.log('[vercel-build] db ready');

  // Build-time branding for static files
  const fs = require('fs');
  const path = require('path');
  const brandName = (process.env.BRAND_NAME || 'Avardo Official').trim();
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://www.mlbbstore.in').trim();
  let effectiveBrand = brandName; if (effectiveBrand === 'Avardo') effectiveBrand = 'Avardo Official';
  const brandDomain = baseUrl.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  
  if (effectiveBrand !== 'Avardo Official' || brandDomain !== 'www.mlbbstore.in') {
    const publicDir = path.join(__dirname, '..', 'public');
    const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
    let count = 0;
    for (const file of files) {
      const fp = path.join(publicDir, file);
      let content = fs.readFileSync(fp, 'utf8');
      const orig = content;
      content = content.split('Avardo Official').join(effectiveBrand);
      content = content.split('www.mlbbstore.in').join(brandDomain);
      // Also replace bare domain (but not as part of www.)
      content = content.split('mlbbstore.in').join(brandDomain);
      if (content !== orig) {
        fs.writeFileSync(fp, content);
        count++;
      }
    }
    console.log(`[vercel-build] branded ${count} HTML files as "${effectiveBrand}"`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('[vercel-build] failed:', e.message);
  process.exit(1);
});
