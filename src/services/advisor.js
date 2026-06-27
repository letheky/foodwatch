// Đề xuất giải pháp tăng tỉ lệ THÀNH ĐƠN — suy ra từ dữ liệu đối thủ đã khảo sát (thuần đọc DB).
// Mỗi đề xuất gắn SỐ LIỆU thật (giá thị trường, % đối thủ KM, sao, thứ hạng…), không nói chung chung.
const { getDb } = require('../db/database');
const { marketBand } = require('./insights');
const { getRank, listKeywords } = require('./rankTracker');
const { getFees, calcOrder } = require('./economics');
const { complaintInsights } = require('./foodyReviews');
const { nichePhrases } = require('../lib/dishMatch');

const vnd = (v) => (v ? Math.round(v).toLocaleString('vi-VN') + 'đ' : '—');
const nicheLabel = (niche) => nichePhrases(niche)[0] || 'bánh đa cá';

function getRecommendations({ niche, keyword, days = 14 } = {}) {
  const db = getDb();
  const fees = getFees();
  const cutPct = Math.round((fees.commissionPct + (fees.taxEnabled ? fees.vatPct + fees.tncnPct : 0)) * 10) / 10;
  const market = marketBand(niche);
  let kw = keyword || nicheLabel(niche);
  let rank = getRank(kw);
  // Data rank lưu theo từ khoá có dấu ("bánh đa cá"); nếu không khớp, dùng từ khoá gần nhất đã quét.
  if (!rank.ranking || !rank.ranking.length) {
    const kws = listKeywords();
    if (kws.length) { kw = kws[0].keyword; rank = getRank(kw); }
  }
  const competitors = db.prepare('SELECT * FROM restaurants WHERE is_own = 0').all();
  const own = db.prepare('SELECT * FROM restaurants WHERE is_own = 1').all();

  const recs = [];
  const push = (priority, icon, category, title, detail, data = {}) => recs.push({ priority, icon, category, title, detail, data });

  // ── A. Định giá ──────────────────────────────────────────
  if (market.band && market.band.count) {
    const b = market.band;
    const target = Math.round(b.median * 0.95 / 1000) * 1000;
    const econ = calcOrder({ price: target, qty: 1, includeCogs: true });
    let detail = `Giá ${nicheLabel(niche)} trên thị trường: rẻ nhất ${vnd(b.min)} · trung vị ${vnd(b.median)} · đắt nhất ${vnd(b.max)} (khảo sát ${b.count} món của đối thủ). `;
    detail += `Lúc mới mở nên đặt quanh ${vnd(target)} (hơi dưới trung vị) để dễ được chọn khi khách so giá. Với giá vốn ${fees.cogsPct}%, mỗi đơn lãi ~${vnd(econ.profit)} (${econ.marginPct}%) sau khi sàn giữ ${cutPct}%.`;
    if (market.advice) detail += ` Món của bạn hiện ${vnd(market.advice.myPrice)} — ${market.advice.position}, ${market.advice.cheaperThanMe} đối thủ rẻ hơn.`;
    push('high', '💰', 'Định giá', `Đặt giá quanh ${vnd(target)} (dưới trung vị thị trường)`, detail, { band: b, target, profit: econ.profit, margin: econ.marginPct });
  } else {
    push('med', '💰', 'Định giá', 'Cần thêm dữ liệu giá thị trường', 'Hãy bấm "Quét menu" vài quán bánh đa cá đối thủ (tab Khảo sát) để có dải giá → mình sẽ đề xuất mức giá tối ưu kèm lợi nhuận.');
  }

  // ── B. Khuyến mãi ────────────────────────────────────────
  if (competitors.length) {
    const promoTexts = {};
    let withPromo = 0;
    for (const c of competitors) {
      let ps = []; try { ps = JSON.parse(c.promo_summary || '[]'); } catch {}
      if (ps.length) withPromo++;
      for (const p of ps) { const t = (p.text || '').trim(); if (t) promoTexts[t] = (promoTexts[t] || 0) + 1; }
    }
    const topPromo = Object.entries(promoTexts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t} (${n} quán)`);
    const pct = Math.round(withPromo / competitors.length * 100);
    push(pct >= 50 ? 'high' : 'med', '🎁', 'Khuyến mãi',
      `${withPromo}/${competitors.length} đối thủ (${pct}%) đang chạy KM${pct >= 50 ? ' — bạn nên có KM để không lép vế' : ''}`,
      `KM phổ biến: ${topPromo.join(', ') || '—'}. Khách ShopeeFood rất nhạy KM/Freeship. Lúc mới mở, bật Freeship hoặc giảm 10–15% để kéo đơn đầu + đổi lấy đánh giá. Nhớ cộng chi phí KM vào giá (tab Bộ tính chi phí) để không lỗ.`,
      { withPromo, total: competitors.length, topPromo });
  }

  // ── C. Thứ hạng & tên món (SEO tìm kiếm) ─────────────────
  if (rank.ranking && rank.ranking.length) {
    const hk = rank.ranking.filter(x => x.isHoanKiem);
    const total = rank.ranking.length;
    const topDistricts = [...new Set(rank.ranking.slice(0, 5).map(x => x.districtName).filter(Boolean))];
    push(hk.length <= 3 ? 'high' : 'med', '📈', 'Thứ hạng & tên món',
      `Chỉ ${hk.length} đối thủ "${kw}" ở Hoàn Kiếm (trong top ${total}) → cơ hội lên top khu vực cao`,
      `Để khớp tìm kiếm "${kw}", đặt TÊN MÓN chứa đúng cụm khoá + biến thể: "bánh đa cá rô đồng", "bánh đa cá sụn/chả". Top hiện thuộc quận khác (${topDistricts.join(', ') || '—'}); bạn ở Hoàn Kiếm dễ nổi bật với khách quanh Hàm Long. Quét lại thứ hạng định kỳ để đo đà lên/xuống.`,
      { hk: hk.length, total, topDistricts });
  }

  // ── D. Đánh giá ──────────────────────────────────────────
  const rated = competitors.filter(c => c.rating_avg).map(c => c.rating_avg);
  if (rated.length) {
    const avg = Math.round(rated.reduce((s, x) => s + x, 0) / rated.length * 10) / 10;
    const top = Math.max(...rated);
    push('high', '⭐', 'Đánh giá',
      `Đặt mục tiêu sao ≥ ${avg} (đối thủ trung bình ${avg}, cao nhất ${top})`,
      `Món mới 0 đánh giá rất khó lên đơn — khách lướt qua. Ngay từ đơn đầu: nhắn cảm ơn + xin đánh giá, kèm món nhỏ/giảm nhẹ để đổi review. Trả lời lịch sự các đánh giá thấp. Dùng nút 📝 (foody) đọc khen/chê thật của đối thủ để né đúng lỗi họ hay bị chê.`,
      { avg, top, n: rated.length });
  }

  // ── D2. Đối thủ hay bị chê gì (sentiment foody) ──────────
  // Chỉ nêu từ bị nhắc ≥2 lần để tránh nhiễu khi dữ liệu review còn ít.
  const comp = complaintInsights();
  const sig = comp.top.filter(t => t.n >= 2);
  if (sig.length >= 3) {
    push('med', '💬', 'Đánh giá',
      `Đối thủ hay bị chê: ${sig.slice(0, 6).map(t => t.word).join(', ')}`,
      `Phân tích ${comp.low} đánh giá thấp (foody) của đối thủ — từ bị nhắc nhiều nhất: ${sig.slice(0, 8).map(t => `${t.word} (${t.n})`).join(', ')}. Né đúng các lỗi này (vd chuẩn vị, giao nhanh, đóng gói kỹ, đủ topping) để tạo lợi thế ngay từ đầu. Bấm 📝 trên từng quán (tab Khảo sát) để đọc chi tiết khen/chê.`,
      { top: sig, low: comp.low });
  }

  // ── E. Giờ bán ───────────────────────────────────────────
  const closed = competitors.filter(c => c.is_open === 0).length;
  if (closed > 0) push('med', '🕒', 'Giờ bán',
    `${closed} đối thủ đang đóng cửa — mở vào khung giờ họ nghỉ để hứng đơn`,
    `Theo dõi giờ đóng/mở đối thủ (tab Hoạt động). Mở sớm/khuya hơn hoặc giữ mở đúng giờ cao điểm (trưa 11–13h, tối 18–20h) khi đối thủ nghỉ = bắt trọn nhu cầu khu vực.`, { closed });

  // ── F. Thực đơn (món hot đối thủ) ────────────────────────
  const hot = db.prepare(`SELECT name, total_like FROM dishes WHERE is_active_row = 1 AND total_like IS NOT NULL AND name IS NOT NULL ORDER BY total_like DESC LIMIT 5`).all();
  if (hot.length) push('med', '🍜', 'Thực đơn',
    `Học món hot của đối thủ + làm combo để tăng giá trị đơn`,
    `Món nhiều ♥ nhất khu: ${hot.slice(0, 4).map(h => `${h.name} (${h.total_like}♥)`).join(', ')}. Cân nhắc có món tương tự, và bán COMBO (bánh đa cá + quẩy/nước) — tăng giá trị đơn trung bình thay vì chỉ đua giảm giá (đỡ mất biên lợi nhuận).`, { hot });

  // ── G. Lợi nhuận / phí sàn ───────────────────────────────
  push('low', '🧮', 'Lợi nhuận',
    `Mỗi đơn sàn giữ ${cutPct}% (chiết khấu ${fees.commissionPct}% + thuế ${fees.taxEnabled ? (fees.vatPct + fees.tncnPct) + '%' : '0'})`,
    `Đảm bảo giá đủ bù phí sàn + giá vốn + đóng gói. Tăng lãi mà KHÔNG phá giá: thêm topping (chả/trứng/sụn), combo, upsell đồ uống → kéo giá trị đơn lên. Tính thử từng kịch bản ở tab Bộ tính chi phí.`, { cutPct });

  const order = { high: 0, med: 1, low: 2 };
  recs.sort((a, b) => order[a.priority] - order[b.priority]);
  return {
    generatedAt: new Date().toISOString(),
    context: {
      competitors: competitors.length, ownShops: own.length,
      niche: nicheLabel(niche), keyword: kw,
      marketCount: market.band?.count || 0, rankTotal: rank.ranking?.length || 0,
    },
    recommendations: recs,
  };
}

module.exports = { getRecommendations };
