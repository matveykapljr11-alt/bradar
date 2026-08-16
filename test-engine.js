'use strict';
/* Engine assertions. Run: node test-engine.js
 * Seed catalog is production-disabled; enable it so these tests can exercise the
 * scoring/budget logic against a known pool. */
process.env.BRADAR_ALLOW_SEED = '1';
const E = require('./engine');
const results = [];
const ok = (name, cond) => results.push([name, !!cond]);

// 1. vertical detection
ok('detect beauty', E.detectVertical('уходовая косметика для чувствительной кожи') === 'beauty');
ok('detect edu', E.detectVertical('онлайн-школа английского языка') === 'edu');
ok('detect b2b', E.detectVertical('saas crm для малого бизнеса') === 'b2b');
ok('detect generic fallback', E.detectVertical('привет мир') === 'generic');

// 2. brand extraction
ok('brand from quotes', E.guessBrandName('бренд «NORD» одежды', 'x') === 'NORD');

// 3. budget scaling — prices sum exactly to the chosen budget
const p1 = E.buildPlan({ desc: 'онлайн-школа английского «SkillUp»', budget: 300000 });
ok('edu vertical', p1.vertical === 'edu');
ok('budget sums exactly', p1.channels.reduce((s, c) => s + c.price, 0) === 300000);
ok('totals.budget matches', p1.totals.budget === 300000);
ok('6 channels for non-beauty', p1.channels.length === 6);

// 3b. real-only: with seed disabled and no live candidates → honest empty plan (no fakes)
delete process.env.BRADAR_ALLOW_SEED;
const empty = E.buildPlan({ desc: 'уходовая косметика для чувствительной кожи', budget: 150000 });
ok('real-only: empty plan when no candidates', empty.noData === true && empty.channels.length === 0);
ok('real-only: still builds from live candidates', (() => {
  const cand = [{ id: 'r1', name: 'Живой канал', cat: 'Красота', topic: 'skincare', subs: 50000, match: 80, cpm: 500, reach: 12000, w: 12000, eng: '5%', adShare: '10%', real: true }];
  const pl = E.buildPlan({ desc: 'косметика', budget: 100000, candidates: cand });
  return !pl.noData && pl.channels.length === 1 && pl.channels[0].id === 'r1';
})());
process.env.BRADAR_ALLOW_SEED = '1';

// 4. exclusions remove matching topics
const pEx = E.buildPlan({ desc: 'бренд одежды', budget: 150000, exclude: ['Новости'] });
ok('excludes news topic', pEx.channels.every(c => c.topic !== 'news'));

// 5. brand-aware matching: same channel, different match for different brands
// both are beauty-vertical (mention косметика/уход) but emphasise different things
const skin = E.buildPlan({ desc: 'уходовая косметика, разбор состава для чувствительной кожи', budget: 150000 });
const life = E.buildPlan({ desc: 'уходовая косметика для женского lifestyle и осознанного потребления, забота о себе', budget: 150000 });
function matchOf(plan, id) { const c = plan.channels.find(x => x.id === id); return c ? c.match : null; }
// koja (состав/кожа) should score higher for the skincare-worded brand than for the lifestyle-worded one
ok('match is brand-specific (koja skincare>lifestyle)', matchOf(skin, 'koja') > matchOf(life, 'koja'));
// budni (женский lifestyle) should score higher for the lifestyle-worded brand
ok('match is brand-specific (budni lifestyle>skincare)', matchOf(life, 'budni') > matchOf(skin, 'budni'));
ok('matches within 45..97', skin.channels.every(c => c.match >= 45 && c.match <= 97));

// 6. beauty keeps its curated 8 (incl. the risky channel) regardless of ranking
ok('beauty has 8', skin.channels.length === 8);
ok('beauty keeps risky channel', skin.channels.some(c => c.id === 'beauty' && c.risks.length));

// 7. determinism
const a = E.buildPlan({ desc: 'уход за кожей', budget: 150000 });
const b = E.buildPlan({ desc: 'уход за кожей', budget: 150000 });
ok('deterministic', JSON.stringify(a.channels.map(c => [c.id, c.match, c.price])) === JSON.stringify(b.channels.map(c => [c.id, c.match, c.price])));

// 8. alternatives available and exclude in-plan ids
const ids = skin.channels.map(c => c.id);
const alts = E.altsFor('beauty', ids, 'beauty', 780, 71, 48900);
ok('alternatives returned', alts.length > 0);
ok('alternatives not in plan', alts.every(a => ids.indexOf(a.channel.id) < 0));

// 9. group percentages present
ok('groups sum ~100', Math.abs((p1.groups.core.pct + p1.groups.adj.pct + p1.groups.exp.pct) - 100) <= 1);

// 10. risks are computed from metrics, not hard-coded
const beautyPlan = E.buildPlan({ desc: 'уходовая косметика для чувствительной кожи', budget: 150000 });
const risky = beautyPlan.channels.find(c => c.id === 'beauty');  // adShare 27%, eng 3,4% → should be flagged
const clean = beautyPlan.channels.find(c => c.id === 'koja');    // adShare 14%, eng 6,1% → clean
ok('high-ad channel flagged (adBad)', risky && risky.adBad === true && risky.risks.length > 0);
ok('flagged channel downgraded to gold', risky && risky.vColor === 'var(--gold)');
ok('clean channel has no risks', clean && clean.risks.length === 0);
ok('risk text mentions ad share', risky && risky.risks.some(r => /реклам/i.test(r)));

const pass = results.filter(r => r[1]).length;
console.log('\nBRADAR engine test');
results.forEach(r => console.log(`  ${r[1] ? '✓' : '✗ FAIL'}  ${r[0]}`));
console.log(`\n${pass}/${results.length} passed`);
console.log('sample match (skincare brand):', E.buildPlan({ desc: 'уход за чувствительной кожей, состав' }).channels.map(c => c.name + ' ' + c.match + '%').join(' · '));
process.exit(pass === results.length ? 0 : 1);
