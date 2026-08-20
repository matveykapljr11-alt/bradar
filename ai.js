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
const XAI_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

function provider() { if (XAI_KEY) return 'xai'; if (ANTHROPIC_KEY) return 'anthropic'; return null; }
function enabled() { return !!provider(); }
function model() {
  if (provider() === 'xai') return process.env.XAI_MODEL || 'grok-4';
  if (provider() === 'anthropic') return process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  return null;
}

async function callXAI(system, user, maxTokens) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + XAI_KEY },
    body: JSON.stringify({ model: model(), max_tokens: maxTokens, temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 12000),
  });
  if (!res.ok) throw new Error('xai ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return (((data.choices || [])[0] || {}).message || {}).content || '';
}
async function callAnthropic(system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 12000),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
async function callLLM(system, user, maxTokens = 1800) {
  const p = provider();
  if (p === 'xai') return callXAI(system, user, maxTokens);
  if (p === 'anthropic') return callAnthropic(system, user, maxTokens);
  throw new Error('no AI provider configured');
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no json in model reply');
  return JSON.parse(m[0]);
}

const SYSTEM = `Ты — опытный медиабайер по рекламе в Telegram-каналах. Тебе дают описание бренда, бриф и УЖЕ ОТОБРАННЫЙ движком список каналов с метриками. Не выдумывай новые каналы и не меняй числа.
Оценивай каждый канал как медиабайер при закупе рекламы:
— живой авторский канал / тематическое сообщество (доверие аудитории, реклама заходит) ценнее обезличенного агрегатора-репостера (дешёвый, но «холодный» охват, слабая конверсия);
— доля рекламы выше ~25% → «рекламная слепота», контакт замылен;
— вовлечённость к охвату: живые реакции/комменты = настоящая аудитория; неестественные показатели = риск накрутки;
— главное — соответствие именно ПОКУПАТЕЛЮ бренда (кто платит), а не просто теме;
— если продукт сезонный — отметь лучшее время/повод для размещения.
Задачи:
1) для каждого канала — 2–4 пункта "почему рекомендуем" под этот бренд, опираясь ТОЛЬКО на переданные метрики и здравый смысл медиабайера;
2) риски честно в "risks" (высокая доля рекламы, дорогой CPM, слабая/сомнительная вовлечённость, размытая аудитория, пересечение с другими каналами плана);
3) короткая "strategy" (2–3 предложения): логика распределения бюджета (ядро/смежные/тест) и почему; при возможности — совет по формату (нативный пост) и по срокам.
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
const CLASSIFY_VERSION = 'v5';
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
    'Пройди как профи ПО ШАГАМ (это твоя линейка рассуждений):',
    'ШАГ 1. brand — что это за бренд и что именно он продаёт (1 фраза).',
    'ШАГ 2. buyer — КТО его покупатель = кто реально платит (не всегда тот, кто пользуется). Определи платёжеспособный сегмент.',
    'ШАГ 3. interests — ГДЕ эта аудитория проводит время в Telegram: её интересы, сообщества, смежные темы (не только прямая тема продукта).',
    'ШАГ 4. keywords — по каким фразам искать эти каналы (из шага 3).',
    'Также выбери ОДНУ вертикаль строго из списка (одним словом): ' + VERTICALS,
    'ГЛАВНОЕ на шаге 2 — пойми, КОМУ бренд продаёт:',
    '• Если это сервис / бот / CRM / инструмент / платформа ДЛЯ бизнеса (например «бот записи для салонов красоты», «CRM для стоматологий») — покупатель это ВЛАДЕЛЬЦЫ этого бизнеса, а не их клиенты. Ищи каналы для владельцев/предпринимателей этой сферы (бьюти-бизнес, владельцы салонов, стоматологи-предприниматели), НЕ каналы для конечных клиентов.',
    '• Если товар/услуга для людей — ищи каналы, где сидят эти люди (по интересу), а не конкурентов.',
    'Изучи, кто покупатель, на примерах (описание → КТО покупатель → какие каналы искать):',
    '— «бот записи для салонов красоты» → владельцы салонов и бьюти-мастера → бьюти-бизнес, владельцы салонов, обучение мастеров, бьюти-предприниматели',
    '— «CRM для стоматологий» → владельцы стоматологий → стоматология бизнес, дентал, медбизнес',
    '— «детские игрушки» → родители, чаще мамы → мамы, родительство, раннее развитие',
    '— «спортивное питание» → посетители спортзалов → бодибилдинг, фитнес, пауэрлифтинг',
    '— «франшиза кофейни» → предприниматели-инвесторы → франшизы, малый бизнес, инвестиции',
    '— «курс по таргету» → начинающие маркетологи и фрилансеры → таргет, smm, фриланс, удалёнка',
    '— «косметика оптом» → закупщики и селлеры → товарный бизнес, оптовики, маркетплейсы',
    '— «доставка цветов» → чаще мужчины к поводам → отношения, мужской юмор, подарки',
    '— «премиум-мебель на заказ» → дизайнеры интерьера и обеспеченные → дизайн интерьера, премиум lifestyle',
    '— «приложение для трейдинга» → трейдеры и инвесторы → трейдинг, инвестиции, финансы',
    '— «онлайн-бухгалтерия для ИП» → предприниматели и ИП → малый бизнес, предприниматели, самозанятые',
    '— «барбершоп» (локальный) → мужчины города/района → городские паблики, местные мужские каналы',
    '— «профессиональная косметика для мастеров» → бьюти-мастера (B2B) → бьюти-бизнес, мастера маникюра, обучение',
    '— «языковая школа для детей» → родители (платят они) → мамы, родительство, детское развитие',
    '— «пансионат для пожилых» → взрослые дети (решают и платят) → люди 35–55, забота о родителях',
    '— «корпоративные подарки» → HR и отделы закупок (B2B) → HR, тимлиды, корпоративная культура',
    '— «новостройки от застройщика» → покупатели и инвесторы жилья → недвижимость, ипотека, инвестиции',
    '— «свадебные платья» → невесты → свадьба, невесты, подготовка к свадьбе',
    '— «сервис для селлеров WB» → продавцы маркетплейсов → wildberries, селлеры, товарный бизнес',
    '— «автозапчасти» → автовладельцы и автосервисы → авто, автосервис, ремонт машин',
    '— «игровые ПК» → геймеры → гейминг, киберспорт, сборки пк',
    '— «доставка здорового питания» → занятые на ПП и худеющие → пп, зож, фитнес',
    'ПРИНЦИП: платит не всегда тот, кто пользуется — ищи именно ПЛАТЕЛЬЩИКА/лицо, принимающее решение (родитель за ребёнка, взрослые дети за пожилых, HR за сотрудников, даритель за получателя, владелец бизнеса за инструмент).',
    'Теперь думай как опытный медиабайер по рекламе в Telegram:',
    '• Реклама лучше заходит в АВТОРСКИХ каналах и живых тематических сообществах (доверие к автору/комьюнити), хуже — в гигантских обезличенных новостниках-агрегаторах и накрученных каналах.',
    '• Ищи СМЕЖНЫЕ интересы платёжеспособной аудитории, а не только прямую тему: премиум-часы → мужской стиль, авто, бизнес, luxury (там богатые мужчины), а не «магазины часов»; крафтовое пиво → бары, музыка, локальные тусовки; детская онлайн-школа → мамы и семейный досуг.',
    '• Дай смесь: 2–3 фразы под ядро (прямой интерес покупателя) и 1–2 под смежные интересы, где он тоже проводит время.',
    'КРИТИЧНО про фразы: мы ищем по ним каналы по НАЗВАНИЮ в Telegram. Поэтому фразы должны быть такими, как реально НАЗЫВАЮТ каналы и ниши (1–2 слова, конкретно), а не абстрактным описанием аудитории.',
    '  Плохо: «платёжеспособные мужчины 30+», «занятые предприниматели», «люди, которым важен уход». Хорошо: «мужской стиль», «барбершоп», «streetwear», «бизнес молодость», «маркетинг», «нутрициология», «мамы москвы».',
    'Придумай 4–6 таких коротких фраз (по 1–2 слова) под каналы ИМЕННО этого покупателя — как эти каналы реально называются в Telegram.',
    'Поле audienceType: "b2c" если продукт покупают конечные люди для себя; "b2b" если покупатель — бизнес/владельцы/специалисты.',
    'Если в описании упомянут ГОРОД или район (например «барбершоп троицк») — верни его в поле city (только название, без темы). Если города нет — city пустая строка.',
    'Верни JSON строго по линейке: {"brand":"что за бренд","buyer":"кто платит","interests":["где сидит аудитория"],"vertical":"одно_слово_из_списка","keywords":["фраза 1-2 слова","фраза"],"audienceType":"b2c|b2b","city":"город или пусто"}',
  ].join('\n');
  try {
    const out = extractJson(await callLLM(system, user, 420));
    const vlist = VERTICALS.split(',');
    const vertical = vlist.includes(out.vertical) ? out.vertical : null;
    const keywords = Array.isArray(out.keywords) ? out.keywords.filter(x => typeof x === 'string' && x.trim().length >= 2).map(x => x.trim()).slice(0, 6) : [];
    const audience = typeof out.buyer === 'string' && out.buyer.trim() ? out.buyer.trim() : (typeof out.audience === 'string' ? out.audience : '');
    const result = { vertical, keywords, audience, audienceType: out.audienceType === 'b2b' ? 'b2b' : 'b2c', city: typeof out.city === 'string' ? out.city.trim() : '' };
    try { await store.cacheSet(ck, result, 30 * 86400); } catch (e) {}
    return result;
  } catch (e) { return null; }
}

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
    const text = await callLLM(SYSTEM, buildUserPrompt(input, plan), 1800);
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

module.exports = { enrich, classify, geoExpand, enabled, provider, model };
