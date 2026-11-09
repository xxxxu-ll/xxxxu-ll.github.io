// 静园图块试点：把这一片用 16px 图块重新画一遍（A 方案的第 2 阶段）
import { TILE, TILE_M, PX_PER_M, drawGroundTile, drawRoofTile, drawRidgeTile, drawWallTile, drawTreeTile, loadAtlas } from './tileart.js?v=202611091209';
import { pointInPoly, mulberry32, distToSeg } from './util.js?v=202611091209';

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
          const half = r.w * 0.5 + 2.4;
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
        ctx.fillStyle = kind === 'water' ? '#3aa5d6' : kind === 'path' ? '#b9c0b4' : '#57a03c';
        ctx.fillRect(dx, dy, px, px);
      }
      if (kind === 'path') {
        // 压暗 + 只在挨着草地/水的那一边描边，读作"路缘"
        ctx.fillStyle = 'rgba(56,54,44,.36)';
        ctx.fillRect(dx, dy, px, px);
        ctx.fillStyle = 'rgba(54,50,40,.45)';
        const nb = (dcx, dcy) => cells.get((cx + dcx) + ',' + (cy + dcy)) || 'grass';
        const lw = Math.max(1, Math.round(px * 0.08));
        if (nb(0, -1) !== 'path') ctx.fillRect(dx, dy, px, lw);
        if (nb(0, 1) !== 'path') ctx.fillRect(dx, dy + px - lw, px, lw);
        if (nb(-1, 0) !== 'path') ctx.fillRect(dx, dy, lw, px);
        if (nb(1, 0) !== 'path') ctx.fillRect(dx + px - lw, dy, lw, px);
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
  ctx.fillStyle = 'rgba(30,42,30,.18)';
  ctx.fillRect(dx0 + px * 0.35, dy1 - px * 0.4, w, px * 0.9);

  // 墙体：南侧一条，高度按层数（每层一格）
  // 墙高 = max(层数×1格, 进深的 46%)，让正面站得住
  const depth = dy1 - dy0;
  const floors = Math.max(1, Math.min(5, b.fl || 2));
  const wallPx = Math.max(px * 1.5, Math.round(Math.max(px * floors, depth * 0.46)));
  const roofTop = dy0 - wallPx;              // 屋顶整体上移，盖在墙顶
  const roofBot = dy1 - wallPx;

  // 先铺墙（从屋顶下沿到地基）
  ctx.fillStyle = wallColor;
  ctx.fillRect(dx0, roofBot, w, wallPx);
  const rows = Math.max(1, Math.round(wallPx / px));
  const cols = Math.max(1, Math.round(w / px));
  const cw = w / cols, chh = wallPx / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const isDoor = r === rows - 1 && i === Math.floor(cols / 2);
      const band = isDoor ? 2 : (r === 0 && rows > 1 ? 0 : windowBand);
      drawWallTile(ctx, wallColor, band,
        Math.round(dx0 + i * cw), Math.round(roofBot + r * chh),
        Math.max(2, Math.round(cw)), (b.id || 1) + r * 7);
    }
  }
  // 勒脚
  ctx.fillStyle = 'rgba(50,42,32,.28)';
  ctx.fillRect(dx0, dy1 - Math.max(1, px * 0.16), w, Math.max(1, px * 0.16));

  // 屋顶：铺在墙顶之上
  ctx.save();
  ctx.beginPath(); ctx.rect(dx0, roofTop, w, depth); ctx.clip();
  for (let y = roofTop; y < roofBot + px; y += px) {
    for (let x = dx0; x < dx1; x += px) {
      drawRoofTile(ctx, roofColor, x, y, px, (b.id || 1) + x + y);
    }
  }
  ctx.restore();
  // 檐口（屋顶最低一排压暗）
  ctx.fillStyle = 'rgba(30,20,12,.30)';
  ctx.fillRect(dx0, roofBot - Math.max(1, px * 0.18), w, Math.max(1, px * 0.18));
  ctx.strokeStyle = 'rgba(28,22,18,.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(dx0 + 0.5, roofTop + 0.5, w - 1, depth + wallPx - 1);

  // 正脊
  const horiz = w >= depth;
  ctx.save();
  ctx.beginPath(); ctx.rect(dx0, roofTop, w, depth); ctx.clip();
  if (horiz) {
    const ry = Math.round(roofTop + depth / 2 - px / 2);
    for (let x = dx0; x < dx1; x += px) drawRidgeTile(ctx, roofColor, x, ry, px);
  } else {
    const rx = Math.round(dx0 + w / 2 - px / 2);
    for (let y = roofTop; y < roofBot + px; y += px) drawRidgeTile(ctx, roofColor, rx, y, px);
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
