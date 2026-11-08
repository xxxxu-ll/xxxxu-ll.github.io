// 通用工具：数学、几何、颜色、随机数、文本
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
export const dist2 = (x1, y1, x2, y2) => (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);

/** 可复现的伪随机数，保证每次生成的装饰完全一致 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) { return arr[(rng() * arr.length) | 0]; }

// ---------- 颜色 ----------
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r, g, b) {
  const c = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
export function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const f = amt < 0 ? 0 : 255;
  const t = Math.abs(amt);
  return rgbToHex(lerp(r, f, t), lerp(g, f, t), lerp(b, f, t));
}
export function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
}
export function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------- 多边形（扁平数组 [x0,y0,x1,y1,...]） ----------
export function toFlat(pairs) {
  const a = new Float32Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) { a[i * 2] = pairs[i][0]; a[i * 2 + 1] = pairs[i][1]; }
  return a;
}

export function polyBBox(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < f.length; i += 2) {
    const x = f[i], y = f[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function pointInPoly(x, y, f) {
  let inside = false;
  const n = f.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
    if ((yi > y) !== (yj > y)) {
      const t = (y - yi) / (yj - yi);
      if (x < xi + t * (xj - xi)) inside = !inside;
    }
  }
  return inside;
}

export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

/** 圆与多边形相交（含内部） */
export function circlePoly(cx, cy, r, f) {
  if (pointInPoly(cx, cy, f)) return true;
  const n = f.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    if (distToSeg(cx, cy, f[j], f[j + 1], f[i], f[i + 1]) < r) return true;
  }
  return false;
}

export function polyCenter(f) {
  let x = 0, y = 0, n = f.length / 2;
  for (let i = 0; i < f.length; i += 2) { x += f[i]; y += f[i + 1]; }
  return [x / n, y / n];
}

// ---------- 文本 ----------
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 只保留可打印字符，去掉控制符与双向覆盖字符，限制长度 */
export function sanitizeText(s, maxLen = 120) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 9) continue;
    if (c < 32 || (c >= 0x7f && c <= 0x9f)) continue;
    if (c >= 0x202a && c <= 0x202e) continue;
    if (c >= 0x2066 && c <= 0x2069) continue;
    out += ch;
    if ([...out].length >= maxLen) break;
  }
  return out.trim();
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  return Math.floor(s / 3600) + ' 小时';
}

export function nowMs() { return Date.now(); }

/** 稳定哈希，用于地图要素 key */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function randomToken(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 恢复码规范化：去掉分隔符，统一小写十六进制 */
export function normalizeRecovery(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-F]/g, '').toLowerCase();
}

/** 恢复码展示形式：XXXX-XXXX-XXXX-XXXX-XXXX */
export function formatRecovery(raw) {
  return (String(raw || '').toUpperCase().match(/.{1,4}/g) || []).join('-');
}
