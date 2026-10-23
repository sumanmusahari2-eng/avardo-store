// Vercel serverless entry: runs the Express app as a serverless function.
// The app (and its DB pool) is built once per cold start and reused across
// warm invocations via the cached promise below.
const { buildApp } = require('../app');

let appPromise = null;

module.exports = async (req, res) => {
  try {
    if (!appPromise) {
      appPromise = buildApp().then(({ app }) => app);
      // If boot fails, allow the next invocation to retry instead of
      // permanently caching the rejection.
      appPromise.catch(() => { appPromise = null; });
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    console.error('[vercel] boot failed:', err && err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
};
