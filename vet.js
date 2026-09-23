'use strict';
/* ============================================================================
 * Channel vetting — turn the raw signals from bradar-resolver /channel into a
 * живость/накрутка VERDICT *with arguments*. This is the core value the buyers
 * said existing tools don't give ("данные, но не вердикт").
 *
 * Design rule from the interviews: be CONSERVATIVE. A false "накрутка" on a good
 * channel kills trust on the first mistake — so we flag with evidence, and only
 * call "не брать" when several signals agree, never on one borderline number.
 * ========================================================================== */
function fmt(n) { return (Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }

// healthy ERR band (avg reach / subscribers, %) by channel size — from the buyer interviews.
function errBand(subs) {
  if (subs < 5000) return [20, 85];
  if (subs < 20000) return [20, 70];
  if (subs < 100000) return [12, 45];
  if (subs < 500000) return [8, 35];
  return [5, 28];
}

/** Pure. ch = { subs, metrics:{reach, er, cv, adRatio, posts30, ...} } → verdict + signals. */
function vetChannel(ch) {
  const m = (ch && ch.metrics) || {};
  const subs = Number(ch && ch.subs) || 0;
  const reach = Number(m.reach) || 0;
  const err = subs ? Math.round(reach / subs * 1000) / 10 : 0;   // reach/subs %
  const cv = Number(m.cv) || 0;
  const er = Number(m.er) || 0;                                  // (reactions+forwards)/views %
  const adRatio = Number(m.adRatio) || 0;
  const posts30 = Number(m.posts30) || 0;
  const signals = [];
  let score = 68;

  if (!reach || !subs) {
    signals.push({ level: 'warn', text: 'Мало данных, чтобы оценить охват — вердикт приблизительный.' });
  } else {
    const [lo, hi] = errBand(subs);
    if (err < lo * 0.55) { score -= 34; signals.push({ level: 'bad', text: `Охват всего ${err}% от подписчиков (норма ${lo}–${hi}%) — аудитория, похоже, мёртвая или накручены подписчики.` }); }
    else if (err < lo) { score -= 14; signals.push({ level: 'warn', text: `Охват ${err}% — ниже нормы (${lo}–${hi}%), аудитория слабовата.` }); }
    else if (err > hi * 1.7) { score -= 12; signals.push({ level: 'warn', text: `Охват ${err}% подозрительно высок для ${fmt(subs)} подписчиков — возможна накрутка просмотров.` }); }
    else { score += 10; signals.push({ level: 'good', text: `Охват ${err}% — в норме для канала на ${fmt(subs)} подписчиков.` }); }
  }

  if (cv && cv < 0.12) { score -= 28; signals.push({ level: 'bad', text: `Просмотры почти одинаковые от поста к посту (разброс ${cv}) — классический признак накрутки ботами.` }); }
  else if (cv && cv < 0.2) { score -= 10; signals.push({ level: 'warn', text: `Низкий разброс просмотров (${cv}) — у живого канала он обычно больше.` }); }
  else if (cv >= 0.3) { score += 8; signals.push({ level: 'good', text: `Разброс просмотров живой (${cv}) — контент заходит неровно, как у реальной аудитории.` }); }

  if (reach && er < 0.3) { score -= 20; signals.push({ level: 'bad', text: `Реакций почти нет к просмотрам (ER ${er}%) — просмотры есть, живой реакции нет: похоже на купленные просмотры.` }); }
  else if (reach && er >= 0.8 && er <= 7) { score += 6; signals.push({ level: 'good', text: `Вовлечённость ${er}% — в живой норме.` }); }
  else if (er > 14) { score -= 8; signals.push({ level: 'warn', text: `Вовлечённость ${er}% аномально высокая — возможны накрученные реакции.` }); }

  if (adRatio >= 55) { score -= 12; signals.push({ level: 'warn', text: `Больше половины постов — реклама (${adRatio}%): аудитория выжжена, ваш пост потеряется.` }); }
  else if (adRatio >= 35) { signals.push({ level: 'warn', text: `Высокая рекламная нагрузка (${adRatio}% постов).` }); }

  if (m.posts30 != null) {
    if (posts30 === 0) { score -= 22; signals.push({ level: 'bad', text: 'За 30 дней нет постов — канал заморожен.' }); }
    else if (posts30 < 4) { score -= 6; signals.push({ level: 'warn', text: `Постят редко (${posts30} за 30 дней).` }); }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 65 ? 'live' : score >= 42 ? 'caution' : 'dead';
  const verdictLabel = verdict === 'live' ? 'Живой — брать можно' : verdict === 'caution' ? 'С осторожностью' : 'Не брать — признаки накрутки';
  return { score, verdict, verdictLabel, err, signals };
}

// Brand-safety: scan recent post texts for content a real brand shouldn't sit next to.
const UNSAFE = {
  'крипта / инвест-схемы': /крипт|токен|\bnft\b|памп|сигнал|трейд|инвестиц|пассивн\S* доход|x\d+\s*за|иксы/i,
  'ставки / казино': /ставк|казино|1x?бет|мелбет|прогноз на матч|букмекер|договорн\S* матч/i,
  'мат / токсичность': /\b(бляд|хуй|пизд|ебан|уёбищ|сук[аи])\S*/i,
  '18+ / интим': /порно|интим-?услуг|эскорт|\b18\+/i,
  'сомнительные схемы': /развод|обнал|сер\S* схем|пробив\b|документы под ключ|доход без вложений/i,
};
function brandSafety(posts) {
  const text = (posts || []).map(p => (p && p.t) || '').join('  ').toLowerCase();
  const flags = [];
  for (const label in UNSAFE) if (UNSAFE[label].test(text)) flags.push(label);
  return flags;   // [] = clean
}

module.exports = { vetChannel, brandSafety, errBand };
