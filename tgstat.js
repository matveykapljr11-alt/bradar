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
const TOKEN = process.env.TGSTAT_TOKEN || process.env.TGSTAT_API_KEY || '';
const BASE = process.env.TGSTAT_BASE || 'https://api.tgstat.ru';

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
  let items;
  try { items = rowsOf(await api('/channels/search', { q: q.slice(0, 60), peer_type: 'channel', limit: 8 })); }
  catch (e) { return null; }
  return bestMatch(items, title, subs);
}

/** Attach resolved username/link to a list of channels in place (best-effort, parallel). */
async function enrichLinks(channels) {
  if (!enabled() || !Array.isArray(channels) || !channels.length) return channels;
  await Promise.all(channels.map(async c => {
    try {
      const r = await resolveUsername(c.name, c.subs);
      if (r) { c.username = r.username; c.handle = '@' + r.username; c.link = r.link; c.resolved = true; }
    } catch (e) {}
  }));
  return channels;
}

module.exports = { enabled, resolveUsername, enrichLinks, bestMatch };
