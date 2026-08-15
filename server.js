'use strict';
/* ============================================================================
 * BRADAR backend — pure Node (no deps), Node 18+.
 *
 *   node server.js
 *
 * Serves the mini-app, validates Telegram initData, persists plans/favourites
 * per user, runs the media-plan engine (optionally Claude-powered), and has a
 * Telegram Stars payment scaffold. Configure via .env / environment:
 *
 *   BOT_TOKEN            Telegram bot token  (enables initData auth + payments)
 *   ANTHROPIC_API_KEY    enables real AI analysis in /api/analyze (optional)
 *   ANTHROPIC_MODEL      default claude-sonnet-5
 *   PORT                 default 8080
 *   MINIAPP_HTML         path to the mini-app html (default ../bradar.html)
 *   ALLOW_INSECURE_AUTH  "1" to accept requests without valid initData (LOCAL DEV ONLY)
 * ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// load .env if present (tiny parser, no deps)
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
})();

const engine = require('./engine');
const store = require('./store');
const ai = require('./ai');
const source = require('./source');
const { PRODUCTS, untilFor } = require('./products');

const PORT = Number(process.env.PORT) || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEV_AUTH = process.env.ALLOW_INSECURE_AUTH === '1' || !BOT_TOKEN;
function resolveMiniapp() {
  if (process.env.MINIAPP_HTML) return process.env.MINIAPP_HTML;
  const cands = [
    path.join(__dirname, '..', 'bradar.html'),          // local dev: the live source file
    path.join(process.cwd(), 'bradar.html'),
    path.join(__dirname, 'bradar.html'),
    path.join(process.cwd(), 'public', 'bradar.html'),  // deploy (Vercel): bundled snapshot
    path.join(__dirname, 'public', 'bradar.html'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return cands[cands.length - 1];
}
const MINIAPP_HTML = resolveMiniapp();

/* ---------------- Telegram initData validation ---------------- */
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const check = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (check !== hash) return null;
  const authDate = Number(params.get('auth_date')) || 0;
  if (Date.now() / 1000 - authDate > 86400) return null; // 24h freshness
  try { return JSON.parse(params.get('user') || 'null'); } catch (e) { return null; }
}

function authUser(req) {
  const initData = req.headers['x-init-data'] || '';
  if (BOT_TOKEN) {
    const u = verifyInitData(initData);
    if (u && u.id) return { id: String(u.id), name: u.first_name || u.username || 'user', verified: true };
    if (!DEV_AUTH) return null;
  }
  // dev fallback — stable per-browser id passed by the client, else "dev"
  const dev = req.headers['x-dev-user'] || 'dev';
  return { id: 'dev:' + String(dev).slice(0, 40), name: 'dev', verified: false };
}

/* ---------------- helpers ---------------- */
function send(res, code, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'content-type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, headers || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    // On Vercel (@vercel/node) the JSON body may already be parsed into req.body.
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); } }
      return resolve(req.body);
    }
    let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}

/* ---------------- Telegram Bot API (payments) ---------------- */
async function tg(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN not set');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}

/* ---------------- static: serve mini-app with injected client ---------------- */
const CLIENT_JS = path.join(__dirname, 'public', 'bradar-api.js');
function serveApp(res) {
  let html;
  try { html = fs.readFileSync(MINIAPP_HTML, 'utf8'); }
  catch (e) { return send(res, 500, 'mini-app html not found at ' + MINIAPP_HTML); }
  // inline the backend-integration script just before </body> (mini-app file stays untouched on disk).
  // Inlining (vs a <script src>) means one request and works even where a preview proxy
  // won't fetch relative subresources.
  let client = '';
  try { client = fs.readFileSync(CLIENT_JS, 'utf8'); } catch (e) {}
  const inject = '\n<script>\n' + client + '\n</script>\n';
  // insert before the LAST </body> — the app's own JS contains a literal "</body>"
  // (print-PDF helper), so a first-match replace would land inside the script.
  const i = html.lastIndexOf('</body>');
  html = i >= 0 ? html.slice(0, i) + inject + html.slice(i) : html + inject;
  send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
}

/* ---------------- router ---------------- */
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (process.env.ACCESS_LOG === '1' && (p.startsWith('/api/') || p === '/' || p === '/bradar-api.js')) console.log(new Date().toISOString().slice(11, 19), req.method, p);
  try {
    // static
    if (p === '/' || p === '/index.html') return serveApp(res);
    if (p === '/bradar-api.js') {
      try { return send(res, 200, fs.readFileSync(CLIENT_JS, 'utf8'), { 'content-type': 'application/javascript; charset=utf-8' }); }
      catch (e) { return send(res, 404, '// not found'); }
    }
    if (p === '/health') return send(res, 200, { ok: true, ai: ai.enabled(), aiProvider: ai.provider(), dataSource: source.enabled() ? 'telemetr' : 'seed', storage: store.usingRedis ? 'redis' : 'file' });
    // admin-only diagnostic: verifies the real channel source actually returns data.
    // Gated behind ADMIN_TOKEN so it can't be used to burn Telemetr quota or probe
    // the upstream shape publicly. Disabled entirely when ADMIN_TOKEN is unset.
    if (p === '/api/source-check') {
      const admin = process.env.ADMIN_TOKEN || '';
      const tok = url.searchParams.get('token') || req.headers['x-admin-token'] || '';
      if (!admin || tok !== admin) return send(res, 404, 'not found');
      if (url.searchParams.get('raw')) {
        try { return send(res, 200, await source.probe(url.searchParams.get('q'))); }
        catch (e) { return send(res, 200, { error: String(e.message || e) }); }
      }
      const out = { enabled: source.enabled(), count: 0, names: [], error: null };
      try {
        const c = await source.fetchCandidates({ desc: url.searchParams.get('q') || 'косметика уход кожа', vertical: url.searchParams.get('v') || 'beauty' });
        out.count = c ? c.length : 0;
        out.names = (c || []).slice(0, 6).map(x => x.name + ' (' + x.subs + ')');
      } catch (e) { out.error = String(e.message || e); }
      return send(res, 200, out);
    }

    // Telegram webhook (payments). MUST be authenticated: Telegram echoes the
    // secret_token we set via setWebhook in this header. Without it, anyone could
    // POST a fake successful_payment and grant themselves PRO for free.
    if (p === '/api/telegram/webhook' && req.method === 'POST') {
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
      if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) return send(res, 401, { error: 'bad secret' });
      const upd = await readBody(req);
      if (upd.pre_checkout_query) {
        // only approve payloads we actually sell
        const okProd = !!PRODUCTS[upd.pre_checkout_query.invoice_payload];
        await tg('answerPreCheckoutQuery', okProd
          ? { pre_checkout_query_id: upd.pre_checkout_query.id, ok: true }
          : { pre_checkout_query_id: upd.pre_checkout_query.id, ok: false, error_message: 'Товар недоступен' });
      } else if (upd.message && typeof upd.message.text === 'string' && /^\/start\b/.test(upd.message.text)) {
        const app = process.env.APP_URL || '';
        await tg('sendMessage', {
          chat_id: upd.message.chat.id,
          text: 'BRADAR — подбираем Telegram-каналы под ваш бренд и собираем медиаплан.\nНажмите кнопку ниже или значок меню слева от поля ввода, чтобы открыть приложение.',
          reply_markup: app ? { inline_keyboard: [[{ text: '📡 Открыть BRADAR', web_app: { url: app } }]] } : undefined,
        });
      } else if (upd.message && upd.message.successful_payment) {
        const sp = upd.message.successful_payment;
        const uid = String(upd.message.from.id);
        // fail-closed: NEVER grant from an unauthenticated webhook. `secret` truthy
        // here means TELEGRAM_WEBHOOK_SECRET is set AND was verified above — so a
        // forged successful_payment (no secret configured) grants nothing.
        if (!secret) { if (process.env.ACCESS_LOG === '1') console.warn('[webhook] payment ignored — TELEGRAM_WEBHOOK_SECRET not set'); }
        else if (PRODUCTS[sp.invoice_payload]) await store.grant(uid, sp.invoice_payload, untilFor(sp.invoice_payload), sp.telegram_payment_charge_id);
      }
      return send(res, 200, { ok: true });
    }

    // everything below /api requires an authenticated user
    if (p.startsWith('/api/')) {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'unauthorized' });

      if (p === '/api/config' && req.method === 'GET') {
        return send(res, 200, {
          ai: ai.enabled(), aiProvider: ai.provider(), model: ai.enabled() ? ai.model() : null,
          dataSource: source.enabled() ? 'telemetr' : 'seed',
          catalog: engine.catalogStats(), requiresAuth: !!BOT_TOKEN, devAuth: DEV_AUTH,
          products: PRODUCTS, user: { id: user.id, name: user.name, verified: user.verified },
          pro: await store.getGrants(user.id),
        });
      }
      if (p === '/api/analyze' && (req.method === 'POST' || req.method === 'GET')) {
        const b = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
        let candidates = null;
        try { candidates = await source.fetchCandidates(b); } catch (e) {}
        let plan = engine.buildPlan(Object.assign({}, b, { candidates }));
        plan = await ai.enrich(b, plan);
        return send(res, 200, plan);
      }
      if (p === '/api/alternatives' && req.method === 'POST') {
        const b = await readBody(req);
        return send(res, 200, {
          alternatives: engine.altsFor(b.vertical, b.planChannelIds || [], b.channelId, b.cpm || 0, b.match || 0, b.reach || 0),
        });
      }
      if (p === '/api/state' && req.method === 'GET') {
        return send(res, 200, await store.getState(user.id));
      }
      if (p === '/api/plans' && req.method === 'POST') {
        const b = await readBody(req);
        return send(res, 200, await store.savePlan(user.id, b));
      }
      if (p.startsWith('/api/plans/') && req.method === 'DELETE') {
        return send(res, 200, await store.deletePlan(user.id, decodeURIComponent(p.split('/').pop())));
      }
      if (p === '/api/favs' && req.method === 'PUT') {
        const b = await readBody(req);
        return send(res, 200, await store.setFavs(user.id, b.favs || []));
      }
      if (p === '/api/invoice' && req.method === 'POST') {
        const b = await readBody(req);
        const prod = PRODUCTS[b.product];
        if (!prod) return send(res, 400, { error: 'unknown product' });
        if (!BOT_TOKEN) return send(res, 501, { error: 'payments require BOT_TOKEN' });
        const r = await tg('createInvoiceLink', {
          title: prod.title, description: prod.description, payload: b.product,
          provider_token: '', currency: 'XTR', prices: [{ label: prod.title, amount: prod.stars }],
        });
        if (!r.ok) return send(res, 502, { error: 'telegram', detail: r.description });
        return send(res, 200, { link: r.result });
      }
      return send(res, 404, { error: 'not found' });
    }

    send(res, 404, 'not found');
  } catch (e) {
    send(res, 500, { error: 'server', detail: String(e.message || e) });
  }
}

// Run as a normal always-on server when executed directly (local / Render / VPS).
// On Vercel, api/index.js imports { handler } and the platform runs it per-request.
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`BRADAR backend on http://localhost:${PORT}`);
    console.log(`  auth:      ${BOT_TOKEN ? 'Telegram initData' : 'DEV (no BOT_TOKEN)'}${DEV_AUTH && BOT_TOKEN ? ' + insecure fallback' : ''}`);
    console.log(`  AI:        ${ai.enabled() ? ai.provider() + ' (' + ai.model() + ')' : 'engine only (no XAI_API_KEY / ANTHROPIC_API_KEY)'}`);
    console.log(`  catalog:   ${JSON.stringify(engine.catalogStats())}`);
    console.log(`  mini-app:  ${MINIAPP_HTML}`);
  });
}

module.exports = { handler };
