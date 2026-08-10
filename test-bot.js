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

// pre_checkout → approve
const b = bot.handleUpdate({ pre_checkout_query: { id: 'pcq1' } });
ok('pre_checkout approved', b && b.method === 'answerPreCheckoutQuery' && b.ok === true && b.pre_checkout_query_id === 'pcq1');

// successful_payment → grant PRO + confirmation
const uid = 'bottest' + Math.floor(Date.now() / 1000);
const c = bot.handleUpdate({ message: { chat: { id: 9 }, from: { id: uid }, successful_payment: { invoice_payload: 'pro_export', telegram_payment_charge_id: 'chg1' } } });
ok('payment sends confirmation', c && c.method === 'sendMessage' && /PRO/.test(c.text));
ok('payment grants pro_export', store.getGrants(String(uid)).pro_export === true);

// unrelated update → no action
ok('ignores other updates', bot.handleUpdate({ message: { chat: { id: 1 }, text: 'привет', from: { id: 1 } } }) === null);

const pass = results.filter(r => r[1]).length;
console.log('\nBRADAR bot test');
results.forEach(r => console.log(`  ${r[1] ? '✓' : '✗ FAIL'}  ${r[0]}`));
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
