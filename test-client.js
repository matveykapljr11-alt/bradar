'use strict';
/* Headless verification of public/bradar-api.js: stub the browser + app globals,
 * eval the client integration, and assert it wires up correctly and calls the
 * right API paths. Run: node test-client.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const calls = [];        // recorded fetch(path, opts)
const underlying = {};    // which original app fns got invoked

function mockFetch(pathArg, opts) {
  calls.push({ path: pathArg, method: (opts && opts.method) || 'GET', body: opts && opts.body });
  let payload = {};
  if (pathArg === '/api/config') payload = { ai: true, model: 'claude-sonnet-5', user: { id: 'dev:x' }, products: { pro_export: { stars: 150 } }, pro: {} };
  else if (pathArg === '/api/invoice') payload = { link: 'https://t.me/invoice/xyz' };
  else if (pathArg === '/api/state') payload = { plans: [{ id: 'p1', brand: 'SkillUp' }], favs: [{ id: 'koja' }] };
  else if (pathArg === '/api/analyze') payload = { channels: [{ id: 'a', name: 'A', av: { l: 'A', g: '', c: '' } }], plan: { overlap: 9, confidence: 'Высокая', clicks: '1–2' }, strategy: 'СЕРВЕРНАЯ СТРАТЕГИЯ', source: 'claude' };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
}

// ---- app globals the client monkey-patches ----
const ctx = {
  console,
  window: {},
  localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })(),
  document: (function () {
    var caps = [];
    return {
      addEventListener(type, fn, capture) { if (type === 'click' && capture) caps.push(fn); },
      getElementById() { return null; },
      _dispatchClick(dataAct) {
        var el = { getAttribute(k) { return k === 'data-act' ? dataAct : null; }, closest(sel) { return /data-act/.test(sel) ? el : null; } };
        var ev = { target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
        caps.forEach(function (f) { f(ev); });
        return ev;
      },
    };
  })(),
  fetch: mockFetch,
  setTimeout,
  // app state + functions:
  S: { brand: { desc: 'Бренд «NORD»', name: 'NORD' }, vertical: 'fashion', brief: { budget: 200000, exclude: [], goal: 'Продажи', geo: 'РФ' }, saved: [], favs: [], plan: {}, currentPlanId: 'p1', channels: [] },
  DB: { set(k, v) { underlying.dbset = (underlying.dbset || 0) + 1; } },
  CURRENT: 'onboard',
  render() { underlying.render = (underlying.render || 0) + 1; },
  postRender() {},
  buildPlan() { underlying.buildPlan = (underlying.buildPlan || 0) + 1; },
  savePlan() { underlying.savePlan = (underlying.savePlan || 0) + 1; },
  strategyText() { return 'ЛОКАЛЬНАЯ СТРАТЕГИЯ'; },
};
ctx.globalThis = ctx;
vm.createContext(ctx);

const code = fs.readFileSync(path.join(__dirname, 'public', 'bradar-api.js'), 'utf8');
vm.runInContext(code, ctx);

// let the microtasks (config/state fetches) settle
setTimeout(() => {
  const results = [];
  const has = pathArg => calls.some(c => c.path === pathArg);
  results.push(['calls /api/config on load', has('/api/config')]);
  results.push(['calls /api/state on load', has('/api/state')]);
  results.push(['exposes window.BRADAR', !!ctx.window.BRADAR]);

  // hydrate updated S.saved/S.favs from server
  results.push(['hydrated saved from server', ctx.S.saved.length === 1 && ctx.S.saved[0].brand === 'SkillUp']);
  results.push(['hydrated favs from server', ctx.S.favs.length === 1]);

  // savePlan wrapped → posts to /api/plans
  ctx.savePlan();
  results.push(['savePlan still calls original', underlying.savePlan === 1]);
  results.push(['savePlan POSTs /api/plans', calls.some(c => c.path === '/api/plans' && c.method === 'POST')]);

  // DB.set('favs') wrapped → PUT /api/favs
  ctx.DB.set('favs', [{ id: 'x' }]);
  results.push(['DB.set calls original', underlying.dbset === 1]);
  results.push(['DB.set favs PUTs /api/favs', calls.some(c => c.path === '/api/favs' && c.method === 'PUT')]);

  // buildPlan wrapped → original + POST /api/analyze
  ctx.buildPlan();
  results.push(['buildPlan calls original', underlying.buildPlan === 1]);

  // strategyText prefers server strategy when present
  ctx.S.plan.strategy = 'СЕРВЕРНАЯ СТРАТЕГИЯ';
  results.push(['strategyText prefers server strategy', ctx.strategyText() === 'СЕРВЕРНАЯ СТРАТЕГИЯ']);
  ctx.S.plan.strategy = null;
  results.push(['strategyText falls back to local', ctx.strategyText() === 'ЛОКАЛЬНАЯ СТРАТЕГИЯ']);

  // ---- Stars paywall ----
  results.push(['exposes isPro/buyPro', typeof ctx.window.BRADAR.isPro === 'function' && typeof ctx.window.BRADAR.buyPro === 'function']);
  results.push(['not PRO by default', ctx.window.BRADAR.isPro() === false]);
  // gated click while online + not PRO → prevented + creates invoice
  var ev = ctx.document._dispatchClick('download');
  results.push(['gated action prevented for non-PRO', ev.defaultPrevented === true]);
  var afterGate = calls.some(c => c.path === '/api/invoice' && c.method === 'POST');
  results.push(['gated action requests invoice', afterGate]);
  // once PRO, the same action is NOT gated
  ctx.window.BRADAR.config.pro = { pro_export: true };
  results.push(['isPro true after grant', ctx.window.BRADAR.isPro() === true]);
  var ev2 = ctx.document._dispatchClick('download');
  results.push(['PRO action not prevented', ev2.defaultPrevented === false]);

  setTimeout(() => {
    results.push(['buildPlan POSTs /api/analyze', calls.some(c => c.path === '/api/analyze' && c.method === 'POST')]);
    const pass = results.filter(r => r[1]).length, total = results.length;
    console.log('\nBRADAR client integration test');
    results.forEach(r => console.log(`  ${r[1] ? '✓' : '✗ FAIL'}  ${r[0]}`));
    console.log(`\n${pass}/${total} passed`);
    process.exit(pass === total ? 0 : 1);
  }, 20);
}, 30);
