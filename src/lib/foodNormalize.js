// foodNormalize.js — chuyển JSON ShopeeFood (gappapi.deliverynow.vn) → cấu trúc chuẩn của app.
// THUẦN HÀM, không cần browser → test độc lập (test/normalize.test.js).
// Shape dò live 2026-06-18 (Chrome intercept). Tham chiếu: memory shopeefood-api-map.
//   get_detail        → reply.delivery_detail (quán)
//   get_delivery_dishes → reply.menu_infos[] (nhóm món → dishes[])
//   get_browsing_infos  → reply.delivery_infos[] (danh sách quán, cùng shape quán)

const MMS_BASE = 'https://mms.img.susercontent.com';
const SITE = 'https://shopeefood.vn';

function imgFromMms(id) {
  if (!id) return null;
  return String(id).startsWith('http') ? id : `${MMS_BASE}/${id}`;
}

// photos[].value thường đã là URL đầy đủ; chọn ảnh có width lớn nhất, fallback mms id.
function pickPhoto(photos, fallbackMmsId) {
  if (Array.isArray(photos) && photos.length) {
    const withVal = photos.filter(p => p && p.value);
    if (withVal.length) {
      const best = withVal.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a), withVal[0]);
      return String(best.value).startsWith('http') ? best.value : imgFromMms(best.value);
    }
  }
  return imgFromMms(fallbackMmsId);
}

// "50+" | "1.2k+" | "2tr" | 50 → số nguyên ước lượng
function parseLikeCount(v) {
  if (typeof v === 'number') return v;
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/[+,\s]/g, '');
  const m = s.match(/^([\d.]+)(k|tr|m)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === 'k') n *= 1e3;
  else if (m[2] === 'm' || m[2] === 'tr') n *= 1e6;
  return Math.round(n);
}

function buildUrl(locationUrl, slug) {
  if (!locationUrl || !slug) return null;
  return `${SITE}/${locationUrl}/${slug}`;
}

// Trích quán từ delivery_detail HOẶC 1 phần tử delivery_infos[] (cùng shape).
function normalizeRestaurant(d) {
  if (!d) return null;
  const op = d.operating || {};
  const rating = d.rating || {};
  const pos = d.position || {};
  const promotionGroups = Array.isArray(d.promotion_groups)
    ? d.promotion_groups.map(g => ({ group: g.group, text: g.text, discountType: g.discount_type, id: g.id }))
    : [];
  return {
    deliveryId: String(d.id ?? d.delivery_id ?? ''),
    restaurantId: d.restaurant_id != null ? String(d.restaurant_id) : null,
    brandId: d.brand_id != null ? String(d.brand_id) : null,
    name: d.name || d.name_en || null,
    nameEn: d.name_en || null,
    slug: d.url_rewrite_name || d.restaurant_url || null,
    locationUrl: d.location_url || null,
    url: (typeof d.url === 'string' && d.url.startsWith('http'))
      ? d.url
      : buildUrl(d.location_url, d.restaurant_url || d.url_rewrite_name),
    address: d.address || null,
    cityId: d.city_id ?? null,
    districtId: d.district_id ?? null,
    wardId: d.ward_id ?? null,
    lat: pos.latitude ?? pos.lat ?? null,
    lng: pos.longitude ?? pos.lng ?? null,
    categories: Array.isArray(d.categories) ? d.categories : [],
    cuisines: Array.isArray(d.cuisines) ? d.cuisines : [],
    isOpen: typeof d.is_open === 'boolean' ? d.is_open
          : op.status === 1 ? true : op.status === 0 ? false : null,
    openTime: op.open_time || null,
    closeTime: op.close_time || null,
    operatingStatus: op.status ?? null,
    ratingAvg: typeof rating.avg === 'number' ? rating.avg : null,
    totalReview: typeof rating.total_review === 'number' ? rating.total_review : null,
    totalOrder: typeof d.total_order === 'number' ? d.total_order : null,
    favoriteCount: typeof d.user_favorite_count === 'number' ? d.user_favorite_count : null,
    minOrderValue: d.min_order_value?.value ?? null,
    avgPrice: d.delivery?.avg_price?.value ?? null,
    promotionGroups,
    photo: pickPhoto(d.photos, d.logo_mms_img_id || d.image_name),
    displayOrder: d.display_order ?? null,
  };
}

// menu_infos[] → mảng món phẳng (kèm tên nhóm). Giá: price.value (gốc), discount_price.value (KM).
function normalizeDishes(menuInfos) {
  if (!Array.isArray(menuInfos)) return [];
  const out = [];
  for (const g of menuInfos) {
    const groupName = g.dish_type_name || null;
    for (const dish of (g.dishes || [])) {
      if (!dish || dish.id == null) continue;
      out.push({
        dishId: String(dish.id),
        groupName,
        name: dish.name || null,
        description: dish.description || null,
        price: dish.price?.value ?? null,
        discountPrice: dish.discount_price?.value ?? null,
        isAvailable: typeof dish.is_available === 'boolean' ? dish.is_available : null,
        isActive: typeof dish.is_active === 'boolean' ? dish.is_active : null,
        totalLike: parseLikeCount(dish.total_like),
        discountRemaining: typeof dish.discount_remaining_quantity === 'number' ? dish.discount_remaining_quantity : null,
        optionCount: Array.isArray(dish.options) ? dish.options.length : 0,
        photo: pickPhoto(dish.photos, dish.mms_image),
        displayOrder: dish.display_order ?? null,
      });
    }
  }
  return out;
}

// Promo cấp quán: gộp promotion_groups + campaigns + price_slash_discounts thành list gọn.
function normalizePromotions(d) {
  const promos = [];
  for (const g of (d?.promotion_groups || [])) {
    promos.push({ key: `g${g.id ?? g.group}`, kind: 'group', text: g.text || '', discountType: g.discount_type ?? null });
  }
  for (const c of (d?.campaigns || [])) {
    promos.push({ key: `c${c.id ?? c.campaign_id ?? ''}`, kind: 'campaign', text: c.title || c.text || '', discountType: c.discount_type ?? null });
  }
  for (const p of (d?.price_slash_discounts || [])) {
    promos.push({ key: `s${p.id ?? ''}`, kind: 'flash', text: p.title || p.text || 'Flash sale', discountType: p.discount_type ?? null });
  }
  return promos;
}

// Gói chung: từ raw scrape (detail + menu) → payload chuẩn để persist.
function normalizeScrape({ detail, menu } = {}) {
  const dd = detail?.reply?.delivery_detail || detail?.delivery_detail || detail || {};
  const menuInfos = menu?.reply?.menu_infos || menu?.menu_infos || [];
  return {
    restaurant: normalizeRestaurant(dd),
    dishes: normalizeDishes(menuInfos),
    promotions: normalizePromotions(dd),
  };
}

module.exports = {
  normalizeRestaurant, normalizeDishes, normalizePromotions, normalizeScrape,
  imgFromMms, pickPhoto, parseLikeCount, buildUrl, MMS_BASE, SITE,
};
