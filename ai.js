'use strict';
/* ============================================================================
 * Provider-agnostic AI enrichment of a media plan.
 *
 *   XAI_API_KEY  set → Grok (xAI, OpenAI-compatible chat completions)
 *   ANTHROPIC_API_KEY set → Claude (Anthropic messages API)
 *   neither → disabled, the deterministic engine output is used as-is.
 *
 * The model is asked to write per-channel rationale, risks and the strategy
 * grounded ONLY in the metrics we pass (no invented numbers). On any error we
 * transparently fall back to the engine plan. Uses global fetch (Node 18+).
 * ========================================================================== */

const crypto = require('crypto');
const store = require('./store');
// Groq (api.groq.com — fast Llama/Mixtral inference) is DIFFERENT from Grok/xAI (api.x.ai).
// Accept a Groq key under GROQ_API_KEY; the legacy GROK_API_KEY was ambiguous and pointed at xAI.
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const XAI_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// primary provider for cache keys / status; callLLM falls back across providers at runtime, so a
// dead key (e.g. an xAI team out of credits → 403) transparently uses the next configured one.
function provider() { if (GROQ_KEY) return 'groq'; if (XAI_KEY) return 'xai'; if (ANTHROPIC_KEY) return 'anthropic'; return null; }
function enabled() { return !!(GROQ_KEY || XAI_KEY || ANTHROPIC_KEY); }
function groqModel() { return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'; }
function xaiModel() { return process.env.XAI_MODEL || 'grok-4'; }
function anthropicModel() { return process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'; }
function model() { const p = provider(); return p === 'groq' ? groqModel() : p === 'xai' ? xaiModel() : p === 'anthropic' ? anthropicModel() : null; }

// OpenAI-compatible chat completions (Groq and xAI share this shape — only base URL + model differ)
async function callOpenAICompat(baseUrl, key, mdl, label, system, user, maxTokens, json) {
  let useJson = json;   // may drop strict JSON mode if the provider rejects the generation
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model: mdl, max_tokens: maxTokens, temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (useJson) body.response_format = { type: 'json_object' };
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 12000),
    });
    if (res.ok) { const data = await res.json(); return (((data.choices || [])[0] || {}).message || {}).content || ''; }
    const txt = (await res.text()).slice(0, 300);
    // free-tier tokens-per-minute rate limit → wait the suggested delay, then retry
    if (res.status === 429 && attempt < 2) {
      const m = txt.match(/try again in ([\d.]+)s/i);
      await new Promise(r => setTimeout(r, Math.min(6000, Math.max(1000, Math.round((m ? parseFloat(m[1]) : 3) * 1000) + 300))));
      continue;
    }
    // strict JSON mode can fail validation on some models → retry WITHOUT it; extractJson is tolerant
    if (res.status === 400 && useJson && /json[_ ]?validate|validate JSON/i.test(txt)) { useJson = false; continue; }
    throw new Error(label + ' ' + res.status + ' ' + txt);
  }
}
// Groq's model IDs change (llama-3.3-70b-versatile can 404 on some accounts). Self-heal: list the
// account's actual models once and pick the best text model, honouring GROQ_MODEL if it's valid.
let _groqModel = null;
async function groqPickModel() {
  if (_groqModel) return _groqModel;
  const envM = process.env.GROQ_MODEL || '';
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: 'Bearer ' + GROQ_KEY }, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const ids = ((await r.json()).data || []).map(m => m.id).filter(id => id && !/whisper|tts|guard|embed|vision|prompt-?guard/i.test(id));
      const pref = [envM, 'llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama3-70b-8192', 'openai/gpt-oss-120b', 'qwen-2.5-32b', 'deepseek-r1-distill-llama-70b', 'llama-3.1-8b-instant', 'llama3-8b-8192'].filter(Boolean);
      _groqModel = pref.find(p => ids.includes(p)) || ids.find(id => /llama-3\.[13]|70b/i.test(id)) || ids.find(id => /llama/i.test(id)) || ids[0] || null;
    }
  } catch (e) {}
  return _groqModel || envM || 'llama-3.1-8b-instant';
}
const callGroq = async (s, u, m, json) => callOpenAICompat('https://api.groq.com/openai/v1/chat/completions', GROQ_KEY, await groqPickModel(), 'groq', s, u, m, json);
const callXAI = (s, u, m, json) => callOpenAICompat('https://api.x.ai/v1/chat/completions', XAI_KEY, xaiModel(), 'xai', s, u, m, json);
async function callAnthropic(system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: anthropicModel(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 12000),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
// try providers in order of preference; on ANY failure fall through to the next configured one.
// This is what keeps the product intelligent — the whole "who is the buyer / reachModel" step runs
// here, and if it fails the search degrades to keyword-only and returns junk (ministries etc.).
async function callLLM(system, user, maxTokens = 1800, json = false) {
  const errs = [];
  if (GROQ_KEY) { try { return await callGroq(system, user, maxTokens, json); } catch (e) { errs.push(String(e.message || e)); } }
  if (XAI_KEY) { try { return await callXAI(system, user, maxTokens, json); } catch (e) { errs.push(String(e.message || e)); } }
  if (ANTHROPIC_KEY) { try { return await callAnthropic(system, user, maxTokens); } catch (e) { errs.push(String(e.message || e)); } }
  throw new Error(errs.length ? errs.join(' | ') : 'no AI provider configured');
}

// robust JSON extraction — models (esp. Llama) may wrap in ```json fences, add prose, or leave a
// trailing comma. Strip fences, take the outermost {...}, and retry after light repairs.
function extractJson(text) {
  let t = String(text || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no json in model reply');
  let s = m[0];
  try { return JSON.parse(s); } catch (e) {}
  // repair trailing commas before } or ]
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
  // truncated output: close dangling arrays/strings by trimming to the last complete "}"
  const cut = s.lastIndexOf('}');
  if (cut > 0) { try { return JSON.parse(s.slice(0, cut + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e) {} }
  throw new Error('bad json in model reply');
}

const SYSTEM = `Ты — опытный медиабайер по рекламе в Telegram-каналах. Тебе дают описание бренда, бриф и УЖЕ ОТОБРАННЫЙ движком список каналов с метриками. Не выдумывай новые каналы и не меняй числа.
Оценивай каждый канал по профессиональной методике скоринга (три блока с весами):
— FIT БРЕНДА (вес 0.45, главный): ядро аудитории канала = покупатель бренда (кто платит), а не просто общая тема; оффер естественно продолжает контент канала; brand safety (безопасное соседство).
— КАЧЕСТВО АУДИТОРИИ (вес 0.30): достоверность (органичный рост vs накрутка), стабильность охвата, оригинальная редактура и доверие; живой авторский канал/сообщество ценнее обезличенного агрегатора-репостера.
— ЭКОНОМИКА (вес 0.25): CPM к цели, вовлечённость (ERR/ER) к охвату, доля рекламы, прозрачность условий.
ФЛАГИ РИСКА (накрутка/непрозрачность) отмечай в risks честно: резкий рост подписчиков без объяснимых причин; аномально ровные/поздние просмотры; трафик из сомнительных каналов; доля рекламы выше ~25% («рекламная слепота»); устаревшие данные; размытая/случайная аудитория; пересечение с другими каналами плана. CPM/ERR сравнивай в пределах близкой тематики.
Задачи:
1) для каждого канала — 2–4 пункта "почему рекомендуем" под этот бренд по трём блокам (fit/качество/экономика), опираясь ТОЛЬКО на переданные метрики и здравый смысл медиабайера;
2) риски честно в "risks" по флагам выше;
3) verdict по логике порогов: сильный fit + чистая аудитория → "Отлично подходит"; есть флаги/оговорки → "Подходит с оговорками"; слабее, но стоит проверить → "Подходит для теста";
4) короткая "strategy" (2–3 предложения): логика распределения бюджета (ядро/смежные/тест) и почему; при возможности — совет по формату (нативный пост) и по срокам.
Никаких обещаний результата. Отвечай СТРОГО одним JSON-объектом, без markdown, на русском.`;

function buildUserPrompt(input, plan) {
  const chans = plan.channels.map(c => ({
    id: c.id, name: c.name, cat: c.cat, subs: c.subs, match: c.match,
    cpm: c.cpm, reach: c.reach, eng: c.eng, adShare: c.adShare, price: c.price,
  }));
  return [
    'БРЕНД: ' + (input.desc || input.brand || ''),
    'БРИФ: ' + JSON.stringify({ goal: input.goal, geo: input.geo, audience: input.audience, budget: plan.budget, exclude: input.exclude || [] }),
    'ОТОБРАННЫЕ КАНАЛЫ (метрики фиксированы, не меняй):',
    JSON.stringify(chans),
    '',
    'Верни JSON вида:',
    '{"channels":[{"id":"...","why":["..."],"risks":["..."],"verdict":"Отлично подходит|Подходит с оговорками|Подходит для теста","verdictSub":"кратко"}],"strategy":"...","confidence":"Высокая|Средняя|Ниже средней"}',
  ].join('\n');
}

const VERTICALS = 'crypto,beauty,fashion,games,edu,realestate,finance,auto,food,health,fitness,travel,home,kids,pets,marketing,it_dev,jobs,psychology,esoteric,music,cinema,books,science,gifts,electronics,dating,legal,art,ecommerce,logistics,wedding,beauty_serv,crafts,garden,construction,jewelry,anime,outdoor,events,charity,tattoo,b2b,app,generic';
// bump when the classify prompt changes — invalidates the 30-day cache instantly
const CLASSIFY_VERSION = 'v10';
/**
 * Understand a brand by MEANING, not just literal keywords — for vague descriptions
 * where the regex vertical/keywords miss the real niche. Returns {vertical, keywords,
 * audience} constrained to our vertical list, or null (disabled / error / no desc).
 */
async function classify(input) {
  if (!enabled()) return null;
  const desc = String((input && input.desc) || input || '').slice(0, 1200).trim();
  if (desc.length < 8) return null;
  // the brand's essence doesn't change → cache the classification 30 days (Grok is the
  // priciest/slowest step; repeat подборы of the same description skip it)
  const ck = 'cls:' + provider() + ':' + CLASSIFY_VERSION + ':' + crypto.createHash('md5').update(desc.toLowerCase().replace(/\s+/g, ' ')).digest('hex');
  try { const cached = await store.cacheGet(ck); if (cached && typeof cached === 'object') return cached; } catch (e) {}
  const system = 'Ты — профессиональный медиапланер по рекламе в Telegram с многолетним опытом. Твоя работа — по описанию бренда пройти чёткую цепочку и найти, где искать каналы для рекламы. Отвечай СТРОГО одним JSON-объектом, без markdown.';
  const user = [
    'Описание бренда: "' + desc + '"',
    'Рассуждай ПО ШАГАМ как медиабайер:',
    'brand — что продаёт (1 фраза).',
    'buyer — КТО ПЛАТИТ (не всегда тот, кто пользуется): родитель за ребёнка, взрослые дети за пожилых, HR за сотрудников, даритель за получателя, ВЛАДЕЛЕЦ бизнеса за инструмент/сервис. Инструмент/бот/CRM/сервис ДЛЯ бизнеса → покупатель = владельцы этого бизнеса, НЕ их клиенты.',
    'interests — где эта аудитория сидит в Telegram (интересы и смежные темы, не только прямая тема).',
    'keywords — 4–6 коротких фраз (1–2 слова), КАК РЕАЛЬНО НАЗЫВАЮТ каналы в Telegram, из кластеров: прямая категория; проблема/задача; смежные интересы; профессия/роль; стиль жизни; гео (если локальный); альтернативы. Возьми 2–4 сильнейших кластера под покупателя. Дай смесь: ядро + смежные.',
    'Примеры (бренд → кто платит → фразы):',
    '• бот записи для салонов → владельцы салонов/мастера → бьюти-бизнес, владельцы салонов, обучение мастеров',
    '• детские игрушки/одежда → мамы → мамы, родительство, раннее развитие (НЕ «магазины детской одежды»)',
    '• барбершоп (локальный) → мужчины города → городские паблики, местные мужские каналы',
    '• походы/экскурсии → любители активного отдыха → туризм, outdoor, походы, активный отдых',
    '• косметика оптом / сервис для селлеров → закупщики, продавцы WB → товарный бизнес, оптовики, wildberries, селлеры',
    '• премиум-часы/мебель → обеспеченные → мужской стиль, luxury, дизайн интерьера, бизнес',
    '• онлайн-психотерапия → люди с тревогой/выгоранием → психология, саморазвитие, ментальное здоровье',
    '• пансионат для пожилых → взрослые дети → люди 35–55, забота о родителях',
    'ЧЕГО НЕ ДЕЛАТЬ: не путай канал ПРО профессию (там коллеги-конкуренты) с каналом их КЛИЕНТОВ; не давай слова-магниты в одиночку («бизнес», «новости», «лайфстайл»); фразы — названия ниш/каналов, НЕ описания аудитории («мужской стиль», «нутрициология», а не «платёжеспособные мужчины 30+»).',
    'vertical — ОДНО слово строго из списка: ' + VERTICALS,
    'audienceType — "b2b" если покупатель бизнес/владельцы/специалисты, иначе "b2c".',
    'city — если в описании есть город/район (напр. «барбершоп троицк»), верни только название; иначе "".',
    'reachModel — ГОТОВА ли аудитория ехать ради продукта, или покупает потому что рядом:',
    '  "local_point" — рядовая услуга у дома, далеко не поедут (барбершоп, продукты, маникюр, районное кафе) → только каналы этого города;',
    '  "delivery" — доставка/выезд в районе;',
    '  "area" — активность/впечатление, ради которого ЕДУТ по региону (походы, экскурсии, конный клуб, картинг, мастер-класс) → важна ТЕМА, тематические каналы нужны;',
    '  "high_ticket" — дорогое, за которым едут (клиника, авто, недвижимость) → тематические каналы города ок;',
    '  "online" — онлайн/по стране/нет города → гео вторично.',
    'Верни JSON: {"brand":"...","buyer":"кто платит","interests":["..."],"vertical":"одно_слово","keywords":["фраза","фраза"],"audienceType":"b2c|b2b","city":"город или пусто","reachModel":"local_point|delivery|area|high_ticket|online"}',
  ].join('\n');
  try {
    const out = extractJson(await callLLM(system, user, 700, true));
    const vlist = VERTICALS.split(',');
    const vertical = vlist.includes(out.vertical) ? out.vertical : null;
    const keywords = Array.isArray(out.keywords) ? out.keywords.filter(x => typeof x === 'string' && x.trim().length >= 2).map(x => x.trim()).slice(0, 6) : [];
    const buyer = typeof out.buyer === 'string' ? out.buyer.trim() : '';
    const interests = Array.isArray(out.interests) ? out.interests.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 6) : [];
    const RMODELS = ['local_point', 'delivery', 'area', 'high_ticket', 'online'];
    const result = {
      vertical, keywords, audienceType: out.audienceType === 'b2b' ? 'b2b' : 'b2c',
      city: typeof out.city === 'string' ? out.city.trim() : '',
      reachModel: RMODELS.includes(out.reachModel) ? out.reachModel : '',
      brand: typeof out.brand === 'string' ? out.brand.trim() : '', buyer, interests,
      audience: buyer || (typeof out.audience === 'string' ? out.audience : ''),
    };
    try { await store.cacheSet(ck, result, 30 * 86400); } catch (e) {}
    _lastClassifyError = '';
    return result;
  } catch (e) { _lastClassifyError = String((e && e.message) || e); return null; }
}
let _lastClassifyError = '';
function lastClassifyError() { return _lastClassifyError; }

/** Expand a city/district into searchable geo terms — small towns (e.g. Троицк) have no
 *  channels of their own, so we also target the parent city/region (Новая Москва, Москва,
 *  Подмосковье). Returns an array of geo phrases, or [] (disabled / error). */
async function geoExpand(city) {
  if (!enabled()) return [];
  const c = String(city || '').slice(0, 120).trim();
  if (c.length < 2) return [];
  const system = 'Ты помогаешь искать локальные Telegram-каналы по географии России. Отвечай СТРОГО одним JSON-объектом.';
  const user = [
    'Пользователь указал город / район / область: "' + c + '".',
    'Верни 3–6 гео-фраз для поиска Telegram-каналов, покрывающих эту локацию: сам город/район, его родительский город или округ и регион.',
    'Пример: "Троицк" → ["Троицк","Новая Москва","Москва","Подмосковье"]. Только реальные географические названия России, без тематики.',
    'JSON: {"terms":["..."]}',
  ].join('\n');
  try {
    const out = extractJson(await callLLM(system, user, 200));
    return Array.isArray(out.terms) ? out.terms.filter(x => typeof x === 'string' && x.trim().length >= 2).map(x => x.trim()).slice(0, 6) : [];
  } catch (e) { return []; }
}

/** Enrich an engine plan with model-written rationale. Returns the plan (possibly enriched). */
async function enrich(input, plan) {
  if (!enabled()) return plan;
  try {
    const text = await callLLM(SYSTEM, buildUserPrompt(input, plan), 3000, true);
    const out = extractJson(text);
    const byId = {};
    (out.channels || []).forEach(c => { byId[c.id] = c; });
    plan.channels = plan.channels.map(c => {
      const e = byId[c.id];
      if (!e) return c;
      return Object.assign({}, c, {
        why: Array.isArray(e.why) && e.why.length ? e.why : c.why,
        risks: Array.isArray(e.risks) ? e.risks : c.risks,
        verdict: e.verdict || c.verdict,
        verdictSub: e.verdictSub || c.verdictSub,
      });
    });
    if (out.strategy) plan.strategy = out.strategy;
    if (out.confidence) plan.plan.confidence = out.confidence;
    plan.source = provider();
  } catch (e) {
    plan.aiError = String(e.message || e);
  }
  return plan;
}

module.exports = { enrich, classify, geoExpand, enabled, provider, model, lastClassifyError };
