// Số đánh giá THẬT từ foody.vn (thay bucket "999+" của ShopeeFood) + tốc độ tăng review (≈ bán hàng).
const { getDb } = require('../db/database');
const { v4: uuid } = require('uuid');

const foodyUrlOf = (shopeeUrl) => shopeeUrl ? shopeeUrl.replace('shopeefood.vn', 'foody.vn') : null;

async function scanFoodyReviews(deliveryId) {
  const db = getDb();
  const r = db.prepare('SELECT delivery_id, name, url FROM restaurants WHERE delivery_id = ?').get(String(deliveryId));
  if (!r) throw new Error('Quán chưa có trong hệ thống');
  const foodyUrl = foodyUrlOf(r.url);
  if (!foodyUrl) throw new Error('Quán chưa có URL để suy ra link foody');

  const { scrapeFoodyReviews } = require('./foodScraper');
  const res = await scrapeFoodyReviews(foodyUrl);
  const now = new Date().toISOString();

  db.prepare('UPDATE restaurants SET review_real = ?, review_real_at = ? WHERE delivery_id = ?')
    .run(res.total, now, String(deliveryId));
  db.prepare('INSERT INTO foody_review_snapshots (id, delivery_id, review_real, scanned_at) VALUES (?,?,?,?)')
    .run(uuid(), String(deliveryId), res.total, now);

  const ins = db.prepare(`INSERT OR REPLACE INTO foody_reviews
    (id, delivery_id, reviewer, rating, title, comment, total_view, pics, review_time, scraped_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const rv of res.reviews) {
      const id = `${deliveryId}:${(rv.reviewer || '').slice(0, 20)}:${(rv.time || '')}:${(rv.title || '').slice(0, 24)}`;
      ins.run(id, String(deliveryId), rv.reviewer, rv.rating, rv.title, rv.comment, rv.totalView, rv.pics, rv.time, now);
    }
  });
  tx();

  return { deliveryId: String(deliveryId), name: r.name, foodyUrl, ...getFoodyReviews(deliveryId) };
}

function getFoodyReviews(deliveryId) {
  const db = getDb();
  const snaps = db.prepare(
    'SELECT review_real, scanned_at FROM foody_review_snapshots WHERE delivery_id = ? ORDER BY scanned_at DESC LIMIT 30'
  ).all(String(deliveryId));
  const reviews = db.prepare(
    'SELECT reviewer, rating, title, comment, total_view, pics, review_time, scraped_at FROM foody_reviews WHERE delivery_id = ? ORDER BY scraped_at DESC, rowid DESC LIMIT 20'
  ).all(String(deliveryId));

  let velocity = null;
  if (snaps.length >= 2) {
    const latest = snaps[0], oldest = snaps[snaps.length - 1];
    const days = (new Date(latest.scanned_at) - new Date(oldest.scanned_at)) / 86400000;
    const delta = Math.max(0, (latest.review_real || 0) - (oldest.review_real || 0));
    velocity = { delta, days: Math.round(days * 10) / 10, perWeek: days >= 0.5 ? Math.round(delta / days * 7 * 10) / 10 : null };
  }
  return {
    reviewReal: snaps[0]?.review_real ?? null,
    lastScannedAt: snaps[0]?.scanned_at ?? null,
    velocity,
    history: snaps.slice().reverse(),
    reviews,
  };
}

// ── Tổng hợp "đối thủ hay bị chê gì" (P2) từ foody_reviews các quán đối thủ ──
// Thang điểm foody 0–10; coi ≤7 là đánh giá thấp. Tách token tiếng Việt (theo khoảng trắng),
// bỏ stopword + token ngắn, đếm tần suất → gợi ý lỗi để né. Chỉ là tín hiệu (không NLP sâu).
const STOP = new Set(('và là của có không được rất quá nhưng thì mà cho khi nên cũng các những một hai ba bốn với về như ở đi ăn quán món ngon ok oke ổn bình thường khá nha nhé ạ à á thôi lại trong ngoài này kia đó đây em anh chị mình bạn người order đặt ship giao hà nội đồ rồi lắm hơi vẫn sẽ đã vì do nếu hay tôi shop nhà hàng vậy nó ra vào lên xuống còn chỉ mỗi cứ luôn thấy mua đến từ trên dưới sau trước giờ ngày')
  .split(/\s+/));

const tokenize = (s) => String(s || '').toLowerCase().replace(/[^0-9a-zà-ỹ\s]/gi, ' ').split(/\s+/).filter(Boolean);

function complaintInsights({ limit = 12 } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT fr.rating, fr.title, fr.comment FROM foody_reviews fr
    JOIN restaurants r ON r.delivery_id = fr.delivery_id WHERE r.is_own = 0`).all();
  // Loại token là TÊN QUÁN / tên món-ngách (proper noun) → tránh đếm "xôi/cát/lâm/đường/thành/bánh/đa/cá".
  const nameStop = new Set();
  for (const r of db.prepare('SELECT name FROM restaurants').all())
    for (const t of tokenize(r.name)) if (t.length >= 2) nameStop.add(t);
  let analyzed = 0, low = 0; const counts = new Map();
  for (const rv of rows) {
    const text = ((rv.title || '') + ' ' + (rv.comment || '')).trim();
    if (!text) continue;
    analyzed++;
    if (!(rv.rating != null && rv.rating <= 7)) continue; // chỉ phân tích đánh giá thấp
    low++;
    const toks = tokenize(text).filter(t => t.length >= 2 && !STOP.has(t) && !nameStop.has(t));
    for (const t of new Set(toks)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word, n]) => ({ word, n }));
  return { analyzed, low, top };
}

module.exports = { scanFoodyReviews, getFoodyReviews, foodyUrlOf, complaintInsights };
