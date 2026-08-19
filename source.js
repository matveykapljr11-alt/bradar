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

const tgstat = require('./tgstat');
const KEY = process.env.TELEMETR_API_KEY || '';
const BASE = process.env.TELEMETR_BASE || 'https://api.tlmtr.io';

function enabled() { return !!KEY; }

// estimated CPM (₽ per 1000 views) by topic — rough RU market; tweak freely
const CPM_BY_TOPIC = { skincare: 560, beauty: 560, fashion: 520, edu: 420, app: 460, b2b: 640, games: 450, realestate: 640, auto: 520, food: 480, health: 520, fitness: 470, travel: 500, home: 500, kids: 480, pets: 470, marketing: 600, it_dev: 620, jobs: 520, psychology: 520, esoteric: 480, music: 460, cinema: 480, books: 440, science: 520, gifts: 500, electronics: 500, dating: 500, legal: 560, art: 480, ecommerce: 560, logistics: 560, wedding: 560, beauty_serv: 540, crafts: 460, garden: 460, construction: 560, jewelry: 560, anime: 440, outdoor: 480, events: 500, charity: 460, tattoo: 480, lifestyle: 500, conscious: 480, wellness: 470, news: 680, finance: 700, crypto: 750 };
// map a Telemetr category string → our topic (for budget grouping + CPM)
function topicOf(category, vertical) {
  const c = (category || '').toLowerCase();
  if (/beaut|космет|уход|краса/.test(c)) return 'skincare';
  if (/fashion|мода|одежд|стиль/.test(c)) return 'fashion';
  if (/educ|обуч|образов|курс|язык/.test(c)) return 'edu';
  if (/нфт|nft|крипт|crypto|токен|блокчейн|web3/.test(c)) return 'crypto';
  if (/настол|игр|game|гейм|киберспорт/.test(c)) return 'games';
  if (/tech|app|прилож|гаджет|it|софт/.test(c)) return 'app';
  if (/business|бизнес|marketing|маркет|финанс|finance/.test(c)) return 'b2b';
  if (/health|wellness|спорт|фитнес|зож|здоров/.test(c)) return 'wellness';
  if (/news|новост/.test(c)) return 'news';
  if (/эко|осознан|conscious/.test(c)) return 'conscious';
  // fall back to the detected vertical's own topic-ish default
  return ({ beauty: 'skincare', fashion: 'fashion', edu: 'edu', app: 'app', b2b: 'b2b', crypto: 'crypto', games: 'games', realestate: 'realestate', finance: 'finance', auto: 'auto', food: 'food', health: 'health', fitness: 'fitness', travel: 'travel', home: 'home', kids: 'kids', pets: 'pets', marketing: 'marketing', it_dev: 'it_dev', jobs: 'jobs', psychology: 'psychology', esoteric: 'esoteric', music: 'music', cinema: 'cinema', books: 'books', science: 'science', gifts: 'gifts', electronics: 'electronics', dating: 'dating', legal: 'legal', art: 'art', ecommerce: 'ecommerce', logistics: 'logistics', wedding: 'wedding', beauty_serv: 'beauty_serv', crafts: 'crafts', garden: 'garden', construction: 'construction', jewelry: 'jewelry', anime: 'anime', outdoor: 'outdoor', events: 'events', charity: 'charity', tattoo: 'tattoo' })[vertical] || 'lifestyle';
}

const AVPAL = [['#F3D9DC', '#E8B9C4', '#8A5763'], ['#F6E7CF', '#E9C89A', '#8A6B37'], ['#DCE4F5', '#B9C8E8', '#5A6B90'], ['#D9EFEA', '#AFDCD2', '#3E7A6E'], ['#E3EAF8', '#BFCFEC', '#4F638C'], ['#F0E4F2', '#D3BEDD', '#6E5A82'], ['#E6E0F5', '#C6B6E0', '#645488'], ['#DDEFE6', '#B3D9C4', '#417A5E']];
function avOf(name) { const n = name || '•'; const p = AVPAL[(n.charCodeAt(0) + n.length) % AVPAL.length]; return { l: n[0].toUpperCase(), g: `linear-gradient(140deg,${p[0]},${p[1]})`, c: p[2] }; }

// A candidate that is itself a shop/brand (a direct COMPETITOR seller) is a bad ad
// placement — you advertise where the AUDIENCE is (blogs, reviews, communities), not on a
// rival store's channel (which also won't sell you ads). Drop obvious seller channels.
function looksLikeSeller(name) {
  const t = String(name || '').toLowerCase();
  return /магазин|интернет-?магазин|шоурум|бутик|маркетплейс|аутлет|outlet|\bshop\b|\bstore\b|official|официальный магазин|wildberries|вайлдберриз|\bozon\b|распродаж/.test(t);
}
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function pick(o, keys) { for (const k of keys) if (o && o[k] != null) return o[k]; return undefined; }
function handleOf(link, title) {
  const l = String(link || '');
  const m = l.match(/(?:t\.me\/|@)?([A-Za-z0-9_]{3,})\/?$/);
  return '@' + (m ? m[1] : String(title || 'channel').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'channel');
}

// generic/common words that make search too broad — drop them so brand-specific terms surface
const STOP = new Set(['наш', 'наша', 'наше', 'для', 'как', 'что', 'это', 'или', 'бренд', 'канал', 'хотим', 'через', 'сайт', 'себя', 'наши', 'свои', 'также', 'чтобы', 'когда', 'можно', 'продаём', 'продаем', 'маркетплейс', 'москов', 'увеличить', 'продажи', 'приложение', 'приложения', 'сервис', 'платформа', 'телеграм', 'telegram', 'мини', 'апп', 'app', 'миниапп', 'бот', 'bot', 'вебапп', 'webapp', 'помощью', 'который', 'которого', 'которая', 'которые', 'оценивать', 'оценить', 'следить', 'следит', 'ценами', 'цены', 'цена', 'позволяет', 'помогает', 'делать', 'клиентов', 'пользователей', 'аудитории', 'аудиторию', 'реклама', 'рекламы',
  // filler / commerce words — never describe the niche, only pollute search
  'товары', 'товар', 'магазин', 'магазине', 'купить', 'заказать', 'заказ', 'доставка', 'доставкой', 'онлайн', 'каталог', 'ассортимент', 'скидки', 'скидка', 'распродажа', 'лучший', 'лучшие', 'лучшая', 'бесплатно', 'бесплатные', 'бесплатными', 'качество', 'качественный', 'качественные', 'новый', 'новые', 'новая', 'прямой', 'ручной', 'работы']);
// generic mega-niche + cross-niche homonym words. As a SOLO search each pulls a whole
// foreign niche (деньги→финансы, детское→родительство, карта→банки/таро, язык→любой язык).
// They're dropped whenever the brand has its own distinctive words; the detected vertical
// re-supplies the right ones via VERTICAL_TERMS only if too few real channels are found.
const MAGNET = new Set([
  // audience magnets (describe WHO the product is for, not the product)
  'дети', 'детей', 'детьми', 'детское', 'детская', 'детских', 'детям', 'ребёнок', 'ребенок', 'ребёнка', 'ребенка', 'взрослых', 'взрослые', 'женщин', 'женщины', 'мужчин', 'мужчины', 'подростков', 'подростки', 'родителей', 'родителям',
  // generic education (any subject) — a specific subject/language stays distinctive
  'язык', 'языка', 'языки', 'языков', 'изучение', 'изучения', 'обучение', 'обучения', 'образование', 'образования', 'курс', 'курсы', 'курсов', 'урок', 'уроки', 'уроков', 'знания', 'знаний', 'саморазвитие',
  // mega-niches (a precise product word beats these; the right vertical re-adds them)
  'деньги', 'финансы', 'доход', 'доходы', 'здоровье', 'здоровья', 'питание', 'еда', 'игра', 'игры', 'игр', 'авто', 'машина', 'машины', 'дом', 'дома', 'домов', 'ремонт', 'спорт', 'фитнес', 'путешествия', 'туризм', 'музыка', 'кино', 'фильмы', 'мода', 'стиль', 'красота', 'уход', 'косметика', 'психология', 'мотивация', 'работа', 'карьера', 'новости', 'политика', 'книги', 'книга', 'инвестиции', 'бизнес', 'маркетинг',
  // cross-niche homonyms (different meaning in different niches)
  'карта', 'карты', 'модель', 'модели', 'база', 'базы', 'тон', 'капсула', 'мышь', 'ключ', 'культура', 'правило',
]);
// curated fallback search terms per vertical (used only if the brand's own words are too few)
const VERTICAL_TERMS = {
  beauty: ['косметика', 'уход', 'бьюти', 'макияж', 'парфюм'],
  fashion: ['мода', 'стиль', 'одежда', 'гардероб', 'образ'],
  edu: ['обучение', 'курсы', 'образование', 'знания', 'саморазвитие'],
  app: ['приложения', 'гаджеты', 'технологии', 'лайфхаки'],
  crypto: ['нфт', 'nft', 'крипта', 'криптовалюта', 'биржа', 'инвестиции'],
  b2b: ['бизнес', 'маркетинг', 'предприниматель', 'продажи', 'стартап'],
  games: ['настольные игры', 'игры', 'гейминг', 'настолки', 'головоломки'],
  realestate: ['недвижимость', 'новостройки', 'квартиры', 'ипотека', 'инвестиции в недвижимость'],
  finance: ['финансы', 'инвестиции', 'деньги', 'экономика', 'финансовая грамотность'],
  auto: ['авто', 'автомобили', 'автоновости', 'автосервис', 'машины'],
  food: ['еда', 'рецепты', 'доставка еды', 'рестораны', 'кулинария'],
  health: ['здоровье', 'медицина', 'зож', 'велнес', 'психология'],
  fitness: ['фитнес', 'спорт', 'зож', 'тренировки', 'здоровье'],
  travel: ['путешествия', 'туризм', 'отдых', 'отели', 'маршруты'],
  home: ['интерьер', 'дом', 'мебель', 'дизайн', 'уют'],
  kids: ['дети', 'родители', 'мама', 'развитие детей', 'семья'],
  pets: ['питомцы', 'животные', 'зоотовары', 'собаки', 'кошки'],
  marketing: ['маркетинг', 'smm', 'реклама', 'трафик', 'продвижение'],
  it_dev: ['программирование', 'разработка', 'it', 'нейросети', 'технологии'],
  jobs: ['вакансии', 'работа', 'карьера', 'резюме', 'поиск работы'],
  psychology: ['психология', 'саморазвитие', 'ментальное здоровье', 'мотивация', 'отношения'],
  esoteric: ['астрология', 'гороскоп', 'таро', 'эзотерика', 'саморазвитие'],
  music: ['музыка', 'новинки музыки', 'артисты', 'плейлисты', 'концерты'],
  cinema: ['кино', 'сериалы', 'новинки кино', 'что посмотреть', 'рецензии'],
  books: ['книги', 'литература', 'чтение', 'что почитать', 'рецензии'],
  science: ['наука', 'научпоп', 'технологии', 'космос', 'образование'],
  gifts: ['подарки', 'цветы', 'букеты', 'сюрпризы', 'праздники'],
  electronics: ['гаджеты', 'электроника', 'техника', 'обзоры техники', 'новинки'],
  dating: ['знакомства', 'отношения', 'свидания', 'общение', 'психология отношений'],
  legal: ['юрист', 'право', 'юридические услуги', 'законы', 'защита прав'],
  art: ['искусство', 'дизайн', 'иллюстрация', 'фотография', 'творчество'],
  ecommerce: ['маркетплейсы', 'селлеры', 'товарный бизнес', 'wildberries', 'ozon'],
  logistics: ['логистика', 'доставка', 'грузоперевозки', 'склад', 'фулфилмент'],
  wedding: ['свадьба', 'свадебное', 'организация свадьбы', 'невеста', 'торжество'],
  beauty_serv: ['салон красоты', 'маникюр', 'косметология', 'парикмахер', 'бьюти'],
  crafts: ['рукоделие', 'хендмейд', 'мастер-классы', 'творчество', 'handmade'],
  garden: ['сад', 'огород', 'дача', 'растения', 'ландшафт'],
  construction: ['строительство', 'ремонт', 'отделка', 'стройматериалы', 'дизайн'],
  jewelry: ['украшения', 'ювелирные', 'бижутерия', 'подарки', 'мода'],
  anime: ['аниме', 'манга', 'комиксы', 'гик-культура', 'косплей'],
  outdoor: ['охота', 'рыбалка', 'туризм', 'кемпинг', 'снаряжение'],
  events: ['афиша', 'мероприятия', 'концерты', 'фестивали', 'билеты'],
  charity: ['благотворительность', 'фонд', 'волонтёры', 'помощь', 'нко'],
  tattoo: ['тату', 'татуировки', 'пирсинг', 'тату-салон', 'искусство'],
  generic: ['новости', 'лайфстайл', 'саморазвитие', 'психология', 'интересное'],
};
// distinctive keywords from the brand text (≥3 chars so «нфт», «wb» survive), minus the brand's own name
function keywordsFor(desc, brand) {
  const bn = String(brand || '').toLowerCase();
  const words = [...new Set(String(desc || '').toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w) && w !== bn && !(bn.length > 3 && bn.indexOf(w) >= 0)))];
  const byLen = (a, b) => b.length - a.length;                 // distinctive/longer words first
  const distinctive = words.filter(w => !MAGNET.has(w)).sort(byLen);
  const magnets = words.filter(w => MAGNET.has(w)).sort(byLen);
  // If the brand has its OWN distinctive words, search only those — a lone generic/homonym
  // word pulls a whole foreign niche. Only when the brand is described purely in generic
  // terms do we fall back to the magnet words themselves.
  return (distinctive.length ? distinctive : magnets).slice(0, 6);
}
function termsFor(desc, vertical, brand) {
  const kw = keywordsFor(desc, brand);
  const base = VERTICAL_TERMS[vertical] || VERTICAL_TERMS.generic;
  return kw.length ? [...kw, ...base] : base;   // brand-specific terms FIRST, vertical only to top up
}
function termOf(desc, vertical, brand) { return termsFor(desc, vertical, brand)[0]; }
function isRu(r) { const c = String(pick(r, ['country']) || '').toLowerCase(); return c === '' || c === 'russia' || c === 'россия' || c === 'ru'; }

async function apiGet(path, params) {
  const url = new URL(BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  const res = await fetch(url, { headers: { 'X-API-Key': KEY, accept: 'application/json' }, signal: AbortSignal.timeout(Number(process.env.TELEMETR_TIMEOUT_MS) || 6000) });
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
async function searchRu(term) {
  try { return rowsOf(await apiGet('/v1/channels/search', { term, country: 'russia', peer_type: 'Channel', language: 'ru', limit: 20 })); }
  catch (e) { return []; }
}
async function statsFor(id) {
  if (!id) return null;
  try { return await apiGet('/v1/channel/stats', { internal_id: id }); }
  catch (e) { return null; }
}
async function fetchCandidates(input = {}) {
  if (!enabled()) return null;
  const vertical = input.vertical || 'generic';
  const topic = topicOf(null, vertical);            // free tier: no per-result category
  const cpm = CPM_BY_TOPIC[topic] || 500;
  try {
    // AI-provided semantic phrases (for vague descriptions) win over literal keyword extraction
    const brandKw = (Array.isArray(input.searchTerms) && input.searchTerms.length)
      ? input.searchTerms.slice(0, 8)
      : keywordsFor(input.desc, input.brand);
    const base = VERTICAL_TERMS[vertical] || VERTICAL_TERMS.generic;
    const seen = new Set();
    let real = [];
    let rank = 0;
    const collect = async (list, target, perTerm) => {
      for (const t of list) {
        const rows = await searchRu(t); let added = 0;
        for (const r of rows) {
          const id = pick(r, ['internal_id', 'id']);
          if (id && !seen.has(id) && pick(r, ['peer', 'peer_type']) !== 'Group' && num(pick(r, ['members_count', 'members'])) >= 5000 && !looksLikeSeller(pick(r, ['title', 'name']))) {
            r.__rank = rank; seen.add(id); real.push(r);
            if (perTerm && ++added >= perTerm) break;  // don't let one generic word dominate
          }
        }
        rank++;
        if (real.length >= target) break;
      }
    };
    // phrase search first: the top distinctive words together. A channel that matches the
    // whole phrase is genuinely on-topic — this excludes foreign-niche homonym hits. Harmless
    // fallthrough: if Telemetr finds nothing for the phrase, single-word search still runs.
    const phrases = [];
    if (brandKw.length >= 3) phrases.push(brandKw.slice(0, 3).join(' '));
    if (brandKw.length >= 2) phrases.push(brandKw.slice(0, 2).join(' '));
    if (phrases.length) await collect(phrases, 8);
    // local targeting: search the city (+ topic) so local channels surface, ranked first
    // HYPERLOCAL: a local business (a barbershop in Троицк) needs channels of ITS OWN town —
    // NOT the parent metro (nobody drives from Moscow to Троицк). Search the town's own
    // community pabliks by their usual naming patterns; do not broaden to the big city.
    const places = String(input.geoCity || '').split(/[,;]+/).map(s => s.trim()).filter(x => x.length >= 2).slice(0, 3);
    if (places.length) {
      const cityTerms = [];
      places.forEach(c => {
        cityTerms.push('подслушано ' + c);
        cityTerms.push('типичный ' + c);
        cityTerms.push('инцидент ' + c);
        cityTerms.push(c + ' онлайн');
        cityTerms.push('афиша ' + c);
        cityTerms.push(c);
      });
      const before = real.length;
      await collect(cityTerms, 24, 4);
      for (let k = before; k < real.length; k++) real[k].__geoLocal = true;   // mark local finds
    }
    await collect(brandKw, 24, 6);                 // brand-specific keywords (most distinctive first)
    if (real.length < 3) await collect(base, 10);  // vertical terms only if the brand yielded almost nothing
    if (real.length < 3) {
      let plain = [];
      try { plain = rowsOf(await apiGet('/v1/channels/search', { term: (brandKw[0] || base[0]), limit: 30 })); } catch (e) {}
      for (const r of plain) {
        const id = pick(r, ['internal_id', 'id']);
        if (id && !seen.has(id) && num(pick(r, ['members_count', 'members'])) >= 3000) { r.__rank = 99; seen.add(id); real.push(r); }
      }
    }
    if (!real.length) return null;
    // keep relevance order: distinctive-term finds first, larger channels within a term
    real.sort((a, b) => (a.__rank - b.__rank) || (num(pick(b, ['members_count', 'members'])) - num(pick(a, ['members_count', 'members']))));
    real = real.slice(0, 16);
    // enrich with REAL metrics (reach, posts, ER) from channel/stats — parallel, best-effort
    const stats = await Promise.all(real.map(r => statsFor(pick(r, ['internal_id', 'id']))));
    const reachOf = st => num(st && st.avg_post_views && (st.avg_post_views.avg_post_views != null ? st.avg_post_views.avg_post_views : st.avg_post_views));
    const postsOf = st => num(st && st.messages_count && st.messages_count.last_30_days);
    // drop dead / frozen channels: no posts in 30 days or zero views
    let pairs = real.map((r, i) => ({ r, st: stats[i] || {} }));
    const active = pairs.filter(p => postsOf(p.st) >= 2 && reachOf(p.st) > 0);   // healthy
    const semi = pairs.filter(p => postsOf(p.st) >= 1 && reachOf(p.st) > 0);     // at least posting
    if (active.length >= 3) pairs = active;
    else if (semi.length >= 3) pairs = semi;
    else if (semi.length) pairs = semi;
    else if (active.length) pairs = active;
    // else: keep all (stats unavailable — can't tell; don't wipe the result)
    pairs = pairs.slice(0, 12);
    const out = pairs.map(({ r, st }, i) => {
      const title = pick(r, ['title', 'name']) || 'Канал';
      const subs = num(pick(r, ['members_count', 'members', 'participants_count']));
      const realReach = reachOf(st);
      const reach = realReach || Math.max(500, Math.round(subs * 0.22));
      const err = num(st.err_percent);
      const iid = pick(r, ['internal_id', 'id']);
      const base = err ? Math.round(60 + Math.min(err, 8) * 3) : Math.round(58 + Math.log10(Math.max(1000, subs)) * 5);
      return {
        id: 'tm' + (iid || i), name: title,
        handle: '',                                    // free tier exposes no @username
        link: iid ? 'https://telemetr.io/channels/' + iid : '',
        cat: 'Telegram-канал', topic,
        subs, match: Math.min(93, Math.max(60, Math.min(86, base)) + (r.__geoLocal ? 12 : 0)), cpm, reach,
        geoLocal: !!r.__geoLocal,
        eng: err ? (Math.round(err * 10) / 10).toString().replace('.', ',') + '%' : '',
        adShare: '',
        w: reach || subs || 10000, verified: !!pick(r, ['verified', 'is_verified']),
        risks: [], why: r.__geoLocal ? ['Локальный канал вашего города — прямой выход на местную аудиторию'] : [], verdict: 'Подходит', verdictSub: r.__geoLocal ? 'Локальная аудитория' : '',
        vColor: 'var(--teal)', vBg: '#F4FAF9', av: avOf(title),
        placement: { price: 0, clicks: '' },
        real: true,
        metrics: (realReach || err || postsOf(st)) ? {
          reach: realReach,
          reach24: num(st.avg_post_views && st.avg_post_views.avg_post_views_24h),
          reach48: num(st.avg_post_views && st.avg_post_views.avg_post_views_48h),
          reach72: num(st.avg_post_views && st.avg_post_views.avg_post_views_72h),
          err: err, err24: num(st.err24_percent),
          posts30: postsOf(st), posts7: num(st.messages_count && st.messages_count.last_7_days),
          growth30: num(st.members_change && st.members_change.last_30_days),
          growth7: num(st.members_change && st.members_change.last_7_days),
          female: num(st.gender && st.gender.female_percent), male: num(st.gender && st.gender.male_percent),
          premium: num(st.premium_percent), adsGrade: st.ads_index_grade || '',
          reactions: num(st.engagement && st.engagement.reactions_avg),
          comments: num(st.engagement && st.engagement.comments_avg),
          forwards: num(st.engagement && st.engagement.forwards_avg),
        } : null,
      };
    }).filter(c => c.subs > 0);
    // via TGStat: resolve @username/link + read the last 3 posts → competitor flag AND a
    // brand-relevance signal (does the channel actually post about the brand's topic?)
    try { await tgstat.enrichLinks(out, brandKw); } catch (e) {}
    // last posts HELP the match: boost channels that really post on-topic, penalise off-topic
    out.forEach(c => {
      if (!c.hasPosts) return;
      if (c.relHits >= 2) c.match = Math.min(94, c.match + 5);
      else if (c.relHits === 0) c.match = Math.max(48, c.match - 10);
    });
    // drop direct-competitor shops, as long as enough clean channels remain
    const clean = out.filter(c => !c.competitor);
    let finalOut = (clean.length >= 3 ? clean : out);
    // hyperlocal: when a specific city is set, keep ONLY its own local channels — an empty
    // result is honest (a tiny town may simply have no channels) rather than showing the metro
    if (String(input.geoCity || '').trim()) {
      finalOut = finalOut.filter(c => c.geoLocal);
    }
    finalOut = finalOut.sort((a, b) => b.match - a.match);
    return finalOut.length ? finalOut : null;
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
    const titles = arr ? arr.slice(0, 8).map(x => x && (x.title || x.name) + ' [' + (x.peer || '') + '/' + (x.country || '') + '/' + (x.members_count || 0) + ']') : [];
    return { ok: true, topKeys: keys, arrKey, len: arr ? arr.length : 0, firstKeys: arr && arr[0] ? Object.keys(arr[0]) : [], titles };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function resolveUsername(id) {
  const tried = [];
  for (const u of ['https://telemetr.io/channels/' + id, 'https://telemetr.io/en/channels/' + id, 'https://tlmtr.io/channels/' + id]) {
    try {
      const res = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
      const html = res.ok ? await res.text() : '';
      const m = html.match(/t\.me\/([A-Za-z0-9_]{4,32})/);
      const uname = m && !/^(s|share|joinchat|addstickers|proxy|iv)$/i.test(m[1]) ? m[1] : null;
      tried.push({ url: u, status: res.status, len: html.length, uname });
      if (uname) return { uname, from: u };
    } catch (e) { tried.push({ url: u, error: String(e.message || e) }); }
  }
  return { uname: null, tried };
}
async function probe(term) {
  const t = term || 'косметика';
  const channels_ru = await probeOne('/v1/channels/search', { term: t, country: 'russia', peer_type: 'Channel', language: 'ru', limit: 8 });
  let stats = null, resolve = null;
  try {
    const rows = rowsOf(await apiGet('/v1/channels/search', { term: t, country: 'russia', peer_type: 'Channel', language: 'ru', limit: 5 }));
    const id = rows[0] && pick(rows[0], ['internal_id', 'id']);
    if (id) {
      const st = await apiGet('/v1/channel/stats', { internal_id: id });
      stats = { internal_id: id, keys: st && typeof st === 'object' ? Object.keys(st) : [] };
      resolve = await resolveUsername(id);
    }
  } catch (e) { stats = { error: String(e.message || e) }; }
  return { channels_ru, stats, resolve };
}

module.exports = { enabled, fetchCandidates, termOf, topicOf, probe, keywordsFor };
