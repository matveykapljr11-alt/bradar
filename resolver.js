'use strict';
/* ============================================================================
 * Channel contact resolver — turns a Telemetr channel (title + subs, NO username)
 * into a real Telegram @username + advertising contact, WITHOUT a userbot/phone.
 *
 *   Telemetr {title, subs}
 *     → Web Search API ("title" site:t.me)        → candidate @usernames from t.me URLs
 *     → Bot API getChat + getChatMemberCount       → verify by title + subscriber match
 *     → pick best (score ≥ threshold, clear lead)  → cache internal_id → @username (30d)
 *     → getChat description/pinned + regex         → public advertising contact
 *
 * All plain HTTPS → runs on Vercel/serverless. Probabilistic (a new/unindexed/
 * private channel just stays unresolved → the UI falls back to "find in Telegram").
 * ENV: TAVILY_API_KEY (or BRAVE_API_KEY) + BOT_TOKEN.
 * ========================================================================== */
const store = require('./store');
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const BRAVE_KEY = process.env.BRAVE_API_KEY || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const RESOLVE_TTL = (Number(process.env.RESOLVE_TTL_DAYS) || 30) * 86400;
const NEG_TTL = (Number(process.env.RESOLVE_NEG_TTL_DAYS) || 3) * 86400;   // retry unresolved sooner
const MAX_CHANNELS = Number(process.env.RESOLVE_MAX) || 6;                 // per подбор (protect quotas)
const MAX_CANDIDATES = Number(process.env.RESOLVE_CANDIDATES) || 4;        // Bot API checks per channel
const ACCEPT = Number(process.env.RESOLVE_ACCEPT) || 0.82;                 // min score to auto-accept
const LEAD = Number(process.env.RESOLVE_LEAD) || 0.12;                     // min gap to #2 (avoid homonyms)

function searchEnabled() { return !!TAVILY_KEY || !!BRAVE_KEY; }
function enabled() { return !!BOT_TOKEN && searchEnabled(); }
async function cacheGet(k) { try { return await store.cacheGet(k); } catch (e) { return null; } }
async function cacheSet(k, v, ttl) { try { await store.cacheSet(k, v, ttl); } catch (e) {} }

/* ---------------------------------------------------------------- pure helpers (unit-tested) */
// strip emoji/decorative unicode, punctuation, and one-sided decorator words, for fair comparison.
// (token-filter, not a \b-regex — JS \b doesn't handle Cyrillic word boundaries)
const NORM_STOP = new Set(['канал', 'news', 'новости', 'онлайн', 'online', 'телеграм', 'telegram', 'чат', 'chat', 'group', 'групп', 'группа', 'live']);
function normTitle(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[^a-zа-я0-9 ]+/g, ' ')
    .split(/\s+/).filter(w => w && !NORM_STOP.has(w) && !/^официальн/.test(w))
    .join(' ').trim();
}
// token-overlap similarity of two titles, 0..1
function titleSim(a, b) {
  const A = new Set(normTitle(a).split(' ').filter(Boolean));
  const B = new Set(normTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
  return inter / Math.max(A.size, B.size);
}
// subscriber-count closeness, 0..1 (Telemetr vs Telegram may differ a bit → tolerant)
function subsSim(a, b) {
  a = Number(a) || 0; b = Number(b) || 0;
  if (a <= 0 || b <= 0) return 0;
  const diff = Math.abs(a - b) / Math.max(a, b);
  return Math.max(0, 1 - diff);
}
// pull channel @usernames out of t.me URLs; skip invites/private/system paths
function usernamesFromUrls(urls) {
  const out = [], seen = new Set();
  const SKIP = /^(s|c|joinchat|share|proxy|iv|addstickers|addemoji|setlanguage|bg|login|contact)$/i;
  for (const u of urls || []) {
    const m = String(u).match(/(?:t\.me|telegram\.me)\/(?:s\/)?(\+?@?[a-zA-Z0-9_]{4,32})/);
    if (!m) continue;
    const name = m[1].replace(/^@/, '');
    if (name.startsWith('+') || SKIP.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, MAX_CANDIDATES);
}
// advertising contact from description + pinned text: a @username / t.me / email, preferring one
// sitting next to an "ad" keyword and never the channel's own handle
const AD_KW = /(реклам|сотруднич|по\s*вопрос|по\s*размещ|менеджер|\bадмин|размещен|прайс|\bпо\s*рекл|\bpr\b|\bads?\b|commercial|marketing|бронир|заказать\s*реклам|для\s*связи|связаться|contact)/i;
function extractAdContact(text, ownUsername) {
  if (!text) return '';
  const own = String(ownUsername || '').replace(/^@/, '').toLowerCase();
  const re = /(@[a-zA-Z0-9_]{4,32})|(?:t\.me\/)([a-zA-Z0-9_]{4,32})|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    const val = m[1] || (m[2] ? '@' + m[2] : null) || m[3];
    if (!val) continue;
    const bare = val.replace(/^@/, '').toLowerCase();
    if (bare === own && !val.includes('@' + own + '.') && val.indexOf('@') === 0) continue;   // skip own handle (but keep emails)
    const near = AD_KW.test(text.slice(Math.max(0, m.index - 50), m.index)) || AD_KW.test(text.slice(m.index, m.index + 40));
    found.push({ val, near });
  }
  if (!found.length) return '';
  const nearOne = found.find(f => f.near);
  return (nearOne || found[0]).val;
}

/* ---------------------------------------------------------------- search providers */
async function searchTavily(query) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TAVILY_KEY },
    body: JSON.stringify({ query, include_domains: ['t.me'], max_results: 8, search_depth: 'basic' }),
    signal: AbortSignal.timeout(Number(process.env.RESOLVE_TIMEOUT_MS) || 8000),
  });
  if (!r.ok) throw new Error('tavily ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const d = await r.json();
  return (d.results || []).map(x => x && x.url).filter(Boolean);
}
async function searchBrave(query) {
  const url = 'https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(query);
  const r = await fetch(url, {
    headers: { 'x-subscription-token': BRAVE_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.RESOLVE_TIMEOUT_MS) || 8000),
  });
  if (!r.ok) throw new Error('brave ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const d = await r.json();
  return (((d.web && d.web.results) || [])).map(x => x && x.url).filter(Boolean);
}
async function searchCandidates(title) {
  const q = '"' + title + '" site:t.me';
  let urls = [];
  try { urls = TAVILY_KEY ? await searchTavily(q) : await searchBrave(q); }
  catch (e) { if (BRAVE_KEY && TAVILY_KEY) { try { urls = await searchBrave(q); } catch (e2) {} } else throw e; }
  return usernamesFromUrls(urls);
}

/* ---------------------------------------------------------------- Telegram Bot API (no membership needed for public @usernames) */
async function tg(method, params) {
  const url = new URL('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  const d = await r.json().catch(() => ({}));
  if (!d || !d.ok) throw new Error(method + ' ' + ((d && d.description) || r.status));
  return d.result;
}

/* ---------------------------------------------------------------- resolve one channel */
async function resolveOne(ch, dbg) {
  const title = ch.name || ch.title || '';
  const subs = Number(ch.subs) || 0;
  const iid = ch.internalId || ch.id || '';
  if (!enabled() || String(title).trim().length < 3) return null;
  const ck = 'resolve:' + String(iid || title).toLowerCase().slice(0, 60);
  const cached = await cacheGet(ck);
  if (cached !== null && cached !== undefined) return cached || null;   // false = confirmed unresolved (cached)
  let result = null, scored = [];
  try {
    const cands = await searchCandidates(title);
    for (const u of cands) {
      let chat = null;
      try { chat = await tg('getChat', { chat_id: '@' + u }); } catch (e) { continue; }
      if (!chat) continue;
      let cnt = 0; try { cnt = await tg('getChatMemberCount', { chat_id: '@' + u }); } catch (e) {}
      const ts = titleSim(title, chat.title || '');
      const ss = (subs > 0 && cnt > 0) ? subsSim(subs, cnt) : 0;
      const score = (subs > 0 && cnt > 0) ? (0.55 * ts + 0.45 * ss) : ts;   // no count → title only
      scored.push({ u, chat, cnt, ts: +ts.toFixed(2), ss: +ss.toFixed(2), score: +score.toFixed(3) });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0], second = scored[1];
    if (best && best.score >= ACCEPT && (!second || best.score - second.score >= LEAD)) {
      const pin = best.chat.pinned_message && (best.chat.pinned_message.text || best.chat.pinned_message.caption);
      const blob = String(best.chat.description || '') + ' \n ' + String(pin || '');
      result = {
        username: best.u, link: 'https://t.me/' + best.u,
        adContact: extractAdContact(blob, best.u),
        confidence: best.score, source: TAVILY_KEY ? 'tavily+botapi' : 'brave+botapi',
      };
    }
  } catch (e) { if (dbg) dbg.err = String(e.message || e); }
  if (dbg) { dbg.title = title; dbg.subs = subs; dbg.scored = scored.map(s => s.u + '(' + s.score + ' t' + s.ts + '/s' + s.ss + ')'); }
  await cacheSet(ck, result || false, result ? RESOLVE_TTL : NEG_TTL);
  return result;
}

/* ---------------------------------------------------------------- enrich a shortlist in place */
async function enrichChannels(channels, trace) {
  if (!enabled() || !Array.isArray(channels) || !channels.length) return channels;
  const targets = channels.filter(c => !c.username).slice(0, MAX_CHANNELS);   // skip ones that already carry a @username
  const dbgs = [];
  await Promise.all(targets.map(async c => {
    const dbg = {}; dbgs.push(dbg);
    try {
      const r = await resolveOne({ name: c.name, subs: c.subs, internalId: String(c.id || '').replace(/^tm/, '') }, dbg);
      dbg.name = c.name; dbg.ok = !!r;
      if (r) {
        c.username = r.username; c.handle = '@' + r.username; c.link = r.link; c.resolved = true;
        c.contactConfidence = r.confidence;
        if (r.adContact) c.adContact = r.adContact;
      }
    } catch (e) { dbg.err = String(e.message || e); }
  }));
  if (trace) trace.push({ stage: 'resolve', tried: targets.length, resolved: channels.filter(c => c.resolved).length, detail: dbgs.slice(0, 8) });
  return channels;
}

module.exports = {
  enabled, searchEnabled, resolveOne, enrichChannels,
  normTitle, titleSim, subsSim, usernamesFromUrls, extractAdContact,   // exported for tests
};
