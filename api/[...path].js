// Vercel serverless entry for /api/* (catch-all). Reuses the always-on server's
// request handler; the mini-app page itself is served statically from public/.
module.exports = require('../server').handler;
