// Map district_id (mã nội bộ ShopeeFood) → tên quận. Lấy từ get_metadata 2026-06-18.
const HANOI = {
  20: 'Ba Đình', 21: 'Cầu Giấy', 22: 'Đống Đa', 23: 'Hà Đông', 24: 'Hai Bà Trưng',
  25: 'Hoàn Kiếm', 26: 'Hoàng Mai', 27: 'Long Biên', 28: 'Tây Hồ', 29: 'Thanh Xuân',
  678: 'Gia Lâm', 679: 'Hoài Đức', 688: 'Thanh Trì', 689: 'Thường Tín',
  690: 'Bắc Từ Liêm', 945: 'Nam Từ Liêm',
};
const HCM = {
  1: 'Quận 1', 2: 'Gò Vấp', 4: 'Quận 2', 5: 'Quận 3', 6: 'Quận 4', 7: 'Quận 5', 8: 'Quận 6',
  9: 'Quận 7', 10: 'Quận 8', 11: 'Quận 9', 12: 'Quận 10', 13: 'Quận 11', 14: 'Quận 12',
  15: 'Bình Thạnh', 16: 'Tân Bình', 17: 'Phú Nhuận', 18: 'Bình Tân', 19: 'Tân Phú',
  693: 'TP. Thủ Đức', 694: 'Củ Chi', 695: 'Hóc Môn', 696: 'Bình Chánh', 698: 'Cần Giờ', 699: 'Nhà Bè',
};
const BY_CITY = { 218: HANOI, 217: HCM };

// Trả tên quận, hoặc null nếu không tra được (FE hiển thị '—' thay vì số khó hiểu).
function districtName(cityId, districtId) {
  if (districtId == null) return null;
  const m = BY_CITY[cityId] || HANOI; // mặc định Hà Nội (app đang tập trung HN)
  return m[districtId] || HANOI[districtId] || HCM[districtId] || null;
}

module.exports = { districtName, HANOI, HCM, BY_CITY };
