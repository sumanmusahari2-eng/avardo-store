// Cloudflare Turnstile ("I'm not a robot") verification.
// Env:
//   TURNSTILE_SECRET_KEY  secret key from Cloudflare dashboard (required to enable)
//   TURNSTILE_SITE_KEY     site key, exposed to the frontend via /api/auth/turnstile-config
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
const SECRET = () => (process.env.TURNSTILE_SECRET_KEY || '').trim();

function turnstileEnabled() {
  return !!SECRET();
}

async function verifyTurnstile(token, remoteIp) {
  if (!turnstileEnabled()) return { ok: true, skipped: true };
  if (typeof token !== 'string' || !token) {
    return { ok: false, error: 'Please complete the "I\'m not a robot" check.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const body = new URLSearchParams({ secret: SECRET(), response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (data && data.success) return { ok: true };
    const codes = data && Array.isArray(data['error-codes']) ? data['error-codes'].join(',') : 'unknown';
    console.error('[turnstile] verification failed:', codes);
    return { ok: false, error: 'Robot check failed. Please try again.' };
  } catch (e) {
    console.error('[turnstile] siteverify request failed:', e.message);
    // Fail open on Cloudflare outage so legit users aren't locked out;
    // the failure is logged for review.
    return { ok: true, skipped: true, outage: true };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { turnstileEnabled, verifyTurnstile };
