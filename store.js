'use strict';
/* Tiny JSON-file store, keyed by Telegram user id. No deps.
 * Good enough to be real for a single-node deployment; swap for Postgres later
 * by keeping the same 4 methods. Writes are atomic (tmp file + rename). */
const fs = require('fs');
const path = require('path');

// On serverless (Vercel) the project dir is read-only; use the ephemeral /tmp.
// Durable cross-request storage there needs Vercel KV — see README. Locally this
// is a normal JSON file next to the code.
const DATA_DIR = process.env.BRADAR_DATA_DIR || (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp/bradar-data' : path.join(__dirname, 'data'));
const FILE = path.join(DATA_DIR, 'store.json');

function ensure() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return { users: {} }; }
}
let cache = null;
function db() { if (!cache) cache = readAll(); return cache; }
function flush() {
  // best-effort: an unwritable fs (read-only serverless) must not crash a request
  try {
    ensure();
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db()));
    fs.renameSync(tmp, FILE);
  } catch (e) { /* in-memory only for this instance */ }
}
function userRec(uid) {
  const d = db();
  if (!d.users[uid]) d.users[uid] = { plans: [], favs: [], grants: {} };
  if (!d.users[uid].grants) d.users[uid].grants = {};
  return d.users[uid];
}

module.exports = {
  getState(uid) { const u = userRec(uid); return { plans: u.plans, favs: u.favs }; },

  savePlan(uid, plan) {
    const u = userRec(uid);
    const rec = Object.assign({}, plan);
    if (!rec.id) rec.id = 'p' + Date.now();
    const i = u.plans.findIndex(p => p.id === rec.id);
    if (i >= 0) u.plans[i] = rec; else u.plans.unshift(rec);
    // keep it bounded
    u.plans = u.plans.slice(0, 100);
    flush();
    return rec;
  },
  deletePlan(uid, id) {
    const u = userRec(uid);
    u.plans = u.plans.filter(p => p.id !== id);
    flush();
    return { ok: true };
  },
  setFavs(uid, favs) {
    const u = userRec(uid);
    u.favs = Array.isArray(favs) ? favs.slice(0, 300) : [];
    flush();
    return { ok: true };
  },

  // ---- Telegram Stars grants ----
  grant(uid, product, until, chargeId) {
    const u = userRec(uid);
    u.grants[product] = { until: until || 0, chargeId: chargeId || null, at: Date.now() };
    flush();
    return u.grants[product];
  },
  getGrants(uid) {
    const u = userRec(uid);
    const now = Date.now();
    const active = {};
    for (const k in u.grants) {
      const g = u.grants[k];
      active[k] = (g.until === 0) || (g.until > now); // 0 = one-time/permanent
    }
    return active;
  },
};
