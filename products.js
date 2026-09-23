'use strict';
/* PRO products purchasable with Telegram Stars (currency XTR). Shared by the
 * server (invoice + webhook) and the bot (long-poll payments). */
const PRODUCTS = {
  pro_export:  { title: 'BRADAR PRO', description: 'Соответствие каналов вашему бренду с обоснованием, пересечение аудиторий, реальные контакты для закупки и экспорт. Доступ на 30 дней.', stars: 400, days: 30 },
  plan_single: { title: 'Разовый медиаплан', description: 'Один расширенный медиаплан с обоснованием и контактами каналов.', stars: 50, days: 0 },
};
// grant expiry timestamp for a purchased product (0 = permanent / one-time)
function untilFor(payload) {
  const p = PRODUCTS[payload];
  return p && p.days ? Date.now() + p.days * 86400e3 : 0;
}
module.exports = { PRODUCTS, untilFor };
