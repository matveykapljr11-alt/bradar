'use strict';
/* ============================================================================
 * TGStat Stat API adapter — resolves a channel's REAL @username / t.me link.
 *   https://api.tgstat.ru   auth: query param `token`
 * Telemetr (free) gives rich metrics but no usernames; TGStat channels/search
 * returns username + link + participants. We call it only for the final shortlist
 * (a few requests per подбор), matching by title + subscriber proximity, so a
 * channel in the plan becomes clickable/contactable. Best-effort: any failure
 * just leaves the existing "find in Telegram" fallback.
 * ========================================================================== */
const store = require('./store');
const TOKEN = process.env.TGSTAT_TOKEN || process.env.TGSTAT_API_KEY || '';
const BASE = process.env.TGSTAT_BASE || 'https://api.tgstat.ru';
async function cacheGet(k) { try { return await store.cacheGet(k); } catch (e) { return null; } }
async function cacheSet(k, v, ttl) { try { await store.cacheSet(k, v, ttl); } catch (e) {} }

function enabled() { return !!TOKEN; }
function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim(); }

async function api(path, params) {
  const url = new URL(BASE + path);
  url.searchParams.set('token', TOKEN);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  const res = await fetch(url, { signal: AbortSignal.timeout(Number(process.env.TGSTAT_TIMEOUT_MS) || 6000) });
  if (!res.ok) throw new Error('tgstat ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return res.json();
}
function rowsOf(data) { const r = data && data.response; return (r && (r.items || r.channels)) || (Array.isArray(r) ? r : []); }

/** Pure: pick the best-matching channel from search results by title (+ subs
 *  proximity). Returns { username, link, subs } or null. Unit-tested. */
function bestMatch(items, title, subs) {
  const want = norm(title);
  if (!want || !Array.isArray(items)) return null;
  let best = null, bestScore = -1;
  for (const it of items) {
    const u = String(it.username || '').replace(/^@/, '');
    if (u.length < 3) continue;
    const t = norm(it.title);
    let score;
    if (t === want) score = 3;
    else if (t && (t.startsWith(want) || want.startsWith(t))) score = 2;
    else if (t && (t.includes(want) || want.includes(t))) score = 1;
    else continue;
    const p = Number(it.participants_count) || 0;
    if (subs > 0 && p > 0) { const ratio = Math.max(p, subs) / Math.min(p, subs); if (ratio <= 1.6) score += 1; else if (ratio > 3) score -= 1; }
    if (score > bestScore) { bestScore = score; best = { username: u, link: 'https://t.me/' + u, subs: p }; }
  }
  return bestScore >= 2 ? best : null;   // require a solid title match, not a loose substring
}

/** Resolve a real @username for a channel identified by (title, subs). Returns
 *  { username, link, subs } or null when no confident match is found. */
async function resolveUsername(title, subs) {
  const q = String(title || '').trim();
  if (q.length < 3) return null;
  // @username never changes → cache 30 days
  const ck = 'uname:' + norm(title).slice(0, 40) + ':' + Math.round((Number(subs) || 0) / 10000);
  const cached = await cacheGet(ck);
  if (cached !== null) return cached || null;   // false = confirmed no-match (cached)
  let items;
  try { items = rowsOf(await api('/channels/search', { q: q.slice(0, 60), peer_type: 'channel', limit: 8 })); }
  catch (e) { return null; }
  const best = bestMatch(items, title, subs);
  await cacheSet(ck, best || false, 30 * 86400);
  return best;
}

/** Search TGStat's catalog (2.8M channels — far deeper than Telemetr for small LOCAL pabliks)
 *  and return normalized rows. Used for city discovery: «Подслушано Троицк» etc. live here even
 *  when Telemetr doesn't track them. Cached 7 days per term. Returns [] on error / disabled. */
async function searchCatalog(term, limit) {
  if (!enabled()) return [];
  const q = String(term || '').trim();
  if (q.length < 2) return [];
  const ck = 'tgsearch:' + norm(q).slice(0, 50) + ':' + (limit || 10);
  const cached = await cacheGet(ck);
  if (Array.isArray(cached)) return cached;
  let items = [];
  try { items = rowsOf(await api('/channels/search', { q: q.slice(0, 60), peer_type: 'channel', limit: limit || 10 })); }
  catch (e) { return []; }
  const out = items.map(it => {
    const u = String(it.username || '').replace(/^@/, '');
    return {
      tgId: it.tg_id || it.id || null, username: u,
      title: it.title || it.channel_name || '', subs: Number(it.participants_count) || 0,
      link: u ? 'https://t.me/' + u : (it.link || ''),
    };
  }).filter(c => c.title && (c.username || c.tgId));
  await cacheSet(ck, out, 7 * 86400);
  return out;
}

/** Text of a channel's last N posts (for competitor / relevance checks). '' on error.
 *  Cached ~12h: posts rotate, but the channel's NATURE (shop vs content) is stable enough
 *  for classification, and this is what saves most of the TGStat quota on repeat channels. */
async function recentPostsText(username, n) {
  if (!username) return '';
  const ck = 'posts:' + String(username).toLowerCase();
  const cached = await cacheGet(ck);
  if (typeof cached === 'string') return cached;
  let txt = '';
  try {
    const data = await api('/channels/posts', { channelId: '@' + username, limit: n || 3, extended: 0 });
    const items = rowsOf(data);
    txt = items.map(p => String((p && (p.text || (p.media && p.media.caption))) || '')).join(' \n ').slice(0, 2500);
  } catch (e) { txt = ''; }
  // channel nature is stable for days — default 3-day TTL (env-tunable), refresh rarely
  if (txt) await cacheSet(ck, txt, (Number(process.env.TGSTAT_POSTS_TTL_H) || 72) * 3600);   // don't cache empty → retry
  return txt;
}
// count "own-store" commerce signals in post text — a shop selling its own goods (a direct
// competitor) reads very differently from a content/media channel where the audience is.
function commerceHits(text) {
  const t = String(text || '').toLowerCase();
  return (t.match(/куп(и|ить|ите)\b|заказать|закажи|оформить заказ|в наличии|в продаже|\bцена\b|стоимост|₽|руб\.|\bр\.\b|скидк|промокод|корзин|артикул|распродаж|каталог|наш магазин|по промокоду|успей купить/g) || []).length;
}
/** Pure: is this channel a shop selling its own goods (competitor), judged by post text? */
function isSellerByPosts(text) { return commerceHits(text) >= 5; }

/** Attach resolved @username/link, a competitor flag, and a brand-RELEVANCE signal — all
 *  from the channel's last 3 posts — to each channel in place. `terms` are the brand's
 *  topic words; relHits counts how many actually appear in what the channel posts. */
async function enrichLinks(channels, terms) {
  if (!enabled() || !Array.isArray(channels) || !channels.length) return channels;
  const T = (terms || []).map(s => String(s).toLowerCase()).filter(x => x.length >= 4).map(x => x.slice(0, 5));
  await Promise.all(channels.map(async c => {
    try {
      // TGStat-sourced local channels already carry a real @username — use it, skip re-resolving.
      let uname = c.username && c.resolved !== false ? String(c.username).replace(/^@/, '') : '';
      if (!uname) {
        const r = await resolveUsername(c.name, c.subs);
        if (!r) return;
        c.username = r.username; c.handle = '@' + r.username; c.link = r.link; c.resolved = true;
        uname = r.username;
      }
      const txt = await recentPostsText(uname, 3);   // last 3 posts → real content, not just the name
      if (txt) {
        const low = txt.toLowerCase();
        c.commerce = commerceHits(low);
        c.competitor = c.commerce >= 5;
        c.relHits = T.length ? T.reduce((n, t) => n + (low.indexOf(t) >= 0 ? 1 : 0), 0) : 0;
        c.hasPosts = true;
      }
    } catch (e) {}
  }));
  return channels;
}

module.exports = { enabled, resolveUsername, enrichLinks, bestMatch, recentPostsText, commerceHits, isSellerByPosts, searchCatalog };
