// Khớp tên món: bỏ dấu + lọc theo "ngách" (niche) + Jaccard token để gom món tương đương giữa các quán.
// Thuần hàm → test được.

function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ngách mặc định cho chủ quán bánh đa cá (Hàm Long, Hoàn Kiếm).
const DEFAULT_NICHE = ['banh da ca', 'bun ca', 'mien ca', 'banh da cua', 'banh da', 'bun rieu ca', 'mien luon', 'bun ca ro'];

function nichePhrases(niche) {
  if (Array.isArray(niche)) return niche.filter(Boolean);
  if (typeof niche === 'string' && niche.trim()) return niche.split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_NICHE;
}

// Món thuộc ngách nếu tên chứa 1 cụm khoá (so theo bản đã bỏ dấu).
function matchesNiche(name, niche) {
  const n = norm(name);
  return nichePhrases(niche).some(p => n.includes(norm(p)));
}

function tokens(s) {
  return norm(s).split(' ').filter(t => t.length >= 2 || /\d/.test(t));
}

// Jaccard đơn giản để gom món "giống nhau" giữa 2 quán.
function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / new Set([...A, ...B]).size;
}

module.exports = { norm, tokens, similarity, matchesNiche, nichePhrases, DEFAULT_NICHE };
