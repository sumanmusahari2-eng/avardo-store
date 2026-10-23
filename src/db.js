// Database factory: Postgres when DATABASE_URL is set (production on Render +
// Neon), otherwise the local SQLite file (local dev). Both backends expose the
// same async statement API:
//   db.prepare(sql) -> { get(...p): row|null, all(...p): rows[], run(...p): {lastInsertRowid, changes} }
// Backend modules are required lazily so only the needed driver is loaded.
async function initDb(dbPath) {
  if (process.env.DATABASE_URL) {
    console.log('[db] backend: postgres (DATABASE_URL is set)');
    const { initPg } = require('./db-pg');
    return initPg();
  }
  const path = require('path');
  const resolved = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'store.db');
  console.log('[db] backend: sqlite at', resolved);
  const { initSqlite } = require('./db-sqlite');
  return initSqlite(resolved);
}

module.exports = { initDb };
