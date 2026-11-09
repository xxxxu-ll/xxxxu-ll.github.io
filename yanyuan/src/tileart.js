// 图块素材：来源于 CC0 公共领域素材包 Ninja Adventure（pixel-boy）
// https://github.com/pixel-boy/NinjaAdventure  ·  License: CC0-1.0
// 只取其中 16×16 的地面瓦片；建筑用程序化图块（同一套调色板）
import { mulberry32 } from './util.js?v=202611091249';

export const TILE = 16;            // 图块像素
export const TILE_M = 2;           // 一格 = 2 米
export const PX_PER_M = TILE / TILE_M;   // 8 px/m

const SRC = './assets/cc0/ninja_floor.png';
let atlas = null;
let ready = false;

export function loadAtlas() {
  if (atlas) return atlas;
  atlas = new Image();
  atlas.onload = () => { ready = true; };
  atlas.src = SRC;
  return atlas;
}
export function atlasReady() { return ready; }

// 从 CC0 素材图里取的地面瓦片（列, 行）；同一类给多个变体，按坐标哈希挑选
const GROUND = {
  grass: [[13, 12], [15, 12], [12, 12], [14, 12]],
  path: [],
  water: [[11, 25], [13, 25], [12, 26]],
};

function pickVariant(list, dx, dy) {
  const h = ((dx * 73856093) ^ (dy * 19349663)) >>> 0;
  return list[h % list.length];
}

/** 程序化石板路：低对比、2x2 石板 + 细缝 */
export function drawPavingTile(ctx, dx, dy, px = TILE) {
  const rng = mulberry32((dx * 374761393) ^ (dy * 668265263));
  ctx.fillStyle = '#b9bdb0';
  ctx.fillRect(dx, dy, px, px);
  const half = px / 2;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const off = r ? half / 2 : 0;
      const x = dx + c * half + (r ? -half / 2 : 0);
      const k = 0.94 + rng() * 0.12;
      ctx.fillStyle = `rgba(${Math.round(185 * k)},${Math.round(189 * k)},${Math.round(176 * k)},1)`;
      ctx.fillRect(x, dy + r * half, half - 1, half - 1);
      if (r === 1 && x + half > dx + px) {
        ctx.fillRect(dx, dy + r * half, half / 2 - 1, half - 1);
      }
    }
  }
  ctx.fillStyle = 'rgba(120,124,114,.28)';
  ctx.fillRect(dx, dy + half - 1, px, 1);
  ctx.fillRect(dx + half - 1, dy, 1, half);
}

/** 画一格地面瓦片（素材未就绪时用程序化兜底） */
export function drawGroundTile(ctx, kind, dx, dy, px = TILE) {
  if (kind === 'path') { drawPavingTile(ctx, dx, dy, px); return true; }
  const list = GROUND[kind] || GROUND.grass;
  const [sx, sy] = pickVariant(list, dx, dy);
  if (ready) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(atlas, sx * TILE, sy * TILE, TILE, TILE, dx, dy, px, px);
    return true;
  }
  return false;
}

// ---------------- 程序化建筑图块（和素材同一套像素密度） ----------------
const BAYER = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
];

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r * k)));
  g = Math.max(0, Math.min(255, Math.round(g * k)));
  b = Math.max(0, Math.min(255, Math.round(b * k)));
  return `rgb(${r},${g},${b})`;
}

/** 屋顶瓦片：横向瓦垄 + 抖色，读起来像瓦 */
export function drawRoofTile(ctx, base, dx, dy, px = TILE, seed = 1) {
  const rng = mulberry32(seed * 977 + dx * 31 + dy * 17);
  ctx.fillStyle = base;
  ctx.fillRect(dx, dy, px, px);
  // 小瓦：2 列 x 4 行，错缝排列
  const cw = px / 2, ch = px / 4;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 2; c++) {
      const off = (r % 2) * cw * 0.5;
      const x = dx + c * cw + (off > 0 ? -cw * 0.5 : 0);
      ctx.fillStyle = shade(base, 0.94 + (rng() - 0.5) * 0.08);
      ctx.fillRect(x, dy + r * ch, cw, ch * 0.86);
      // 瓦头高光 + 缝
      ctx.fillStyle = shade(base, 1.12);
      ctx.fillRect(x, dy + r * ch, cw, Math.max(1, ch * 0.18));
      ctx.fillStyle = shade(base, 0.72);
      ctx.fillRect(x, dy + r * ch + ch * 0.86, cw, Math.max(1, ch * 0.14));
      ctx.fillRect(x + cw - 1, dy + r * ch, 1, ch * 0.86);
    }
  }
}

/** 屋脊瓦片 */
export function drawRidgeTile(ctx, base, dx, dy, px = TILE) {
  ctx.fillStyle = shade(base, 0.72);
  ctx.fillRect(dx, dy, px, px);
  ctx.fillStyle = shade(base, 0.98);
  ctx.fillRect(dx, dy + px * 0.18, px, px * 0.3);
  ctx.fillStyle = shade(base, 0.62);
  ctx.fillRect(dx, dy + px * 0.74, px, px * 0.16);
}

/** 墙面图块：band 0 素墙 / 1 方窗 / 2 门 / 3 拱窗 / 4 带窗 / 5 木格窗 / 6 橱窗 / 7 阳台 / 8 标语墙 */
export function drawWallTile(ctx, wall, band, dx, dy, px = TILE, seed = 1) {
  const rng = mulberry32(seed * 613 + dx * 7 + dy * 13);
  ctx.fillStyle = wall;
  ctx.fillRect(dx, dy, px, px);
  ctx.fillStyle = 'rgba(110,90,68,.13)';
  ctx.fillRect(dx, dy + px * 0.5, px, 1);
  ctx.fillRect(dx + px * (rng() > 0.5 ? 0.25 : 0.6), dy, 1, px * 0.5);
  const glass = '#587586', glassLit = '#9fc4d6', trim = '#ece6d6';

  if (band === 1) {                       // 方窗
    ctx.fillStyle = glass;
    ctx.fillRect(dx + px * 0.2, dy + px * 0.24, px * 0.6, px * 0.42);
    ctx.fillStyle = glassLit;
    ctx.fillRect(dx + px * 0.23, dy + px * 0.27, px * 0.22, px * 0.34);
    ctx.fillStyle = trim;
    ctx.fillRect(dx + px * 0.16, dy + px * 0.66, px * 0.68, px * 0.09);
  } else if (band === 2) {                // 门
    ctx.fillStyle = '#4a4a44';
    ctx.fillRect(dx + px * 0.26, dy + px * 0.2, px * 0.48, px * 0.7);
    ctx.fillStyle = 'rgba(255,240,200,.22)';
    ctx.fillRect(dx + px * 0.3, dy + px * 0.26, px * 0.16, px * 0.56);
    ctx.fillStyle = trim;
    ctx.fillRect(dx + px * 0.2, dy + px * 0.12, px * 0.6, px * 0.1);
  } else if (band === 3) {                // 拱窗
    ctx.fillStyle = trim;
    ctx.fillRect(dx + px * 0.16, dy + px * 0.2, px * 0.68, px * 0.62);
    ctx.fillStyle = glass;
    ctx.fillRect(dx + px * 0.22, dy + px * 0.28, px * 0.56, px * 0.5);
    ctx.fillStyle = trim;
    ctx.fillRect(dx + px * 0.3, dy + px * 0.16, px * 0.4, px * 0.09);
    ctx.fillStyle = glassLit;
    ctx.fillRect(dx + px * 0.26, dy + px * 0.32, px * 0.16, px * 0.4);
  } else if (band === 4) {                // 连续带窗
    ctx.fillStyle = glass;
    ctx.fillRect(dx, dy + px * 0.26, px, px * 0.38);
    ctx.fillStyle = glassLit;
    ctx.fillRect(dx, dy + px * 0.3, px * 0.34, px * 0.3);
    ctx.fillStyle = trim;
    ctx.fillRect(dx, dy + px * 0.64, px, px * 0.07);
    ctx.fillRect(dx + px * 0.5, dy + px * 0.26, 1, px * 0.38);
  } else if (band === 5) {                // 木格窗
    ctx.fillStyle = '#7a5340';
    ctx.fillRect(dx + px * 0.18, dy + px * 0.22, px * 0.64, px * 0.5);
    ctx.fillStyle = '#3f3126';
    for (let i = 0; i < 3; i++) ctx.fillRect(dx + px * (0.2 + i * 0.21), dy + px * 0.24, 1, px * 0.46);
    for (let i = 0; i < 2; i++) ctx.fillRect(dx + px * 0.18, dy + px * (0.34 + i * 0.18), px * 0.64, 1);
    ctx.fillStyle = trim;
    ctx.fillRect(dx + px * 0.14, dy + px * 0.72, px * 0.72, px * 0.08);
  } else if (band === 6) {                // 橱窗 + 雨篷
    ctx.fillStyle = '#f0e6d0';
    ctx.fillRect(dx, dy + px * 0.22, px, px * 0.78);
    ctx.fillStyle = glassLit;
    ctx.fillRect(dx + px * 0.1, dy + px * 0.38, px * 0.8, px * 0.46);
    ctx.fillStyle = '#b23a2a';
    ctx.fillRect(dx, dy + px * 0.2, px, px * 0.16);
    ctx.fillStyle = 'rgba(246,238,220,.9)';
    for (let x = 0; x < px; x += px * 0.25) ctx.fillRect(dx + x, dy + px * 0.2, px * 0.12, px * 0.16);
    ctx.fillStyle = '#8f3a24';
    ctx.fillRect(dx + px * 0.1, dy + px * 0.04, px * 0.8, px * 0.12);
  } else if (band === 7) {                // 阳台
    ctx.fillStyle = glass;
    ctx.fillRect(dx + px * 0.2, dy + px * 0.18, px * 0.6, px * 0.4);
    ctx.fillStyle = 'rgba(255,250,238,.85)';
    ctx.fillRect(dx + px * 0.08, dy + px * 0.58, px * 0.84, px * 0.16);
    ctx.fillStyle = 'rgba(120,104,82,.45)';
    ctx.fillRect(dx + px * 0.08, dy + px * 0.74, px * 0.84, 1);
    ctx.fillStyle = 'rgba(150,120,90,.5)';
    ctx.fillRect(dx + px * 0.08, dy + px * 0.42, 1, px * 0.16);
  } else if (band === 8) {                // 标语墙
    ctx.fillStyle = 'rgba(255,250,236,.55)';
    ctx.fillRect(dx + px * 0.3, dy, px * 0.1, px);
    ctx.fillStyle = '#b23a2a';
    ctx.fillRect(dx + px * 0.42, dy + px * 0.28, px * 0.5, px * 0.3);
    ctx.fillStyle = 'rgba(255,244,216,.9)';
    for (let i = 0; i < 3; i++) ctx.fillRect(dx + px * (0.46 + i * 0.15), dy + px * 0.34, px * 0.08, px * 0.18);
  }
  ctx.fillStyle = 'rgba(60,44,30,.16)';
  ctx.fillRect(dx, dy + px - 1, px, 1);
}

/** 树图块（16×16 内画一棵俯视树） */
export function drawTreeTile(ctx, dx, dy, px, kind, seed) {
  const rng = mulberry32(seed * 31 + 7);
  const cx = dx + px / 2, cy = dy + px / 2;
  const r = px * (kind === 'bush' ? 0.22 : 0.34);
  ctx.fillStyle = 'rgba(30,44,28,.28)';
  ctx.beginPath();
  ctx.ellipse(cx + 1, cy + r * 1.1, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  const tones = kind === 'ginkgo' ? ['#9fbf4a', '#b8d05c']
    : kind === 'maple' ? ['#9a6a42', '#b58954']
      : ['#3f7f33', '#57993f'];
  ctx.fillStyle = tones[0];
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = tones[1];
  ctx.beginPath(); ctx.arc(cx - r * 0.24, cy - r * 0.24, r * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,220,.22)';
  ctx.fillRect(cx - r * 0.4, cy - r * 0.72, Math.max(1, r * 0.5), 1);
}
