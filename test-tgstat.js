'use strict';
/* TGStat matcher + competitor-by-posts assertions (pure, no network). Run: node test-tgstat.js */
const tg = require('./tgstat');
const results = [];
const ok = (n, c) => results.push([n, !!c]);

const items = [
  { username: 'koja_i_pravda', title: 'Кожа и правда', participants_count: 79000 },
  { username: 'other', title: 'Совсем другой канал', participants_count: 500000 },
  { username: 'koja_fake', title: 'Кожа и правда', participants_count: 12 },
];
const m1 = tg.bestMatch(items, 'Кожа и правда', 78400);
ok('resolves exact title', m1 && m1.username === 'koja_i_pravda');
ok('builds t.me link', m1 && m1.link === 'https://t.me/koja_i_pravda');
ok('no match → null', tg.bestMatch(items, 'Финансовый вестник', 40000) === null);
ok('empty username ignored', tg.bestMatch([{ username: '', title: 'Кожа и правда', participants_count: 78000 }], 'Кожа и правда', 78000) === null);

// --- competitor-by-posts ---
const shopPosts = 'Новинка! Куртка из эко-кожи — цена 4990 ₽, в наличии. Оформить заказ по промокоду SALE. Успей купить, распродажа! Каталог в закрепе.';
const contentPosts = 'Разбираем, как ухаживать за кожаными вещами зимой. Личный опыт и советы стилиста — почему базовый гардероб экономит время и нервы.';
ok('shop posts → competitor', tg.isSellerByPosts(shopPosts) === true);
ok('content posts → not competitor', tg.isSellerByPosts(contentPosts) === false);
ok('commerceHits counts signals', tg.commerceHits(shopPosts) >= 5);
ok('empty posts → not competitor', tg.isSellerByPosts('') === false);

const pass = results.filter(r => r[1]).length;
console.log('\nBRADAR tgstat test');
results.forEach(r => console.log(`  ${r[1] ? '✓' : '✗ FAIL'}  ${r[0]}`));
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
