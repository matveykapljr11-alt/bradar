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
  if (useRedis) {
    try { await redisCmd(['SET', KEY(uid), JSON.stringify(rec)]); await redisCmd(['SADD', 'bradar:users', String(uid)]); } catch (e) {}
    return;
  }
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

  // ---- generic TTL cache (used to avoid re-hitting TGStat for the same channel) ----
  async cacheGet(key) {
    if (useRedis) { try { const v = await redisCmd(['GET', 'bradar:cache:' + key]); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
    const d = fileDb(); const c = d.cache && d.cache[key];
    if (c && (!c.exp || c.exp > Date.now())) return c.v;
    return null;
  },
  async cacheSet(key, value, ttlSec) {
    if (useRedis) { try { await redisCmd(['SET', 'bradar:cache:' + key, JSON.stringify(value), 'EX', String(ttlSec || 3600)]); } catch (e) {} return; }
    const d = fileDb(); if (!d.cache) d.cache = {}; d.cache[key] = { v: value, exp: Date.now() + (ttlSec || 3600) * 1000 }; fileFlush();
  },

  // atomic-ish counter for rate limiting. Returns the new count. Fails OPEN (returns 0) on any
  // store error so a Redis hiccup never locks users out. Redis path uses INCR (+EXPIRE on first).
  async bump(key, ttlSec) {
    if (useRedis) {
      try { const n = Number(await redisCmd(['INCR', 'bradar:rl:' + key])) || 0; if (n === 1) { try { await redisCmd(['EXPIRE', 'bradar:rl:' + key, String(ttlSec || 3600)]); } catch (e) {} } return n; }
      catch (e) { return 0; }
    }
    const d = fileDb(); if (!d.rl) d.rl = {}; const now = Date.now(); const e = d.rl[key];
    if (!e || e.exp <= now) d.rl[key] = { n: 1, exp: now + (ttlSec || 3600) * 1000 }; else e.n++;
    fileFlush(); return d.rl[key].n;
  },

  // ---- request log (admin analytics) ----
  // Append one analyze record for the admin dashboard. Best-effort: never throws into a request.
  // Keeps the newest LOG_KEEP (default 500) records + lifetime/day counters.
  async logRequest(rec) {
    const r = Object.assign({ ts: Date.now() }, rec || {});
    const keep = Number(process.env.LOG_KEEP) || 500;
    const day = new Date(r.ts).toISOString().slice(0, 10).replace(/-/g, '');
    if (useRedis) {
      try {
        await redisCmd(['LPUSH', 'bradar:log', JSON.stringify(r)]);
        await redisCmd(['LTRIM', 'bradar:log', '0', String(keep - 1)]);
        await redisCmd(['INCR', 'bradar:stat:total']);
        if (r.uid) await redisCmd(['SADD', 'bradar:users', String(r.uid)]);   // count everyone who ran a подбор
        const dk = 'bradar:stat:day:' + day; await redisCmd(['INCR', dk]); try { await redisCmd(['EXPIRE', dk, '5184000']); } catch (e) {}
      } catch (e) {}
      return;
    }
    const d = fileDb(); if (!d.log) d.log = []; d.log.unshift(r); d.log = d.log.slice(0, keep);
    if (r.uid && !d.users[r.uid]) d.users[r.uid] = blankUser();   // register the user for the total count
    if (!d.stat) d.stat = { total: 0, day: {} }; d.stat.total = (d.stat.total || 0) + 1; d.stat.day[day] = (d.stat.day[day] || 0) + 1;
    fileFlush();
  },
  // newest-first analyze records (full detail), capped.
  async recentRequests(limit) {
    const n = Math.min(Number(limit) || 200, Number(process.env.LOG_KEEP) || 500);
    if (useRedis) {
      try { const rows = (await redisCmd(['LRANGE', 'bradar:log', '0', String(n - 1)])) || []; return rows.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean); }
      catch (e) { return []; }
    }
    return (fileDb().log || []).slice(0, n);
  },
  // aggregate metrics derived from the log window + lifetime counter.
  async requestStats() {
    const recent = await this.recentRequests(Number(process.env.LOG_KEEP) || 500);
    const now = Date.now(), DAY = 86400000, todayStr = new Date(now).toISOString().slice(0, 10);
    const u24 = new Set(), u7 = new Set(); let empty = 0, chSum = 0, chN = 0, today = 0, aiErr = 0;
    recent.forEach(r => {
      const t = r.ts || 0;
      if (r.uid && now - t <= DAY) u24.add(r.uid);
      if (r.uid && now - t <= 7 * DAY) u7.add(r.uid);
      if ((r.count || 0) === 0) empty++;
      if (typeof r.count === 'number') { chSum += r.count; chN++; }
      if (r.aiError) aiErr++;
      if (new Date(t).toISOString().slice(0, 10) === todayStr) today++;
    });
    let total = recent.length;
    if (useRedis) { try { const v = await redisCmd(['GET', 'bradar:stat:total']); if (v != null) total = Number(v) || total; } catch (e) {} }
    else { const s = fileDb().stat; if (s && s.total) total = s.total; }
    return { total, today, active24h: u24.size, active7d: u7.size, empty, emptyRate: recent.length ? Math.round(empty / recent.length * 100) : 0, aiErrRate: recent.length ? Math.round(aiErr / recent.length * 100) : 0, avgChannels: chN ? Math.round(chSum / chN * 10) / 10 : 0, window: recent.length };
  },

  // ---- admin aggregate (for the dashboard) ----
  async adminStats() {
    let ids = [];
    if (useRedis) { try { ids = (await redisCmd(['SMEMBERS', 'bradar:users'])) || []; } catch (e) { ids = []; } }
    else { ids = Object.keys(fileDb().users); }
    ids = ids.slice(0, 2000);
    const now = Date.now();
    let plans = 0, favs = 0, activeUsers = 0;
    const pro = {}, recent = [];
    for (const uid of ids) {
      const u = await loadUser(uid);
      const np = (u.plans || []).length, nf = (u.favs || []).length;
      plans += np; favs += nf;
      if (np || nf) activeUsers++;
      for (const k in (u.grants || {})) { const g = u.grants[k]; if (g && ((g.until === 0) || (g.until > now))) pro[k] = (pro[k] || 0) + 1; }
      (u.plans || []).slice(0, 3).forEach(p => recent.push({ uid: String(uid).slice(0, 14), brand: p.brand || '—', date: p.date || 0, budget: p.budget || 0, count: Array.isArray(p.channels) ? p.channels.length : 0 }));
    }
    recent.sort((a, b) => (b.date || 0) - (a.date || 0));
    return { users: ids.length, activeUsers, plans, favs, pro, recent: recent.slice(0, 25), storage: useRedis ? 'redis' : 'file', at: now };
  },
};
