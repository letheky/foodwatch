// Telegram tối giản (giống base): token/chatId lưu app_settings; gửi HTML.
const https = require('https');
const { getSetting, setSetting } = require('../db/database');

function getConfig() {
  const token = getSetting('tg_token');
  const chatId = getSetting('tg_chat_id');
  return token && chatId ? { token, chatId } : null;
}
function saveConfig(token, chatId) {
  setSetting('tg_token', token);
  setSetting('tg_chat_id', chatId);
}

function sendTelegram(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(d))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const ICON = {
  new_dish: '🆕', removed_dish: '🗑️', dish_price: '💰', dish_discount: '🔥',
  dish_unavailable: '⛔', dish_back: '✅', promo_start: '🎁', promo_end: '➖',
  restaurant_closed: '🚪', restaurant_open: '🔔', rating_change: '⭐', name_change: '✏️',
};

async function notifyChanges(restaurantName, changes) {
  const cfg = getConfig();
  if (!cfg || !changes?.length) return;
  const lines = [`<b>🍜 ${restaurantName}</b>`, ...changes.slice(0, 20).map(c => `${ICON[c.type] || '•'} ${c.title}`)];
  if (changes.length > 20) lines.push(`… và ${changes.length - 20} thay đổi khác`);
  await sendTelegram(cfg.token, cfg.chatId, lines.join('\n'));
}

module.exports = { getConfig, saveConfig, sendTelegram, notifyChanges };
