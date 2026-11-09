// 静园图块试点：把这一片用 16px 图块重新画一遍（A 方案的第 2 阶段）
import { TILE, TILE_M, PX_PER_M, drawGroundTile, drawRoofTile, drawRidgeTile, drawWallTile, drawTreeTile, loadAtlas } from './tileart.js?v=202611091309';
import { pointInPoly, mulberry32, distToSeg } from './util.js?v=202611091309';

// 全图图块（阶段 3：静园试点定稿后铺满全校）
export const TILE_WHOLE_MAP = true;
export const PILOT = { x0: -250, y0: 90, x1: 130, y1: 400 };   // 兼容旧引用

export function inPilot(x, y) {
  if (!cellMeta) return false;
  const cx = Math.floor((x - cellMeta.x0) / TILE_M);
  const cy = Math.floor((y - cellMeta.y0) / TILE_M);
  return cx >= 0 && cy >= 0 && cx < cellMeta.cols && cy < cellMeta.rows;
}

let cellMeta = null;    // { x0, y0, cols, rows, arr: Uint8Array(0草地 1铺装 2水面) }

/** 把整张地图栅格化成 2 米格（道路用线段盖章，水面用扫描线，速度够快） */
export function buildCells(world) {
  if (cellMeta) return cellMeta;
  loadAtlas();
  const [wx0, wy0, wx1, wy1] = world.world;
  const cols = Math.ceil((wx1 - wx0) / TILE_M) + 2;
  const rows = Math.ceil((wy1 - wy0) / TILE_M) + 2;
  const arr = new Uint8Array(cols * rows);
  const idx = (cx, cy) => cy * cols + cx;
  const setCell = (x, y, v) => {
    const cx = Math.floor((x - wx0) / TILE_M), cy = Math.floor((y - wy0) / TILE_M);
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
    const i = idx(cx, cy);
    if (v > arr[i]) arr[i] = v;
  };
  // 道路：沿线段推进，按半径盖章
  for (const r of world.roads) {
    const rad = Math.max(TILE_M * 0.9, r.w * 0.5 + (r.w >= 4 ? 1.6 : 0.7));
    const rr = rad / TILE_M;
    for (let i = 0; i < r.pts.length - 2; i += 2) {
      const ax = r.pts[i], ay = r.pts[i + 1], bx = r.pts[i + 2], by = r.pts[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.01) continue;
      const steps = Math.max(1, Math.ceil(len / (TILE_M * 0.5)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t;
        const span = Math.ceil(rr);
        const gx = Math.floor((cx - wx0) / TILE_M), gy = Math.floor((cy - wy0) / TILE_M);
        for (let dy = -span; dy <= span; dy++) {
          for (let dx = -span; dx <= span; dx++) {
            if (dx * dx + dy * dy > rr * rr + 0.4) continue;
            const ix = gx + dx, iy = gy + dy;
            if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) continue;
            const j = idx(ix, iy);
            if (arr[j] === 0) arr[j] = 1;
          }
        }
      }
    }
  }
  // 水面：扫描线
  for (const w of world.water) {
    for (const ring of w.rings) {
      const bb = w.bbox;
      for (let y = Math.max(bb[1], wy0); y <= Math.min(bb[3], wy1); y += TILE_M * 0.5) {
        const xs = [];
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const yi = ring[i + 1], yj = ring[j + 1];
          if ((yi > y) !== (yj > y)) {
            xs.push((ring[j] - ring[i]) * (y - yi) / (yj - yi) + ring[i]);
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let x = xs[k]; x <= xs[k + 1]; x += TILE_M * 0.5) setCell(x, y, 2);
        }
      }
    }
  }
  cellMeta = { x0: wx0, y0: wy0, cols, rows, arr };
  return cellMeta;
}

/** 画当前视野内的地面图块（全图） */
export function drawPilotGround(ctx, cam) {
  if (!cellMeta) return;
  const S = cam.scale;
  const { x0, y0, cols, rows, arr } = cellMeta;
  const vx0 = cam.x - cam.w / 2 / S - TILE_M, vy0 = cam.y - cam.h / 2 / S - TILE_M;
  const vx1 = cam.x + cam.w / 2 / S + TILE_M, vy1 = cam.y + cam.h / 2 / S + TILE_M;
  const c0 = Math.max(0, Math.floor((vx0 - x0) / TILE_M)), c1 = Math.min(cols - 1, Math.ceil((vx1 - x0) / TILE_M));
  const r0 = Math.max(0, Math.floor((vy0 - y0) / TILE_M)), r1 = Math.min(rows - 1, Math.ceil((vy1 - y0) / TILE_M));
  const px = Math.max(2, Math.round(TILE_M * S));
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const v = arr[cy * cols + cx];
      const kind = v === 2 ? 'water' : v === 1 ? 'path' : 'grass';
      const dx = Math.round(cam.sx(x0 + cx * TILE_M));
      const dy = Math.round(cam.sy(y0 + cy * TILE_M));
      if (dx > cam.w || dy > cam.h || dx + px < 0 || dy + px < 0) continue;
      const pxl = px + 1;   // 多铺 1px，消除取整造成的接缝
      // 先铺底色：素材瓦片若含透明像素，也不会露出上一帧的内容
      ctx.fillStyle = kind === 'water' ? '#3aa5d6' : kind === 'path' ? '#b9bdb0' : '#57a03c';
      ctx.fillRect(dx, dy, pxl, pxl);
      drawGroundTile(ctx, kind, dx, dy, pxl);
      if (kind === 'water') {
        // 水岸：临草的一侧补浅色岸石，弱化阶梯感
        const nbW = (dcx, dcy) => {
          const nx = cx + dcx, ny = cy + dcy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return 0;
          return arr[ny * cols + nx];
        };
        const lw = Math.max(1, Math.round(px * 0.16));
        ctx.fillStyle = 'rgba(206,214,200,.85)';
        if (nbW(0, -1) !== 2) ctx.fillRect(dx, dy, pxl, lw);
        if (nbW(0, 1) !== 2) ctx.fillRect(dx, dy + pxl - lw, pxl, lw);
        if (nbW(-1, 0) !== 2) ctx.fillRect(dx, dy, lw, pxl);
        if (nbW(1, 0) !== 2) ctx.fillRect(dx + pxl - lw, dy, lw, pxl);
      }
      if (kind === 'path') {
        const nb = (dcx, dcy) => {
          const nx = cx + dcx, ny = cy + dcy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return 0;
          return arr[ny * cols + nx];
        };
        ctx.fillStyle = 'rgba(54,50,40,.40)';
        const lw = Math.max(1, Math.round(px * 0.08));
        if (nb(0, -1) === 0) ctx.fillRect(dx, dy, px, lw);
        if (nb(0, 1) === 0) ctx.fillRect(dx, dy + px - lw, px, lw);
        if (nb(-1, 0) === 0) ctx.fillRect(dx, dy, lw, px);
        if (nb(1, 0) === 0) ctx.fillRect(dx + px - lw, dy, lw, px);
      }
    }
  }
}

/** 楼的主轴角度（取最长边，归到 -45°~45°），用来让瓦片顺着楼走，而不是死对屏幕 */
function dominantAngle(b) {
  let best = 0, bestLen = 0;
  for (const ring of b.outer) {
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      const dx = ring[j] - ring[i], dy = ring[j + 1] - ring[i + 1];
      const len = Math.hypot(dx, dy);
      if (len > bestLen) { bestLen = len; best = Math.atan2(dy, dx); }
    }
  }
  let a = best;
  while (a > Math.PI / 4) a -= Math.PI / 2;
  while (a < -Math.PI / 4) a += Math.PI / 2;
  return Math.abs(a) < 0.05 ? 0 : a;
}

/** 一栋楼的图块画法：屋顶 = 占地轮廓，墙 = 轮廓向下拉；瓦片网格跟着楼的主轴旋转 */
export function drawTileBuilding(ctx, b, cam, roofColor, wallColor, windowBand, groundBand = 2, eaveColor = '#8d3520') {
  const S = cam.scale;
  const bb = b.bbox;
  const px = Math.max(2, Math.round(TILE_M * S));
  const dx0 = Math.round(cam.sx(bb[0])), dy0 = Math.round(cam.sy(bb[1]));
  const dx1 = Math.round(cam.sx(bb[2])), dy1 = Math.round(cam.sy(bb[3]));
  const w = dx1 - dx0, h = dy1 - dy0;
  if (w < 2 || h < 2) return;
  if (dx1 < -px * 8 || dy1 < -px * 8 || dx0 > cam.w + px * 8 || dy0 > cam.h + px * 8) return;

  const floors = Math.max(1, Math.min(5, b.fl || 2));
  const wallPx = Math.max(Math.round(px * 1.6), Math.min(Math.round(px * 6), Math.round(px * floors * 1.1)));

  // 轮廓（屏幕坐标）
  const pts = [];
  for (const ring of b.outer) for (let i = 0; i < ring.length; i += 2) pts.push([cam.sx(ring[i]), cam.sy(ring[i + 1])]);
  const cx = (dx0 + dx1) / 2, cy = (dy0 + dy1) / 2;

  // 让瓦片顺着楼的主轴：整体旋转坐标再画
  const ang = dominantAngle(b);
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const toRot = (x, y) => {
    const ddx = x - cx, ddy = y - cy;
    return [cx + ddx * cos + ddy * sin, cy - ddx * sin + ddy * cos];
  };

  // 旋转后的包围盒（用来铺瓦）
  let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
  for (const [x, y] of pts) {
    const [u, v] = toRot(x, y);
    rx0 = Math.min(rx0, u); rx1 = Math.max(rx1, u);
    ry0 = Math.min(ry0, v); ry1 = Math.max(ry1, v);
  }

  const mkPath = (dy) => {
    const p2 = new Path2D();
    for (const ring of b.outer) {
      const [sx0, sy0] = toRot(cam.sx(ring[0]), cam.sy(ring[1]));
      p2.moveTo(sx0, sy0 + dy);
      for (let i = 2; i < ring.length; i += 2) {
        const [sx1, sy1] = toRot(cam.sx(ring[i]), cam.sy(ring[i + 1]));
        p2.lineTo(sx1, sy1 + dy);
      }
      p2.closePath();
    }
    return p2;
  };

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  ctx.translate(-cx, -cy);

  const roofPath = mkPath(0);
  const wallPath = mkPath(wallPx);

  // 投影（贴墙底）
  ctx.save();
  ctx.translate(px * 0.18, 0);
  ctx.fillStyle = 'rgba(30,42,30,.16)';
  ctx.fill(mkPath(wallPx + Math.round(px * 0.25)));
  ctx.restore();

  // 墙：轮廓向下拉一段，铺窗
  ctx.save();
  ctx.clip(wallPath);
  ctx.fillStyle = wallColor;
  ctx.fill(wallPath);
  const wallW = rx1 - rx0;
  const rows = Math.max(1, Math.round(wallPx / px));
  const cols = Math.max(1, Math.round(wallW / px));
  const cw = wallW / cols, chh = wallPx / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const isGround = r === rows - 1;
      const band = isGround ? (i === Math.floor(cols / 2) ? groundBand : (groundBand === 6 ? 6 : windowBand)) : windowBand;
      drawWallTile(ctx, wallColor, band,
        Math.round(rx0 + i * cw), Math.round(ry1 + r * chh),
        Math.max(2, Math.round(cw)), (b.id || 1) + r * 7);
    }
  }
  // 墙脚暗线
  ctx.fillStyle = 'rgba(40,32,24,.30)';
  ctx.fillRect(rx0 - px, ry1 + wallPx - Math.max(1, px * 0.18), wallW + px * 2, Math.max(1, px * 0.18));
  ctx.restore();

  // 屋顶：占地轮廓本身，铺瓦
  ctx.save();
  ctx.clip(roofPath);
  const eaveOut = Math.round(px * 0.35);
  for (let y = ry0 - eaveOut; y < ry1 + px; y += px) {
    for (let x = rx0 - eaveOut; x < rx1 + px; x += px) {
      drawRoofTile(ctx, roofColor, x, y, px, (b.id || 1) + x + y);
    }
  }
  ctx.restore();
  // 檐口
  ctx.save();
  ctx.strokeStyle = eaveColor;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = Math.max(1, px * 0.16);
  ctx.stroke(roofPath);
  ctx.restore();
  // 正脊（沿长边方向）
  ctx.save();
  ctx.clip(roofPath);
  if (wallW >= ry1 - ry0) {
    const ryMid = Math.round((ry0 + ry1) / 2 - px / 2);
    for (let x = rx0; x < rx1; x += px) drawRidgeTile(ctx, roofColor, x, ryMid, px);
  } else {
    const rxMid = Math.round((rx0 + rx1) / 2 - px / 2);
    for (let y = ry0; y < ry1; y += px) drawRidgeTile(ctx, roofColor, rxMid, y, px);
  }
  ctx.restore();

  ctx.restore();
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
