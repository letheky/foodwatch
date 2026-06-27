// Theo dõi thứ hạng từ khoá (vd "bánh đa cá") + tham số tham khảo kinh doanh của từng đối thủ.
// scanRank: search_global → lưu rank_snapshots (kèm rating/đã bán/giá TB/KM) + đăng ký quán để theo dõi.
// getRank: batch mới nhất + Δ hạng + món hot-seller (nếu đã quét menu).
const { getDb, getSetting, setSetting } = require('../db/database');
const { v4: uuid } = require('uuid');
const { districtName } = require('../lib/districts');
const { registerAreaRestaurant } = require('./restaurantMonitor');

const HOAN_KIEM = 25;
const promoText = (groups) => (groups || []).map(g => g.text).filter(Boolean).slice(0, 2).join(' / ') || null;

// ── Điểm giao (P1b): xếp hạng theo vị trí khách quanh điểm này, KHÔNG phải city-wide ──
// Mặc định = toạ độ quán của mình (nếu đã thêm). Cho phép đặt riêng trong cài đặt.
function getDeliveryPoint() {
  const raw = getSetting('delivery_point');
  if (raw) { try { const p = JSON.parse(raw); if (p && p.lat != null && p.lng != null) return p; } catch {} }
  const own = getDb().prepare('SELECT name, lat, lng FROM restaurants WHERE is_own = 1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY last_scanned_at DESC').get();
  if (own) return { lat: own.lat, lng: own.lng, label: own.name || 'Quán của tôi', auto: true };
  return null;
}
function setDeliveryPoint({ lat, lng, label } = {}) {
  if (lat == null || lng == null || lat === '' || lng === '') { setSetting('delivery_point', ''); return getDeliveryPoint(); }
  setSetting('delivery_point', JSON.stringify({ lat: Number(lat), lng: Number(lng), label: label || null }));
  return getDeliveryPoint();
}

async function scanRank(keyword, { cityUrl = 'ha-noi', cityId = 218, top = 60, lat = null, lng = null } = {}) {
  const { scrapeSearch } = require('./foodScraper');
  const dp = (lat != null && lng != null) ? { lat, lng } : getDeliveryPoint();
  const res = await scrapeSearch(keyword, { cityUrl, lat: dp?.lat ?? null, lng: dp?.lng ?? null });
  const db = getDb();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO rank_snapshots
    (id, keyword, city_id, restaurant_id, delivery_id, name, district_id, rank, matched_dishes,
     rating_avg, total_review, total_order, avg_price, is_open, promo_text, url, scanned_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const r of res.ranking.slice(0, top)) {
      if (r.deliveryId) { try { registerAreaRestaurant(r); } catch {} } // đưa vào hệ để theo dõi + Quét menu
      ins.run(uuid(), keyword, cityId, r.restaurantId, r.deliveryId || null, r.name || null,
        r.districtId ?? null, r.rank, r.matchedDishes,
        r.ratingAvg ?? null, r.totalReview ?? null, r.totalOrder ?? null, r.avgPrice ?? null,
        r.isOpen === true ? 1 : r.isOpen === false ? 0 : null, promoText(r.promotionGroups), r.url || null, now);
    }
  });
  tx();
  return { keyword, total: res.total, saved: Math.min(res.ranking.length, top), scannedAt: now, ...getRank(keyword) };
}

// Món bán chạy nhất của quán (nếu đã quét menu) = dish total_like cao nhất.
function hotSeller(db, deliveryId) {
  if (!deliveryId) return null;
  const d = db.prepare(`SELECT name, total_like, price, discount_price FROM dishes
    WHERE delivery_id = ? AND is_active_row = 1 AND name IS NOT NULL
    ORDER BY total_like DESC, display_order ASC LIMIT 1`).get(String(deliveryId));
  if (!d) return null;
  return { name: d.name, likes: d.total_like, price: (d.discount_price && d.discount_price > 0) ? d.discount_price : d.price };
}

function getRank(keyword) {
  const db = getDb();
  const batches = db.prepare(
    'SELECT DISTINCT scanned_at FROM rank_snapshots WHERE keyword = ? ORDER BY scanned_at DESC LIMIT 2'
  ).all(keyword).map(r => r.scanned_at);
  if (!batches.length) return { keyword, scannedAt: null, ranking: [] };

  const latest = db.prepare('SELECT * FROM rank_snapshots WHERE keyword = ? AND scanned_at = ? ORDER BY rank ASC').all(keyword, batches[0]);
  const prev = batches[1]
    ? new Map(db.prepare('SELECT restaurant_id, rank FROM rank_snapshots WHERE keyword = ? AND scanned_at = ?').all(keyword, batches[1]).map(r => [r.restaurant_id, r.rank]))
    : new Map();
  const ownByDelivery = new Set(db.prepare('SELECT delivery_id FROM restaurants WHERE is_own = 1').all().map(r => String(r.delivery_id)));

  const ranking = latest.map(r => {
    const prevRank = prev.get(r.restaurant_id);
    return {
      rank: r.rank, name: r.name, restaurantId: r.restaurant_id, deliveryId: r.delivery_id, url: r.url || null,
      districtId: r.district_id, districtName: districtName(r.city_id, r.district_id), isHoanKiem: r.district_id === HOAN_KIEM,
      isOwn: r.delivery_id && ownByDelivery.has(String(r.delivery_id)),
      matchedDishes: r.matched_dishes,
      ratingAvg: r.rating_avg, totalReview: r.total_review, totalOrder: r.total_order,
      avgPrice: r.avg_price, isOpen: r.is_open, promo: r.promo_text,
      hotSeller: hotSeller(db, r.delivery_id),
      prevRank: prevRank ?? null,
      delta: prevRank != null ? prevRank - r.rank : null,  // dương = lên hạng
    };
  });
  // bổ sung url từ bảng restaurants cho mốc cũ chưa lưu url (KHÔNG ghi đè url đã có từ rank_snapshots)
  const urls = new Map(db.prepare('SELECT delivery_id, url FROM restaurants').all().map(r => [String(r.delivery_id), r.url]));
  for (const x of ranking) if (x.deliveryId && !x.url) x.url = urls.get(String(x.deliveryId)) || null;

  return { keyword, scannedAt: batches[0], prevScannedAt: batches[1] || null, ranking };
}

function listKeywords() {
  return getDb().prepare(`
    SELECT keyword, MAX(scanned_at) AS lastScannedAt, COUNT(DISTINCT scanned_at) AS scans
    FROM rank_snapshots GROUP BY keyword ORDER BY lastScannedAt DESC
  `).all();
}

module.exports = { scanRank, getRank, listKeywords, getDeliveryPoint, setDeliveryPoint, HOAN_KIEM };
