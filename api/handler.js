// Vercel serverless entry (referenced by vercel.json). Reuses the always-on
// server's request handler; the mini-app page is served statically from public/.
module.exports = require('../server').handler;
