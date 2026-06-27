// Phân tích thuần đọc DB (không scrape): giá thị trường theo ngách + xếp hạng đối thủ theo tốc độ review/đơn.
const { getDb } = require('../db/database');
const { matchesNiche, nichePhrases } = require('../lib/dishMatch');

const effPrice = (d) => (d.discount_price && d.discount_price > 0 ? d.discount_price : d.price);
const DAY = 86400000;
const median = (arr) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null);

// ── Giá thị trường cho ngách (vd "bánh đa cá") ──
// Gom mọi món đang bán (is_active_row=1) khớp ngách → dải giá đối thủ + món của mình + cảnh báo phá giá.
function marketBand(niche) {
  const db = getDb();
  const phrases = nichePhrases(niche);
  const rows = db.prepare(`
    SELECT d.dish_id, d.name, d.price, d.discount_price, d.is_available, d.photo, d.total_like,
           r.delivery_id, r.name AS resto, r.is_own, r.url AS resto_url,
           r.rating_avg, r.total_review, r.total_order, r.district_id
    FROM dishes d JOIN restaurants r ON r.delivery_id = d.delivery_id
    WHERE d.is_active_row = 1
  `).all();

  const matched = rows.filter(d => matchesNiche(d.name, phrases) && effPrice(d) > 0);
  const toItem = (d) => ({
    resto: d.resto, deliveryId: d.delivery_id, dishId: d.dish_id, dish: d.name,
    price: effPrice(d), origPrice: d.price, discountPrice: d.discount_price,
    available: d.is_available === 1,
    rating: d.rating_avg, totalReview: d.total_review, totalOrder: d.total_order, totalLike: d.total_like,
    url: d.resto_url, photo: d.photo,
  });
  const competitors = matched.filter(d => !d.is_own).map(toItem).sort((a, b) => a.price - b.price);
  const mine = matched.filter(d => d.is_own).map(toItem).sort((a, b) => a.price - b.price);

  const prices = competitors.map(c => c.price);
  const band = prices.length
    ? { min: prices[0], max: prices[prices.length - 1], median: median(prices), avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length), count: prices.length }
    : null;

  // Gợi ý vị thế giá nếu mình đã có món trong ngách.
  let advice = null;
  if (band && mine.length) {
    const myMin = Math.min(...mine.map(m => m.price));
    const cheaper = competitors.filter(c => c.price < myMin).length;
    advice = {
      myPrice: myMin, marketMedian: band.median,
      cheaperThanMe: cheaper,
      position: myMin <= band.min ? 'rẻ nhất thị trường'
        : myMin >= band.max ? 'đắt nhất thị trường'
        : myMin <= band.median ? 'rẻ hơn trung vị' : 'đắt hơn trung vị',
    };
  }
  return { phrases, band, competitors, mine, advice };
}

// ── Xếp hạng đối thủ theo tốc độ tăng review (≈ bán chạy) + sao + đơn ──
function competitorRanking({ days = 14 } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - days * DAY).toISOString();
  const restos = db.prepare("SELECT * FROM restaurants WHERE is_own = 0").all();

  const out = restos.map(r => {
    const hist = db.prepare(`
      SELECT total_review, rating_avg, total_order, is_open, scanned_at
      FROM restaurant_history WHERE delivery_id = ? AND scanned_at >= ? ORDER BY scanned_at ASC
    `).all(r.delivery_id, since);

    let reviewDelta = null, orderDelta = null, ratingChange = null;
    if (hist.length >= 2) {
      const a = hist[0], b = hist[hist.length - 1];
      reviewDelta = Math.max(0, (b.total_review || 0) - (a.total_review || 0));
      orderDelta = Math.max(0, (b.total_order || 0) - (a.total_order || 0));
      if (a.rating_avg != null && b.rating_avg != null) ratingChange = Math.round((b.rating_avg - a.rating_avg) * 100) / 100;
    }
    let promo = []; try { promo = JSON.parse(r.promo_summary || '[]'); } catch {}
    return {
      deliveryId: r.delivery_id, name: r.name, url: r.url,
      rating: r.rating_avg, totalReview: r.total_review,
      reviewDelta, orderDelta, ratingChange,
      isOpen: r.is_open === 1, hasPromo: promo.length > 0, promo,
      districtId: r.district_id, scans: hist.length,
    };
  });

  // Ưu tiên review tăng nhanh (bán chạy), rồi sao, rồi tổng review.
  out.sort((a, b) =>
    (b.reviewDelta ?? -1) - (a.reviewDelta ?? -1) ||
    (b.rating || 0) - (a.rating || 0) ||
    (b.totalReview || 0) - (a.totalReview || 0));
  return out;
}

// ── Radar khuyến mãi & cơ hội (thuần DB) ──
// Biến feed "changes" + trạng thái quán thành việc-cần-làm: ai đang KM, ai đóng cửa,
// món hot vừa hết (cơ hội hứng đơn), và mình đang bị phá giá ở đâu.
function getOpportunities({ days = 3, niche } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - days * DAY).toISOString();
  const comps = db.prepare('SELECT * FROM restaurants WHERE is_own = 0').all();

  // Đối thủ đang chạy KM (promo_summary còn hiệu lực).
  const promoNow = [];
  for (const c of comps) {
    let ps = []; try { ps = JSON.parse(c.promo_summary || '[]'); } catch {}
    const texts = ps.map(p => p.text).filter(Boolean);
    if (texts.length) promoNow.push({ deliveryId: c.delivery_id, name: c.name, url: c.url, rating: c.rating_avg, isOpen: c.is_open === 1, promo: texts });
  }

  // Đối thủ đang đóng cửa → mở vào khung giờ họ nghỉ để hứng đơn.
  const closedNow = comps.filter(c => c.is_open === 0)
    .map(c => ({ deliveryId: c.delivery_id, name: c.name, url: c.url, rating: c.rating_avg, openTime: c.open_time, closeTime: c.close_time }));

  // KM / giảm giá vừa bật gần đây.
  const recentPromoStarts = db.prepare(
    `SELECT change_type, title, url, image, created_at FROM changes
     WHERE change_type IN ('promo_start','dish_discount') AND created_at >= ? ORDER BY created_at DESC LIMIT 20`).all(since);

  // Món của đối thủ VỪA HẾT (chỉ giữ món vẫn đang hết = cơ hội còn hiệu lực), kèm ♥ để biết món hot.
  const hotSoldOut = db.prepare(
    `SELECT delivery_id, dish_id, title, url, created_at FROM changes
     WHERE change_type = 'dish_unavailable' AND created_at >= ? ORDER BY created_at DESC LIMIT 30`).all(since)
    .map(c => {
      const d = c.dish_id ? db.prepare('SELECT name, total_like, is_available FROM dishes WHERE delivery_id = ? AND dish_id = ?').get(c.delivery_id, c.dish_id) : null;
      const resto = db.prepare('SELECT name, url FROM restaurants WHERE delivery_id = ?').get(c.delivery_id);
      return { title: c.title, url: c.url || resto?.url, createdAt: c.created_at, resto: resto?.name, totalLike: d?.total_like ?? null, stillOut: d ? d.is_available === 0 : null };
    })
    .filter(x => x.stillOut !== false)
    .sort((a, b) => (b.totalLike || 0) - (a.totalLike || 0));

  // Phá giá: mình đang bị đối thủ bán rẻ hơn trong ngách.
  let undercut = [];
  const band = marketBand(niche);
  if (band.mine.length && band.competitors.length) {
    const myMin = Math.min(...band.mine.map(m => m.price));
    undercut = band.competitors.filter(c => c.price < myMin).slice(0, 8)
      .map(c => ({ resto: c.resto, dish: c.dish, price: c.price, myPrice: myMin, url: c.url, photo: c.photo, gapPct: Math.round((c.price - myMin) / myMin * 1000) / 10 }));
  }

  return { days, promoNow, closedNow, recentPromoStarts, hotSoldOut, undercut };
}

// ── Tổng quan dashboard: KPI nhanh + cơ hội ──
function getOverview({ days = 14, niche } = {}) {
  const db = getDb();
  const d1 = new Date(Date.now() - DAY).toISOString();
  const comps = db.prepare('SELECT * FROM restaurants WHERE is_own = 0').all();
  const ownCount = db.prepare('SELECT COUNT(*) n FROM restaurants WHERE is_own = 1').get().n;
  const hasPromo = (c) => { let ps = []; try { ps = JSON.parse(c.promo_summary || '[]'); } catch {} return ps.some(p => p.text); };
  const promoNow = comps.filter(hasPromo).length;
  const closedNow = comps.filter(c => c.is_open === 0).length;
  const newDishes24h = db.prepare("SELECT COUNT(*) n FROM changes WHERE change_type='new_dish' AND created_at >= ?").get(d1).n;
  const priceChanges24h = db.prepare("SELECT COUNT(*) n FROM changes WHERE change_type IN ('dish_price','dish_discount') AND created_at >= ?").get(d1).n;
  const ranking = competitorRanking({ days });
  const topMover = ranking.find(r => r.reviewDelta > 0) || null;

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      competitors: comps.length, ownShops: ownCount, promoNow, closedNow,
      newDishes24h, priceChanges24h,
      topMover: topMover ? { name: topMover.name, reviewDelta: topMover.reviewDelta, url: topMover.url } : null,
    },
    opportunities: getOpportunities({ days: 3, niche }),
  };
}

module.exports = { marketBand, competitorRanking, getOpportunities, getOverview };
