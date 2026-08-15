'use strict';
/* Per-user store, keyed by Telegram user id. Async interface (Promises).
 *
 * Two backends, chosen automatically:
 *   • Upstash Redis (REST) — DURABLE, used whenever UPSTASH_REDIS_REST_URL +
 *     UPSTASH_REDIS_REST_TOKEN (or Vercel's KV_REST_API_URL / KV_REST_API_TOKEN)
 *     are set. This is what makes plans/favs/PRO survive on serverless (Vercel).
 *   • JSON file / in-memory — local dev & self-host. On serverless without Redis
 *     this falls back to ephemeral /tmp (data is NOT durable — dev only).
 *
 * All six methods share the same read-modify-write shape, so swapping the
 * backend is transparent to callers. No third-party deps. */
const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);

/* ---------------- file backend (local dev / self-host) ---------------- */
const DATA_DIR = process.env.BRADAR_DATA_DIR || (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp/bradar-data' : path.join(__dirname, 'data'));
const FILE = path.join(DATA_DIR, 'store.json');
let cache = null;
function fileDb() {
  if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { cache = { users: {} }; } }
  if (!cache.users) cache.users = {};
  return cache;
}
function fileFlush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(fileDb()));
    fs.renameSync(tmp, FILE);
  } catch (e) { /* read-only fs (serverless): in-memory only for this instance */ }
}

/* ---------------- redis backend (Upstash REST) ---------------- */
async function redisCmd(args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error('redis ' + res.status + ' ' + (await res.text()).slice(0, 120));
  return (await res.json()).result;
}
const KEY = uid => 'bradar:user:' + uid;

/* ---------------- unified per-user record ---------------- */
function blankUser() { return { plans: [], favs: [], grants: {} }; }
async function loadUser(uid) {
  if (useRedis) {
    try {
      const v = await redisCmd(['GET', KEY(uid)]);
      const rec = v ? JSON.parse(v) : blankUser();
      if (!rec.plans) rec.plans = []; if (!rec.favs) rec.favs = []; if (!rec.grants) rec.grants = {};
      return rec;
    } catch (e) { return blankUser(); }   // never crash a request on a store blip
  }
  const d = fileDb();
  if (!d.users[uid]) d.users[uid] = blankUser();
  if (!d.users[uid].grants) d.users[uid].grants = {};
  return d.users[uid];
}
async function saveUser(uid, rec) {
  if (useRedis) { try { await redisCmd(['SET', KEY(uid), JSON.stringify(rec)]); } catch (e) {} return; }
  const d = fileDb(); d.users[uid] = rec; fileFlush();
}

module.exports = {
  usingRedis: useRedis,

  async getState(uid) { const u = await loadUser(uid); return { plans: u.plans, favs: u.favs }; },

  async savePlan(uid, plan) {
    const u = await loadUser(uid);
    const rec = Object.assign({}, plan);
    if (!rec.id) rec.id = 'p' + Date.now();
    const i = u.plans.findIndex(p => p.id === rec.id);
    if (i >= 0) u.plans[i] = rec; else u.plans.unshift(rec);
    u.plans = u.plans.slice(0, 100);
    await saveUser(uid, u);
    return rec;
  },
  async deletePlan(uid, id) {
    const u = await loadUser(uid);
    u.plans = u.plans.filter(p => p.id !== id);
    await saveUser(uid, u);
    return { ok: true };
  },
  async setFavs(uid, favs) {
    const u = await loadUser(uid);
    u.favs = Array.isArray(favs) ? favs.slice(0, 300) : [];
    await saveUser(uid, u);
    return { ok: true };
  },

  // ---- Telegram Stars grants ----
  async grant(uid, product, until, chargeId) {
    const u = await loadUser(uid);
    u.grants[product] = { until: until || 0, chargeId: chargeId || null, at: Date.now() };
    await saveUser(uid, u);
    return u.grants[product];
  },
  async getGrants(uid) {
    const u = await loadUser(uid);
    const now = Date.now();
    const active = {};
    for (const k in u.grants) {
      const g = u.grants[k];
      active[k] = (g.until === 0) || (g.until > now); // 0 = one-time / permanent
    }
    return active;
  },
};
