'use strict';
/* ============================================================================
 * BRADAR Telegram bot — launches the Mini App and handles Stars payments.
 * Pure Node, no deps. Needs BOT_TOKEN and APP_URL (https URL of the mini-app).
 *
 *   node bot.js                 long-poll updates (dev; no public webhook needed)
 *   node bot.js setmenu         set the chat "menu button" to open the Mini App
 *   node bot.js setwebhook URL  route updates to your server /api/telegram/webhook
 *   node bot.js delwebhook      remove the webhook (needed before long-poll)
 *   node bot.js setcommands     register /start
 *
 * In long-poll mode the bot also answers pre-checkout and grants PRO on payment,
 * so Stars work in dev without a public webhook. In production prefer setwebhook
 * (the server handles payments) + setmenu.
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
(function loadEnv() {
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
})();

const store = require('./store');
const { untilFor } = require('./products');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_URL = process.env.APP_URL || process.env.MINIAPP_URL || '';

async function tg(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN not set');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
  });
  return res.json();
}

// ---- pure logic (unit-tested in test-bot.js) --------------------------------
function startKeyboard() {
  return { inline_keyboard: [[{ text: '📡 Открыть BRADAR', web_app: { url: APP_URL } }]] };
}
/** Map an incoming update to a single Bot API action (or null). Also applies
 *  side effects (granting PRO) for successful payments. */
function handleUpdate(upd) {
  if (upd.message && typeof upd.message.text === 'string' && /^\/start\b/.test(upd.message.text)) {
    return {
      method: 'sendMessage', chat_id: upd.message.chat.id,
      text: 'BRADAR — подбираем Telegram-каналы под ваш бренд и собираем медиаплан.\nОпишите бренд своими словами — и мы предложим каналы, объясним выбор и покажем риски.',
      reply_markup: startKeyboard(),
    };
  }
  if (upd.pre_checkout_query) {
    return { method: 'answerPreCheckoutQuery', pre_checkout_query_id: upd.pre_checkout_query.id, ok: true };
  }
  if (upd.message && upd.message.successful_payment) {
    const sp = upd.message.successful_payment;
    const uid = String(upd.message.from.id);
    store.grant(uid, sp.invoice_payload, untilFor(sp.invoice_payload), sp.telegram_payment_charge_id);
    return { method: 'sendMessage', chat_id: upd.message.chat.id, text: 'Оплата получена — BRADAR PRO активирован. Спасибо!' };
  }
  return null;
}

async function dispatch(upd) {
  const action = handleUpdate(upd);
  if (!action) return;
  const { method, ...payload } = action;
  await tg(method, payload);
}

// ---- runners ----------------------------------------------------------------
async function poll() {
  if (!BOT_TOKEN) return fail('BOT_TOKEN not set');
  if (!APP_URL) console.warn('warning: APP_URL not set — the "Открыть BRADAR" button will be empty');
  console.log('BRADAR bot: long-polling…  (Ctrl-C to stop)');
  // ensure no webhook is set (long-poll and webhook are mutually exclusive)
  try { await tg('deleteWebhook', {}); } catch (e) {}
  let offset = 0;
  for (;;) {
    let r;
    try { r = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'pre_checkout_query'] }); }
    catch (e) { console.error('getUpdates:', e.message); await sleep(2000); continue; }
    if (r && r.ok) for (const upd of r.result) { offset = upd.update_id + 1; try { await dispatch(upd); } catch (e) { console.error('dispatch:', e.message); } }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg) { console.error('error: ' + msg); process.exit(1); }

async function main() {
  const cmd = process.argv[2] || 'poll';
  if (!BOT_TOKEN && cmd !== 'help') return fail('BOT_TOKEN not set (put it in .env)');
  if (cmd === 'poll') return poll();
  if (cmd === 'setmenu') {
    if (!APP_URL) return fail('APP_URL not set');
    console.log(await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'BRADAR', web_app: { url: APP_URL } } }));
    return;
  }
  if (cmd === 'setwebhook') {
    const url = process.argv[3]; if (!url) return fail('usage: node bot.js setwebhook https://you/api/telegram/webhook');
    console.log(await tg('setWebhook', { url, allowed_updates: ['message', 'pre_checkout_query'] }));
    return;
  }
  if (cmd === 'delwebhook') { console.log(await tg('deleteWebhook', {})); return; }
  if (cmd === 'setcommands') { console.log(await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть BRADAR' }] })); return; }
  console.log('commands: poll | setmenu | setwebhook <url> | delwebhook | setcommands');
}

if (require.main === module) main().catch(e => fail(e.message));

module.exports = { handleUpdate, startKeyboard, dispatch };
