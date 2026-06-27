// SQLite cho FoodWatch. Cùng kiểu base ShopWatch: better-sqlite3 + WAL + initSchema + migrate try/catch.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/food.db');
let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
    migrate();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- Đăng ký quán theo dõi + trạng thái mới nhất (gộp registry + latest, như base gộp shop_monitors).
    CREATE TABLE IF NOT EXISTS restaurants (
      delivery_id   TEXT PRIMARY KEY,   -- = foody delivery id (request_id, id_type=2)
      restaurant_id TEXT,               -- foody restaurant id (dùng cho reviews)
      brand_id      TEXT,
      name          TEXT,
      name_en       TEXT,
      url           TEXT,
      slug          TEXT,
      location_url  TEXT,
      address       TEXT,
      city_id       INTEGER,
      district_id   INTEGER,
      ward_id       INTEGER,
      lat           REAL,
      lng           REAL,
      categories    TEXT,               -- json
      cuisines      TEXT,               -- json
      photo         TEXT,
      -- registry (do người dùng đặt, KHÔNG bị ghi đè khi scan):
      is_own        INTEGER DEFAULT 0,
      group_id      TEXT,
      scan_interval_h INTEGER,
      notes         TEXT,
      -- trạng thái mới nhất (cập nhật mỗi lần scan):
      is_open       INTEGER,
      open_time     TEXT,
      close_time    TEXT,
      rating_avg    REAL,
      total_review  INTEGER,
      total_order   INTEGER,
      favorite_count INTEGER,
      min_order_value INTEGER,
      avg_price     INTEGER,
      promo_summary TEXT,               -- json [{key,kind,text}]
      dish_count    INTEGER DEFAULT 0,
      last_scanned_at DATETIME,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Time-series cấp quán (KPI: tốc độ đơn, tăng review, mở/đóng cửa).
    CREATE TABLE IF NOT EXISTS restaurant_history (
      id          TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      rating_avg  REAL,
      total_review INTEGER,
      total_order INTEGER,
      is_open     INTEGER,
      scanned_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_resto_hist ON restaurant_history(delivery_id, scanned_at);

    -- Snapshot từng món (1 row / món). is_active_row=0 = món đã biến mất khỏi menu.
    CREATE TABLE IF NOT EXISTS dishes (
      id            TEXT PRIMARY KEY,   -- = delivery_id:dish_id
      delivery_id   TEXT NOT NULL,
      dish_id       TEXT NOT NULL,
      group_name    TEXT,
      name          TEXT,
      description   TEXT,
      price         INTEGER,
      discount_price INTEGER,
      is_available  INTEGER,
      is_active     INTEGER,
      total_like    INTEGER,
      discount_remaining INTEGER,
      option_count  INTEGER DEFAULT 0,
      photo         TEXT,
      display_order INTEGER,
      notes         TEXT,
      is_active_row INTEGER DEFAULT 1,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(delivery_id, dish_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dishes_resto ON dishes(delivery_id, is_active_row);

    -- Time-series từng món (giá / KM / còn-hết / like).
    CREATE TABLE IF NOT EXISTS dish_history (
      id           TEXT PRIMARY KEY,
      delivery_id  TEXT NOT NULL,
      dish_id      TEXT NOT NULL,
      price        INTEGER,
      discount_price INTEGER,
      is_available INTEGER,
      total_like   INTEGER,
      scanned_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dish_hist ON dish_history(delivery_id, dish_id, scanned_at);

    -- Khuyến mãi cấp quán (trạng thái bật/tắt theo thời gian).
    CREATE TABLE IF NOT EXISTS promotions (
      id          TEXT PRIMARY KEY,     -- = delivery_id:key
      delivery_id TEXT NOT NULL,
      promo_key   TEXT NOT NULL,
      kind        TEXT,
      text        TEXT,
      discount_type INTEGER,
      is_active   INTEGER DEFAULT 1,
      detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at    DATETIME,
      UNIQUE(delivery_id, promo_key)
    );

    -- Feed thay đổi (giống shop_changes của base).
    CREATE TABLE IF NOT EXISTS changes (
      id          TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      dish_id     TEXT,
      change_type TEXT NOT NULL,        -- new_dish|removed_dish|dish_price|dish_discount|dish_unavailable|dish_back|promo_start|promo_end|restaurant_closed|restaurant_open|rating_change|name_change
      title       TEXT,
      image       TEXT,
      url         TEXT,
      old_value   TEXT,
      new_value   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_changes ON changes(delivery_id, created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Xếp hạng theo từ khoá (mỗi lần quét = 1 batch cùng scanned_at).
    CREATE TABLE IF NOT EXISTS rank_snapshots (
      id            TEXT PRIMARY KEY,
      keyword       TEXT NOT NULL,
      city_id       INTEGER,
      restaurant_id TEXT,
      delivery_id   TEXT,
      name          TEXT,
      district_id   INTEGER,
      rank          INTEGER,
      matched_dishes INTEGER,
      scanned_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_rank ON rank_snapshots(keyword, scanned_at);

    -- Số đánh giá THẬT từ foody.vn (ShopeeFood chỉ cho bucket "999+"). 1 mốc/lần quét → tốc độ tăng.
    CREATE TABLE IF NOT EXISTS foody_review_snapshots (
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, review_real INTEGER,
      scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_foody_snap ON foody_review_snapshots(delivery_id, scanned_at);
    -- Vài review gần nhất từ foody (sentiment).
    CREATE TABLE IF NOT EXISTS foody_reviews (
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, reviewer TEXT, rating REAL, title TEXT, comment TEXT,
      total_view INTEGER, pics INTEGER, review_time TEXT, scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_foody_rv ON foody_reviews(delivery_id, scraped_at);
  `);
}

// Chỗ thêm cột tương lai (ALTER fails nếu đã có → try/catch), giống base.
function migrate() {
  // Nguồn thêm quán: 'url' (người dùng dán link) | 'area' (quét khu vực).
  try { db.exec(`ALTER TABLE restaurants ADD COLUMN source TEXT`); } catch {}
  // Tham số tham khảo lưu kèm mỗi mốc xếp hạng (để bảng rank không cần join nhiều).
  for (const col of [
    'rating_avg REAL', 'total_review INTEGER', 'total_order INTEGER',
    'avg_price INTEGER', 'is_open INTEGER', 'promo_text TEXT', 'url TEXT',
  ]) { try { db.exec(`ALTER TABLE rank_snapshots ADD COLUMN ${col}`); } catch {} }
  // Số đánh giá thật (foody) mới nhất trên quán.
  for (const col of ['review_real INTEGER', 'review_real_at DATETIME']) {
    try { db.exec(`ALTER TABLE restaurants ADD COLUMN ${col}`); } catch {}
  }
}

function getSetting(key, def = null) {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : def;
  } catch { return def; }
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

module.exports = { getDb, getSetting, setSetting, DB_PATH };
