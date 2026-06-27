// Test thuần (không cần DB/browser) cho foodNormalize — fixture mô phỏng shape dò live.
const assert = require('assert');
const { normalizeScrape, parseLikeCount, imgFromMms } = require('../src/lib/foodNormalize');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓', name); };

// Fixture: get_detail.reply.delivery_detail + get_delivery_dishes.reply.menu_infos
const detail = { reply: { delivery_detail: {
  id: 655, restaurant_id: 1148, brand_id: 4523,
  name: 'Cơm Gà Hải Nam - Nguyễn Tri Phương', name_en: 'Com ga Hai Nam',
  url_rewrite_name: 'com-ga-hai-nam-nguyen-tri-phuong', restaurant_url: 'com-ga-hai-nam-nguyen-tri-phuong',
  location_url: 'ho-chi-minh', address: '379 Nguyễn Tri Phương', city_id: 217, district_id: 5, ward_id: 106,
  position: { latitude: 10.76, longitude: 106.66 },
  categories: ['Quán ăn'], cuisines: ['Món Trung Hoa'],
  is_open: true, operating: { status: 1, open_time: '09:30:00', close_time: '21:15:59' },
  rating: { avg: 4.8, total_review: 1000 }, total_order: 320, user_favorite_count: 50,
  min_order_value: { value: 20000 }, delivery: { avg_price: { value: 100586 } },
  promotion_groups: [{ id: 1, group: 1, text: 'Giảm 30%', discount_type: 2 }],
  campaigns: [], price_slash_discounts: [],
  logo_mms_img_id: 'vn-logo-abc', photos: [{ width: 640, value: 'https://mms.img.susercontent.com/vn-big.jpg' }],
  display_order: 621,
} } };

const menu = { reply: { menu_infos: [
  { dish_type_name: 'Cơm', display_order: 1, dishes: [
    { id: 204310, name: 'Cơm đùi gà nước mắm', price: { value: 98000 }, discount_price: { value: 68250 },
      is_available: true, is_active: true, total_like: '50+', discount_remaining_quantity: 1,
      options: [], mms_image: 'vn-dish-1', photos: [{ width: 120, value: 'https://mms.img.susercontent.com/vn-dish-1.jpg' }], display_order: 29 },
    { id: 204311, name: 'Cơm gà xối mỡ', price: { value: 75000 }, discount_price: { value: 0 },
      is_available: false, is_active: true, total_like: '1.2k+', options: [{}, {}], display_order: 30 },
  ] },
] } };

t('parseLikeCount xử lý "50+", "1.2k+", số', () => {
  assert.strictEqual(parseLikeCount('50+'), 50);
  assert.strictEqual(parseLikeCount('1.2k+'), 1200);
  assert.strictEqual(parseLikeCount(42), 42);
  assert.strictEqual(parseLikeCount(null), null);
});

t('imgFromMms ghép base, giữ URL đầy đủ', () => {
  assert.strictEqual(imgFromMms('vn-x'), 'https://mms.img.susercontent.com/vn-x');
  assert.strictEqual(imgFromMms('https://a/b.jpg'), 'https://a/b.jpg');
});

const out = normalizeScrape({ detail, menu });

t('quán: id/url/giờ mở/rating/đơn/promo', () => {
  const r = out.restaurant;
  assert.strictEqual(r.deliveryId, '655');
  assert.strictEqual(r.restaurantId, '1148');
  assert.strictEqual(r.url, 'https://shopeefood.vn/ho-chi-minh/com-ga-hai-nam-nguyen-tri-phuong');
  assert.strictEqual(r.isOpen, true);
  assert.strictEqual(r.openTime, '09:30:00');
  assert.strictEqual(r.ratingAvg, 4.8);
  assert.strictEqual(r.totalReview, 1000);
  assert.strictEqual(r.totalOrder, 320);
  assert.strictEqual(r.minOrderValue, 20000);
  assert.strictEqual(r.avgPrice, 100586);
  assert.strictEqual(r.promotionGroups.length, 1);
  assert.strictEqual(r.photo, 'https://mms.img.susercontent.com/vn-big.jpg');
});

t('món: giá gốc + KM + còn/hết + like + topping', () => {
  assert.strictEqual(out.dishes.length, 2);
  const d0 = out.dishes[0];
  assert.strictEqual(d0.dishId, '204310');
  assert.strictEqual(d0.groupName, 'Cơm');
  assert.strictEqual(d0.price, 98000);
  assert.strictEqual(d0.discountPrice, 68250);
  assert.strictEqual(d0.isAvailable, true);
  assert.strictEqual(d0.totalLike, 50);
  assert.strictEqual(d0.discountRemaining, 1);
  const d1 = out.dishes[1];
  assert.strictEqual(d1.isAvailable, false);
  assert.strictEqual(d1.totalLike, 1200);
  assert.strictEqual(d1.optionCount, 2);
});

t('promotions: gộp từ promotion_groups', () => {
  assert.strictEqual(out.promotions.length, 1);
  assert.strictEqual(out.promotions[0].kind, 'group');
  assert.strictEqual(out.promotions[0].text, 'Giảm 30%');
});

console.log(`\nOK — ${pass} test passed.`);
