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

const SYSTEM = `Ты — медиапланер по рекламе в Telegram-каналах. Тебе дают описание бренда, бриф и УЖЕ ОТОБРАННЫЙ движком список каналов с их метриками. Твоя задача — не выдумывать новые каналы и не менять числа, а:
1) для каждого канала написать 2–4 пункта "почему рекомендуем" именно под этот бренд, опираясь только на переданные метрики (тематика, соответствие, охват, CPM, доля рекламы, вовлечённость);
2) если по метрикам видны риски (доля рекламы выше ~25%, CPM заметно выше средней по подборке, низкая вовлечённость) — перечислить их честно в "risks";
3) написать короткую "strategy" (2–3 предложения) — как распределён бюджет и почему.
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
/**
 * Understand a brand by MEANING, not just literal keywords — for vague descriptions
 * where the regex vertical/keywords miss the real niche. Returns {vertical, keywords,
 * audience} constrained to our vertical list, or null (disabled / error / no desc).
 */
async function classify(input) {
  if (!enabled()) return null;
  const desc = String((input && input.desc) || input || '').slice(0, 1200).trim();
  if (desc.length < 8) return null;
  const system = 'Ты классифицируешь бренд для подбора рекламных Telegram-каналов. Пойми СМЫСЛ описания, даже если в нём нет прямых ключевых слов и названий ниши. Отвечай СТРОГО одним JSON-объектом, без markdown.';
  const user = [
    'Описание бренда: "' + desc + '"',
    'Выбери ОДНУ наиболее подходящую вертикаль строго из списка (одним словом): ' + VERTICALS,
    'И придумай 4–6 коротких поисковых фраз (по 1–3 слова, на русском) — по ним будем искать релевантные Telegram-каналы этой ниши. Фразы должны отражать СМЫСЛ ниши, а не копировать слова из описания.',
    'Верни JSON: {"vertical":"одно_слово_из_списка","keywords":["фраза","фраза"],"audience":"кратко кто целевая аудитория"}',
  ].join('\n');
  try {
    const out = extractJson(await callLLM(system, user, 320));
    const vlist = VERTICALS.split(',');
    const vertical = vlist.includes(out.vertical) ? out.vertical : null;
    const keywords = Array.isArray(out.keywords) ? out.keywords.filter(x => typeof x === 'string' && x.trim().length >= 2).map(x => x.trim()).slice(0, 6) : [];
    return { vertical, keywords, audience: typeof out.audience === 'string' ? out.audience : '' };
  } catch (e) { return null; }
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

module.exports = { enrich, classify, enabled, provider, model };
