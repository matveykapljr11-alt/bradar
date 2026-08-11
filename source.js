'use strict';
/* ============================================================================
 * Real channel data source — Telemetr.io.
 *   https://api.tlmtr.io   auth: header `api_key`
 * If TELEMETR_API_KEY is set, fetchCandidates() pulls real Telegram channels
 * (with real subscribers / average views / engagement) for the brand and maps
 * them into the engine's channel shape. Ad *prices* aren't public, so CPM is
 * estimated by topic and the plan's price is derived by the engine from budget.
 * On any error we return null and the engine falls back to its seed catalog.
 * ========================================================================== */

const KEY = process.env.TELEMETR_API_KEY || '';
const BASE = process.env.TELEMETR_BASE || 'https://api.tlmtr.io';

function enabled() { return !!KEY; }

// estimated CPM (₽ per 1000 views) by topic — rough RU market; tweak freely
const CPM_BY_TOPIC = { skincare: 560, beauty: 560, fashion: 520, edu: 420, app: 460, b2b: 640, lifestyle: 500, conscious: 480, wellness: 470, news: 680, finance: 700 };
// map a Telemetr category string → our topic (for budget grouping + CPM)
function topicOf(category, vertical) {
  const c = (category || '').toLowerCase();
  if (/beaut|космет|уход|краса/.test(c)) return 'skincare';
  if (/fashion|мода|одежд|стиль/.test(c)) return 'fashion';
  if (/educ|обуч|образов|курс|язык/.test(c)) return 'edu';
  if (/tech|app|прилож|гаджет|it|софт/.test(c)) return 'app';
  if (/business|бизнес|marketing|маркет|финанс|finance/.test(c)) return 'b2b';
  if (/health|wellness|спорт|фитнес|зож|здоров/.test(c)) return 'wellness';
  if (/news|новост/.test(c)) return 'news';
  if (/эко|осознан|conscious/.test(c)) return 'conscious';
  // fall back to the detected vertical's own topic-ish default
  return ({ beauty: 'skincare', fashion: 'fashion', edu: 'edu', app: 'app', b2b: 'b2b' })[vertical] || 'lifestyle';
}

const AVPAL = [['#F3D9DC', '#E8B9C4', '#8A5763'], ['#F6E7CF', '#E9C89A', '#8A6B37'], ['#DCE4F5', '#B9C8E8', '#5A6B90'], ['#D9EFEA', '#AFDCD2', '#3E7A6E'], ['#E3EAF8', '#BFCFEC', '#4F638C'], ['#F0E4F2', '#D3BEDD', '#6E5A82'], ['#E6E0F5', '#C6B6E0', '#645488'], ['#DDEFE6', '#B3D9C4', '#417A5E']];
function avOf(name) { const n = name || '•'; const p = AVPAL[(n.charCodeAt(0) + n.length) % AVPAL.length]; return { l: n[0].toUpperCase(), g: `linear-gradient(140deg,${p[0]},${p[1]})`, c: p[2] }; }

function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function pick(o, keys) { for (const k of keys) if (o && o[k] != null) return o[k]; return undefined; }
function handleOf(link, title) {
  const l = String(link || '');
  const m = l.match(/(?:t\.me\/|@)?([A-Za-z0-9_]{3,})\/?$/);
  return '@' + (m ? m[1] : String(title || 'channel').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'channel');
}

// derive a search term from the brand description
const STOP = new Set(['наш', 'наша', 'наше', 'для', 'как', 'что', 'это', 'или', 'бренд', 'канал', 'хотим', 'через', 'сайт', 'себя', 'наши', 'свои', 'также', 'чтобы', 'когда', 'можно', 'продаём', 'маркетплейс', 'москов', 'увеличить', 'продажи']);
function termOf(desc, vertical) {
  const words = String(desc || '').toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w));
  if (words.length) return words.slice(0, 4).join(' ');
  return ({ beauty: 'косметика уход', fashion: 'мода стиль', edu: 'обучение курсы', app: 'приложения', b2b: 'бизнес маркетинг' })[vertical] || 'lifestyle';
}

async function apiGet(path, params) {
  const url = new URL(BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  const res = await fetch(url, { headers: { api_key: KEY, accept: 'application/json' } });
  if (!res.ok) throw new Error('telemetr ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  return data.data || data.items || data.channels || data.result || data.results || [];
}

/**
 * Fetch real candidate channels for a brand. Returns engine-shaped channels, or
 * null if the source is disabled or the call fails (→ engine uses its seed catalog).
 */
async function fetchCandidates(input = {}) {
  if (!enabled()) return null;
  const vertical = input.vertical || 'generic';
  const term = termOf(input.desc, vertical);
  try {
    const data = await apiGet('/v1/catalog/search', {
      term, language: 'ru', members_min: 5000,
      sort_by: 'members', sort_direction: 'desc', limit: 16,
    });
    const rows = rowsOf(data);
    if (!rows.length) return null;
    const out = rows.map((r, i) => {
      const title = pick(r, ['title', 'name']) || 'Канал';
      const subs = num(pick(r, ['members_count', 'members', 'participants_count', 'subscribers']));
      const reach = num(pick(r, ['avg_post_views', 'avg_views', 'views', 'avg_post_reach'])) || Math.round(subs * 0.25);
      const errRaw = pick(r, ['err_percent', 'err', 'er_percent', 'engagement']);
      const err = num(errRaw);
      const topic = topicOf(pick(r, ['category', 'category_name']), vertical);
      const cpm = CPM_BY_TOPIC[topic] || 500;
      const base = Math.max(55, Math.min(88, Math.round(60 + err * 3)));
      const id = 'tm' + (pick(r, ['internal_id', 'id', 'channel_id']) || i);
      return {
        id, name: title, handle: handleOf(pick(r, ['link', 'username', 'url']), title),
        cat: pick(r, ['category', 'category_name']) || 'Telegram-канал', topic,
        subs, match: base, cpm, reach,
        eng: (err ? String(err).replace('.', ',') : '—') + (err ? '%' : ''),
        adShare: pick(r, ['ad_percent', 'ads_percent']) != null ? num(pick(r, ['ad_percent', 'ads_percent'])) + '%' : '',
        w: reach || subs || 10000,
        verified: !!pick(r, ['verified', 'is_verified']),
        risks: [], why: [], verdict: 'Подходит', verdictSub: '',
        vColor: 'var(--teal)', vBg: '#F4FAF9', av: avOf(title),
        placement: { price: 0, clicks: '' },
      };
    }).filter(c => c.subs > 0);
    return out.length ? out : null;
  } catch (e) {
    if (process.env.ACCESS_LOG === '1') console.error('[source] telemetr failed:', e.message);
    return null;
  }
}

// ---- diagnostics: reveal the real response shape so mapping can be fixed ----
async function probeOne(path, params) {
  try {
    const data = await apiGet(path, params);
    if (Array.isArray(data)) return { ok: true, arrKey: '(root)', len: data.length, firstKeys: data[0] ? Object.keys(data[0]) : [], first: data[0] || null };
    const keys = data && typeof data === 'object' ? Object.keys(data) : [];
    let arr = null, arrKey = null;
    for (const k of keys) {
      if (Array.isArray(data[k])) { arr = data[k]; arrKey = k; break; }
      if (data[k] && typeof data[k] === 'object') {
        for (const k2 of Object.keys(data[k])) if (Array.isArray(data[k][k2])) { arr = data[k][k2]; arrKey = k + '.' + k2; break; }
        if (arr) break;
      }
    }
    return { ok: true, topKeys: keys, arrKey, len: arr ? arr.length : 0, firstKeys: arr && arr[0] ? Object.keys(arr[0]) : [], first: (arr && arr[0]) || (arr ? null : data) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function probe(term) {
  const t = term || 'косметика';
  return {
    catalog: await probeOne('/v1/catalog/search', { term: t, language: 'ru', limit: 5 }),
    channels: await probeOne('/v1/channels/search', { term: t, limit: 5 }),
  };
}

module.exports = { enabled, fetchCandidates, termOf, topicOf, probe };
