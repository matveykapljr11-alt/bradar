// Vercel serverless entry for /api/* and /health. Reuses the always-on server's
// request handler; the mini-app page itself is served statically from public/.
module.exports = require('../server').handler;
