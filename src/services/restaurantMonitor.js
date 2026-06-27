// Ghi DB + phát hiện thay đổi cho 1 lần scan quán. Dựa trên persistShopScan của base ShopWatch.
const { getDb } = require('../db/database');
const { v4: uuid } = require('uuid');
const { notifyChanges } = require('./telegram');

const fmtPrice = (v) => (v ? Number(v).toLocaleString('vi-VN') + 'đ' : '—');
// Giá hiệu lực = giá KM nếu có, không thì giá gốc.
const effPrice = (d) => (d.discountPrice && d.discountPrice > 0 ? d.discountPrice : d.price);
const bool01 = (v) => (v === true ? 1 : v === false ? 0 : null);

// ── Đăng ký quán (registry) — gọi khi thêm quán; KHÔNG đụng dữ liệu scan ──
function addRestaurant({ deliveryId, name, url, slug, locationUrl, isOwn = false, groupId = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO restaurants (delivery_id, name, url, slug, location_url, is_own, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(delivery_id) DO UPDATE SET
      is_own = excluded.is_own, group_id = excluded.group_id,
      url = COALESCE(excluded.url, restaurants.url)
  `).run(String(deliveryId), name || null, url || null, slug || null, locationUrl || null, isOwn ? 1 : 0, groupId);
  return db.prepare('SELECT * FROM restaurants WHERE delivery_id = ?').get(String(deliveryId));
}

function setRestaurantMeta(deliveryId, { isOwn, groupId, scanIntervalH, notes } = {}) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM restaurants WHERE delivery_id = ?').get(String(deliveryId));
  if (!cur) throw new Error('Quán chưa có trong hệ thống');
  db.prepare(`
    UPDATE restaurants SET
      is_own = ?, group_id = ?, scan_interval_h = ?, notes = ?
    WHERE delivery_id = ?
  `).run(
    isOwn != null ? (isOwn ? 1 : 0) : cur.is_own,
    groupId !== undefined ? groupId : cur.group_id,
    scanIntervalH !== undefined ? scanIntervalH : cur.scan_interval_h,
    notes !== undefined ? notes : cur.notes,
    String(deliveryId),
  );
  return db.prepare('SELECT * FROM restaurants WHERE delivery_id = ?').get(String(deliveryId));
}

// ── Ghi quán cấp KHU VỰC (từ quét vùng) — chỉ trạng thái quán, KHÔNG đụng menu/changes ──
// Dùng COALESCE để không xoá dish_count/registry của quán đang theo dõi. Re-discover không spam feed.
function registerAreaRestaurant(r) {
  if (!r || !r.deliveryId) return;
  const db = getDb();
  const now = new Date().toISOString();
  const id = String(r.deliveryId);
  let promos = [];
  if (Array.isArray(r.promotionGroups)) {
    promos = r.promotionGroups.map(g => ({ key: `g${g.id ?? g.group}`, kind: 'group', text: g.text || '' }));
  }
  db.prepare(`
    INSERT INTO restaurants (
      delivery_id, restaurant_id, brand_id, name, name_en, url, slug, location_url,
      address, city_id, district_id, ward_id, lat, lng, categories, cuisines, photo,
      is_open, open_time, close_time, rating_avg, total_review, total_order, favorite_count,
      min_order_value, avg_price, promo_summary, source, last_scanned_at, first_seen_at
    ) VALUES (
      @delivery_id, @restaurant_id, @brand_id, @name, @name_en, @url, @slug, @location_url,
      @address, @city_id, @district_id, @ward_id, @lat, @lng, @categories, @cuisines, @photo,
      @is_open, @open_time, @close_time, @rating_avg, @total_review, @total_order, @favorite_count,
      @min_order_value, @avg_price, @promo_summary, 'area', @now, @now
    )
    ON CONFLICT(delivery_id) DO UPDATE SET
      name=excluded.name, url=COALESCE(excluded.url, restaurants.url), photo=excluded.photo,
      address=excluded.address, district_id=excluded.district_id, ward_id=excluded.ward_id,
      lat=excluded.lat, lng=excluded.lng, categories=excluded.categories, cuisines=excluded.cuisines,
      is_open=excluded.is_open, open_time=excluded.open_time, close_time=excluded.close_time,
      rating_avg=excluded.rating_avg, total_review=excluded.total_review, total_order=excluded.total_order,
      favorite_count=excluded.favorite_count, min_order_value=excluded.min_order_value,
      avg_price=excluded.avg_price, promo_summary=excluded.promo_summary, last_scanned_at=excluded.last_scanned_at
  `).run({
    delivery_id: id, restaurant_id: r.restaurantId, brand_id: r.brandId,
    name: r.name, name_en: r.nameEn, url: r.url, slug: r.slug, location_url: r.locationUrl,
    address: r.address, city_id: r.cityId, district_id: r.districtId, ward_id: r.wardId,
    lat: r.lat, lng: r.lng,
    categories: JSON.stringify(r.categories || []), cuisines: JSON.stringify(r.cuisines || []),
    photo: r.photo, is_open: bool01(r.isOpen), open_time: r.openTime, close_time: r.closeTime,
    rating_avg: r.ratingAvg, total_review: r.totalReview, total_order: r.totalOrder,
    favorite_count: r.favoriteCount, min_order_value: r.minOrderValue, avg_price: r.avgPrice,
    promo_summary: JSON.stringify(promos), now,
  });
  db.prepare(`INSERT INTO restaurant_history (id, delivery_id, rating_avg, total_review, total_order, is_open, scanned_at)
    VALUES (?,?,?,?,?,?,?)`).run(uuid(), id, r.ratingAvg, r.totalReview, r.totalOrder, bool01(r.isOpen), now);
}

// ── Lõi: ghi 1 lần scan + diff so với trạng thái cũ ──
function persistRestaurantScan(scraped) {
  const db = getDb();
  const r = scraped?.restaurant;
  if (!r || !r.deliveryId) throw new Error('Thiếu dữ liệu quán (deliveryId)');
  const dishes = Array.isArray(scraped.dishes) ? scraped.dishes : [];
  const promos = Array.isArray(scraped.promotions) ? scraped.promotions : [];
  const id = String(r.deliveryId);
  const now = new Date().toISOString();
  const changes = [];

  const old = db.prepare('SELECT * FROM restaurants WHERE delivery_id = ?').get(id) || null;

  const tx = db.transaction(() => {
    // 1) Upsert quán (giữ nguyên registry: is_own/group_id/scan_interval_h/notes)
    db.prepare(`
      INSERT INTO restaurants (
        delivery_id, restaurant_id, brand_id, name, name_en, url, slug, location_url,
        address, city_id, district_id, ward_id, lat, lng, categories, cuisines, photo,
        is_open, open_time, close_time, rating_avg, total_review, total_order, favorite_count,
        min_order_value, avg_price, promo_summary, dish_count, last_scanned_at, first_seen_at
      ) VALUES (
        @delivery_id, @restaurant_id, @brand_id, @name, @name_en, @url, @slug, @location_url,
        @address, @city_id, @district_id, @ward_id, @lat, @lng, @categories, @cuisines, @photo,
        @is_open, @open_time, @close_time, @rating_avg, @total_review, @total_order, @favorite_count,
        @min_order_value, @avg_price, @promo_summary, @dish_count, @now, @now
      )
      ON CONFLICT(delivery_id) DO UPDATE SET
        restaurant_id=excluded.restaurant_id, brand_id=excluded.brand_id,
        name=excluded.name, name_en=excluded.name_en, url=COALESCE(excluded.url, restaurants.url),
        slug=excluded.slug, location_url=excluded.location_url, address=excluded.address,
        city_id=excluded.city_id, district_id=excluded.district_id, ward_id=excluded.ward_id,
        lat=excluded.lat, lng=excluded.lng, categories=excluded.categories, cuisines=excluded.cuisines,
        photo=excluded.photo, is_open=excluded.is_open, open_time=excluded.open_time, close_time=excluded.close_time,
        rating_avg=excluded.rating_avg, total_review=excluded.total_review, total_order=excluded.total_order,
        favorite_count=excluded.favorite_count, min_order_value=excluded.min_order_value,
        avg_price=excluded.avg_price, promo_summary=excluded.promo_summary,
        dish_count=excluded.dish_count, last_scanned_at=excluded.last_scanned_at
    `).run({
      delivery_id: id, restaurant_id: r.restaurantId, brand_id: r.brandId,
      name: r.name, name_en: r.nameEn, url: r.url, slug: r.slug, location_url: r.locationUrl,
      address: r.address, city_id: r.cityId, district_id: r.districtId, ward_id: r.wardId,
      lat: r.lat, lng: r.lng,
      categories: JSON.stringify(r.categories || []), cuisines: JSON.stringify(r.cuisines || []),
      photo: r.photo, is_open: bool01(r.isOpen), open_time: r.openTime, close_time: r.closeTime,
      rating_avg: r.ratingAvg, total_review: r.totalReview, total_order: r.totalOrder,
      favorite_count: r.favoriteCount, min_order_value: r.minOrderValue, avg_price: r.avgPrice,
      promo_summary: JSON.stringify(promos), dish_count: dishes.length, now,
    });

    db.prepare(`INSERT INTO restaurant_history (id, delivery_id, rating_avg, total_review, total_order, is_open, scanned_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(uuid(), id, r.ratingAvg, r.totalReview, r.totalOrder, bool01(r.isOpen), now);

    // 2) Đổi ở cấp quán
    if (old) {
      const oldOpen = old.is_open, newOpen = bool01(r.isOpen);
      if (oldOpen != null && newOpen != null && oldOpen !== newOpen) {
        changes.push(newOpen === 0
          ? { type: 'restaurant_closed', title: `Đóng cửa: ${r.name}` }
          : { type: 'restaurant_open', title: `Mở cửa lại: ${r.name}` });
      }
      if (old.name && r.name && old.name !== r.name) {
        changes.push({ type: 'name_change', title: `Đổi tên quán: "${old.name}" → "${r.name}"`,
          oldValue: { name: old.name }, newValue: { name: r.name } });
      }
      if (old.rating_avg != null && r.ratingAvg != null && Math.abs(old.rating_avg - r.ratingAvg) >= 0.1) {
        const dir = r.ratingAvg < old.rating_avg ? 'giảm' : 'tăng';
        changes.push({ type: 'rating_change', title: `Sao ${dir}: ${r.name} — ${old.rating_avg} → ${r.ratingAvg}`,
          oldValue: { rating: old.rating_avg }, newValue: { rating: r.ratingAvg } });
      }
    }

    // 3) Món: upsert + lịch sử + diff
    const oldDishes = db.prepare('SELECT * FROM dishes WHERE delivery_id = ? AND is_active_row = 1').all(id);
    const oldByDish = new Map(oldDishes.map(d => [String(d.dish_id), d]));
    const seen = new Set();

    const upsertDish = db.prepare(`
      INSERT INTO dishes (id, delivery_id, dish_id, group_name, name, description, price, discount_price,
        is_available, is_active, total_like, discount_remaining, option_count, photo, display_order,
        is_active_row, first_seen_at, last_seen_at)
      VALUES (@id,@delivery_id,@dish_id,@group_name,@name,@description,@price,@discount_price,
        @is_available,@is_active,@total_like,@discount_remaining,@option_count,@photo,@display_order,
        1,@now,@now)
      ON CONFLICT(delivery_id, dish_id) DO UPDATE SET
        group_name=excluded.group_name, name=excluded.name, description=excluded.description,
        price=excluded.price, discount_price=excluded.discount_price, is_available=excluded.is_available,
        is_active=excluded.is_active, total_like=excluded.total_like, discount_remaining=excluded.discount_remaining,
        option_count=excluded.option_count, photo=excluded.photo, display_order=excluded.display_order,
        is_active_row=1, last_seen_at=excluded.last_seen_at
    `);
    const insHist = db.prepare(`INSERT INTO dish_history (id, delivery_id, dish_id, price, discount_price, is_available, total_like, scanned_at)
      VALUES (?,?,?,?,?,?,?,?)`);

    for (const d of dishes) {
      const did = String(d.dishId);
      seen.add(did);
      upsertDish.run({
        id: `${id}:${did}`, delivery_id: id, dish_id: did, group_name: d.groupName, name: d.name,
        description: d.description, price: d.price, discount_price: d.discountPrice,
        is_available: bool01(d.isAvailable), is_active: bool01(d.isActive), total_like: d.totalLike,
        discount_remaining: d.discountRemaining, option_count: d.optionCount, photo: d.photo,
        display_order: d.displayOrder, now,
      });
      insHist.run(uuid(), id, did, d.price, d.discountPrice, bool01(d.isAvailable), d.totalLike, now);

      const ov = oldByDish.get(did);
      const base = { dishId: did, title: '', image: d.photo, url: r.url };
      if (!ov) {
        changes.push({ ...base, type: 'new_dish', title: `Món mới: ${d.name} — ${fmtPrice(effPrice(d))}`,
          newValue: { name: d.name, price: effPrice(d) } });
        continue;
      }
      // đổi giá hiệu lực (gốc hoặc KM)
      const oldEff = (ov.discount_price && ov.discount_price > 0) ? ov.discount_price : ov.price;
      const newEff = effPrice(d);
      if (oldEff != null && newEff != null && oldEff !== newEff) {
        const dir = newEff < oldEff ? 'giảm' : 'tăng';
        changes.push({ ...base, type: 'dish_price',
          title: `Giá món ${dir}: ${d.name} — ${fmtPrice(oldEff)} → ${fmtPrice(newEff)}`,
          oldValue: { price: oldEff }, newValue: { price: newEff, direction: dir } });
      }
      // bật/tắt KM
      const oldHadKM = ov.discount_price && ov.discount_price > 0 && ov.discount_price < ov.price;
      const newHasKM = d.discountPrice && d.discountPrice > 0 && d.discountPrice < d.price;
      if (!oldHadKM && newHasKM) {
        changes.push({ ...base, type: 'dish_discount',
          title: `KM mới: ${d.name} — ${fmtPrice(d.price)} → ${fmtPrice(d.discountPrice)}`,
          newValue: { price: d.price, discountPrice: d.discountPrice } });
      }
      // còn ↔ hết
      const oa = ov.is_available, na = bool01(d.isAvailable);
      if (oa != null && na != null && oa !== na) {
        changes.push({ ...base, type: na === 0 ? 'dish_unavailable' : 'dish_back',
          title: na === 0 ? `Hết món: ${d.name}` : `Có món trở lại: ${d.name}` });
      }
    }

    // món biến mất khỏi menu
    for (const [did, ov] of oldByDish) {
      if (!seen.has(did)) {
        db.prepare('UPDATE dishes SET is_active_row = 0, last_seen_at = ? WHERE delivery_id = ? AND dish_id = ?')
          .run(now, id, did);
        changes.push({ dishId: did, type: 'removed_dish', title: `Bỏ món: ${ov.name}`, image: ov.photo, url: r.url });
      }
    }

    // 4) Khuyến mãi: diff trạng thái bật/tắt
    const oldPromos = db.prepare('SELECT * FROM promotions WHERE delivery_id = ? AND is_active = 1').all(id);
    const oldPromoKeys = new Set(oldPromos.map(p => p.promo_key));
    const newPromoKeys = new Set(promos.map(p => p.key));
    const upPromo = db.prepare(`
      INSERT INTO promotions (id, delivery_id, promo_key, kind, text, discount_type, is_active, detected_at, ended_at)
      VALUES (?,?,?,?,?,?,1,?,NULL)
      ON CONFLICT(delivery_id, promo_key) DO UPDATE SET
        kind=excluded.kind, text=excluded.text, discount_type=excluded.discount_type, is_active=1, ended_at=NULL
    `);
    for (const p of promos) {
      upPromo.run(`${id}:${p.key}`, id, p.key, p.kind, p.text, p.discountType, now);
      if (!oldPromoKeys.has(p.key)) {
        changes.push({ type: 'promo_start', title: `KM quán bật: ${p.text || p.kind} — ${r.name}`,
          image: r.photo, url: r.url, newValue: { text: p.text, kind: p.kind } });
      }
    }
    for (const p of oldPromos) {
      if (!newPromoKeys.has(p.promo_key)) {
        db.prepare('UPDATE promotions SET is_active = 0, ended_at = ? WHERE id = ?').run(now, `${id}:${p.promo_key}`);
        changes.push({ type: 'promo_end', title: `KM quán tắt: ${p.text || p.kind} — ${r.name}`, image: r.photo, url: r.url });
      }
    }

    // 5) Ghi feed
    const insChange = db.prepare(`INSERT INTO changes (id, delivery_id, dish_id, change_type, title, image, url, old_value, new_value, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const c of changes) {
      insChange.run(uuid(), id, c.dishId || null, c.type, c.title, c.image || r.photo || null,
        c.url || r.url || null, c.oldValue ? JSON.stringify(c.oldValue) : null,
        c.newValue ? JSON.stringify(c.newValue) : null, now);
    }
  });
  tx();

  // Telegram (best-effort; chỉ khi quán là đối thủ — món/giá/KM/đóng cửa là tín hiệu cạnh tranh)
  if (changes.length && (!old || old.is_own === 0)) {
    notifyChanges(r.name, changes).catch(() => {});
  }

  return { deliveryId: id, name: r.name, dishCount: dishes.length, changes };
}

// ── Getters cho route ──
function listRestaurants() {
  return getDb().prepare('SELECT * FROM restaurants ORDER BY is_own DESC, last_scanned_at DESC').all();
}
function getRestaurant(deliveryId) {
  return getDb().prepare('SELECT * FROM restaurants WHERE delivery_id = ?').get(String(deliveryId));
}
function deleteRestaurant(deliveryId) {
  getDb().prepare('DELETE FROM restaurants WHERE delivery_id = ?').run(String(deliveryId));
}
function listDishes(deliveryId) {
  return getDb().prepare('SELECT * FROM dishes WHERE delivery_id = ? AND is_active_row = 1 ORDER BY group_name, display_order')
    .all(String(deliveryId));
}
function getChanges(deliveryId, limit = 100) {
  const db = getDb();
  if (deliveryId) {
    return db.prepare('SELECT * FROM changes WHERE delivery_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(String(deliveryId), limit);
  }
  return db.prepare('SELECT * FROM changes ORDER BY created_at DESC LIMIT ?').all(limit);
}
function getDishHistory(deliveryId, dishId, limit = 90) {
  return getDb().prepare(`SELECT price, discount_price, is_available, total_like, scanned_at
    FROM dish_history WHERE delivery_id = ? AND dish_id = ? ORDER BY scanned_at ASC LIMIT ?`)
    .all(String(deliveryId), String(dishId), limit);
}

module.exports = {
  addRestaurant, setRestaurantMeta, persistRestaurantScan, registerAreaRestaurant,
  listRestaurants, getRestaurant, deleteRestaurant, listDishes, getChanges, getDishHistory,
};
