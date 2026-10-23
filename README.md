# GameRefill

A full-stack e-commerce web app for selling digital subscriptions and premium services
(YouTube Premium, Spotify, Apple Music, Netflix, ChatGPT Plus, Google Gemini, …).

**Stack:** Node.js + Express · dual database: SQLite (`better-sqlite3`) for local dev,
PostgreSQL (`pg`) for production · JWT auth in httpOnly cookies ·
`bcryptjs` password hashing · Vanilla JS + Tailwind CDN frontend (no build step).

**Roles:** `admin` (full control) · `reseller` (discounted prices + dashboard) · `user` (shop + orders).

---

## Quick start

```bash
cd gamerefill
cp .env.example .env
# edit .env and set JWT_SECRET (generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm install
npm start
# open http://localhost:3000
```

On first boot the app creates the database and seeds it:
categories, 6 products, 3 banners, 3 testimonials, default settings, and one admin account.

### Database: SQLite locally, Postgres in production

- **Local dev (default):** leave `DATABASE_URL` empty — the app uses the SQLite file
  at `DB_PATH` (default `./data/store.db`).
- **Production (Render free tier):** set `DATABASE_URL` to your Postgres connection
  string (e.g. a free [Neon](https://neon.tech) database). The app switches to
  Postgres automatically (SSL on, as Neon requires). Render's free tier has an
  **ephemeral filesystem**, so SQLite would be wiped on every restart — Postgres
  is required for a real shop there.

Both backends expose the same query API; all SQL stays parameterized on both.
See `DEPLOY.md` for the exact free-hosting steps and `TESTING_NOTES.md` for what
was verified on each backend.

### Default credentials (change immediately)

- **Admin:** `admin@meowjiofficial.com` / `ChangeMe123!`
- After logging in, go to **/admin → Users** to change things, and ask the admin to
  reset the password (register a new admin user and delete the seeded one, or update
  the password directly in the DB).

> ⚠️ The seeded password is public knowledge (it's in this repo). Change it before
> exposing the site to the internet.

## How Google login is enabled

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create an **OAuth client ID** of type **Web application**.
3. Under **Authorized JavaScript origins**, add your site origin(s), e.g.
   `http://localhost:3000` for testing and `https://your-domain.com` for production.
   (No redirect URI is needed — the frontend uses the Google Identity Services button
   flow and posts the ID token to the backend.)
4. Set `GOOGLE_CLIENT_ID=<your client id>` in `.env` and restart.
5. The Login/Register pages will now show a "Continue with Google" button.
   If `GOOGLE_CLIENT_ID` is blank, the button is hidden and a friendly notice is shown instead.

The backend verifies the ID token with `google-auth-library` (`verifyIdToken` with your
client ID as audience). Google users are created with role `user`; promote them to
reseller/admin from **/admin → Users**.

## How to set prices

**Option A — Admin dashboard (recommended):** log in as admin → **/admin → Products** →
edit any product: `price_regular` (what normal users pay), `price_reseller`
(what resellers pay), `price_mrp` (optional strikethrough MRP for a discount badge),
`stock_status`, `featured` flag, category, description, image URL.

**Option B — Default reseller discount:** **/admin → Settings** → `reseller_discount_default`
(default 15). This is informational for now — when adding a product, set the reseller
price manually (the seed uses 15% below regular, rounded).

## Order flow (manual UPI payment)

1. Customer adds products to cart → **Checkout** → order created as `pending`.
2. **Order page** shows the UPI ID + WhatsApp number (from **/admin → Settings**),
   the order ID, and payment instructions.
3. Customer taps **"I've paid"** → admin sees a "customer says paid" flag.
4. Admin (**/admin → Orders**) verifies payment and moves `pending → paid`,
   then after delivering credentials moves `paid → delivered` with a delivery note
   (login details / activation instructions). The customer sees the delivery note in
   **My Orders → order detail**.
5. Orders can be `cancelled` from `pending` or `paid`.

Payment gateway integrations (Razorpay/Stripe) are **not** included — the code has
clearly marked stub points in `src/routes/shop.js` (`// TODO: payment gateway webhook`)
if you add one later. Never commit real gateway keys; use environment variables.

## Project layout

```
server.js               Express app, middleware, page routes (async boot: DB init + seed, then listen)
render.yaml             Render Blueprint (free web service)
src/db.js               Backend picker: Postgres when DATABASE_URL is set, else SQLite
src/db-pg.js            Async pg.Pool adapter + Postgres schema + SQLite→Postgres SQL rewrite
src/db-sqlite.js        Async wrapper around better-sqlite3 (local development)
src/asyncwrap.js        Forwards rejected async route handlers to error middleware
src/seed.js              First-boot seed data (admin, products, banners, …; either backend)
src/auth.js              JWT, bcrypt, auth middleware
src/validate.js          Input validators
src/routes/auth.js       register, login, Google OAuth, logout, me
src/routes/public.js     categories, banners, products, testimonials, public settings
src/routes/shop.js       checkout, my orders, mark-paid
src/routes/reseller.js   reseller dashboard summary
src/routes/admin.js      full admin CRUD (products, categories, banners, users,
                         orders, settings, testimonials) + stats
public/                 Frontend (Tailwind CDN, vanilla JS)
data/store.db           SQLite database (local dev only; created on boot; git-ignored)
```

## Security notes

- Passwords hashed with bcrypt (cost 12); JWTs in httpOnly cookies (`Secure` in production).
- `helmet` headers, rate limiting on `/api/*` (600/15 min) and `/api/auth/*` (40/15 min).
- All SQL uses parameterized prepared statements; inputs validated server-side.
- Checkout prices are computed server-side from the DB — the client can never set prices.
- Role guards: `requireAuth`, `requireRole('admin')`, `requireRole('reseller','admin')`.

## Scripts

- `npm start` — run the server
- `npm run seed` — re-run the seed (safe: skips content if users exist)

## License

Private — all rights reserved.
