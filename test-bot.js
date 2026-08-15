'use strict';
/* Bot logic assertions (no network). Run: node test-bot.js */
process.env.APP_URL = 'https://example.test/app';
const bot = require('./bot');
const store = require('./store');
const results = [];
const ok = (n, c) => results.push([n, !!c]);

// /start → sendMessage with a WebApp launch button
const a = bot.handleUpdate({ message: { chat: { id: 1 }, text: '/start', from: { id: 1 } } });
ok('/start sends a message', a && a.method === 'sendMessage' && a.chat_id === 1);
ok('/start has WebApp button', a && a.reply_markup.inline_keyboard[0][0].web_app.url === 'https://example.test/app');
ok('/start text mentions BRADAR', a && /BRADAR/.test(a.text));

// pre_checkout → approve a real product
const b = bot.handleUpdate({ pre_checkout_query: { id: 'pcq1', invoice_payload: 'pro_export' } });
ok('pre_checkout approved', b && b.method === 'answerPreCheckoutQuery' && b.ok === true && b.pre_checkout_query_id === 'pcq1');

// pre_checkout → reject an unknown/forged product
const bx = bot.handleUpdate({ pre_checkout_query: { id: 'pcq2', invoice_payload: 'free_pro_haha' } });
ok('pre_checkout rejects unknown product', bx && bx.ok === false && /недоступен/i.test(bx.error_message || ''));

(async () => {
  // successful_payment → grant PRO (applyPayment) + confirmation (handleUpdate)
  const uid = 'bottest' + Math.floor(Date.now() / 1000);
  const upd = { message: { chat: { id: 9 }, from: { id: uid }, successful_payment: { invoice_payload: 'pro_export', telegram_payment_charge_id: 'chg1' } } };
  const c = bot.handleUpdate(upd);
  ok('payment sends confirmation', c && c.method === 'sendMessage' && /PRO/.test(c.text));
  await bot.applyPayment(upd);
  ok('payment grants pro_export', (await store.getGrants(String(uid))).pro_export === true);

  // forged payment with unknown payload → no grant
  const uid2 = 'bottest2' + Math.floor(Date.now() / 1000);
  await bot.applyPayment({ message: { chat: { id: 9 }, from: { id: uid2 }, successful_payment: { invoice_payload: 'free_pro_haha', telegram_payment_charge_id: 'chg2' } } });
  ok('forged payload grants nothing', (await store.getGrants(String(uid2))).free_pro_haha !== true);

  // unrelated update → no action
  ok('ignores other updates', bot.handleUpdate({ message: { chat: { id: 1 }, text: 'привет', from: { id: 1 } } }) === null);

  const pass = results.filter(r => r[1]).length;
  console.log('\nBRADAR bot test');
  results.forEach(r => console.log(`  ${r[1] ? '✓' : '✗ FAIL'}  ${r[0]}`));
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
