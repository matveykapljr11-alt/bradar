// Vercel serverless entry — reuses the same request handler as the always-on server.
// vercel.json rewrites every path here; req.url keeps the original path.
module.exports = require('../server').handler;
