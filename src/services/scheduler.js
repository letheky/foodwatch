// Tự động quét định kỳ + job "Quét tất cả".
// Mọi scrape đã được serialize trong foodScraper (1 Chrome/lúc) nên ở đây chỉ cần
// chạy TUẦN TỰ + giãn cách (jitter) để né anti-bot, và 1 job state trong RAM cho UI theo dõi.
// LƯU Ý: chỉ chạy khi tiến trình node đang bật (máy có Chrome). Khi lên VPS thì tách 2-tier.
const { getDb, getSetting, setSetting } = require('../db/database');
const mon = require('./restaurantMonitor');

const TICK_MS = 5 * 60 * 1000;            // nhịp kiểm tra "đến hạn"
const DEFAULT_INTERVAL_H = 12;            // mặc định quét lại mỗi 12h nếu quán không đặt riêng
const GAP_MIN_MS = 45 * 1000, GAP_MAX_MS = 120 * 1000; // giãn cách giữa 2 quán (anti-bot)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS));
const scraper = () => require('./foodScraper');

let job = null;          // { kind, total, done, ok, failed, current, startedAt, finishedAt, results[], running }
let lastTickAt = null;
let timer = null;

const emptyJob = () => ({ kind: null, total: 0, done: 0, ok: 0, failed: 0, current: null, startedAt: null, finishedAt: null, results: [], running: false });

function getAuto() {
  return {
    enabled: getSetting('auto_scan_enabled') === '1',
    intervalH: parseInt(getSetting('auto_scan_interval_h'), 10) || DEFAULT_INTERVAL_H,
  };
}
function setAuto({ enabled, intervalH } = {}) {
  if (enabled !== undefined) setSetting('auto_scan_enabled', enabled ? '1' : '0');
  if (intervalH !== undefined && intervalH !== null && intervalH !== '') {
    const h = Math.max(1, Math.min(168, parseInt(intervalH, 10) || DEFAULT_INTERVAL_H));
    setSetting('auto_scan_interval_h', String(h));
  }
  return getAuto();
}

// Quán cần quét: có url + (chưa quét bao giờ HOẶC quá hạn theo scan_interval_h ?? mặc định).
function dueRestaurants() {
  const { intervalH } = getAuto();
  const now = Date.now();
  return getDb().prepare('SELECT delivery_id, name, url, scan_interval_h, last_scanned_at FROM restaurants WHERE url IS NOT NULL').all()
    .filter(r => {
      if (!r.last_scanned_at) return true;
      const iv = (r.scan_interval_h || intervalH) * 3600000;
      return now - new Date(r.last_scanned_at).getTime() >= iv;
    });
}

async function runBatch(list, kind) {
  if (job && job.running) return job;
  job = { kind, total: list.length, done: 0, ok: 0, failed: 0, current: null,
          startedAt: new Date().toISOString(), finishedAt: null, results: [], running: true };
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    job.current = r.name || r.delivery_id;
    try {
      const scraped = await scraper().scrapeRestaurant(r.url);
      const res = mon.persistRestaurantScan(scraped);
      job.ok++;
      job.results.push({ name: res.name, dishCount: res.dishCount, changes: res.changes.length, ok: true });
    } catch (e) {
      job.failed++;
      job.results.push({ name: r.name || r.delivery_id, error: e.message || String(e), ok: false });
    }
    job.done++;
    if (i < list.length - 1) await sleep(jitter());   // giãn cách chống bot
  }
  job.current = null; job.running = false; job.finishedAt = new Date().toISOString();
  return job;
}

// Quét tất cả quán có URL (own + đối thủ). Chạy NỀN, trả job snapshot ngay để UI poll.
function scanAll() {
  if (job && job.running) return job;
  const list = getDb().prepare('SELECT delivery_id, name, url FROM restaurants WHERE url IS NOT NULL ORDER BY is_own DESC').all();
  if (!list.length) return { ...emptyJob(), error: 'Chưa có quán nào có URL để quét' };
  runBatch(list, 'all').catch(() => {});
  return job;
}

async function tick() {
  lastTickAt = new Date().toISOString();
  if (!getAuto().enabled) return;
  if (job && job.running) return;
  const due = dueRestaurants();
  if (due.length) await runBatch(due, 'auto');
}

function getStatus() {
  const auto = getAuto();
  return { auto, defaultIntervalH: auto.intervalH, job: job || emptyJob(), lastTickAt, due: dueRestaurants().length, busy: scraper().isBusy?.() ?? false };
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 30000); // 1 nhịp sau khi boot 30s
}

module.exports = { start, tick, scanAll, getStatus, setAuto, getAuto, dueRestaurants, DEFAULT_INTERVAL_H };
