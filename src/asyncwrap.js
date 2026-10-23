// Express 4 does not forward rejections from async route handlers to the error
// middleware — they become unhandled promise rejections. This wraps a Router's
// methods so async handlers fail safely into next(err).
function wrapAsyncRouter(router) {
  for (const method of ['get', 'post', 'put', 'delete', 'patch', 'use']) {
    const original = router[method].bind(router);
    router[method] = function (path, ...handlers) {
      const wrapped = handlers.map((h) => {
        if (typeof h !== 'function' || h.length === 4) return h; // skip error middleware
        return (req, res, next) => {
          Promise.resolve(h(req, res, next)).catch(next);
        };
      });
      return original(path, ...wrapped);
    };
  }
  return router;
}

module.exports = { wrapAsyncRouter };
