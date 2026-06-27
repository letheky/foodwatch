const express = require('express');
const mon = require('../services/restaurantMonitor');
const insights = require('../services/insights');
const econ = require('../services/economics');
const rank = require('../services/rankTracker');
const foody = require('../services/foodyReviews');
const advisor = require('../services/advisor');
const scheduler = require('../services/scheduler');
const exporter = require('../services/exporter');
const { getConfig, saveConfig, sendTelegram } = require('../services/telegram');
const { getSetting, setSetting } = require('../db/database');
const { DEFAULT_NICHE } = require('../lib/dishMatch');

const router = express.Router();
const getNiche = () => getSetting('niche') || DEFAULT_NICHE.join(', ');

// scraper require lazy: API quản lý/đọc DB vẫn chạy được khi máy chưa có Chrome/driver.
function scraper() { return require('../services/foodScraper'); }
const err = (res, e, code = 500) => res.status(code).json({ success: false, error: e.message || String(e) });

// ── Quán ──────────────────────────────────────────────────
router.get('/restaurants', (req, res) => {
  res.json({ success: true, data: mon.listRestaurants() });
});

// Thêm quán bằng URL: scrape 1 lần → persist snapshot + đặt registry (own/group).
router.post('/restaurants', async (req, res) => {
  const { url, isOwn = false, groupId = null } = req.body || {};
  if (!url) return err(res, new Error('Thiếu url'), 400);
  try {
    const scraped = await scraper().scrapeRestaurant(url.trim());
    const result = mon.persistRestaurantScan(scraped);
    mon.setRestaurantMeta(result.deliveryId, { isOwn, groupId });
    res.json({ success: true, data: { ...result, restaurant: mon.getRestaurant(result.deliveryId), warning: scraped.warning } });
  } catch (e) { err(res, e); }
});

router.get('/restaurants/:id', (req, res) => {
  const r = mon.getRestaurant(req.params.id);
  if (!r) return err(res, new Error('Không tìm thấy quán'), 404);
  res.json({ success: true, data: r });
});

router.patch('/restaurants/:id', (req, res) => {
  try { res.json({ success: true, data: mon.setRestaurantMeta(req.params.id, req.body || {}) }); }
  catch (e) { err(res, e, 400); }
});

router.delete('/restaurants/:id', (req, res) => {
  mon.deleteRestaurant(req.params.id);
  res.json({ success: true });
});

// Quét menu 1 quán. Dùng url đã lưu; nếu quán CHƯA theo dõi (vd bấm "Quét menu" ở bảng
// xếp hạng) thì nhận url trong body → quét + persist (persistRestaurantScan tự upsert vào hệ).
router.post('/restaurants/:id/sync', async (req, res) => {
  const r = mon.getRestaurant(req.params.id);
  const url = (r && r.url) || (req.body?.url || '').trim();
  if (!url) return err(res, new Error('Quán chưa có URL để quét — quét lại thứ hạng hoặc thêm bằng link'), 400);
  try {
    const scraped = await scraper().scrapeRestaurant(url);
    res.json({ success: true, data: mon.persistRestaurantScan(scraped) });
  } catch (e) { err(res, e); }
});

// Nạp kết quả scrape sẵn (cho mô hình 2-tier crawler local, hoặc test không cần browser).
router.post('/ingest', (req, res) => {
  try { res.json({ success: true, data: mon.persistRestaurantScan(req.body?.scraped || req.body) }); }
  catch (e) { err(res, e, 400); }
});

// ── Món ───────────────────────────────────────────────────
router.get('/restaurants/:id/dishes', (req, res) => {
  res.json({ success: true, data: mon.listDishes(req.params.id) });
});
router.get('/restaurants/:id/dishes/:dishId/history', (req, res) => {
  res.json({ success: true, data: mon.getDishHistory(req.params.id, req.params.dishId, Math.min(parseInt(req.query.limit) || 90, 365)) });
});

// ── Feed thay đổi ─────────────────────────────────────────
router.get('/changes', (req, res) => {
  res.json({ success: true, data: mon.getChanges(null, Math.min(parseInt(req.query.limit) || 200, 500)) });
});
router.get('/restaurants/:id/changes', (req, res) => {
  res.json({ success: true, data: mon.getChanges(req.params.id, Math.min(parseInt(req.query.limit) || 100, 300)) });
});

// ── Khám phá đối thủ theo khu vực (Hà Nội=ha-noi, Hoàn Kiếm district_id=25) ──
router.post('/discover', async (req, res) => {
  const cityUrl = (req.body?.cityUrl || 'ha-noi').trim();
  const districtId = req.body?.districtId === null ? null : (req.body?.districtId ?? 25);
  try {
    const list = await scraper().scrapeArea({ cityUrl });
    const inDistrict = districtId != null ? list.filter(r => String(r.districtId) === String(districtId)) : list;
    for (const r of inDistrict) mon.registerAreaRestaurant(r);
    res.json({ success: true, data: {
      found: list.length, inDistrict: inDistrict.length, districtId,
      candidates: inDistrict.map(r => ({
        deliveryId: r.deliveryId, name: r.name, rating: r.ratingAvg, totalReview: r.totalReview,
        isOpen: r.isOpen, cuisines: r.cuisines, categories: r.categories,
        promo: (r.promotionGroups || []).map(g => g.text).filter(Boolean),
        url: r.url, photo: r.photo,
      })),
    }});
  } catch (e) { err(res, e); }
});

// Giá thị trường theo ngách (mặc định "bánh đa cá…") — cần đã quét menu vài quán.
router.get('/market', (req, res) => {
  res.json({ success: true, data: insights.marketBand(req.query.niche || getNiche()) });
});

// Xếp hạng đối thủ theo tốc độ review (≈ bán chạy) + sao + KM.
router.get('/insights', (req, res) => {
  res.json({ success: true, data: insights.competitorRanking({ days: Math.min(parseInt(req.query.days) || 14, 90) }) });
});

// Tổng quan dashboard: KPI nhanh + radar KM/cơ hội.
router.get('/overview', (req, res) => {
  try { res.json({ success: true, data: insights.getOverview({ days: Math.min(parseInt(req.query.days) || 14, 90), niche: req.query.niche || getNiche() }) }); }
  catch (e) { err(res, e); }
});
// Radar KM & cơ hội riêng (nếu cần gọi tách).
router.get('/opportunities', (req, res) => {
  try { res.json({ success: true, data: insights.getOpportunities({ days: Math.min(parseInt(req.query.days) || 3, 30), niche: req.query.niche || getNiche() }) }); }
  catch (e) { err(res, e); }
});

router.get('/settings/niche', (req, res) => res.json({ success: true, data: { niche: getNiche() } }));
router.post('/settings/niche', (req, res) => {
  setSetting('niche', String(req.body?.niche || '').trim() || DEFAULT_NICHE.join(', '));
  res.json({ success: true, data: { niche: getNiche() } });
});

// ── Đề xuất giải pháp tăng tỉ lệ thành đơn (đọc DB, không scrape) ──
router.get('/advice', (req, res) => {
  try { res.json({ success: true, data: advisor.getRecommendations({ niche: req.query.niche || getNiche(), keyword: req.query.keyword }) }); }
  catch (e) { err(res, e); }
});

// ── Đánh giá THẬT từ foody.vn ─────────────────────────────
// POST /restaurants/:id/foody/scan — mở Chrome lấy Summary.Total + review (lâu ~25-40s).
router.post('/restaurants/:id/foody/scan', async (req, res) => {
  try { res.json({ success: true, data: await foody.scanFoodyReviews(req.params.id) }); }
  catch (e) { err(res, e); }
});
router.get('/restaurants/:id/foody', (req, res) => {
  res.json({ success: true, data: foody.getFoodyReviews(req.params.id) });
});

// ── Thứ hạng từ khoá ──────────────────────────────────────
// POST /rank/scan {keyword} — mở Chrome, search_global, lưu batch (lâu ~30-60s).
router.post('/rank/scan', async (req, res) => {
  const keyword = (req.body?.keyword || getNiche().split(',')[0]).trim();
  if (!keyword) return err(res, new Error('Thiếu từ khoá'), 400);
  try { res.json({ success: true, data: await rank.scanRank(keyword, { cityUrl: req.body?.cityUrl || 'ha-noi', lat: req.body?.lat ?? null, lng: req.body?.lng ?? null }) }); }
  catch (e) { err(res, e); }
});
router.get('/rank', (req, res) => {
  const keyword = (req.query.keyword || getNiche().split(',')[0]).trim();
  res.json({ success: true, data: rank.getRank(keyword) });
});
router.get('/rank/keywords', (req, res) => res.json({ success: true, data: rank.listKeywords() }));

// Điểm giao để xếp hạng theo vị trí (P1b).
router.get('/settings/delivery-point', (req, res) => res.json({ success: true, data: rank.getDeliveryPoint() }));
router.post('/settings/delivery-point', (req, res) => res.json({ success: true, data: rank.setDeliveryPoint(req.body || {}) }));

// ── Bộ tính chi phí sàn + kinh tế ─────────────────────────
router.get('/settings/fees', (req, res) => res.json({ success: true, data: econ.getFees() }));
router.post('/settings/fees', (req, res) => res.json({ success: true, data: econ.setFees(req.body || {}) }));

// Máy tính lợi nhuận: 1 đơn giá P × qty (cho trang Bộ tính chi phí). feeOverride = what-if không lưu.
router.post('/calc', (req, res) => {
  const { price, qty = 1, includeCogs = true, ...feeOverride } = req.body || {};
  res.json({ success: true, data: econ.calcOrder({ price, qty, includeCogs, feeOverride }) });
});

// Kinh tế 1 quán: đơn/kỳ + doanh thu ước + thực nhận sau phí sàn.
router.get('/restaurants/:id/economics', (req, res) => {
  const d = econ.restaurantEconomics(req.params.id, Math.min(parseInt(req.query.days) || 30, 180));
  if (!d) return err(res, new Error('Không tìm thấy quán'), 404);
  res.json({ success: true, data: d });
});

// ── Tự động quét + Quét tất cả ────────────────────────────
router.get('/scan-status', (req, res) => res.json({ success: true, data: scheduler.getStatus() }));
router.post('/scan-all', (req, res) => res.json({ success: true, data: scheduler.scanAll() }));
router.get('/settings/scan', (req, res) => res.json({ success: true, data: scheduler.getAuto() }));
router.post('/settings/scan', (req, res) => res.json({ success: true, data: scheduler.setAuto(req.body || {}) }));

// ── Xuất dữ liệu (CSV bảng đối thủ / Markdown báo cáo) ────
router.get('/export', (req, res) => {
  try {
    const fmt = (req.query.format || 'md').toLowerCase() === 'csv' ? 'csv' : 'md';
    const { filename, mime, content } = exporter.buildExport(fmt, { niche: getNiche(), days: Math.min(parseInt(req.query.days) || 14, 90) });
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (e) { err(res, e); }
});

// ── Telegram ──────────────────────────────────────────────
router.get('/settings/telegram', (req, res) => {
  const cfg = getConfig();
  res.json({ success: true, data: { configured: !!cfg } });
});
router.post('/settings/telegram', async (req, res) => {
  const { token, chatId } = req.body || {};
  if (!token || !chatId) return err(res, new Error('Cần token và chatId'), 400);
  saveConfig(token.trim(), chatId.trim());
  try { await sendTelegram(token.trim(), chatId.trim(), '✅ <b>FoodWatch</b> đã kết nối Telegram.'); res.json({ success: true }); }
  catch (e) { err(res, e); }
});

module.exports = router;
