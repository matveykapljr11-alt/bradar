'use strict';
/* PRO products purchasable with Telegram Stars (currency XTR). Shared by the
 * server (invoice + webhook) and the bot (long-poll payments). */
const PRODUCTS = {
  pro_export:  { title: 'BRADAR PRO — экспорт и контакты', description: 'Полный экспорт медиаплана (PDF/XLSX), контакты каналов и снятие лимитов.', stars: 150, days: 30 },
  plan_single: { title: 'Разовый медиаплан', description: 'Один расширенный медиаплан с обоснованием и контактами каналов.', stars: 50, days: 0 },
};
// grant expiry timestamp for a purchased product (0 = permanent / one-time)
function untilFor(payload) {
  const p = PRODUCTS[payload];
  return p && p.days ? Date.now() + p.days * 86400e3 : 0;
}
module.exports = { PRODUCTS, untilFor };
