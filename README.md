# FoodWatch — theo dõi đối thủ ShopeeFood (MVP)

Dựng từ base **ShopWatch** (Shopee). Giữ kiến trúc/kỹ thuật đã chứng minh, đổi sang mô hình **quán → món → khuyến mãi**, bỏ phần quét tồn phức tạp của Shopee (món ShopeeFood có cờ `is_available` trực tiếp).

## Chạy
```bash
cd foodwatch
npm install          # better-sqlite3 (build native), express… ; patchright là optional
npm test             # test chuẩn hoá JSON (không cần DB/Chrome)
npm start            # API ở http://localhost:3101  (đổi PORT qua env)
```
Quét cần **Chrome** + driver. `npm install` đã kéo `playwright-core` (dùng Chrome hệ thống). Muốn stealth mạnh hơn thì cài `patchright` (code tự ưu tiên patchright nếu có).
Env: `PORT`, `DB_PATH`, `CHROME_PATH`, `CHROME_PROFILE_DIR`, `HEADLESS=1`, `AUTH_TOKEN`.

## Cách hoạt động
ShopeeFood chặn gọi API trần (`error 90309999`) → **phải để trang tự gọi rồi intercept** (giống base). `foodScraper` mở quán bằng Chrome (persistent profile chống bot), bắt:
- `delivery/get_detail?id_type=2&request_id={id}` → quán (rating, giờ mở, promo, toạ độ…)
- `dish/get_delivery_dishes?id_type=2&request_id={id}` → menu (giá, giá KM, còn/hết, like, topping…)

`foodNormalize` (thuần hàm, có test) chuẩn hoá JSON → `restaurantMonitor.persistRestaurantScan` ghi DB + **phát hiện thay đổi** và đẩy feed + Telegram.

## API
| Method | Path | Việc |
|---|---|---|
| GET | `/api/food/restaurants` | danh sách quán |
| POST | `/api/food/restaurants` | thêm quán bằng `{url,isOwn,groupId}` (scrape 1 lần) |
| PATCH | `/api/food/restaurants/:id` | đặt `{isOwn,groupId,scanIntervalH,notes}` |
| DELETE | `/api/food/restaurants/:id` | xoá |
| POST | `/api/food/restaurants/:id/sync` | quét lại |
| POST | `/api/food/ingest` | nạp `{scraped}` sẵn (test/2-tier, không cần browser) |
| GET | `/api/food/restaurants/:id/dishes` | menu hiện tại |
| GET | `/api/food/restaurants/:id/dishes/:dishId/history` | lịch sử giá/còn-hết món |
| GET | `/api/food/restaurants/:id/changes` · `/api/food/changes` | feed thay đổi |
| GET/POST | `/api/food/settings/telegram` | cấu hình Telegram |

## Thay đổi tự phát hiện (feed + Telegram)
`new_dish`, `removed_dish`, `dish_price`(±), `dish_discount`(bật KM), `dish_unavailable`/`dish_back`(còn↔hết), `promo_start`/`promo_end`, `restaurant_closed`/`restaurant_open`, `rating_change`, `name_change`.

## DB (better-sqlite3, `data/food.db`)
`restaurants` (registry + trạng thái mới nhất) · `restaurant_history` (KPI: đơn/review/mở-đóng) · `dishes` · `dish_history` · `promotions` · `changes` · `app_settings`.

## Giao diện (dashboard có sidebar — `public/index.html`, mở `http://localhost:3101`)
3 mảng:
1. **Khảo sát** — thêm quán URL / quét đối thủ Hoàn Kiếm; bảng đối thủ: **số đơn/kỳ · doanh thu ước · thực nhận sau phí sàn** + ⭐/review + KM + nút Quét menu; giá thị trường theo ngách (bánh đa cá).
2. **Bộ tính chi phí sàn** — chỉnh tham số phí + **máy tính lợi nhuận** (giá bán × số đơn → chiết khấu/thuế/giá vốn → lợi nhuận thực thu, %).
3. **Hoạt động** — feed thay đổi.

### Phí ShopeeFood (mặc định bộ tính — số thật 06/2025, chỉnh được)
- Chiết khấu (hoa hồng) đồ ăn **25%** GMV (15% Fresh/Mart/hoa/bia); phí mở gian hàng **0đ**.
- Thuế khấu trừ tại nguồn **NĐ 117/2025** (từ 01/07/2025 sàn nộp thay), *dịch vụ ăn uống*: **VAT 3% + TNCN 1.5% = 4.5%** GMV. Doanh thu &lt;1 tỷ/năm có thể được hoàn cuối kỳ.
- Endpoint: `GET/POST /api/food/settings/fees`, `POST /api/food/calc`, `GET /api/food/restaurants/:id/economics`.

## Đã có (MVP) vs chưa
- ✅ Thêm/quét quán + menu; phát hiện đổi giá/KM/còn-hết/đóng cửa/món mới-mất; quét khu vực + lọc Hoàn Kiếm; giá thị trường ngách; số đơn/doanh thu/lợi nhuận + bộ tính chi phí sàn; feed; Telegram; lịch sử; dashboard 3 mảng.
- ⏳ **Chưa**: rank theo từ khoá THẬT (cần bắt API search — ô search ẩn sau icon), fetch nội dung review (sentiment), so giá món trùng tự động (undercut Telegram), benchmark nhóm.

## Lên 2-tier (như base) khi cần
Tách `foodScraper` ra app `local/` chạy ở máy có Chrome, proxy `/api/*` về server giữ DB; route `/ingest` đã sẵn để local đẩy kết quả lên. Xem memory `shopeefood-api-map`, `shopeefood-pivot`.
