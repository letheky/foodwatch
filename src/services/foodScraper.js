// Mở ShopeeFood bằng Chrome thật → intercept get_detail + get_delivery_dishes.
// Tái dùng kỹ thuật base: context.on('response') (foody chặn curl trần → bắt buộc để page tự gọi).
// Driver: patchright (stealth) nếu có; fallback playwright-core (dùng Chrome hệ thống).
let chromium;
try { ({ chromium } = require('patchright')); }
catch { try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); } }

const path = require('path');
const { normalizeScrape, normalizeRestaurant } = require('../lib/foodNormalize');

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(__dirname, '../../.chrome-profile');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Khoá độc quyền: MỌI lần mở Chrome dùng CHUNG 1 persistent profile dir ──
// → KHÔNG được chạy 2 context song song (profile bị khoá). Serialize tất cả scrape
// (scheduler tự động + nút Quét tất cả + Quét menu tay + discover + rank + foody).
let _chain = Promise.resolve();
let _busy = false;
function runExclusive(fn) {
  const p = _chain.then(async () => { _busy = true; try { return await fn(); } finally { _busy = false; } });
  _chain = p.catch(() => {}); // không để 1 lỗi làm kẹt hàng đợi
  return p;
}
const isBusy = () => _busy;

// url = link nhà hàng ShopeeFood, vd https://shopeefood.vn/ho-chi-minh/<slug>
async function _scrapeRestaurant(url, { headless = process.env.HEADLESS === '1', timeoutMs = 60000 } = {}) {
  if (!url) throw new Error('Thiếu url nhà hàng');
  if (!chromium) throw new Error('Chưa cài driver: npm i (patchright) hoặc npm i playwright-core');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    executablePath: CHROME_PATH,
    viewport: { width: 1366, height: 900 },
    args: process.platform === 'win32'
      ? ['--no-first-run', '--no-default-browser-check', '--disable-default-apps']
      : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let detail = null, menu = null;

  const onResp = async (res) => {
    const u = res.url();
    try {
      if (/\/api\/delivery\/get_detail/.test(u)) detail = await res.json();
      else if (/\/api\/dish\/get_delivery_dishes/.test(u)) menu = await res.json();
    } catch { /* body đã bị thu hồi */ }
  };
  ctx.on('response', onResp);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    // cuộn để lazy-load menu; dừng sớm khi đã có cả 2 API
    while ((!detail || !menu) && Date.now() < deadline) {
      await page.mouse.wheel(0, 2200).catch(() => {});
      await sleep(1200);
    }
  } finally {
    ctx.off('response', onResp);
    await ctx.close().catch(() => {});
  }

  if (!detail) throw new Error('Không bắt được get_detail (anti-bot, URL sai, hoặc cần giải captcha 1 lần trong profile)');
  const out = normalizeScrape({ detail, menu });
  out.scrapedAt = new Date().toISOString();
  out.sourceUrl = url;
  if (!menu) out.warning = 'Chưa bắt được menu (get_delivery_dishes) — thử tăng timeout hoặc cuộn lâu hơn';
  return out;
}

// Duyệt khu vực: mở trang thành phố → cuộn để page tự gọi get_browsing_infos nhiều lần → gom quán.
// Trả danh sách quán đã chuẩn hoá (cấp khu vực, CHƯA có menu). Lọc quận/ngách làm ở tầng trên.
async function _scrapeArea({ cityUrl = 'ha-noi', scrollRounds = 10, headless = process.env.HEADLESS === '1', timeoutMs = 90000 } = {}) {
  if (!chromium) throw new Error('Chưa cài driver (playwright-core/patchright)');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless, executablePath: CHROME_PATH, viewport: { width: 1366, height: 900 },
    args: process.platform === 'win32'
      ? ['--no-first-run', '--no-default-browser-check', '--disable-default-apps']
      : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const byId = new Map();
  const onResp = async (res) => {
    if (!/\/api\/delivery\/get_browsing_infos/.test(res.url())) return;
    try {
      const j = await res.json();
      for (const d of (j?.reply?.delivery_infos || [])) {
        const r = normalizeRestaurant(d);
        if (r?.deliveryId) byId.set(r.deliveryId, r);
      }
    } catch {}
  };
  ctx.on('response', onResp);
  try {
    await page.goto(`https://shopeefood.vn/${cityUrl}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    await sleep(5000);
    for (let i = 0; i < scrollRounds; i++) { await page.mouse.wheel(0, 3000).catch(() => {}); await sleep(1500); }
  } finally {
    ctx.off('response', onResp);
    await ctx.close().catch(() => {});
  }
  return [...byId.values()];
}

// Tìm theo từ khoá → lấy XẾP HẠNG (search_result[foody_service=1].restaurant_ids theo đúng thứ tự)
// + hydrate chi tiết qua get_infos. Trả danh sách đã xếp hạng.
async function _scrapeSearch(keyword, { cityUrl = 'ha-noi', scrollRounds = 18, hydrateTop = 60, lat = null, lng = null, headless = process.env.HEADLESS === '1', timeoutMs = 75000 } = {}) {
  if (!chromium) throw new Error('Chưa cài driver (playwright-core/patchright)');
  if (!keyword) throw new Error('Thiếu từ khoá');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless, executablePath: CHROME_PATH, viewport: { width: 1366, height: 900 },
    args: process.platform === 'win32'
      ? ['--no-first-run', '--no-default-browser-check', '--disable-default-apps']
      : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  // (P1b) Best-effort đặt ĐIỂM GIAO → xếp hạng theo vị trí khách quanh điểm này thay vì city-wide.
  // Key localStorage chính xác của ShopeeFood chưa verify live → set vài key phổ biến; bị bỏ qua thì rơi về
  // city-wide (KHÔNG hỏng gì). Khi verify được key thật chỉ cần sửa addInitScript này.
  if (lat != null && lng != null) {
    await ctx.addInitScript(([la, ln]) => {
      try {
        const loc = { lat: la, lng: ln, latitude: la, longitude: ln };
        localStorage.setItem('deliveryLocation', JSON.stringify(loc));
        localStorage.setItem('user_location', JSON.stringify(loc));
        localStorage.setItem('selected_address', JSON.stringify(loc));
      } catch {}
    }, [lat, lng]).catch(() => {});
  }
  let ranking = null;                 // { total, ids:[restaurantId], matched:Map(rid->dishCount) }
  const infos = new Map();            // restaurantId -> normalized restaurant

  const onResp = async (res) => {
    const u = res.url();
    try {
      if (/\/api\/delivery\/search_global/.test(u)) {
        const j = await res.json();
        const groups = j?.reply?.search_result || [];
        const food = groups.find(g => g.foody_service === 1) || groups[0];
        if (food && Array.isArray(food.restaurant_ids) && food.restaurant_ids.length) {
          const matched = new Map((food.restaurants || []).map(r => [String(r.restaurant_id), (r.dish_ids || []).length]));
          ranking = { total: food.total_items ?? food.restaurant_ids.length, ids: food.restaurant_ids.map(String), matched };
        }
      } else if (/\/api\/delivery\/get_infos/.test(u)) {
        const j = await res.json();
        for (const d of (j?.reply?.delivery_infos || [])) {
          const r = normalizeRestaurant(d);
          if (r?.restaurantId) infos.set(String(r.restaurantId), r);
        }
      }
    } catch {}
  };
  ctx.on('response', onResp);
  try {
    const url = `https://shopeefood.vn/${cityUrl}/danh-sach-dia-diem-giao-tan-noi?q=${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    await sleep(5000);
    // Fallback: nếu load thẳng URL không bắn search → gõ vào ô tìm hiển thị
    if (!ranking) {
      const box = page.locator('input[placeholder*="món ăn"], input[placeholder*="địa điểm"]').first();
      if (await box.count().catch(() => 0)) {
        await box.click({ timeout: 4000 }).catch(() => {});
        await box.pressSequentially(keyword, { delay: 240 }).catch(() => {});
        await sleep(3000); await page.keyboard.press('Enter').catch(() => {}); await sleep(5000);
      }
    }
    // Cuộn để page tự gọi get_infos hydrate dần (theo thứ tự hạng) — đủ top N thì dừng.
    const target = Math.min(ranking?.ids.length || 0, hydrateTop);
    for (let i = 0; i < scrollRounds && infos.size < target; i++) {
      await page.mouse.wheel(0, 3500).catch(() => {}); await sleep(1300);
    }
  } finally {
    ctx.off('response', onResp);
    await ctx.close().catch(() => {});
  }
  if (!ranking) throw new Error('Không bắt được kết quả search (anti-bot hoặc đổi cấu trúc)');

  // Mỗi dòng = toàn bộ thông tin quán (normalizeRestaurant) + hạng + số món khớp từ khoá.
  const list = ranking.ids.map((rid, i) => {
    const info = infos.get(rid) || {};
    return { ...info, rank: i + 1, restaurantId: rid, matchedDishes: ranking.matched.get(rid) || 0 };
  });
  return { keyword, cityUrl, total: ranking.total, hydrated: infos.size, scrapedAt: new Date().toISOString(), ranking: list };
}

// Lấy SỐ ĐÁNH GIÁ THẬT + vài review từ foody.vn (ShopeeFood chỉ cho bucket "999+").
// foody.vn/__get/Review/ResLoadMore → reply.Summary.Total (số thật) + Items[] (review).
async function _scrapeFoodyReviews(foodyUrl, { headless = process.env.HEADLESS === '1', timeoutMs = 50000 } = {}) {
  if (!chromium) throw new Error('Chưa cài driver');
  if (!foodyUrl) throw new Error('Thiếu foody URL');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless, executablePath: CHROME_PATH, viewport: { width: 1366, height: 900 },
    args: process.platform === 'win32'
      ? ['--no-first-run', '--no-default-browser-check', '--disable-default-apps']
      : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let total = null; const items = [];
  const onResp = async (res) => {
    if (!/__get\/Review\/ResLoadMore/i.test(res.url())) return;
    try {
      const j = await res.json();
      const t = j?.Summary?.Total ?? j?.reply?.Summary?.Total;
      if (typeof t === 'number') total = t;
      for (const it of (j?.Items || j?.reply?.Items || [])) items.push(it);
    } catch {}
  };
  ctx.on('response', onResp);
  try {
    await page.goto(foodyUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    await sleep(4000);
    for (let i = 0; i < 8 && total == null; i++) { await page.mouse.wheel(0, 2500).catch(() => {}); await sleep(1200); }
    if (total != null) { for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 3000).catch(() => {}); await sleep(1400); } } // load thêm vài review
    // Quán 0 review trên foody → ResLoadMore không bắn; đọc số "N Bình luận/đánh giá" trên trang.
    if (total == null) {
      try {
        const t = await page.evaluate(() => { const m = document.body.innerText.match(/([\d.,]+)\s*(bình luận|đánh giá|nhận xét|review)/i); return m ? m[1] : null; });
        if (t != null) { const n = parseInt(String(t).replace(/[.,]/g, ''), 10); if (Number.isFinite(n)) total = n; }
      } catch {}
    }
  } finally {
    ctx.off('response', onResp);
    await ctx.close().catch(() => {});
  }
  if (total == null) throw new Error('Không xác định được đánh giá foody (URL sai / trang đổi cấu trúc / anti-bot)');

  const seen = new Set();
  const reviews = items.map(it => ({
    reviewer: it.Owner?.DisplayName || it.UserName || null,
    rating: (typeof it.AvgRating === 'number') ? it.AvgRating : (typeof it.Rating === 'number' ? it.Rating : null), // thang 0–10
    title: it.Title || null,
    comment: it.Comment || null,
    totalView: it.TotalView ?? null,
    pics: it.TotalPictures ?? null,
    time: it.CreatedOnText || it.CreatedOn || it.Time || it.CreatedTime || null,
  })).filter(r => {
    const k = (r.reviewer || '') + '|' + (r.title || '') + '|' + (r.time || '');
    if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 20);

  return { foodyUrl, total, reviews, scrapedAt: new Date().toISOString() };
}

// Bọc khoá độc quyền: dù gọi từ đâu cũng chỉ 1 Chrome chạy/lúc.
const scrapeRestaurant = (...a) => runExclusive(() => _scrapeRestaurant(...a));
const scrapeArea = (...a) => runExclusive(() => _scrapeArea(...a));
const scrapeSearch = (...a) => runExclusive(() => _scrapeSearch(...a));
const scrapeFoodyReviews = (...a) => runExclusive(() => _scrapeFoodyReviews(...a));

module.exports = { scrapeRestaurant, scrapeArea, scrapeSearch, scrapeFoodyReviews, isBusy, PROFILE_DIR };
