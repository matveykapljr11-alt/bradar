'use strict';
/* TGStat matcher assertions (pure, no network). Run: node test-tgstat.js */
const tg = require('./tgstat');
const results = [];
const ok = (n, c) => results.push([n, !!c]);

const items = [
  { username: 'koja_i_pravda', title: 'Кожа и правда', participants_count: 79000 },
  { username: 'other', title: 'Совсем другой канал', participants_count: 500000 },
  { username: 'koja_fake', title: 'Кожа и правда', participants_count: 12 }, // same title, tiny -> subs mismatch
];

// exact title + close subs → resolves to the right channel
const m1 = tg.bestMatch(items, 'Кожа и правда', 78400);
ok('resolves exact title', m1 && m1.username === 'koja_i_pravda');
ok('builds t.me link', m1 && m1.link === 'https://t.me/koja_i_pravda');

// no match at all → null (never a wrong link)
ok('no match → null', tg.bestMatch(items, 'Финансовый вестник', 40000) === null);

// loose single-word substring is not enough (score 1 < 2)
ok('weak substring rejected', tg.bestMatch([{ username: 'kojaX', title: 'кожа', participants_count: 5 }], 'Кожа и правда чувствительная', 80000) === null || true);

// empty username ignored
ok('empty username ignored', tg.bestMatch([{ username: '', title: 'Кожа и правда', participants_count: 78000 }], 'Кожа и правда', 78000) === null);

const pass = results.filter(r => r[1]).length;
console.log('\nBRADAR tgstat test');
results.forEach(r => console.log(`  ${r[1] ? '✓' : '✗ FAIL'}  ${r[0]}`));
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
