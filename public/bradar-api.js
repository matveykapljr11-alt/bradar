/* ============================================================================
 * BRADAR client integration — injected by the backend before </body>.
 * Progressive enhancement: the mini-app keeps working exactly as the offline
 * prototype, and when served by the backend it additionally
 *   • authenticates via Telegram initData,
 *   • stores plans/favourites server-side (multi-device),
 *   • upgrades the plan with the authoritative engine / Claude via /api/analyze.
 * It only monkey-patches globals the app already exposes; if anything is
 * missing it silently no-ops.
 * ========================================================================== */
(function () {
  if (window.__BRADAR_API__) return; window.__BRADAR_API__ = true;

  var DEV = localStorage.getItem('bradar_dev');
  if (!DEV) { DEV = 'd' + Math.random().toString(36).slice(2, 10); localStorage.setItem('bradar_dev', DEV); }

  function initData() { try { return (window.Telegram && Telegram.WebApp && Telegram.WebApp.initData) || ''; } catch (e) { return ''; } }
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, Object.assign({}, opts, {
      headers: Object.assign({ 'content-type': 'application/json', 'x-init-data': initData(), 'x-dev-user': DEV }, opts.headers || {}),
    })).then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw e; }); });
  }
  window.BRADAR = { api: api, online: false, config: null };

  function reRender(onlyOn) {
    try {
      if (typeof render !== 'function') return;
      if (onlyOn && onlyOn.indexOf(CURRENT) < 0) return;
      render();
      var el = document.getElementById('screen-' + CURRENT); if (el) el.classList.add('active');
      if (typeof postRender === 'function') postRender();
    } catch (e) {}
  }

  /* --- config + hydrate state from server --- */
  api('/api/config').then(function (cfg) {
    window.BRADAR.online = true; window.BRADAR.config = cfg;
  }).catch(function () {});

  function mergeById(local, remote) {
    var byId = {};
    (local || []).forEach(function (p) { if (p && p.id) byId[p.id] = p; });
    (remote || []).forEach(function (p) { if (p && p.id) byId[p.id] = p; });
    return Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return (b.date || 0) - (a.date || 0); });
  }
  api('/api/state').then(function (st) {
    if (typeof S === 'undefined') return;
    // merge, don't overwrite — a failed server sync must not wipe local saves
    if (st && Array.isArray(st.plans)) S.saved = mergeById(S.saved, st.plans);
    if (st && Array.isArray(st.favs)) S.favs = mergeById(S.favs, st.favs);
    reRender(['onboard', 'saved', 'favorites', 'profile']);
  }).catch(function () {});

  /* --- mirror favourites writes to the server --- */
  try {
    if (typeof DB !== 'undefined' && DB && DB.set) {
      var _set = DB.set.bind(DB);
      DB.set = function (k, val) {
        _set(k, val);
        if (k === 'favs') api('/api/favs', { method: 'PUT', body: JSON.stringify({ favs: val }) }).catch(function () {});
      };
    }
  } catch (e) {}

  /* --- persist saved plans to the server --- */
  try {
    if (typeof savePlan === 'function') {
      var _save = savePlan;
      savePlan = function () {
        _save.apply(this, arguments);
        try {
          var rec = S.saved.filter(function (p) { return p.id === S.currentPlanId; })[0];
          if (rec) api('/api/plans', { method: 'POST', body: JSON.stringify(rec) }).catch(function () {});
        } catch (e) {}
      };
    }
  } catch (e) {}

  /* --- delete on server too (delete is handled inline in the app's click) --- */
  document.addEventListener('click', function (e) {
    var d = e.target.closest && e.target.closest('[data-del-plan]');
    if (d) api('/api/plans/' + encodeURIComponent(d.getAttribute('data-del-plan')), { method: 'DELETE' }).catch(function () {});
  }, true);

  /* --- progressive upgrade of the plan through the server engine / Claude --- */
  try {
    if (typeof buildPlan === 'function') {
      var _build = buildPlan;
      buildPlan = function () {
        _build.apply(this, arguments); // real-only: sets a "searching" state, no seed
        try {
          var body = { desc: S.brand.desc, brand: S.brand.name, vertical: S.vertical, budget: S.brief.budget, channels: S.brief.channels, exclude: S.brief.exclude, goal: S.brief.goal, geo: S.brief.geo, geoCity: S.brief.geoCity, audience: S.brief.audience };
          api('/api/analyze', { method: 'POST', body: JSON.stringify(body) }).then(function (plan) {
            S._searching = false;
            if (plan && Array.isArray(plan.channels) && plan.channels.length) {
              S.channels = plan.channels;
              S.pool = Array.isArray(plan.pool) ? plan.pool : [];   // real replacement options
              if (plan.vertical) S.vertical = plan.vertical;        // sync AI-resolved niche → tags/creative
              S._noData = false;
              if (plan.plan) { S.plan.overlap = plan.plan.overlap; S.plan.confidence = plan.plan.confidence; S.plan.clicks = plan.plan.clicks; }
              if (plan.strategy) S.plan.strategy = plan.strategy;
            } else {
              S.channels = []; S.pool = []; S._noData = true;        // real search found nothing — honest empty state
            }
            window.BRADAR.lastSource = plan && plan.source;
            reRender(['analysis', 'plan']);
          }).catch(function () { try { S._searching = false; S._noData = true; reRender(['analysis', 'plan']); } catch (e) {} });
        } catch (e) { try { S._searching = false; } catch (e2) {} }
      };
    }
  } catch (e) {}

  /* --- prefer AI-written strategy text when present --- */
  try {
    if (typeof strategyText === 'function') {
      var _st = strategyText;
      strategyText = function () { try { return (S.plan && S.plan.strategy) ? S.plan.strategy : _st(); } catch (e) { return _st(); } };
    }
  } catch (e) {}

  /* --- Telegram Stars paywall: gate export / contacts behind PRO when online --- */
  function isPro() { try { return !!(window.BRADAR.config && window.BRADAR.config.pro && window.BRADAR.config.pro.pro_export); } catch (e) { return false; } }
  function proPrice() { try { return window.BRADAR.config.products.pro_export.stars || 150; } catch (e) { return 150; } }
  function refreshConfig() { api('/api/config').then(function (c) { window.BRADAR.config = c; }).catch(function () {}); }
  function toastMsg(m) { try { if (typeof toast === 'function') toast(m); } catch (e) {} }
  function buyPro() {
    api('/api/invoice', { method: 'POST', body: JSON.stringify({ product: 'pro_export' }) }).then(function (r) {
      if (r && r.link && window.Telegram && Telegram.WebApp && Telegram.WebApp.openInvoice) {
        Telegram.WebApp.openInvoice(r.link, function (status) {
          if (status === 'paid') { refreshConfig(); toastMsg('BRADAR PRO активирован — спасибо!'); }
        });
      } else { toastMsg('Оплата Stars доступна внутри Telegram'); }
    }).catch(function () { toastMsg('Не удалось создать счёт'); });
  }
  window.BRADAR.isPro = isPro; window.BRADAR.buyPro = buyPro;
  var GATED = { download: 1, contacts: 1, requests: 1 };
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]'); if (!el) return;
    var act = el.getAttribute('data-act');
    if (GATED[act] && window.BRADAR.online && !isPro()) {
      e.preventDefault(); e.stopPropagation();
      var msg = 'Экспорт и контакты — в BRADAR PRO (' + proPrice() + ' ⭐). Оформить?';
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.showConfirm) {
        Telegram.WebApp.showConfirm(msg, function (ok) { if (ok) buyPro(); });
      } else { toastMsg('BRADAR PRO — ' + proPrice() + ' ⭐: экспорт и контакты'); buyPro(); }
    }
  }, true);
})();
