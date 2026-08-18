'use strict';
/* ============================================================================
 * BRADAR — server-side media-plan engine
 * Authoritative version of the selection logic that ships in the mini-app.
 * Pure JS, no deps. Deterministic: given brand text + brief → a media plan.
 *
 * The channel CATALOG below is seed data. In production replace `loadCatalog()`
 * with a real source (TGStat / Telemetr / Telega.in API or your own DB) —
 * every consumer here only depends on the channel shape, not on how it is stored.
 * ========================================================================== */

const BASE_BUDGET = 150000;

const GROUPS = {
  core: { name: 'Основное ядро аудитории', short: 'Основное ядро', color: '#1668E3', desc: 'Каналы, максимально близкие вашей теме — прямое попадание в спрос' },
  adj:  { name: 'Смежные интересы', short: 'Смежные интересы', color: '#5FA0F0', desc: 'Смежные интересы аудитории — расширяем охват' },
  exp:  { name: 'Экспериментальные каналы', short: 'Эксперименты', color: '#0E9AA7', desc: 'Новые сегменты и гипотезы для проверки' },
};
const TOPIC_GROUP = { skincare:'core', beauty:'core', fashion:'core', edu:'core', b2b:'core', app:'core', games:'core', lifestyle:'adj', conscious:'adj', wellness:'exp', news:'exp', finance:'exp', crypto:'exp', politics:'exp', gambling:'exp', adult:'exp' };
const EXCLUDE_MAP = { 'Политика':'politics', 'Азартные игры':'gambling', 'Контент 18+':'adult', 'Криптовалюты':'crypto', 'Новости':'news' };

const AVPAL = [['#F3D9DC','#E8B9C4','#8A5763'],['#F6E7CF','#E9C89A','#8A6B37'],['#DCE4F5','#B9C8E8','#5A6B90'],['#D9EFEA','#AFDCD2','#3E7A6E'],['#E3EAF8','#BFCFEC','#4F638C'],['#F0E4F2','#D3BEDD','#6E5A82'],['#E6E0F5','#C6B6E0','#645488'],['#DDEFE6','#B3D9C4','#417A5E']];
function avOf(name){ const p = AVPAL[(name.charCodeAt(0)+name.length) % AVPAL.length]; return { l: name[0], g: `linear-gradient(140deg,${p[0]},${p[1]})`, c: p[2] }; }
const KIND = { ok:['var(--teal)','#F4FAF9','Отлично подходит'], mid:['var(--gold)','#FFF8EC','Подходит с оговорками'], test:['var(--blue)','#F0F7FF','Подходит для теста'] };
function C(id,name,cat,topic,subs,match,cpm,reach,eng,adShare,w,kind,vsub,why){
  return { id, name, handle:'@'+id, cat, topic, subs, match, cpm, reach, eng, adShare, w,
    verified:true, risks:[], why:why||[], verdict:KIND[kind][2], verdictSub:vsub,
    vColor:KIND[kind][0], vBg:KIND[kind][1], av:avOf(name), placement:{ price:0, clicks:'' } };
}

// ---- beauty vertical: authored, rich detail (matches the mini-app demo) ----
const BEAUTY = [
  { id:'koja', name:'Кожа и правда', handle:'@koja_i_pravda', cat:'Красота и уход', topic:'skincare', group:'core', subs:78400, match:92, cpm:620, w:28000, reach:21400, eng:'6,1%', adShare:'14%',
    verified:true, verdict:'Отлично подходит', verdictSub:'Совпадает и тематика, и тон', vColor:'var(--teal)', vBg:'#F4FAF9', av:avOf('Кожа и правда'), placement:{price:0,clicks:''}, risks:[],
    why:['Аудитория обсуждает состав средств и реакции чувствительной кожи','Спокойный разборный тон публикаций совпадает с тоном бренда','Реклама косметики здесь собирает на 18% больше просмотров, чем в среднем по каналу','За 30 дней ни одного прямого конкурента в уходе за кожей'] },
  { id:'beauty', name:'Бьюти-разборы', handle:'@beauty_razbory', cat:'Красота и уход', topic:'skincare', group:'core', subs:214000, match:71, cpm:780, w:38000, reach:48900, eng:'3,4%', adShare:'27%',
    verified:true, verdict:'Подходит с оговорками', verdictSub:'Тематика верная, но цена и реклама выше нормы', vColor:'var(--gold)', vBg:'#FFF8EC', av:avOf('Бьюти-разборы'), placement:{price:0,clicks:''}, engBad:true, cpmBad:true, adBad:true, replaceable:true,
    why:['Крупнейший охват в категории — даёт 26% всех просмотров плана','Регулярные разборы состава — формат близок к линейке для чувствительной кожи','83% аудитории — женщины 25–44 из городов-миллионников'],
    risks:['За последний месяц частота рекламы выросла с 14% до 27% публикаций','31% аудитории пересекается с каналом «Кожа и правда» из этого же плана','Цена выше средней по категории на 12%'],
    advice:'Наш совет: взять одно размещение вместо двух и не ставить его в ту же неделю, что «Кожа и правда».' },
  { id:'budni', name:'будни без спешки', handle:'@budni_bez_speshki', cat:'Женский lifestyle', topic:'lifestyle', group:'adj', subs:142000, match:84, cpm:410, w:22000, reach:34200, eng:'4,8%', adShare:'11%',
    verified:true, verdict:'Хорошо подходит', verdictSub:'Точная аудитория, редкая реклама', vColor:'var(--teal)', vBg:'#F4FAF9', av:avOf('будни без спешки'), placement:{price:0,clicks:''}, risks:[],
    why:['Женский lifestyle с интересом к осознанному уходу за собой','Реклама выходит редко — 11% публикаций, контакт не «замылен»','Тёплый личный тон совпадает с тоном бренда'] },
  { id:'osoz', name:'осознанно и просто', handle:'@osoznanno_prosto', cat:'Осознанное потребление', topic:'conscious', group:'adj', subs:41800, match:81, cpm:470, w:14500, reach:12600, eng:'5,4%', adShare:'9%',
    verified:true, verdict:'Хорошо подходит', verdictSub:'Ценности бренда и канала совпадают', vColor:'var(--teal)', vBg:'#F4FAF9', av:avOf('осознанно и просто'), placement:{price:0,clicks:''}, risks:[],
    why:['Аудитория выбирает средства по составу, а не по обещаниям','Небольшой, но очень вовлечённый канал','Осознанное потребление — прямая ценность линейки'] },
  { id:'sostav', name:'Чистый состав', handle:'@chisty_sostav', cat:'Красота и уход', topic:'skincare', group:'core', subs:56000, match:88, cpm:400, w:16000, reach:14000, eng:'5,9%', adShare:'12%',
    verified:true, verdict:'Отлично подходит', verdictSub:'Экспертный разбор ингредиентов', vColor:'var(--teal)', vBg:'#F4FAF9', av:avOf('Чистый состав'), placement:{price:0,clicks:''}, risks:[],
    why:['Канал разбирает INCI-составы — идеальная среда для чувствительной кожи','Дешёвый контакт при высокой вовлечённости','Аудитория доверяет рекомендациям автора'] },
  { id:'minimum', name:'Минимум и кожа', handle:'@minimum_koja', cat:'Красота и уход', topic:'skincare', group:'core', subs:33000, match:79, cpm:340, w:9000, reach:9000, eng:'6,4%', adShare:'8%',
    verified:true, verdict:'Хорошо подходит', verdictSub:'Минимализм в уходе', vColor:'var(--teal)', vBg:'#F4FAF9', av:avOf('Минимум и кожа'), placement:{price:0,clicks:''}, risks:[],
    why:['Небольшой нишевый канал с очень лояльной аудиторией','Самый дешёвый контакт в плане','Философия «меньше, но лучше» близка бренду'] },
  { id:'ritual', name:'Вечерний ритуал', handle:'@evening_ritual', cat:'Женский lifestyle', topic:'lifestyle', group:'exp', subs:88000, match:74, cpm:360, w:13500, reach:20000, eng:'4,1%', adShare:'15%',
    verified:true, verdict:'Подходит для теста', verdictSub:'Проверяем новую аудиторию', vColor:'var(--blue)', vBg:'#F0F7FF', av:avOf('Вечерний ритуал'), placement:{price:0,clicks:''}, risks:[],
    why:['Широкий lifestyle-охват для проверки гипотезы','Дешёвый контакт','Вечерние рутины хорошо сочетаются с уходом'] },
  { id:'shopping', name:'Осознанный шопинг', handle:'@smart_shopping', cat:'Осознанное потребление', topic:'wellness', group:'exp', subs:27000, match:77, cpm:320, w:9000, reach:8000, eng:'5,1%', adShare:'10%',
    verified:true, verdict:'Подходит для теста', verdictSub:'Велнес и здоровый образ жизни', vColor:'var(--blue)', vBg:'#F0F7FF', av:avOf('Осознанный шопинг'), placement:{price:0,clicks:''}, risks:[],
    why:['Аудитория велнеса — гипотеза расширения','Самый дешёвый охват','Тема осознанного выбора созвучна бренду'] },
  // replacement pool (not selected into the default plan)
  C('spok','спокойный уход','Красота и уход','skincare',64200,89,540,17800,'5,7%','9%',16000,'ok','Точная аудитория, редкая реклама',['Аудитория точно про уход за чувствительной кожей','Реклама в канале выходит редко','Спокойный тон совпадает с брендом']),
  C('budget','бьюти-бюджет','Красота и уход','skincare',96500,76,390,26000,'3,9%','19%',14000,'mid','Дёшево, но аудитория про скидки',['Самый дешёвый контакт среди альтернатив','Хватает на два размещения','Большой охват женской аудитории']),
  C('zhensky','женский день','Lifestyle','lifestyle',310000,69,610,62300,'2,8%','22%',13000,'mid','Большой охват, размытая аудитория',['Самый большой охват в подборке','Новая аудитория для бренда','Дешевле по CPM, чем крупные бьюти-каналы']),
  C('wellness','ритуалы и баланс','Велнес','wellness',72000,73,430,15000,'4,4%','12%',11000,'test','Гипотеза велнес-аудитории',['Аудитория велнеса и заботы о себе','Дешёвый контакт для теста гипотезы']),
];

const POOL = {
  beauty: BEAUTY,
  fashion: [
    C('garderob','Гардероб на каждый день','Мода и стиль','fashion',120000,88,480,22000,'5,2%','13%',20000,'ok','Прямое попадание в спрос',['Аудитория собирает базовый гардероб','Форматы «образ дня» органичны для бренда одежды']),
    C('baza','База и стиль','Мода и стиль','fashion',76000,84,420,15000,'6,0%','11%',16000,'ok','Точная аудитория',['Разбирают базовые вещи и сочетания','Высокая вовлечённость, редкая реклама']),
    C('trendy','Тренды сезона','Мода','fashion',210000,74,640,41000,'3,6%','24%',15000,'mid','Большой охват, дороже',['Крупнейший охват в категории','Реклама выходит часто — контакт дороже']),
    C('ecomoda','Осознанная мода','Осознанное потребление','conscious',44000,81,450,11000,'5,8%','9%',12000,'ok','Ценности совпадают',['Аудитория выбирает вещи вдумчиво','Осознанное потребление — ценность бренда']),
    C('street','Streetstyle daily','Lifestyle','lifestyle',98000,72,520,24000,'4,1%','16%',11000,'test','Проверяем новую аудиторию',['Молодая городская аудитория','Широкий lifestyle-охват для теста']),
    C('shopgid','Шопинг-гид','Мода','fashion',61000,77,400,13000,'5,0%','12%',9000,'ok','Дешёвый контакт',['Подборки и распродажи','Аудитория готова к покупке']),
    C('modanews','Мода и новости','Новости','news',150000,60,700,30000,'2,9%','28%',8000,'mid','Много рекламы',['Большой охват','Ниже соответствие и выше цена контакта']),
    C('capsule','Капсульный гардероб','Мода','fashion',52000,83,410,11000,'5,4%','10%',10000,'ok','Точная аудитория',['Про минимализм в одежде','Дешёвый вовлечённый контакт']),
    C('sale','Распродажи и находки','Мода','fashion',175000,68,540,34000,'3,2%','21%',8000,'mid','Много рекламы',['Большой охват охотников за скидками','Часто рекламируется']),
  ],
  edu: [
    C('practice','Английский на практике','Образование','edu',88000,90,360,17000,'6,4%','10%',20000,'ok','Прямое попадание',['Аудитория активно учит язык','Формат «урок дня» ведёт к пробным занятиям']),
    C('igra','Учись играя','Образование','edu',54000,85,340,12000,'5,9%','9%',16000,'ok','Вовлечённая аудитория',['Интерактивные задания и высокая вовлечённость','Дешёвый контакт']),
    C('career','Карьера и рост','Образование','edu',130000,78,520,26000,'4,0%','14%',15000,'mid','Шире аудитория',['Аудитория думает о развитии','Форматы близки к онлайн-обучению']),
    C('selfdev','Саморазвитие','Lifestyle','lifestyle',190000,72,560,38000,'3,4%','18%',13000,'test','Тест широкой аудитории',['Большой охват','Интерес к учёбе подтверждён у части подписчиков']),
    C('poliglot','Полиглот','Образование','edu',47000,82,320,10000,'6,1%','8%',12000,'ok','Точная аудитория',['Ядро изучающих языки','Самый дешёвый контакт']),
    C('exam','Сдай экзамен','Образование','edu',72000,79,300,15000,'5,5%','11%',9000,'ok','Целевой сегмент',['Готовятся к экзаменам','Прямой спрос на обучение']),
    C('itlearn','IT с нуля','Образование','edu',140000,80,540,28000,'4,3%','13%',14000,'mid','Целевой сегмент',['Аудитория осваивает новую профессию','Профильно для курсов']),
    C('books','Книги и знания','Образование','edu',95000,81,400,19000,'5,0%','10%',12000,'ok','Вовлечённое ядро',['Аудитория любит учиться','Стабильная вовлечённость']),
    C('mama','Мама учит','Lifestyle','lifestyle',66000,75,380,13000,'5,2%','12%',11000,'test','Тёплая аудитория',['Родители, выбирающие обучение','Высокое доверие к рекомендациям']),
  ],
  app: [
    C('lifehack','Лайфхаки и приложения','Технологии','app',160000,86,380,32000,'5,0%','13%',20000,'ok','Прямой спрос',['Аудитория ищет полезные приложения','Формат «приложение недели» ведёт к установкам']),
    C('calm','Спокойствие и сон','Велнес','wellness',110000,84,420,22000,'5,6%','10%',16000,'ok','Совпадение по теме',['Аудитория про сон и осознанность','Органично для приложений здоровья']),
    C('prod','Продуктивность','Технологии','app',90000,80,400,18000,'5,1%','12%',15000,'mid','Хорошее совпадение',['Аудитория оптимизирует рутину','Готова пробовать новые инструменты']),
    C('privychki','Здоровье и привычки','Велнес','wellness',140000,76,460,28000,'4,2%','15%',13000,'test','Шире охват',['Большой охват велнес-аудитории','Интерес к приложению у части подписчиков']),
    C('gadget','Гаджеты и софт','Технологии','app',200000,71,620,40000,'3,3%','22%',12000,'mid','Дороже контакт',['Крупнейший охват в теме','Часто рекламируется — дороже']),
    C('mind','Осознанность','Осознанное потребление','conscious',60000,82,360,13000,'6,0%','9%',9000,'ok','Точная аудитория',['Ядро осознанной аудитории','Дешёвый и вовлечённый контакт']),
    C('fintech','Финтех и деньги','Технологии','app',130000,79,520,26000,'4,0%','14%',14000,'mid','Хорошее совпадение',['Аудитория пробует финтех-приложения','Готовы к установке']),
    C('fitapp','Фитнес каждый день','Велнес','wellness',150000,78,460,30000,'4,4%','12%',12000,'ok','По теме здоровья',['Аудитория про спорт и трекеры','Органично для health-приложений']),
    C('travelapp','Путешествия и сервисы','Lifestyle','lifestyle',175000,72,560,34000,'3,4%','17%',11000,'test','Тест охвата',['Большой охват','Интерес к приложению у части подписчиков']),
  ],
  b2b: [
    C('smallbiz','Малый бизнес','Бизнес','b2b',70000,88,520,14000,'4,8%','12%',20000,'ok','Прямая аудитория',['Владельцы малого бизнеса','Прямой спрос на сервисы для дела']),
    C('market','Маркетинг без воды','Бизнес','b2b',120000,84,560,24000,'4,1%','14%',16000,'ok','Целевой сегмент',['Маркетологи и предприниматели','Профильная аудитория для B2B']),
    C('founder','Основателям','Бизнес','b2b',54000,86,480,11000,'5,2%','10%',15000,'ok','Точное ядро',['Фаундеры и продакты','Высокое доверие к рекомендациям']),
    C('sales','Продажи и CRM','Бизнес','b2b',88000,78,600,17000,'3,9%','16%',13000,'mid','Дороже контакт',['Отделы продаж и руководители','Профильный, но дорогой контакт']),
    C('ecom','E-commerce будни','Бизнес','b2b',96000,80,540,19000,'4,3%','13%',12000,'ok','Хорошее совпадение',['Владельцы интернет-магазинов','Прямой спрос на инструменты']),
    C('finbiz','Финансы бизнеса','Финансы','finance',140000,70,700,28000,'3,1%','20%',9000,'mid','Осторожно с ценой',['Широкий охват предпринимателей','Дорогой контакт и много рекламы']),
    C('hr','HR и команда','Бизнес','b2b',60000,82,500,12000,'4,6%','11%',14000,'ok','Целевое ядро',['Руководители и HR','Профильный B2B-контакт']),
    C('nocode','No-code и автоматизация','Бизнес','b2b',72000,84,520,15000,'4,5%','12%',12000,'ok','Точная аудитория',['Малый бизнес автоматизирует процессы','Прямой спрос на инструменты']),
    C('smm','SMM и трафик','Бизнес','b2b',110000,76,560,22000,'3,8%','16%',11000,'mid','Шире аудитория',['Маркетологи и владельцы','Профильно, но много рекламы']),
  ],
  generic: [
    C('daily','Полезное каждый день','Lifestyle','lifestyle',180000,82,460,36000,'4,6%','13%',20000,'ok','Широкое ядро',['Массовая вовлечённая аудитория','Универсальные форматы интеграций']),
    C('whatsnew','Что нового','Lifestyle','lifestyle',220000,76,560,44000,'3,5%','17%',16000,'mid','Большой охват',['Крупнейший охват','Реклама выходит часто']),
    C('women','Женский клуб','Lifestyle','lifestyle',160000,80,500,32000,'4,2%','12%',15000,'ok','Тёплая аудитория',['Активная женская аудитория','Высокая вовлечённость']),
    C('city','Городская жизнь','Lifestyle','lifestyle',130000,74,520,26000,'3,8%','15%',13000,'test','Тест региона',['Городская аудитория','Хорошо для локальных задач']),
    C('money','Деньги и скидки','Осознанное потребление','conscious',90000,78,420,18000,'4,9%','11%',12000,'ok','Готовы к покупке',['Аудитория ищет выгодные предложения','Дешёвый контакт']),
    C('zozh','ЗОЖ и энергия','Велнес','wellness',110000,79,440,22000,'4,7%','10%',9000,'ok','Вовлечённое ядро',['Аудитория про здоровье и заботу о себе','Стабильная вовлечённость']),
    C('family','Семья и дом','Lifestyle','lifestyle',140000,80,470,28000,'4,3%','11%',14000,'ok','Тёплое ядро',['Массовая семейная аудитория','Универсальные интеграции']),
    C('food','Еда и рецепты','Lifestyle','lifestyle',200000,77,500,40000,'4,0%','14%',12000,'ok','Большой охват',['Очень массовая аудитория','Хорошая вовлечённость']),
    C('psy','Психология и отношения','Lifestyle','lifestyle',160000,79,480,32000,'4,5%','12%',11000,'ok','Вовлечённое ядро',['Аудитория про саморазвитие','Высокое доверие к автору']),
  ],
};

/* ---- pluggable data source -------------------------------------------------
 * Real channel data is a drop-in: put a JSON file at data/channels.json (or set
 * CHANNELS_FILE) shaped as { "<vertical>": [ {id,name,cat,topic,subs,match,cpm,
 * reach,eng,adShare,w, kind?, verdictSub?, why?, handle?, group?, risks?} ] }.
 * Any vertical present there replaces the built-in seed for that vertical; the
 * rest stay. This is where a TGStat / Telemetr / Telega.in export or your own DB
 * dump plugs in — no code change. (`match` here is a base quality; the engine
 * still re-scores it against each brand.) */
function normalizeChannel(r) {
  const kind = r.kind || (r.match >= 82 ? 'ok' : r.match >= 72 ? 'mid' : 'test');
  const ch = C(r.id, r.name, r.cat || '', r.topic || 'lifestyle', r.subs || 0, r.match || 60, r.cpm || 500, r.reach || 0, r.eng || '', r.adShare || '', r.w || 10000, kind, r.verdictSub || '', Array.isArray(r.why) ? r.why : []);
  if (r.handle) ch.handle = r.handle;
  if (r.group) ch.group = r.group;
  if (Array.isArray(r.risks)) ch.risks = r.risks;
  if (r.verdict) ch.verdict = r.verdict;
  return ch;
}
(function loadOverrides() {
  try {
    const fs = require('fs'), path = require('path');
    const f = process.env.CHANNELS_FILE || path.join(__dirname, 'data', 'channels.json');
    if (!fs.existsSync(f)) return;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    let n = 0;
    for (const v in data) {
      if (Array.isArray(data[v]) && data[v].length) { POOL[v] = data[v].map(normalizeChannel); n += data[v].length; }
    }
    if (n) console.log(`[engine] loaded ${n} channels from ${f}`);
  } catch (e) { console.error('[engine] channels.json load failed:', e.message); }
})();

const V_META = {
  beauty:  { brand:'ваш бренд', site:'brand.ru', handle:'@brand', tags:['уход за кожей','чувствительная кожа','женщины 25–40','маркетплейсы','осознанное потребление'] },
  fashion: { brand:'ваш бренд', site:'brand.ru', handle:'@brand', tags:['одежда','базовый гардероб','стиль','женская аудитория','сезонная коллекция'] },
  edu:     { brand:'ваша школа', site:'school.ru', handle:'@school', tags:['обучение','заявки','взрослая аудитория','пробный урок','развитие'] },
  app:     { brand:'ваше приложение', site:'app.ru', handle:'@app', tags:['мобильное приложение','установки','здоровье','осознанность','25–40'] },
  crypto:  { brand:'ваш проект', site:'project.io', handle:'@project', tags:['крипта','NFT','инвестиции','трейдинг','Web3'] },
  b2b:     { brand:'ваш сервис', site:'service.ru', handle:'@service', tags:['B2B','заявки','предприниматели','малый бизнес','автоматизация'] },
  games:   { brand:'ваш проект', site:'brand.ru', handle:'@brand', tags:['настольные игры','гейминг','досуг','игровое сообщество','развлечения'] },
  generic: { brand:'ваш бренд', site:'brand.ru', handle:'@brand', tags:['аудитория 25–40','узнаваемость','продажи','lifestyle','города-миллионники'] },
};

function detectVertical(text) {
  const t = (text || '').toLowerCase();
  if (/нфт|nft|крипт|crypto|токен|блокчейн|web3|биткоин|bitcoin|ethereum|трейд|coin/.test(t)) return 'crypto';
  if (/косметик|уход|кожа|бьюти|beauty|skincare|крем|сыворотк|макияж|парфюм/.test(t)) return 'beauty';
  if (/одежд|мода|fashion|коллекц|обув|аксессуар|гардероб|бренд одежды/.test(t)) return 'fashion';
  if (/настол|гейм|\bgame|игров|играм|игрок|игры|киберспорт|приставк|головолом|квиз|викторин|бродилк/.test(t)) return 'games';
  if (/школ|курс|обучен|изучен|educ|english|англ|язык|лингвист|грамматик|словар|разговорн|носител|урок|вебинар|образован|репетит|самоучит/.test(t)) return 'edu';
  if (/приложен|\bapp\b|устан|мобильн|медитац|трекер|сервис-приложение/.test(t)) return 'app';
  if (/b2b|saas|бизнес|crm|склад|предпринимат|сервис для|оптов|поставщик/.test(t)) return 'b2b';
  return 'generic';
}
function guessBrandName(text, def) {
  const q = (text || '').match(/[«"]([^»"]{2,32})[»"]/); if (q) return q[1].trim();
  const lat = (text || '').match(/\b([A-ZА-ЯЁ][A-Za-zА-Яа-яё0-9é&]{2,20})\b/);
  if (lat && !/^(Мы|Наш|Наша|Хотим|Продаём|Бренд|Компания)$/i.test(lat[1])) return lat[1];
  return def;
}

function overlapOf(chs) {
  if (!chs.length) return 0;
  const byTopic = {}; chs.forEach(c => byTopic[c.topic] = (byTopic[c.topic] || 0) + 1);
  const maxDup = Math.max.apply(null, Object.values(byTopic));
  return Math.max(4, Math.min(22, Math.round((maxDup - 1) / chs.length * 40) + 4));
}
function confidenceOf(chs) {
  if (!chs.length) return 'Средняя';
  const avg = chs.reduce((s, c) => s + c.match, 0) / chs.length;
  return avg >= 85 ? 'Высокая' : avg >= 72 ? 'Средняя' : 'Ниже средней';
}
const fmt = n => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
function clicksRange(views) {
  const lo = Math.round(views * 0.0078 / 100) * 100, hi = Math.round(views * 0.0104 / 100) * 100;
  return fmt(lo) + '–' + fmt(hi);
}
function totalsOf(chs) {
  const budget = chs.reduce((s, c) => s + c.price, 0);
  const views = chs.reduce((s, c) => s + c.price / c.cpm * 1000, 0);
  return { budget, views, avgCpm: budget / (views || 1) * 1000, count: chs.length };
}
function groupTotals(chs) {
  const g = { core: 0, adj: 0, exp: 0 };
  chs.forEach(c => g[c.group] += c.price);
  const budget = g.core + g.adj + g.exp || 1;
  const pct = v => Math.round(v / budget * 100);
  return { core:{sum:g.core,pct:pct(g.core)}, adj:{sum:g.adj,pct:pct(g.adj)}, exp:{sum:g.exp,pct:pct(g.exp)} };
}

/* ---- brand-aware matching --------------------------------------------------
 * Instead of a hard-coded "match %", we score each channel against THIS brand's
 * words. Lightweight Russian morphology: lowercase, strip punctuation, keep
 * words >=4 chars, compare by 5-char prefix so "косметика" ~ "косметики". A
 * channel's own words come from its category / topic / name / rationale, so no
 * separate keyword lists to maintain. The final match blends the channel's base
 * quality with its affinity to the brand, normalised across the candidate set. */
const STOP = new Set(['наш','наша','наше','для','как','что','это','или','бренд','канал','очень','более','менее','хотим','через','сайт','себя','быть','есть','этот','наши','свои','также','чтобы','когда','можно','около']);
function norm(w) { return w.toLowerCase().replace(/ё/g, 'е'); }
function tokenize(text) {
  return (text || '').replace(/[^A-Za-zА-Яа-яЁё0-9\s]/g, ' ').split(/\s+/)
    .map(norm).filter(w => w.length >= 4 && !STOP.has(w)).map(w => w.slice(0, 4));
}
function channelWords(ch) {
  return new Set(tokenize([ch.cat, ch.name, (ch.why || []).join(' '), ch.verdictSub || ''].join(' ')));
}
function affinity(brandTokens, ch) {
  const set = channelWords(ch);
  let hit = 0;
  for (const t of brandTokens) if (set.has(t)) hit++;
  return hit;
}
/** Score a candidate list against a brand; returns copies with computed `match` (base kept in `q`). */
function scoreCandidates(pool, brandText) {
  const bt = tokenize(brandText);
  const raw = pool.map(c => affinity(bt, c));
  const maxRaw = Math.max(1, ...raw);
  return pool.map((c, i) => {
    const q = c.match;
    const aff = raw[i] / maxRaw; // 0..1 within this candidate set
    const m = raw[i] === 0 ? q : Math.round(0.5 * q + 0.5 * (55 + 40 * aff));
    return Object.assign({}, c, { q, affinity: raw[i], match: Math.max(45, Math.min(97, m)) });
  });
}

/* ---- risks computed from metrics (not hard-coded) -------------------------- */
function pctNum(s) { if (typeof s === 'number') return s; const m = String(s || '').replace(',', '.').match(/[\d.]+/); return m ? parseFloat(m[0]) : 0; }
function computeRisks(ch, ctx) {
  const risks = []; let adBad = false, cpmBad = false, engBad = false;
  const ad = pctNum(ch.adShare), eng = pctNum(ch.eng);
  if (ad > 25) { adBad = true; risks.push(`Доля рекламы ${ch.adShare} — выше нормы для тематики (до 25%)`); }
  if (eng && eng < 3.5) { engBad = true; risks.push(`Вовлечённость ${ch.eng} — ниже среднего по тематике`); }
  if ((adBad || engBad) && ctx.medianCpm && ch.cpm > ctx.medianCpm * 1.4) {
    cpmBad = true; const over = Math.round((ch.cpm / ctx.medianCpm - 1) * 100);
    risks.push(`Цена контакта выше средней по подборке на ${over}%`);
  }
  if (risks.length) {
    const dup = ctx.channels.find(o => o.id !== ch.id && o.topic === ch.topic && Math.min(o.subs, ch.subs) > 40000);
    if (dup) risks.push(`Заметное пересечение аудитории с каналом «${dup.name}» из этого плана`);
  }
  return { risks, adBad, cpmBad, engBad };
}

/**
 * Build a media plan from a brand description + brief.
 * @param {{desc?:string, brand?:string, vertical?:string, budget?:number, exclude?:string[]}} input
 */
function buildPlan(input = {}) {
  const desc = input.desc || '';
  const vertical = input.vertical || detectVertical(desc);
  const brand = input.brand || guessBrandName(desc, V_META[vertical] ? V_META[vertical].brand : 'ваш бренд');
  const budget = Number(input.budget) || BASE_BUDGET;
  const exTopics = new Set((input.exclude || []).map(e => EXCLUDE_MAP[e]).filter(Boolean));

  // REAL SEARCH ONLY: build strictly from live candidates. The seed catalog below is
  // never used in production — it stays only for the standalone prototype / tests, gated
  // behind BRADAR_ALLOW_SEED. No real channels → honest empty plan (noData), no fakes.
  const realData = Array.isArray(input.candidates) && input.candidates.length > 0;
  const ALLOW_SEED = process.env.BRADAR_ALLOW_SEED === '1';
  if (!realData && !ALLOW_SEED) {
    return {
      vertical, brand, budget, tags: (V_META[vertical] || V_META.generic).tags,
      channels: [], pool: [], totals: { budget: 0, count: 0, views: 0, avgCpm: 0 },
      groups: groupTotals([]), plan: { overlap: 0, confidence: '—', clicks: '—' },
      source: 'engine', dataSource: 'none', noData: true,
    };
  }
  let pool;
  if (realData) {
    pool = input.candidates.filter(c => !exTopics.has(c.topic));
  } else if (vertical === 'beauty') {
    pool = (POOL.beauty || BEAUTY).slice(0, 8).filter(c => !exTopics.has(c.topic));
  } else {
    pool = (POOL[vertical] || POOL.generic).filter(c => !exTopics.has(c.topic));
  }
  // brand-aware match, then rank
  const scored = scoreCandidates(pool, (desc + ' ' + brand)).sort((a, b) => b.match - a.match);
  const base = realData ? scored.slice(0, 8) : (vertical === 'beauty' ? scored : scored.slice(0, 6));
  const wsum = base.reduce((s, c) => s + (c.w || 10000), 0) || 1;
  const chans = base.map(c => {
    const price = Math.max(1000, Math.round(budget * (c.w || 10000) / wsum / 500) * 500);
    const nc = Object.assign({}, c);
    nc.price = price;
    nc.group = c.group || TOPIC_GROUP[c.topic] || 'adj';
    nc.placement = { price, clicks: '≈' + fmt(Math.round(price / c.cpm * 1000 * 0.0092)) + ' переходов по прогнозу' };
    return nc;
  });
  const diff = budget - chans.reduce((s, c) => s + c.price, 0);
  if (chans[0]) { chans[0].price += diff; chans[0].placement.price = chans[0].price; }

  // risks from metrics, computed against the final plan set
  const cpms = chans.map(c => c.cpm).sort((a, b) => a - b);
  const medianCpm = cpms[Math.floor(cpms.length / 2)] || 0;
  chans.forEach(c => {
    const r = computeRisks(c, { medianCpm, channels: chans });
    c.risks = r.risks; c.adBad = r.adBad; c.cpmBad = r.cpmBad; c.engBad = r.engBad;
    if (r.risks.length) {
      c.verdict = 'Подходит с оговорками';
      c.verdictSub = c.verdictSub || 'Есть замечания по метрикам';
      c.vColor = 'var(--gold)'; c.vBg = '#FFF8EC';
      if (!c.advice) c.advice = 'Совет: возьмите одно размещение и следите за стоимостью результата.';
    }
  });

  const totals = totalsOf(chans);
  return {
    vertical, brand, budget,
    tags: (V_META[vertical] || V_META.generic).tags,
    channels: chans,
    // extra live candidates (not selected) — used as real replacement options, no seed
    pool: realData ? scored.slice(base.length, base.length + 12).map(c => Object.assign({}, c)) : [],
    totals: { budget: totals.budget, count: totals.count, views: Math.round(totals.views), avgCpm: Math.round(totals.avgCpm) },
    groups: groupTotals(chans),
    plan: { overlap: overlapOf(chans), confidence: confidenceOf(chans), clicks: clicksRange(totals.views) },
    source: 'engine',
    dataSource: realData ? 'telemetr' : 'seed',
  };
}

/** Alternatives to replace a channel. Real-only: replacements come from the live pool
 *  returned by buildPlan; the seed pool is used only when BRADAR_ALLOW_SEED is set. */
function altsFor(vertical, planChannelIds, channelId, curCpm, curMatch, curReach) {
  if (process.env.BRADAR_ALLOW_SEED !== '1') return [];
  const inPlan = new Set(planChannelIds);
  const pool = (POOL[vertical] || POOL.generic).filter(c => !inPlan.has(c.id));
  return pool.slice().sort((a, b) => b.match - a.match).slice(0, 3).map(c => ({
    channel: c,
    badge: c.match > curMatch ? 'ВЫШЕ СООТВЕТСТВИЕ' : c.cpm < curCpm ? 'ДЕШЕВЛЕ' : c.reach > curReach ? 'БОЛЬШЕ ОХВАТ' : 'АЛЬТЕРНАТИВА',
  }));
}

function catalogStats() {
  const out = {};
  for (const v in POOL) out[v] = POOL[v].length;
  return out;
}

module.exports = { buildPlan, altsFor, detectVertical, guessBrandName, catalogStats, scoreCandidates, tokenize, POOL, GROUPS, V_META, BASE_BUDGET };
