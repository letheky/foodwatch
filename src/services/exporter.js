// Xuất dữ liệu toàn cục (P2): CSV bảng đối thủ hoặc Markdown báo cáo tổng hợp.
const mon = require('./restaurantMonitor');
const { marketBand, competitorRanking, getOverview } = require('./insights');

const vnd = (v) => (v ? Math.round(v).toLocaleString('vi-VN') + 'đ' : '');
const parsePromo = (s) => { try { return JSON.parse(s || '[]').map(p => p.text).filter(Boolean); } catch { return []; } };
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function buildExport(format = 'md', { niche, days = 14 } = {}) {
  const restos = mon.listRestaurants();
  const ranking = new Map(competitorRanking({ days }).map(x => [x.deliveryId, x]));

  if (format === 'csv') {
    const head = ['name', 'is_own', 'district_id', 'rating_avg', 'total_review', 'review_real', 'total_order',
      'avg_price', `orderDelta_${days}d`, 'is_open', 'promo', 'url', 'last_scanned_at'];
    const lines = [head.join(',')];
    for (const r of restos) {
      const k = ranking.get(r.delivery_id) || {};
      lines.push([
        r.name, r.is_own, r.district_id, r.rating_avg, r.total_review, r.review_real, r.total_order,
        r.avg_price, k.orderDelta ?? '', r.is_open, parsePromo(r.promo_summary).join(' | '), r.url, r.last_scanned_at,
      ].map(csvCell).join(','));
    }
    return { filename: `foodwatch-${Date.now()}.csv`, mime: 'text/csv;charset=utf-8', content: '﻿' + lines.join('\n') };
  }

  // Markdown báo cáo
  const ov = getOverview({ days, niche });
  const band = marketBand(niche).band;
  const md = [];
  md.push(`# FoodWatch — báo cáo đối thủ (${new Date().toLocaleString('vi-VN')})`, '');
  md.push(`- Đối thủ theo dõi: **${ov.kpis.competitors}** · Quán của tôi: ${ov.kpis.ownShops}`);
  md.push(`- Đang chạy KM: **${ov.kpis.promoNow}** · Đang đóng cửa: ${ov.kpis.closedNow}`);
  md.push(`- Món mới 24h: ${ov.kpis.newDishes24h} · Đổi giá 24h: ${ov.kpis.priceChanges24h}`);
  if (band) md.push(`- Giá thị trường ngách: rẻ nhất ${vnd(band.min)} · trung vị ${vnd(band.median)} · đắt nhất ${vnd(band.max)} (n=${band.count})`);
  md.push('', '## Bảng đối thủ', `| Quán | ⭐ | Đơn/${days}ng | Giá TB | Mở | KM |`, '|---|---|---|---|---|---|');
  for (const r of restos.filter(x => x.is_own === 0)) {
    const k = ranking.get(r.delivery_id) || {};
    md.push(`| ${r.name || r.delivery_id} | ${r.rating_avg || '—'} | ${k.orderDelta ?? '—'} | ${vnd(r.avg_price) || '—'} | ${r.is_open === 1 ? 'mở' : r.is_open === 0 ? 'đóng' : '?'} | ${parsePromo(r.promo_summary).join(', ') || '—'} |`);
  }
  const changes = mon.getChanges(null, 30);
  if (changes.length) {
    md.push('', '## Thay đổi gần đây');
    for (const c of changes) md.push(`- ${c.title} _(${new Date(c.created_at).toLocaleString('vi-VN')})_`);
  }
  return { filename: `foodwatch-${Date.now()}.md`, mime: 'text/markdown;charset=utf-8', content: md.join('\n') };
}

module.exports = { buildExport };
