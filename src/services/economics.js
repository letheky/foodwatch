// Bộ tính chi phí sàn + doanh thu + lợi nhuận. Phí mặc định = số thật ShopeeFood 2025 (user chỉnh được).
//   Chiết khấu food 25% GMV; Thuế (NĐ117/2025, dịch vụ ăn uống) VAT 3% + TNCN 1.5% = 4.5% GMV;
//   phí mở gian hàng 0đ. Giá vốn/đóng gói/phí khác để user nhập.
const { getSetting, setSetting, getDb } = require('../db/database');

const FEE_DEFAULTS = {
  commissionPct: 25,      // chiết khấu (hoa hồng) ShopeeFood — food
  vatPct: 3,              // VAT khấu trừ tại nguồn (ăn uống)
  tncnPct: 1.5,           // TNCN khấu trừ tại nguồn (ăn uống)
  taxEnabled: true,       // hộ KD chịu khấu trừ (dưới 1 tỷ/năm có thể được hoàn cuối kỳ)
  packagingPerOrder: 0,   // phí đóng gói / đơn (đồng) — quán tự chịu
  cogsPct: 35,            // giá vốn nguyên liệu (% giá bán) — ước lượng, user chỉnh
  otherPct: 0,            // phí khác (marketing/CPC…) theo % GMV
};

function getFees() {
  const raw = getSetting('fees');
  if (raw) { try { return { ...FEE_DEFAULTS, ...JSON.parse(raw) }; } catch {} }
  return { ...FEE_DEFAULTS };
}
function setFees(patch) {
  const merged = { ...getFees() };
  for (const k of Object.keys(FEE_DEFAULTS)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    merged[k] = (k === 'taxEnabled') ? !!patch[k] : Number(patch[k]);
  }
  setSetting('fees', JSON.stringify(merged));
  return merged;
}

// Tính chi tiết cho 1 đơn giá P (giá khách trả) × qty.
// includeCogs=false dùng cho ĐỐI THỦ (không biết giá vốn của họ) → ra "thực nhận từ sàn".
function calcOrder({ price = 0, qty = 1, includeCogs = true, feeOverride = {} } = {}) {
  const f = { ...getFees(), ...feeOverride };
  if (feeOverride.taxEnabled !== undefined) f.taxEnabled = !!feeOverride.taxEnabled;
  const gmv = (Number(price) || 0) * (Number(qty) || 0);
  const commission = gmv * (f.commissionPct || 0) / 100;
  const tax = f.taxEnabled ? gmv * ((f.vatPct || 0) + (f.tncnPct || 0)) / 100 : 0;
  const other = gmv * (f.otherPct || 0) / 100;
  const packaging = (f.packagingPerOrder || 0) * (Number(qty) || 0);
  const cogs = includeCogs ? gmv * (f.cogsPct || 0) / 100 : 0;
  const platformCut = commission + tax;               // sàn giữ (chiết khấu + thuế)
  const netFromPlatform = gmv - platformCut;          // thực nhận từ sàn (trước chi phí quán)
  const profit = netFromPlatform - other - packaging - cogs; // lợi nhuận sau mọi chi phí
  const round = (n) => Math.round(n);
  return {
    fees: f, gmv: round(gmv),
    commission: round(commission), tax: round(tax), other: round(other),
    packaging: round(packaging), cogs: round(cogs),
    platformCut: round(platformCut), netFromPlatform: round(netFromPlatform), profit: round(profit),
    takeRatePct: gmv ? Math.round(platformCut / gmv * 1000) / 10 : 0,
    marginPct: gmv ? Math.round(profit / gmv * 1000) / 10 : 0,
  };
}

// Ước tính kinh tế 1 quán theo delta total_order trong kỳ (cần ≥2 lần quét menu) × avg_price.
function restaurantEconomics(deliveryId, days = 30) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM restaurants WHERE delivery_id = ?').get(String(deliveryId));
  if (!r) return null;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const hist = db.prepare(`SELECT total_order, scanned_at FROM restaurant_history
    WHERE delivery_id = ? AND scanned_at >= ? ORDER BY scanned_at ASC`).all(String(deliveryId), since);

  let ordersDelta = null, spanDays = null, perDay = null;
  if (hist.length >= 2) {
    const a = hist[0], b = hist[hist.length - 1];
    ordersDelta = Math.max(0, (b.total_order || 0) - (a.total_order || 0));
    spanDays = (new Date(b.scanned_at) - new Date(a.scanned_at)) / 86400000;
    perDay = spanDays >= 0.5 ? Math.round(ordersDelta / spanDays * 10) / 10 : null;
  }
  const avg = r.avg_price || null;
  let revenue = null, econ = null;
  if (ordersDelta != null && avg) {
    revenue = ordersDelta * avg;
    econ = calcOrder({ price: avg, qty: ordersDelta, includeCogs: false });
  }
  return {
    deliveryId: r.delivery_id, name: r.name, avgPrice: avg,
    totalOrderLifetime: r.total_order, ordersDelta, perDay, spanDays: spanDays ? Math.round(spanDays * 10) / 10 : null,
    revenue, platformCut: econ?.platformCut ?? null, netFromPlatform: econ?.netFromPlatform ?? null,
    days, scans: hist.length,
  };
}

module.exports = { FEE_DEFAULTS, getFees, setFees, calcOrder, restaurantEconomics };
