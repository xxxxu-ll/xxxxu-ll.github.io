// 镜头与世界绘制：地面区块缓存、建筑伪立体、树木、水面动效、昼夜
import { clamp, shade, mixHex, rgba, mulberry32, polyBBox } from './util.js';
import { PPM } from './mapdata.js';

export class Camera {
  constructor() {
    this.x = 0; this.y = 0;      // 世界坐标（米），镜头中心
    this.zoom = 1;
    this.w = 1; this.h = 1;      // CSS 像素尺寸
  }
  updateSize(w, h) { this.w = w; this.h = h; }
  /** 世界米 -> 屏幕像素 */
  sx(x) { return (x - this.x) * PPM * this.zoom + this.w / 2; }
  sy(y) { return (y - this.y) * PPM * this.zoom + this.h / 2; }
  /** 屏幕像素 -> 世界米 */
  wx(px) { return (px - this.w / 2) / (PPM * this.zoom) + this.x; }
  wy(py) { return (py - this.h / 2) / (PPM * this.zoom) + this.y; }
  get scale() { return PPM * this.zoom; }
  viewRect(padM = 0) {
    const hw = this.w / 2 / this.scale + padM;
    const hh = this.h / 2 / this.scale + padM;
    return [this.x - hw, this.y - hh, this.x + hw, this.y + hh];
  }
}

// ---------- 调色 ----------
const GRASS = ['#7cb342', '#79ae3f', '#82b84a', '#74a83a'];
const ROAD_STYLE = {
  footway: { core: '#cfc2a2', edge: '#b3a684', dash: null },
  path: { core: '#c2b494', edge: '#a89a7c', dash: null },
  steps: { core: '#c9c4b8', edge: '#a9a496', dash: 'step' },
  service: { core: '#9a9a96', edge: '#7d7d79', dash: '#e8e4d8' },
  residential: { core: '#8f8f8b', edge: '#727270', dash: '#e8e4d8' },
  cycleway: { core: '#a87f6a', edge: '#8a6450', dash: null },
  pedestrian: { core: '#c8bda4', edge: '#a89d84', dash: null },
};

const ROOF_BY_CAT = {
  '教学': '#b9b3a6',
  '生活': '#b4715a',
  '食堂': '#c9a05c',
  '园林': '#8f8574',
  '体育': '#8b98a4',
  '校园服务': '#a8a294',
  '校门': '#a8493a',
};

const HERITAGE_ROOF = '#7a4a3a';

function roofColor(b) {
  if (b.heritage) return HERITAGE_ROOF;
  const pitched = /hip|gable|xieshan|wudian|coiled|barrel|pier/.test(b.roof);
  const base = ROOF_BY_CAT[b.cat] || '#a9a396';
  if (!pitched) return base;
  // 坡屋顶：生活区偏红瓦，教学/园林偏青灰瓦
  if (b.cat === '生活') return mixHex(base, '#8a4436', 0.45);
  if (b.cat === '食堂') return mixHex(base, '#9a5a3a', 0.3);
  return mixHex(base, '#5f6a66', 0.42);
}

function heightPx(b) {
  // 视觉挤出高度：按层高压缩，避免高楼遮挡过多
  const h = Math.max(3, b.h || b.fl * 3.4 || 8);
  return clamp(Math.round(Math.sqrt(h) * 5.2), 10, 34);
}

// ---------- 地面区块 ----------
export class Ground {
  constructor(world) {
    this.world = world;
    this.chunkM = 32;                 // 每块 32 米
    this.chunkPx = this.chunkM * PPM; // 256 px
    this.cache = new Map();
    this.maxCache = 48;
    this.grassPattern = null;
    this.queue = [];
  }

  _grassTile() {
    if (this._tile) return this._tile;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const rng = mulberry32(4242);
    g.fillStyle = GRASS[0];
    g.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 210; i++) {
      const x = (rng() * 32) | 0, y = (rng() * 32) | 0;
      const r = rng();
      g.fillStyle = r < 0.4 ? '#84ba4c' : r < 0.72 ? '#74a83a' : r < 0.9 ? '#8ec455' : '#6b9e34';
      g.fillRect(x, y, 1 + ((rng() * 2) | 0), 1);
    }
    this._tile = c;
    return c;
  }

  _getChunk(cx, cy) {
    const key = cx + ',' + cy;
    let c = this.cache.get(key);
    if (c) { this.cache.delete(key); this.cache.set(key, c); return c; }
    c = this._renderChunk(cx, cy);
    this.cache.set(key, c);
    if (this.cache.size > this.maxCache) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
    return c;
  }

  _renderChunk(cx, cy) {
    const W = this.chunkPx;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = W;
    const g = canvas.getContext('2d');
    const w0 = cx * this.chunkM, h0 = cy * this.chunkM;
    // 世界米 -> 本地像素
    g.setTransform(PPM, 0, 0, PPM, -w0 * PPM, -h0 * PPM);

    // 草地
    if (!this.grassPattern) this.grassPattern = g.createPattern(this._grassTile(), 'repeat');
    g.save();
    g.setTransform(1, 0, 0, 1, -w0 * PPM, -h0 * PPM);
    g.fillStyle = this.grassPattern;
    g.fillRect(w0 * PPM, h0 * PPM, W, W);
    g.restore();

    const rng = mulberry32((cx + 1000) * 7919 + (cy + 1000) * 104729);
    // 草地色块变化
    for (let i = 0; i < 14; i++) {
      g.fillStyle = rgba(i % 2 ? '#6ea63a' : '#8abd52', 0.10 + rng() * 0.10);
      const x = w0 + rng() * this.chunkM, y = h0 + rng() * this.chunkM;
      const rw = 5 + rng() * 22, rh = 4 + rng() * 16;
      g.fillRect(x, y, rw, rh);
    }
    // 小花与草簇
    for (let i = 0; i < 11; i++) {
      const x = w0 + rng() * this.chunkM, y = h0 + rng() * this.chunkM;
      const r = rng();
      if (r < 0.22) { g.fillStyle = 'rgba(242,230,168,.75)'; g.fillRect(x, y, 0.45, 0.45); }
      else if (r < 0.34) { g.fillStyle = 'rgba(232,201,216,.7)'; g.fillRect(x, y, 0.45, 0.45); }
      else { g.fillStyle = rgba('#5d9333', 0.45); g.fillRect(x, y, 0.4, 0.8); }
    }

    // 绿地
    for (const lc of this.world.landcover) {
      if (!bboxHit(lc.bbox, w0, h0, w0 + this.chunkM, h0 + this.chunkM)) continue;
      g.beginPath();
      tracePoly(g, lc.ring);
      g.fillStyle = lc.wooded ? '#5f9436' : mixHex('#7cb342', '#6aa63a', 0.35);
      g.fill();
      g.strokeStyle = rgba('#4f7a2a', 0.25);
      g.lineWidth = 0.35;
      g.stroke();
    }

    // 体育场地
    for (const s of this.world.sports) {
      if (!bboxHit(s.bbox, w0, h0, w0 + this.chunkM, h0 + this.chunkM)) continue;
      this._drawSport(g, s);
    }

    // 水
    for (const w of this.world.water) {
      if (!bboxHit(w.bbox, w0, h0, w0 + this.chunkM, h0 + this.chunkM)) continue;
      for (const ring of w.rings) {
        // 岸线浅滩
        g.beginPath();
        tracePoly(g, ring);
        g.strokeStyle = '#cfe0b8';
        g.lineWidth = 2.6;
        g.stroke();
        g.strokeStyle = '#a8c8a0';
        g.lineWidth = 1.2;
        g.stroke();
        // 水面
        g.beginPath();
        tracePoly(g, ring);
        g.fillStyle = '#5aa8c9';
        g.fill();
        // 波纹
        const bb = polyBBox(ring);
        g.save();
        g.beginPath();
        tracePoly(g, ring);
        g.clip();
        const area = Math.abs(bb[2] - bb[0]) * Math.abs(bb[3] - bb[1]);
        const waves = Math.min(70, Math.max(6, Math.round(area / 55)));
        const wrng = mulberry32(Math.round(bb[0] * 13 + bb[1] * 7) | 0);
        for (let i = 0; i < waves; i++) {
          const x = bb[0] + wrng() * (bb[2] - bb[0]);
          const y = bb[1] + wrng() * (bb[3] - bb[1]);
          g.strokeStyle = wrng() > 0.5 ? 'rgba(190,232,244,.42)' : 'rgba(58,126,160,.30)';
          g.lineWidth = 0.22;
          g.beginPath();
          g.moveTo(x, y);
          g.quadraticCurveTo(x + 0.9, y - 0.35, x + 1.9, y);
          g.stroke();
        }
        g.restore();
      }
    }

    // 道路（先宽后窄，避免覆盖顺序问题）
    const roads = this.world.roads
      .filter(r => bboxHit(r.bbox, w0, h0, w0 + this.chunkM, h0 + this.chunkM))
      .sort((a, b) => b.w - a.w);
    for (const r of roads) this._drawRoad(g, r, 0);

    // 校园边界（很淡的点线，只在全图与近处可见）
    return canvas;
  }

  _drawSport(g, s) {
    g.beginPath();
    tracePoly(g, s.ring);
    const sp = (s.sport || '').toLowerCase();
    let base = '#6f9a4a';
    if (sp === 'running' || sp === 'athletics') base = '#b4573f';
    else if (sp === 'tennis') base = '#4a7a6a';
    else if (sp === 'basketball') base = '#8a6a4a';
    else if (sp === 'volleyball') base = '#b08a4a';
    else if (sp === 'soccer') base = '#5f9a44';
    else if (sp === 'climbing') base = '#8a8578';
    g.fillStyle = base;
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = 0.4;
    g.stroke();
    // 场地线
    const bb = polyBBox(s.ring);
    g.save();
    g.beginPath();
    tracePoly(g, s.ring);
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,.42)';
    g.lineWidth = 0.3;
    if (sp === 'running' || sp === 'athletics') {
      for (let i = 1; i <= 4; i++) {
        const inset = (bb[2] - bb[0]) * 0.06 * i;
        g.strokeRect(bb[0] + inset, bb[1] + inset, bb[2] - bb[0] - inset * 2, bb[3] - bb[1] - inset * 2);
      }
    } else if (sp === 'basketball' || sp === 'tennis' || sp === 'volleyball') {
      g.beginPath();
      g.moveTo(bb[0] + (bb[2] - bb[0]) / 2, bb[1]);
      g.lineTo(bb[0] + (bb[2] - bb[0]) / 2, bb[3]);
      g.stroke();
      const rr = Math.min(bb[2] - bb[0], bb[3] - bb[1]) * 0.18;
      g.beginPath();
      g.arc(bb[0] + (bb[2] - bb[0]) / 2, bb[1] + (bb[3] - bb[1]) / 2, rr, 0, Math.PI * 2);
      g.stroke();
    } else if (sp === 'soccer') {
      g.strokeRect(bb[0] + 1.5, bb[1] + 1.5, bb[2] - bb[0] - 3, bb[3] - bb[1] - 3);
    }
    g.restore();
  }

  _drawRoad(g, r, t) {
    const st = ROAD_STYLE[r.kind] || ROAD_STYLE.footway;
    const w = r.w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // 外描边
    g.beginPath();
    traceLine(g, r.pts);
    g.strokeStyle = st.edge;
    g.lineWidth = w + 0.7;
    g.stroke();
    // 路面
    g.beginPath();
    traceLine(g, r.pts);
    g.strokeStyle = st.core;
    g.lineWidth = w;
    g.stroke();

    if (st.dash === 'step') {
      g.strokeStyle = 'rgba(120,116,104,.5)';
      g.lineWidth = w * 0.9;
      g.setLineDash([0.55, 0.55]);
      g.beginPath(); traceLine(g, r.pts); g.stroke();
      g.setLineDash([]);
    } else if (st.dash && w >= 4.4) {
      g.strokeStyle = rgba(st.dash, 0.8);
      g.lineWidth = 0.22;
      g.setLineDash([2.2, 2.6]);
      g.beginPath(); traceLine(g, r.pts); g.stroke();
      g.setLineDash([]);
    }
  }

  /** 绘制可见区块 */
  draw(ctx, cam) {
    const [vx0, vy0, vx1, vy1] = cam.viewRect(2);
    const c0x = Math.floor(vx0 / this.chunkM), c1x = Math.floor(vx1 / this.chunkM);
    const c0y = Math.floor(vy0 / this.chunkM), c1y = Math.floor(vy1 / this.chunkM);
    const s = cam.scale;
    ctx.imageSmoothingEnabled = false;
    let missing = 0;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const key = cx + ',' + cy;
        let ch = this.cache.get(key);
        if (!ch) {
          if (missing < 2) { ch = this._getChunk(cx, cy); missing++; }
          else continue;
        }
        const dx = cam.sx(cx * this.chunkM);
        const dy = cam.sy(cy * this.chunkM);
        ctx.drawImage(ch, Math.round(dx), Math.round(dy), Math.ceil(this.chunkPx * cam.zoom), Math.ceil(this.chunkPx * cam.zoom));
      }
    }
  }
}

function bboxHit(bb, x0, y0, x1, y1) {
  return !(bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1);
}

function tracePoly(g, f) {
  g.moveTo(f[0], f[1]);
  for (let i = 2; i < f.length; i += 2) g.lineTo(f[i], f[i + 1]);
  g.closePath();
}

function traceLine(g, pts) {
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
}

// ---------- 建筑 ----------
export function prepareBuilding(b) {
  if (b._path) return b;
  const path = new Path2D();
  for (const poly of b.polys) {
    for (const ring of poly) {
      path.moveTo(ring[0], ring[1]);
      for (let i = 2; i < ring.length; i += 2) path.lineTo(ring[i], ring[i + 1]);
      path.closePath();
    }
  }
  b._path = path;
  b._roof = roofColor(b);
  b._extrude = heightPx(b);
  b._pitch = /hip|gable|xieshan|wudian|coiled|barrel/.test(b.roof);
  return b;
}

export function drawBuilding(ctx, b, cam, timeOfDay) {
  prepareBuilding(b);
  const s = cam.scale;
  const ex = b._extrude * cam.zoom;  const ox = cam.w / 2 - cam.x * s;
  const oy = cam.h / 2 - cam.y * s;
  const setM = (dx, dy) => {
    ctx.translate(ox + dx, oy + dy);
    ctx.scale(s, s);
  };

  // 地面阴影
  ctx.save();
  setM(ex * 0.16 + 2, ex * 0.34 + 3);
  ctx.fillStyle = 'rgba(38,52,32,.20)';
  ctx.fill(b._path);
  ctx.restore();

  // 墙体：把占地整体下移，形成南向立面
  ctx.save();
  setM(0, ex);
  ctx.fillStyle = shade(b._roof, -0.34);
  ctx.fill(b._path);
  ctx.restore();

  // 屋顶
  ctx.save();
  setM(0, 0);
  ctx.fillStyle = b._roof;
  ctx.fill(b._path, 'evenodd');

  const bb = b.bbox;
  ctx.save();
  ctx.clip(b._path, 'evenodd');
  if (b._pitch) {
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    ctx.strokeStyle = rgba('#3a332c', 0.22);
    ctx.lineWidth = 0.35;
    if (w >= h) {
      const cy = (bb[1] + bb[3]) / 2;
      ctx.beginPath(); ctx.moveTo(bb[0], cy); ctx.lineTo(bb[2], cy); ctx.stroke();
    } else {
      const cx = (bb[0] + bb[2]) / 2;
      ctx.beginPath(); ctx.moveTo(cx, bb[1]); ctx.lineTo(cx, bb[3]); ctx.stroke();
    }
    ctx.strokeStyle = rgba('#2f2a24', 0.09);
    ctx.lineWidth = 0.12;
    for (let y = bb[1] + 1; y < bb[3]; y += 1.1) {
      ctx.beginPath(); ctx.moveTo(bb[0], y); ctx.lineTo(bb[2], y); ctx.stroke();
    }
  } else {
    // 平屋顶：分格缝、设备箱、天窗
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    ctx.strokeStyle = rgba('#3a332c', 0.09);
    ctx.lineWidth = 0.12;
    for (let x = bb[0] + 6; x < bb[2]; x += 6) {
      ctx.beginPath(); ctx.moveTo(x, bb[1]); ctx.lineTo(x, bb[3]); ctx.stroke();
    }
    for (let y = bb[1] + 6; y < bb[3]; y += 6) {
      ctx.beginPath(); ctx.moveTo(bb[0], y); ctx.lineTo(bb[2], y); ctx.stroke();
    }
    const rng = mulberry32((b.id | 0) * 977 + 13);
    const n = Math.min(6, Math.max(1, Math.round(w * h / 900)));
    for (let i = 0; i < n; i++) {
      const uw = 2 + rng() * 4, uh = 1.6 + rng() * 3;
      const ux = bb[0] + 2 + rng() * Math.max(1, w - uw - 4);
      const uy = bb[1] + 2 + rng() * Math.max(1, h - uh - 4);
      ctx.fillStyle = rgba('#4a4740', 0.28);
      ctx.fillRect(ux + 0.3, uy + 0.3, uw, uh);
      ctx.fillStyle = rgba('#e8e4d6', 0.34);
      ctx.fillRect(ux, uy, uw, uh * 0.55);
    }
    if (w > 20 && h > 20) {
      ctx.fillStyle = rgba('#9fc6d8', 0.30);
      ctx.fillRect(bb[0] + w * 0.28, bb[1] + h * 0.42, Math.min(8, w * 0.2), Math.min(3, h * 0.08));
    }
  }
  ctx.restore();

  // 轮廓
  ctx.strokeStyle = rgba('#2c2a22', 0.55);
  ctx.lineWidth = 0.28;
  ctx.stroke(b._path);

  // 受光的南侧屋檐
  ctx.save();
  ctx.clip(b._path, 'evenodd');
  ctx.fillStyle = rgba('#fff6dd', 0.22);
  ctx.fillRect(bb[0], bb[3] - 0.8, bb[2] - bb[0], 0.8);
  ctx.restore();

  // 南侧立面的窗（画在屋顶下移形成的墙带上）
  if (ex > 8) {
    ctx.save();
    setM(0, ex);
    ctx.clip(b._path);
    const exM = ex / s;                       // 立面视觉高度（米）
    const rows = Math.min(3, Math.max(1, Math.round(exM / 4.2)));
    const rng = mulberry32((b.id | 0) * 31 + 7);
    const night = nightStrength(timeOfDay) > 0.15;
    for (let r = 0; r < rows; r++) {
      const y = bb[3] - 1.1 - r * (exM / rows);
      for (let x = bb[0] + 1.4; x < bb[2] - 1.4; x += 2.8) {
        const skip = rng() < 0.18;
        const lit = rng() < 0.45;
        if (skip) continue;
        if (night && lit) {
          ctx.fillStyle = 'rgba(255,214,140,.92)';
          ctx.fillRect(x, y - 1.4, 1.3, 1.4);
          ctx.fillStyle = 'rgba(255,232,170,.22)';
          ctx.fillRect(x - 0.5, y - 2.0, 2.3, 2.4);
        } else {
          ctx.fillStyle = 'rgba(46,60,68,.62)';
          ctx.fillRect(x, y - 1.4, 1.3, 1.4);
          ctx.fillStyle = 'rgba(246,230,184,.16)';
          ctx.fillRect(x, y - 1.4, 1.3, 0.4);
        }
      }
    }
    ctx.restore();
  }
  ctx.restore();

  // 名称标签
  const sc = cam.zoom;
  if (b.name && (b.area > 260 || b.heritage)) {
    const [lx, ly] = b.label;
    const px = cam.sx(lx), py = cam.sy(ly) - ex * 0.15;
    const d = Math.hypot(lx - cam.x, ly - cam.y);
    if (d < 150) {
      const alpha = clamp(1 - (d - 90) / 60, 0.15, 0.92);
      drawLabel(ctx, b.name, px, py, Math.max(10, 11 * sc), alpha);
    }
  }
}

export function drawLabel(ctx, text, x, y, size, alpha = 0.9, color = '#2a3524') {
  ctx.save();
  ctx.font = `600 ${Math.round(size)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, size / 4);
  ctx.strokeStyle = rgba('#fdfaf3', alpha * 0.85);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = rgba(color, alpha);
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ---------- 树木 ----------
const TREE_TONES = [
  ['#3f7d3a', '#4f9a45', '#2f5f2c'],
  ['#4a8a3c', '#5aa84e', '#376a2c'],
  ['#4f7a3a', '#5f9448', '#3a5f2a'],
  ['#57803a', '#6b9e48', '#3f6228'],
];

export function drawTree(ctx, t, cam) {
  const x = cam.sx(t.x), y = cam.sy(t.y);
  const z = cam.zoom;
  const tone = TREE_TONES[t.tone % TREE_TONES.length];
  const s = t.s * z;
  // 阴影
  ctx.fillStyle = 'rgba(38,52,32,.16)';
  ctx.beginPath();
  ctx.ellipse(x + 3 * s, y + 2.6 * s, 7.4 * s, 3.4 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  // 树干
  ctx.fillStyle = '#6b4a32';
  ctx.fillRect(Math.round(x - 1.2 * s), Math.round(y - 3 * s), Math.max(1.5, Math.round(2.4 * s)), Math.round(5 * s));

  if (t.kind === 'pine') {
    ctx.fillStyle = tone[2];
    ctx.beginPath();
    ctx.moveTo(x, y - 28 * s);
    ctx.lineTo(x + 9.5 * s, y - 3 * s);
    ctx.lineTo(x - 9.5 * s, y - 3 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = tone[0];
    ctx.beginPath();
    ctx.moveTo(x, y - 21 * s);
    ctx.lineTo(x + 6.4 * s, y - 6 * s);
    ctx.lineTo(x - 6.4 * s, y - 6 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = tone[1];
    ctx.beginPath();
    ctx.moveTo(x - 1.2 * s, y - 24 * s);
    ctx.lineTo(x + 0.2 * s, y - 16 * s);
    ctx.lineTo(x - 4.6 * s, y - 10 * s);
    ctx.closePath();
    ctx.fill();
  } else if (t.kind === 'willow') {
    ctx.strokeStyle = tone[1];
    ctx.lineWidth = Math.max(1, 1.3 * s);
    for (let i = -4; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 2.6 * s, y - 13 * s);
      ctx.quadraticCurveTo(x + i * 4.2 * s, y - 6 * s, x + i * 3.4 * s, y - 0.5 * s);
      ctx.stroke();
    }
    ctx.fillStyle = tone[0];
    ctx.beginPath();
    ctx.ellipse(x, y - 15 * s, 9.6 * s, 6.6 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = tone[1];
    ctx.beginPath();
    ctx.ellipse(x - 2.4 * s, y - 17 * s, 4.6 * s, 3.2 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const r = (t.kind === 'round' ? 9.6 : 11.2) * s;
    ctx.fillStyle = tone[2];
    ctx.beginPath();
    ctx.ellipse(x, y - 11 * s, r, r * 0.84, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = tone[0];
    ctx.beginPath();
    ctx.ellipse(x - r * 0.16, y - 13 * s, r * 0.88, r * 0.74, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = tone[1];
    ctx.beginPath();
    ctx.ellipse(x - r * 0.34, y - 15.2 * s, r * 0.46, r * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- 水面动效 ----------
export function drawWaterAnim(ctx, world, cam, time) {
  const [vx0, vy0, vx1, vy1] = cam.viewRect(0);
  ctx.save();
  for (const w of world.water) {
    if (!bboxHit(w.bbox, vx0, vy0, vx1, vy1)) continue;
    for (const ring of w.rings) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cam.sx(ring[0]), cam.sy(ring[1]));
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(cam.sx(ring[i]), cam.sy(ring[i + 1]));
      ctx.closePath();
      ctx.clip();
      const bb = polyBBox(ring);
      // 缓慢漂移的亮斑
      for (let i = 0; i < 3; i++) {
        const phase = (time * 0.00004 + i * 0.33) % 1;
        const cx = bb[0] + (bb[2] - bb[0]) * (0.2 + 0.6 * ((i * 0.37 + phase) % 1));
        const cy = bb[1] + (bb[3] - bb[1]) * (0.25 + 0.5 * ((i * 0.61 + phase * 0.7) % 1));
        const rx = (bb[2] - bb[0]) * 0.16, ry = (bb[3] - bb[1]) * 0.06;
        const grad = ctx.createRadialGradient(cam.sx(cx), cam.sy(cy), 0, cam.sx(cx), cam.sy(cy), Math.max(8, rx * PPM * cam.zoom));
        grad.addColorStop(0, rgba('#d8f2fb', 0.10));
        grad.addColorStop(1, rgba('#d8f2fb', 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(cam.sx(cx), cam.sy(cy), rx * PPM * cam.zoom, ry * PPM * cam.zoom, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // 波光
      const rng = mulberry32(777 + Math.floor(time / 900));
      for (let i = 0; i < 8; i++) {
        const px = bb[0] + rng() * (bb[2] - bb[0]);
        const py = bb[1] + rng() * (bb[3] - bb[1]);
        ctx.fillStyle = rgba('#eaf9ff', 0.35 + 0.25 * Math.sin(time * 0.002 + i));
        ctx.fillRect(cam.sx(px), cam.sy(py), 2.5 * cam.zoom, 1 * cam.zoom);
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

// ---------- 夜间灯光 ----------
export function nightStrength(hour) {
  if (hour >= 18.5 || hour < 6) return 1;
  if (hour >= 17.5) return (hour - 17.5) / 1;
  if (hour < 6.8) return Math.max(0, 1 - (hour - 6) / 0.8);
  return 0;
}

export function drawNightLights(ctx, world, cam, hour) {
  const k = nightStrength(hour);
  if (k <= 0.02) return;
  const [vx0, vy0, vx1, vy1] = cam.viewRect(3);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const lamp of world.lamps) {
    if (lamp.x < vx0 || lamp.x > vx1 || lamp.y < vy0 || lamp.y > vy1) continue;
    const x = cam.sx(lamp.x), y = cam.sy(lamp.y);
    const r = 46 * cam.zoom;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,214,150,${0.30 * k})`);
    g.addColorStop(0.45, `rgba(255,196,120,${0.13 * k})`);
    g.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,236,190,${0.9 * k})`;
    ctx.beginPath();
    ctx.arc(x, y, 2.2 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------- 昼夜色调 ----------
export function dayTint(hour) {
  // 返回 [overlayColor, alpha]
  if (hour >= 6 && hour < 8) return ['#ffd9a0', 0.12];
  if (hour >= 8 && hour < 16.5) return [null, 0];
  if (hour >= 16.5 && hour < 18.5) return ['#ffb877', 0.16];
  if (hour >= 18.5 && hour < 20) return ['#5b6ea8', 0.22];
  return ['#243a5e', 0.40];
}

export function drawTint(ctx, w, h, hour) {
  const [color, alpha] = dayTint(hour);
  if (!color || alpha <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = rgba(color, 1);
  ctx.globalAlpha = alpha;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
