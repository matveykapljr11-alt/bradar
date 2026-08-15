'use strict';
/* Auth / initData assertions — drives the real server.handler with mock req/res.
 * No network (BOT_TOKEN set, only /api/state which hits the in-memory store).
 * Run: node test-auth.js */
const crypto = require('crypto');

// Configure BEFORE requiring the server (it reads BOT_TOKEN / DEV_AUTH at load).
const TOKEN = '123456:TEST-BOT-TOKEN';
process.env.BOT_TOKEN = TOKEN;
process.env.ALLOW_INSECURE_AUTH = '';        // enforce real auth
delete process.env.UPSTASH_REDIS_REST_URL;   // use in-memory file backend
delete process.env.KV_REST_API_URL;

const { handler } = require('./server');
const store = require('./store');
const results = [];
const ok = (n, c) => results.push([n, !!c]);

// Build a valid initData string signed exactly the way verifyInitData checks it.
function signInitData(token, fields) {
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const usp = new URLSearchParams(fields); usp.set('hash', hash);
  return usp.toString();
}

// Minimal mock req/res; returns {code, body}. `body` (object) is exposed as
// req.body, which readBody() returns directly (mirrors @vercel/node).
function call(method, path, headers, body) {
  return new Promise((resolve) => {
    const req = { method, url: path, headers: Object.assign({ host: 'localhost' }, headers || {}), body };
    const res = {
      _code: 0, _body: '',
      writeHead(code) { this._code = code; return this; },
      end(b) { this._body = b || ''; resolve({ code: this._code, body: this._body }); },
    };
    handler(req, res);
  });
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 4242, first_name: 'Test' });

  // 1) no initData → 401
  ok('no initData → 401', (await call('GET', '/api/state')).code === 401);

  // 2) valid initData → 200 with state shape
  const good = signInitData(TOKEN, { query_id: 'q', user, auth_date: String(now) });
  const r2 = await call('GET', '/api/state', { 'x-init-data': good });
  ok('valid initData → 200', r2.code === 200);
  ok('valid initData returns state', /"plans"/.test(r2.body) && /"favs"/.test(r2.body));

  // 3) tampered hash → 401
  const tampered = good.replace(/hash=[a-f0-9]+/, m => 'hash=' + m.slice(5).split('').reverse().join(''));
  ok('tampered hash → 401', (await call('GET', '/api/state', { 'x-init-data': tampered })).code === 401);

  // 4) expired auth_date (>24h) → 401
  const stale = signInitData(TOKEN, { user, auth_date: String(now - 90000) });
  ok('expired auth_date → 401', (await call('GET', '/api/state', { 'x-init-data': stale })).code === 401);

  // 5) wrong token signature → 401
  const wrong = signInitData('999:OTHER', { user, auth_date: String(now) });
  ok('wrong-token signature → 401', (await call('GET', '/api/state', { 'x-init-data': wrong })).code === 401);

  // 6) source-check disabled without ADMIN_TOKEN → 404
  ok('source-check gated without admin token', (await call('GET', '/api/source-check?q=x')).code === 404);

  // 7) webhook rejects bad secret when TELEGRAM_WEBHOOK_SECRET is set
  process.env.TELEGRAM_WEBHOOK_SECRET = 's3cr3t';
  const wh = await call('POST', '/api/telegram/webhook', { 'x-telegram-bot-api-secret-token': 'nope' });
  ok('webhook rejects bad secret → 401', wh.code === 401);

  // 8) fail-closed: a forged payment with NO secret configured grants nothing
  process.env.TELEGRAM_WEBHOOK_SECRET = '';
  const payUid = 'whpay' + now;
  const payUpd = { message: { chat: { id: 1 }, from: { id: payUid }, successful_payment: { invoice_payload: 'pro_export', telegram_payment_charge_id: 'x' } } };
  await call('POST', '/api/telegram/webhook', {}, payUpd);
  ok('unauthenticated webhook grants nothing', (await store.getGrants(String(payUid))).pro_export !== true);

  // 9) with the secret set AND echoed, a real payment does grant
  process.env.TELEGRAM_WEBHOOK_SECRET = 'sek';
  await call('POST', '/api/telegram/webhook', { 'x-telegram-bot-api-secret-token': 'sek' }, payUpd);
  ok('authenticated webhook grants PRO', (await store.getGrants(String(payUid))).pro_export === true);

  const pass = results.filter(r => r[1]).length;
  console.log('\nBRADAR auth test');
  results.forEach(r => console.log(`  ${r[1] ? '✓' : '✗ FAIL'}  ${r[0]}`));
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
