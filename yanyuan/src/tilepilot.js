// 静园图块试点：把这一片用 16px 图块重新画一遍（A 方案的第 2 阶段）
import { TILE, TILE_M, PX_PER_M, drawGroundTile, drawRoofTile, drawRidgeTile, drawWallTile, drawTreeTile, loadAtlas } from './tileart.js?v=202611091159';
import { pointInPoly, mulberry32, distToSeg } from './util.js?v=202611091159';

// 静园片区（米）：涵盖静园草坪、三院到六院、哲学楼、燕南食堂
export const PILOT = { x0: -250, y0: 90, x1: 130, y1: 400 };

export function inPilot(x, y) {
  return x >= PILOT.x0 && x <= PILOT.x1 && y >= PILOT.y0 && y <= PILOT.y1;
}

let cells = null;   // Map<'cx,cy', 'grass'|'path'|'water'>

/** 预先把试点区的地面类型栅格化（一格 2 米） */
export function buildCells(world) {
  if (cells) return cells;
  loadAtlas();
  cells = new Map();
  const cols = Math.ceil((PILOT.x1 - PILOT.x0) / TILE_M);
  const rows = Math.ceil((PILOT.y1 - PILOT.y0) / TILE_M);
  const roads = world.roads.filter(r => r.w >= 2);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = PILOT.x0 + cx * TILE_M + TILE_M / 2;
      const y = PILOT.y0 + cy * TILE_M + TILE_M / 2;
      let type = 'grass';
      // 水
      for (const w of world.water) {
        if (x < w.bbox[0] || x > w.bbox[2] || y < w.bbox[1] || y > w.bbox[3]) continue;
        if (w.rings.some(ring => pointInPoly(x, y, ring))) { type = 'water'; break; }
      }
      // 路
      if (type === 'grass') {
        for (const r of roads) {
          if (x < r.bbox[0] - 6 || x > r.bbox[2] + 6 || y < r.bbox[1] - 6 || y > r.bbox[3] + 6) continue;
          const half = r.w * 0.5 + 1.2;
          for (let i = 0; i < r.pts.length - 2; i += 2) {
            if (distToSeg(x, y, r.pts[i], r.pts[i + 1], r.pts[i + 2], r.pts[i + 3]) < half) { type = 'path'; break; }
          }
          if (type === 'path') break;
        }
      }
      // 广场
      if (type === 'grass') {
        for (const pr of world.precincts) {
          if (!/广场|三角地/.test(pr.name)) continue;
          if (x < pr.bbox[0] || x > pr.bbox[2] || y < pr.bbox[1] || y > pr.bbox[3]) continue;
          if (pointInPoly(x, y, pr.ring)) { type = 'path'; break; }
        }
      }
      cells.set(cx + ',' + cy, type);
    }
  }
  return cells;
}

/** 画试点区地面（在低分辨率缓冲里，按 8px/m） */
export function drawPilotGround(ctx, cam) {
  if (!cells) return;
  const S = cam.scale;
  const x0 = Math.max(PILOT.x0, cam.x - cam.w / 2 / S - 4);
  const y0 = Math.max(PILOT.y0, cam.y - cam.h / 2 / S - 4);
  const x1 = Math.min(PILOT.x1, cam.x + cam.w / 2 / S + 4);
  const y1 = Math.min(PILOT.y1, cam.y + cam.h / 2 / S + 4);
  if (x1 <= x0 || y1 <= y0) return;
  const c0 = Math.floor((x0 - PILOT.x0) / TILE_M), c1 = Math.ceil((x1 - PILOT.x0) / TILE_M);
  const r0 = Math.floor((y0 - PILOT.y0) / TILE_M), r1 = Math.ceil((y1 - PILOT.y0) / TILE_M);
  for (let cy = r0; cy < r1; cy++) {
    for (let cx = c0; cx < c1; cx++) {
      const kind = cells.get(cx + ',' + cy) || 'grass';
      const wx = PILOT.x0 + cx * TILE_M, wy = PILOT.y0 + cy * TILE_M;
      const dx = Math.round(cam.sx(wx)), dy = Math.round(cam.sy(wy));
      const px = Math.round(TILE_M * S);
      if (dx > cam.w || dy > cam.h || dx + px < 0 || dy + px < 0) continue;
      if (!drawGroundTile(ctx, kind, dx, dy, px)) {
        // 素材没加载好时的兜底色
        ctx.fillStyle = kind === 'water' ? '#3aa5d6' : kind === 'path' ? '#cdd4c8' : '#57a03c';
        ctx.fillRect(dx, dy, px, px);
      }
    }
  }
}

/** 一栋楼的图块画法：屋顶瓦片 + 屋脊 + 南侧墙 */
export function drawTileBuilding(ctx, b, cam, roofColor, wallColor, windowBand) {
  const S = cam.scale;
  const bb = b.bbox;
  const px = Math.max(2, Math.round(TILE_M * S));   // 一格屏幕像素
  const dx0 = Math.round(cam.sx(bb[0])), dy0 = Math.round(cam.sy(bb[1]));
  const dx1 = Math.round(cam.sx(bb[2])), dy1 = Math.round(cam.sy(bb[3]));
  const w = dx1 - dx0, h = dy1 - dy0;
  if (w < 2 || h < 2) return;
  if (dx1 < 0 || dy1 < 0 || dx0 > cam.w || dy0 > cam.h) return;

  // 投影
  ctx.fillStyle = 'rgba(30,42,30,.20)';
  ctx.fillRect(dx0 + px * 0.3, dy0 + px * 0.45, w, h);

  // 墙体：南侧一条，高度按层数（每层一格）
  const floors = Math.max(1, Math.min(4, b.fl || 2));
  const wallPx = px * floors;
  ctx.fillStyle = wallColor;
  ctx.fillRect(dx0, dy1 - 1, w, wallPx);
  const cols = Math.max(1, Math.round(w / px));
  const cw = w / cols;
  for (let i = 0; i < cols; i++) {
    drawWallTile(ctx, wallColor, i === Math.floor(cols / 2) ? 2 : windowBand,
      Math.round(dx0 + i * cw), Math.round(dy1 - 1), Math.max(2, Math.round(cw)), b.id || 1);
  }
  // 屋脊/檐口
  ctx.fillStyle = 'rgba(60,44,30,.35)';
  ctx.fillRect(dx0, dy1 - 2, w, 2);

  // 屋顶：按格铺瓦（裁到多边形）
  ctx.save();
  ctx.beginPath(); ctx.rect(dx0, dy0, w, h); ctx.clip();
  for (let y = dy0; y < dy1; y += px) {
    for (let x = dx0; x < dx1; x += px) {
      drawRoofTile(ctx, roofColor, x, y, px, (b.id || 1) + x + y);
    }
  }
  ctx.restore();

  // 正脊
  const horiz = w >= h;
  ctx.save();
  ctx.beginPath(); ctx.rect(dx0, dy0, w, h); ctx.clip();
  if (horiz) {
    for (let x = dx0; x < dx1; x += px) drawRidgeTile(ctx, roofColor, x, Math.round(dy0 + h / 2 - px / 2), px);
  } else {
    for (let y = dy0; y < dy1; y += px) drawRidgeTile(ctx, roofColor, Math.round(dx0 + w / 2 - px / 2), y, px);
  }
  ctx.restore();

  // 外描边
  ctx.strokeStyle = 'rgba(28,22,18,.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(dx0 + 0.5, dy0 + 0.5, w - 1, h - 1);
}

/** 树：用图块画一棵（按 16px 网格） */
export function drawTileTree(ctx, t, cam) {
  const S = cam.scale;
  const px = Math.max(6, Math.round(TILE_M * S));
  const dx = Math.round(cam.sx(t.x) - px / 2);
  const dy = Math.round(cam.sy(t.y) - px / 2);
  if (dx < -px || dy < -px || dx > cam.w || dy > cam.h) return;
  drawTreeTile(ctx, dx, dy, Math.round(px * (t.s || 1) * 0.9), t.kind, t.seed || 1);
}
