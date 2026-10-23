# Testing notes — GameRefill (async DB migration)

Date: 2026-09-27. Context: migrated the data layer to an async API supporting
two backends — SQLite (`better-sqlite3`) for local dev and Postgres (`pg`) for
Render free-tier production (ephemeral filesystem).

## SQLite (local dev) — fully runtime-tested ✅

- Fresh boot: `npm install`, wiped `data/`, `PORT=3101 node server.js`
  → `[db] backend: sqlite`, seed ran, server listened. Clean boot, no errors.
- `node --check` passes on all source files (`server.js`, `src/*.js`, `src/routes/*.js`).
- 24 curl checks, all passing on 2026-09-27:
  - Auth: register 201, duplicate email 409, weak password 400, admin login 200
    (`admin@meowjiofficial.com`), wrong password 401.
  - Role guards: normal user → 403 on `/api/admin/*`; anonymous → 401.
  - Admin CRUD: create category 201, create product (id returned), update price 200.
  - Public: product search (`?search=youtube` → 1 result, user price 300),
    public settings 200, homepage 200.
  - Checkout: 2× Netflix (₹80) + 1× YouTube (₹300) → server-computed total ₹460.
    Bad product id → 400. Checkout works anonymous? No — requires login (401).
  - Order flow: `pending → mark-paid (user) → paid (admin) → delivered (admin)`
    with delivery note; invalid `pending → delivered` correctly rejected 400;
    customer can read their delivery note.
  - Reseller: admin promotes user → reseller (200); after re-login the user sees
    reseller price 255 for YouTube Premium; `/api/reseller/summary` 200.
  - Google OAuth: POST `/api/auth/google` with no `GOOGLE_CLIENT_ID` → 503
    (graceful "not configured").
  - SQL injection: `?search=%27%20OR%20%271%27=%271` → 200 with **0 rows** —
    parameterized queries hold on SQLite.
  - Admin stats: correct counts/revenue after the flow (`orders:1, revenue:460`).
- Test database was wiped after the run (`data/` removed); first real boot
  seeds clean.

## Postgres (`pg` adapter) — NOT live-tested ⚠️

No `DATABASE_URL` was available in this task, so nothing below was run against a
real Postgres/Neon instance. Verified by code-level checks only:

- **SQL rewrite tests (mock pool, all assertions passed):** `?` → `$1…$n`,
  `LIKE` → `ILIKE`, `json_array_length(items)` → `json_array_length(items::json)`,
  `INSERT OR IGNORE INTO settings` → `ON CONFLICT (key) DO NOTHING`,
  `INSERT` (non-settings) → `RETURNING id` so `lastInsertRowid` keeps working,
  `UPDATE`/`DELETE` placeholders converted. No stray `?` remain in emitted SQL.
- **Static scan:** no SQLite-only SQL functions (`datetime(`, `strftime(`,
  `AUTOINCREMENT`, `GLOB`) anywhere in app code; all query parameters are
  placeholders in `VALUES`/`WHERE`/`LIKE`/`LIMIT` positions.
- **Schema:** `PG_SCHEMA` in `src/db-pg.js` was written by hand-translating the
  SQLite schema (`TEXT PRIMARY KEY` keys for settings, `SERIAL` ids, `TIMESTAMPTZ`
  defaults, `JSONB` order items with GIN index). It has **not** been executed —
  syntax was reviewed, not machine-checked.
- **Boot path:** `server.js` → `await initDb()` → `await seed(db)` works the
  same for both backends; `db.backend` is exposed for logging (`pg` vs `sqlite`).

**Before going live on Render/Neon, run the app once with a real `DATABASE_URL`
and re-run the curl test pass against it** — especially the seed-on-empty-DB
path, order checkout, and the admin stats queries (e.g. `json_array_length`
with `::json` cast and `ILIKE` search). The render.yaml Blueprint sets
`healthCheckPath: /api/settings/public` so Render will refuse a broken deploy.

## Known pre-deploy items (not code bugs)

- Seeded admin is `admin@meowjiofficial.com` / `ChangeMe123!` — change before launch.
- UPI ID / WhatsApp number are blank in seed settings — fill in Admin → Settings.
- Google login needs a real `GOOGLE_CLIENT_ID`.
- This deployable project is an earlier build than the private working artifact
  `digital-subscriptions-store-2` (which has user blocking, reseller promotion
  UI, 9:16 banners, stock, coupons, reviews, order updates, checkout
  attributes). Do not present the deployed app as containing those features.
