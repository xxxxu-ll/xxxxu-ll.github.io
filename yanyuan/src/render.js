// 像素渲染：低分辨率缓冲 + 整数倍放大（真正的像素网格，不是矢量贴图）
// 世界按 RENDER_PPM 像素/米 绘制到离屏画布，再由 game.js 整数倍放大到屏幕。
import { clamp, shade, mixHex, rgba, mulberry32, polyBBox } from './util.js?v=202611090505';

export const RENDER_PPM = 4;          // 低分辨率缓冲每米像素数
export const UPSCALE = 2;             // 放大倍数（game.js 使用）

// ---------------- 调色板（低饱和、统一明度关系） ----------------
const P = {
  grass: ['#7fa844', '#7aa241', '#86ad4b', '#739a3b'],
  grassFlower: ['#e8dda6', '#dfc7cf'],
  lawn: '#7ba442',
  lawnDark: '#628c33',
  plaza: '#c6bda8',
  plazaDark: '#aba38d',
  water: ['#357e9c', '#2f7391', '#3d8aa8'],
  waterDeep: '#2a6480',
  shore: '#a89a80',
  shoreDark: '#87795f',
  reed: '#4f7a34',
  asphalt: '#8b8b85',
  asphaltDark: '#72726c',
  curb: '#a3a298',
  path: '#c7b998',
  pathEdge: '#a89a7b',
  stone: '#b7b2a2',
  outline: 'rgba(40,44,36,.5)',
  wallLight: '#e6dfc9',
  wallMid: '#cdc3ac',
  wallDark: '#a29883',
  timber: '#8a5140',
  timberDark: '#6d3d31',
  roofGrey: '#7e858c',
  roofGreyDark: '#59616a',
  roofTile: '#6d7a85',
  roofTileDark: '#4e5962',
  roofDorm: '#94614f',
  roofDormDark: '#734a3c',
  roofGreen: '#5d7a66',
  roofGreenDark: '#465e4d',
  glass: '#8bb8cb',
  glassDark: '#5b8a9e',
  gold: '#d0ab58',
  red: '#a84636',
  redDark: '#82352a',
};

export class Camera {
  constructor() {
    this.x = 0; this.y = 0;
    this.zoom = 1;
    this.w = 1; this.h = 1;
    this.labels = [];
  }
  updateSize(w, h) { this.w = w; this.h = h; }
  sx(x) { return (x - this.x) * RENDER_PPM * this.zoom + this.w / 2; }
  sy(y) { return (y - this.y) * RENDER_PPM * this.zoom + this.h / 2; }
  wx(px) { return (px - this.w / 2) / (RENDER_PPM * this.zoom) + this.x; }
  wy(py) { return (py - this.h / 2) / (RENDER_PPM * this.zoom) + this.y; }
  get scale() { return RENDER_PPM * this.zoom; }
  viewRect(padM = 0) {
    const hw = this.w / 2 / this.scale + padM;
    const hh = this.h / 2 / this.scale + padM;
    return [this.x - hw, this.y - hh, this.x + hw, this.y + hh];
  }
  label(text, x, y, size, color = '#fdfaf3', alpha = 0.9, shadow = true) {
    this.labels.push({ text, x, y, size, color, alpha, shadow });
  }
}

function poly(g, f) {
  g.moveTo(f[0], f[1]);
  for (let i = 2; i < f.length; i += 2) g.lineTo(f[i], f[i + 1]);
  g.closePath();
}

// ---------------- 地面 ----------------
export class Ground {
  constructor(world) {
    this.world = world;
    this.chunkM = 32;
    this.chunkPx = this.chunkM * RENDER_PPM;
    this.cache = new Map();
    this.maxCache = 90;
    this.pattern = null;
    // 建筑周边铺装环（提前算好，避免每块重复判断）
    this.aprons = world.buildings
      .filter(b => b.area > 60)
      .map(b => ({ bbox: b.bbox, polys: b.polys }));
  }

  _grassTile() {
    if (this._tile) return this._tile;
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const g = c.getContext('2d');
    const rng = mulberry32(9182);
    g.fillStyle = P.grass[0];
    g.fillRect(0, 0, 24, 24);
    // 稀疏的深浅斑点（保持安静，只在放大后看得出颗粒）
    for (let i = 0; i < 34; i++) {
      const x = (rng() * 24) | 0, y = (rng() * 24) | 0;
      g.fillStyle = rng() < 0.5 ? P.grass[1] : P.grass[2];
      g.fillRect(x, y, 2, 1);
    }
    // 少量草簇
    for (let i = 0; i < 5; i++) {
      const x = (rng() * 22) | 0, y = (rng() * 22) | 0;
      g.fillStyle = P.grass[3];
      g.fillRect(x, y, 1, 2);
      g.fillRect(x + 1, y + 1, 1, 1);
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
    if (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    return c;
  }

  _renderChunk(cx, cy) {
    const S = RENDER_PPM;
    const cvs = document.createElement('canvas');
    cvs.width = this.chunkPx;
    cvs.height = this.chunkPx;
    const g = cvs.getContext('2d');
    const w0 = cx * this.chunkM, h0 = cy * this.chunkM;
    const x0 = w0, y0 = h0, x1 = w0 + this.chunkM, y1 = h0 + this.chunkM;

    // 世界米 → 本地像素
    g.setTransform(S, 0, 0, S, -w0 * S, -h0 * S);
    g.imageSmoothingEnabled = false;

    // 草地
    if (!this.pattern) this.pattern = g.createPattern(this._grassTile(), 'repeat');
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = this.pattern;
    // 让纹理对齐世界坐标，避免区块接缝
    g.translate(((-w0 * S) % 24 + 24) % 24, ((-h0 * S) % 24 + 24) % 24);
    g.fillRect(-24, -24, this.chunkPx + 48, this.chunkPx + 48);
    g.restore();

    // 绿地（更深的草坪）
    for (const lc of this.world.landcover) {
      if (!hit(lc.bbox, x0, y0, x1, y1)) continue;
      g.beginPath(); poly(g, lc.ring);
      g.fillStyle = lc.wooded ? '#5d8a34' : P.lawn;
      g.fill();
      g.strokeStyle = 'rgba(70,110,36,.35)';
      g.lineWidth = 0.5;
      g.stroke();
    }

    // 片区铺装（广场）
    for (const pr of this.world.precincts) {
      if (!hit(pr.bbox, x0, y0, x1, y1)) continue;
      if (!/广场|三角地/.test(pr.name)) continue;
      g.beginPath(); poly(g, pr.ring);
      g.fillStyle = P.plaza;
      g.fill();
      g.strokeStyle = P.plazaDark;
      g.lineWidth = 0.4;
      g.stroke();
      stampPaving(g, pr.ring);
    }

    // 体育场地
    for (const s of this.world.sports) {
      if (!hit(s.bbox, x0, y0, x1, y1)) continue;
      drawSport(g, s);
    }

    // 水面
    for (const w of this.world.water) {
      if (!hit(w.bbox, x0, y0, x1, y1)) continue;
      for (const ring of w.rings) drawWater(g, ring, w.name);
    }

    // 道路（窄路后画，压在宽路之上）
    const roads = this.world.roads
      .filter(r => hit(r.bbox, x0, y0, x1, y1))
      .sort((a, b) => b.w - a.w);
    for (const r of roads) drawRoad(g, r);

    // 建筑周边铺装
    for (const a of this.aprons) {
      if (!hit(a.bbox, x0 - 4, y0 - 4, x1 + 4, y1 + 4)) continue;
      g.beginPath();
      for (const p of a.polys) for (const ring of p) poly(g, ring);
      g.strokeStyle = P.plazaDark;
      g.lineWidth = 2.2;
      g.stroke();
      g.strokeStyle = P.plaza;
      g.lineWidth = 1.4;
      g.stroke();
    }

    return cvs;
  }

  draw(ctx, cam) {
    const [vx0, vy0, vx1, vy1] = cam.viewRect(2);
    const c0x = Math.floor(vx0 / this.chunkM), c1x = Math.floor(vx1 / this.chunkM);
    const c0y = Math.floor(vy0 / this.chunkM), c1y = Math.floor(vy1 / this.chunkM);
    ctx.imageSmoothingEnabled = false;
    let budget = 3;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        let ch = this.cache.get(cx + ',' + cy);
        if (!ch) {
          if (budget-- <= 0) continue;
          ch = this._getChunk(cx, cy);
        }
        const dx = Math.round(cam.sx(cx * this.chunkM));
        const dy = Math.round(cam.sy(cy * this.chunkM));
        ctx.drawImage(ch, dx, dy, this.chunkPx, this.chunkPx);
      }
    }
  }
}

function hit(b, x0, y0, x1, y1) { return !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1); }

function stampPaving(g, ring) {
  const bb = polyBBox(ring);
  g.save();
  g.beginPath(); poly(g, ring); g.clip();
  g.strokeStyle = 'rgba(150,142,120,.35)';
  g.lineWidth = 0.25;
  for (let x = Math.ceil(bb[0] / 3) * 3; x < bb[2]; x += 3) {
    g.beginPath(); g.moveTo(x, bb[1]); g.lineTo(x, bb[3]); g.stroke();
  }
  for (let y = Math.ceil(bb[1] / 3) * 3; y < bb[3]; y += 3) {
    g.beginPath(); g.moveTo(bb[0], y); g.lineTo(bb[2], y); g.stroke();
  }
  g.restore();
}

function drawSport(g, s) {
  const sp = (s.sport || '').toLowerCase();
  let base = '#6f9a4a', line = 'rgba(255,255,255,.5)';
  if (sp === 'running' || sp === 'athletics') base = '#b45a42';
  else if (sp === 'tennis') base = '#4d7f6c';
  else if (sp === 'basketball') base = '#94694a';
  else if (sp === 'volleyball') base = '#b0893f';
  else if (sp === 'soccer') base = '#5f9a44';
  else if (sp === 'climbing') base = '#8a8578';
  g.beginPath(); poly(g, s.ring);
  g.fillStyle = base; g.fill();
  const bb = polyBBox(s.ring);
  g.save();
  g.beginPath(); poly(g, s.ring); g.clip();
  g.strokeStyle = line; g.lineWidth = 0.3;
  if (sp === 'running' || sp === 'athletics') {
    for (let i = 1; i <= 4; i++) {
      const inset = (bb[2] - bb[0]) * 0.06 * i;
      g.strokeRect(bb[0] + inset, bb[1] + inset, bb[2] - bb[0] - inset * 2, bb[3] - bb[1] - inset * 2);
    }
  } else if (sp === 'basketball' || sp === 'tennis' || sp === 'volleyball') {
    g.beginPath();
    g.moveTo((bb[0] + bb[2]) / 2, bb[1]); g.lineTo((bb[0] + bb[2]) / 2, bb[3]); g.stroke();
    g.beginPath();
    g.arc((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.min(bb[2] - bb[0], bb[3] - bb[1]) * 0.18, 0, Math.PI * 2);
    g.stroke();
  } else if (sp === 'soccer') {
    g.strokeRect(bb[0] + 1.5, bb[1] + 1.5, bb[2] - bb[0] - 3, bb[3] - bb[1] - 3);
  }
  g.restore();
  g.strokeStyle = 'rgba(60,70,55,.4)';
  g.lineWidth = 0.4;
  g.beginPath(); poly(g, s.ring); g.stroke();
}

function drawWater(g, ring, name) {
  const bb = polyBBox(ring);
  // 石砌驳岸
  g.beginPath(); poly(g, ring);
  g.strokeStyle = P.shoreDark; g.lineWidth = 2.6; g.stroke();
  g.strokeStyle = P.shore; g.lineWidth = 1.3; g.stroke();
  // 水体
  g.beginPath(); poly(g, ring);
  g.fillStyle = P.water[1];
  g.fill();
  g.save();
  g.beginPath(); poly(g, ring); g.clip();
  const h = bb[3] - bb[1];
  // 近岸略浅：2px 棋盘抖动，避免出现横向色带
  g.fillStyle = 'rgba(96,175,200,.30)';
  for (let y = bb[1]; y < bb[1] + h * 0.35; y += 2) {
    for (let x = bb[0]; x < bb[2]; x += 2) {
      if (((Math.round(x) + Math.round(y)) & 2) === 0) g.fillRect(x, y, 1, 1);
    }
  }
  // 深处略暗
  g.fillStyle = 'rgba(24,72,96,.22)';
  for (let y = bb[1] + h * 0.7; y < bb[3]; y += 2) {
    for (let x = bb[0]; x < bb[2]; x += 2) {
      if (((Math.round(x) + Math.round(y)) & 2) === 2) g.fillRect(x, y, 1, 1);
    }
  }
  // 波纹
  const rng = mulberry32((Math.round(bb[0]) * 31 + Math.round(bb[1]) * 17) | 0);
  const n = Math.min(70, Math.max(6, Math.round((bb[2] - bb[0]) * (bb[3] - bb[1]) / 110)));
  for (let i = 0; i < n; i++) {
    const x = bb[0] + rng() * (bb[2] - bb[0]);
    const y = bb[1] + rng() * (bb[3] - bb[1]);
    if (rng() < 0.6) {
      g.fillStyle = 'rgba(178,220,236,.5)';
      g.fillRect(x, y, 1.4, 0.25);
    } else {
      g.fillStyle = 'rgba(26,70,92,.4)';
      g.fillRect(x, y, 1.8, 0.25);
    }
  }
  g.restore();
  // 岸边石块与芦苇（沿多边形顶点，比沿包围盒更自然）
  const step = Math.max(1, Math.floor(ring.length / 2 / 40));
  for (let i = 0; i < ring.length; i += 2 * step) {
    const x = ring[i], y = ring[i + 1];
    const r = ((i * 7919) % 100) / 100;
    if (r < 0.45) {
      g.fillStyle = P.shore;
      g.fillRect(x - 0.5, y - 0.5, 1.2, 1.2);
    } else if (r < 0.62) {
      g.fillStyle = P.reed;
      g.fillRect(x, y - 1.4, 0.6, 1.6);
    }
  }
}

function drawRoad(g, r) {
  const w = r.w;
  const st = r.kind;
  let core = P.asphalt, edge = P.asphaltDark;
  if (st === 'footway') { core = P.path; edge = P.pathEdge; }
  else if (st === 'path') { core = '#c2b494'; edge = '#a2967a'; }
  else if (st === 'pedestrian') { core = '#c6b99c'; edge = '#a89a7e'; }
  else if (st === 'steps') { core = '#bdb9ab'; edge = '#9d998c'; }
  else if (st === 'cycleway') { core = '#a87f6a'; edge = '#8a6450'; }

  g.lineCap = 'butt';
  g.lineJoin = 'round';
  // 路缘
  g.beginPath(); traceLine(g, r.pts);
  g.strokeStyle = edge; g.lineWidth = w + 1.1; g.stroke();
  // 路面
  g.beginPath(); traceLine(g, r.pts);
  g.strokeStyle = core; g.lineWidth = w; g.stroke();

  if (st === 'steps') {
    g.strokeStyle = 'rgba(90,88,80,.45)'; g.lineWidth = w * 0.9;
    g.setLineDash([0.7, 0.7]);
    g.beginPath(); traceLine(g, r.pts); g.stroke();
    g.setLineDash([]);
  } else if ((st === 'service' || st === 'residential') && w >= 4.4) {
    g.strokeStyle = 'rgba(240,238,225,.75)';
    g.lineWidth = 0.28;
    g.setLineDash([2.4, 3]);
    g.beginPath(); traceLine(g, r.pts); g.stroke();
    g.setLineDash([]);
  } else if (st === 'footway' || st === 'pedestrian') {
    // 步道石砖
    g.strokeStyle = 'rgba(150,138,112,.3)';
    g.lineWidth = 0.2;
    g.setLineDash([0.9, 0.9]);
    g.beginPath(); traceLine(g, r.pts); g.stroke();
    g.setLineDash([]);
  }
}

function traceLine(g, pts) {
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
}

// ---------------- 建筑 ----------------
const CAT_STYLE = {
  '教学': { wall: P.wallLight, wallShade: '#b9ae95', roof: P.roofGrey, roofDark: P.roofGreyDark, pitched: true },
  '生活': { wall: '#d3a68e', wallShade: '#b98a72', roof: P.roofDorm, roofDark: P.roofDormDark, pitched: true },
  '食堂': { wall: '#e0c9a4', wallShade: '#c4ab86', roof: '#b98f5e', roofDark: '#96703f', pitched: false },
  '园林': { wall: P.timber, wallShade: P.timberDark, roof: P.roofGreen, roofDark: P.roofGreenDark, pitched: true },
  '体育': { wall: '#cfd3d6', wallShade: '#aeb4b9', roof: P.roofTile, roofDark: P.roofTileDark, pitched: false },
  '校园服务': { wall: '#cfc7b6', wallShade: '#ada596', roof: P.roofGrey, roofDark: P.roofGreyDark, pitched: false },
  '校门': { wall: P.red, wallShade: P.redDark, roof: P.roofTileDark, roofDark: '#454f57', pitched: true },
};
const DEFAULT_STYLE = { wall: P.wallMid, wallShade: P.wallDark, roof: P.roofGrey, roofDark: P.roofGreyDark, pitched: false };

export function buildingStyle(b) {
  const s = CAT_STYLE[b.cat] || DEFAULT_STYLE;
  const pitched = s.pitched && /hip|gable|xieshan|wudian|coiled|barrel|pier|hard/i.test(b.roof);
  return { ...s, pitched, heritage: b.heritage };
}

export function prepareBuilding(b) {
  if (b._path) return b;
  const path = new Path2D();
  for (const p of b.polys) for (const ring of p) { poly(path, ring); }
  b._path = path;
  b._style = buildingStyle(b);
  // 视觉高度（低分辨率像素）
  b._hpx = clamp(Math.round(Math.sqrt(Math.max(3, b.h)) * 2.7), 5, 19);
  return b;
}

export function drawBuilding(ctx, b, cam, hour) {
  prepareBuilding(b);
  const S = cam.scale;
  const ox = cam.w / 2 - cam.x * S;
  const oy = cam.h / 2 - cam.y * S;
  const at = (dx, dy) => { ctx.translate(ox + dx, oy + dy); ctx.scale(S, S); };
  const hpx = b._hpx;
  const st = b._style;
  const bb = b.bbox;
  // 每栋楼轻微色差，避免整排一模一样
  const tint = ((b.id | 0) % 7) / 7 - 0.5;
  const roof = mixHex(st.roof, tint > 0 ? '#ffffff' : '#000000', Math.abs(tint) * 0.08);
  const roofDark = mixHex(st.roofDark, '#000000', 0.05);

  // 地面投影（向右下，硬边，带一层浅晕）
  ctx.save();
  at(hpx * 0.20 + 2, hpx * 0.45 + 3);
  ctx.fillStyle = 'rgba(34,44,30,.20)';
  ctx.fill(b._path);
  ctx.restore();
  ctx.save();
  at(hpx * 0.10 + 1, hpx * 0.22 + 1.5);
  ctx.fillStyle = 'rgba(34,44,30,.16)';
  ctx.fill(b._path);
  ctx.restore();

  // 东侧立面
  ctx.save();
  at(1.6, hpx);
  ctx.fillStyle = 'rgba(26,30,24,.34)';
  ctx.fill(b._path);
  ctx.restore();

  // 南立面
  ctx.save();
  at(0, hpx);
  ctx.fillStyle = st.wallShade;
  ctx.fill(b._path);
  ctx.save();
  ctx.clip(b._path);
  const wallTop = bb[3] - hpx;
  // 檐下阴影
  ctx.fillStyle = 'rgba(28,32,26,.30)';
  ctx.fillRect(bb[0], wallTop, bb[2] - bb[0], Math.min(2.0, hpx * 0.42));
  // 窗（横向窗带 + 竖向窗间墙）
  const rng = mulberry32((b.id | 0) * 37 + 11);
  const rows = hpx >= 16 ? 2 : 1;
  const winH = Math.max(1.6, Math.min(2.8, hpx * 0.32));
  const night = nightStrength(hour) > 0.15;
  for (let r = 0; r < rows; r++) {
    const y = bb[3] - 1.2 - (r + 1) * (hpx / (rows + 0.6)) + 0.8;
    for (let x = bb[0] + 1.1; x < bb[2] - 1.1; x += 2.4) {
      const q = rng();
      if (q < 0.16) continue;
      const lit = night && q > 0.55;
      ctx.fillStyle = lit ? '#f7dd9c' : 'rgba(48,62,70,.62)';
      ctx.fillRect(x, y, 1.4, winH);
      ctx.fillStyle = lit ? 'rgba(255,240,190,.5)' : 'rgba(232,226,208,.55)';
      ctx.fillRect(x, y + winH, 1.2, 0.35);
    }
  }
  // 竖向壁柱
  ctx.fillStyle = 'rgba(48,50,42,.14)';
  for (let x = bb[0] + 3.4; x < bb[2] - 2; x += 4.2) {
    ctx.fillRect(x, wallTop + 0.6, 0.5, hpx - 1.2);
  }
  // 勒脚
  ctx.fillStyle = 'rgba(30,32,26,.28)';
  ctx.fillRect(bb[0], bb[3] - 0.7, bb[2] - bb[0], 0.7);
  ctx.restore();
  ctx.restore();

  // 屋顶
  ctx.save();
  at(0, 0);
  ctx.fillStyle = roof;
  ctx.fill(b._path, 'evenodd');
  ctx.save();
  ctx.clip(b._path, 'evenodd');

  if (st.pitched) {
    // 棋盘纹理（大块平屋顶的像素质感）
    ctx.fillStyle = 'rgba(24,30,28,.05)';
    for (let y = bb[1]; y < bb[3]; y += 2) {
      for (let x = bb[0]; x < bb[2]; x += 2) {
        if (((Math.round(x) + Math.round(y)) & 2) === 0) ctx.fillRect(x, y, 1, 1);
      }
    }
    // 檐口环（在屋顶内压一圈深色，形成"坡面 + 檐"的关系）
    ctx.strokeStyle = roofDark;
    ctx.lineWidth = 2.2;
    ctx.stroke(b._path);
    // 正脊
    const horiz = (bb[2] - bb[0]) >= (bb[3] - bb[1]);
    ctx.fillStyle = 'rgba(24,28,26,.42)';
    if (horiz) ctx.fillRect(bb[0], (bb[1] + bb[3]) / 2 - 0.5, bb[2] - bb[0], 1.0);
    else ctx.fillRect((bb[0] + bb[2]) / 2 - 0.5, bb[1], 1.0, bb[3] - bb[1]);
    // 受光坡面：脊线以北（或以西）略亮
    ctx.fillStyle = 'rgba(255,250,235,.06)';
    if (horiz) ctx.fillRect(bb[0], bb[1], bb[2] - bb[0], (bb[3] - bb[1]) / 2);
    else ctx.fillRect(bb[0], bb[1], (bb[2] - bb[0]) / 2, bb[3] - bb[1]);
    // 烟囱 / 通风口
    const rng = mulberry32((b.id | 0) * 17 + 3);
    const n = Math.min(3, Math.max(0, Math.round(b.area / 1100)));
    for (let i = 0; i < n; i++) {
      const ux = bb[0] + 3 + rng() * Math.max(1, bb[2] - bb[0] - 6);
      const uy = bb[1] + 3 + rng() * Math.max(1, bb[3] - bb[1] - 6);
      ctx.fillStyle = 'rgba(38,42,38,.4)';
      ctx.fillRect(ux + 0.4, uy + 0.4, 1.6, 1.4);
      ctx.fillStyle = 'rgba(214,209,196,.6)';
      ctx.fillRect(ux, uy, 1.6, 0.7);
    }
  } else {
    // 平屋顶：女儿墙 + 设备
    ctx.strokeStyle = roofDark;
    ctx.lineWidth = 1.6;
    ctx.stroke(b._path);
    const rng = mulberry32((b.id | 0) * 131 + 7);
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    const n = Math.min(7, Math.max(1, Math.round(w * h / 420)));
    for (let i = 0; i < n; i++) {
      const uw = 1.2 + rng() * 2.6, uh = 1 + rng() * 2.2;
      const ux = bb[0] + 1.4 + rng() * Math.max(1, w - uw - 2.8);
      const uy = bb[1] + 1.4 + rng() * Math.max(1, h - uh - 2.8);
      ctx.fillStyle = 'rgba(40,44,40,.35)';
      ctx.fillRect(ux + 0.3, uy + 0.3, uw, uh);
      ctx.fillStyle = 'rgba(226,222,208,.55)';
      ctx.fillRect(ux, uy, uw, uh * 0.5);
    }
    if (w > 14 && h > 10) {
      ctx.fillStyle = 'rgba(150,196,214,.45)';
      ctx.fillRect(bb[0] + w * 0.3, bb[1] + h * 0.22, Math.min(6, w * 0.2), Math.min(2.4, h * 0.08));
    }
  }
  ctx.restore();
  // 外轮廓
  ctx.strokeStyle = P.outline;
  ctx.lineWidth = 0.5;
  ctx.stroke(b._path);
  ctx.restore();
}
// ---------------- 地标专属造型 ----------------
/**
 * 俯视像素地标：用屋顶平面 + 檐口 + 阴影表达体量（与整体画风一致）。
 * 参考实景：博雅塔八角密檐、西门三开间歇山、图书馆大体量、百讲石材柱廊。
 */
export function drawLandmark(ctx, b, cam, hour, kind) {
  const S = cam.scale;
  const bb = b.bbox;
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  const X = (m) => Math.round(cam.sx(bb[0] + m));
  const Y = (m) => Math.round(cam.sy(bb[1] + m));
  const PW = (m) => Math.max(1, Math.round(m * S));
  const night = nightStrength(hour) > 0.15;
  const rect = (x, y, wm, hm, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(X(x), Y(y), PW(wm), PW(hm));
  };
  const outline = (x, y, wm, hm) => {
    ctx.strokeStyle = P.outline;
    ctx.lineWidth = 1;
    ctx.strokeRect(X(x) + 0.5, Y(y) + 0.5, PW(wm) - 1, PW(hm) - 1);
  };

  if (kind === 'boya') {
    const cx = bb[0] + w / 2, cy = bb[1] + h / 2;
    const sxp = Math.round(cam.sx(cx)), syp = Math.round(cam.sy(cy));
    const r0 = Math.max(3, Math.round(5.2 * S));
    // 影子
    ctx.fillStyle = 'rgba(36,46,32,.24)';
    for (let dy = -2; dy <= 2; dy++) {
      const ww = Math.round(r0 * Math.cos(dy / 3.2));
      ctx.fillRect(sxp - ww + 3, syp + dy * 1.5 + 3, ww * 2, 1);
    }
    // 三层塔身（自下而上收缩，制造高度感）
    pixelDisc(ctx, sxp, syp, r0, '#8d8674');
    pixelDisc(ctx, sxp - 0, syp - 3, r0 * 0.82, '#b0a184');
    pixelDisc(ctx, sxp - 0, syp - 6, r0 * 0.62, '#c3b393');
    pixelDisc(ctx, sxp - 0, syp - 8, r0 * 0.40, '#8f8a7a');
    // 塔刹
    ctx.fillStyle = '#6b6558';
    ctx.fillRect(sxp - 1, syp - 8 - r0 * 0.4 - 3, 2, 3);
    ctx.fillStyle = P.gold;
    ctx.fillRect(sxp - 1, syp - 8 - r0 * 0.4 - 5, 2, 2);
    cam.label('博雅塔', cx, bb[1] - 1.2, 10.5, '#ffeccc', 0.95);
  } else if (kind === 'westgate') {
    // 10×18m 校门：长脊沿南北，西面向路；灰瓦顶 + 朱红墙 + 三开间门洞 + 石狮
    ctx.fillStyle = 'rgba(36,46,32,.22)';
    ctx.fillRect(X(0) + 3, Y(h) - 1, PW(w), 3);
    // 台基
    rect(0, 0, w, h, '#a9a294');
    // 屋面：四坡，正脊沿长轴
    rect(0.7, 0.7, w - 1.4, h - 1.4, '#4f5a63');
    rect(1.5, 1.5, w - 3, h - 3, '#5b666f');
    rect(w / 2 - 0.3, 1.5, 0.6, h - 3, '#39434b');
    // 南北两端的红墙（俯视时只在山墙处露出）
    rect(0.7, 0.7, w - 1.4, 1.2, P.red);
    rect(0.7, h - 1.9, w - 1.4, 1.2, P.red);
    // 西侧门洞（三个小缺口）
    for (let i = 0; i < 3; i++) {
      const yy = 3.4 + i * ((h - 6.8) / 3);
      rect(0.7, yy, 1.2, (h - 6.8) / 3 - 1.4, '#4b2e24');
    }
    // 石狮
    rect(-2.2, 1.6, 1.6, 1.6, '#b9b3a3');
    rect(-2.2, h - 3.2, 1.6, 1.6, '#b9b3a3');
    outline(0.7, 0.7, w - 1.4, h - 1.4);
    cam.label('北京大学西门', bb[0] + w / 2, bb[1] - 1.4, 10.5, '#ffeccc', 0.95);
  } else if (kind === 'library') {
    ctx.fillStyle = 'rgba(36,46,32,.20)';
    ctx.fillRect(X(0) + 4, Y(h) - 1, PW(w), 4);
    // 主体屋面
    rect(0, 0, w, h, '#8e959c');
    rect(0.5, 0.5, w - 1, h - 1, '#9aa1a8');
    // 退台（中央抬高体量）
    rect(w * 0.18, h * 0.16, w * 0.64, h * 0.44, '#a7aeb4');
    rect(w * 0.24, h * 0.22, w * 0.52, h * 0.32, '#b3b9be');
    // 玻璃天窗
    rect(w * 0.3, h * 0.3, w * 0.4, h * 0.1, night ? '#7d9fb0' : '#8fbccd');
    rect(w * 0.3, h * 0.3, w * 0.4, h * 0.02, '#cfe6ef');
    // 屋面分缝
    ctx.fillStyle = 'rgba(60,66,66,.18)';
    for (let x = 6; x < w; x += 8) ctx.fillRect(X(x), Y(0.6), 1, PW(h - 1.2));
    // 南侧入口雨篷
    rect(w * 0.4, h * 0.62, w * 0.2, h * 0.34, '#b9c3c8');
    rect(w * 0.4, h * 0.62, w * 0.2, h * 0.05, '#e4eef2');
    outline(0.5, 0.5, w - 1, h - 1);
    cam.label('北京大学图书馆', bb[0] + w / 2, bb[1] - 1.2, 10.5, '#ffeccc', 0.95);
  } else if (kind === 'podium') {
    ctx.fillStyle = 'rgba(36,46,32,.20)';
    ctx.fillRect(X(0) + 4, Y(h) - 1, PW(w), 4);
    // 石材屋面
    rect(0, 0, w, h, '#c6b998');
    rect(0.6, 0.6, w - 1.2, h - 1.2, '#d2c5a4');
    // 中央高体块
    rect(w * 0.28, h * 0.06, w * 0.44, h * 0.46, '#cabd9c');
    rect(w * 0.34, h * 0.12, w * 0.32, h * 0.32, '#ddd1b2');
    // 中央竖窗
    ctx.fillStyle = '#6d685a';
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(X(w * 0.4 + i * w * 0.05), Y(h * 0.16), Math.max(1, PW(1.2)), PW(h * 0.22));
    }
    // 两侧坡屋顶
    rect(0.6, h * 0.06, w * 0.24, h * 0.3, '#5f6a72');
    rect(w * 0.756, h * 0.06, w * 0.24, h * 0.3, '#5f6a72');
    rect(0.6, h * 0.16, w * 0.24, 0.4, '#77828a');
    rect(w * 0.756, h * 0.16, w * 0.24, 0.4, '#77828a');
    // 南侧柱廊（一排短柱的投影）
    ctx.fillStyle = 'rgba(58,56,46,.35)';
    for (let i = 0; i < 16; i++) {
      ctx.fillRect(X(w * 0.05 + i * w * 0.06), Y(h * 0.72), Math.max(1, PW(1)), PW(h * 0.16));
    }
    // 台阶
    rect(w * 0.36, h * 0.9, w * 0.28, h * 0.07, '#c3b795');
    outline(0.6, 0.6, w - 1.2, h - 1.2);
    cam.label('百周年纪念讲堂', bb[0] + w / 2, bb[1] - 1.2, 10.5, '#ffeccc', 0.95);
  }
}

// ---------------- 树木（像素圆盘拼出树冠） ----------------
const FOLIAGE = [
  ['#3f7a34', '#4f9440', '#2f5f28'],
  ['#4a8434', '#5aa544', '#3a6a28'],
  ['#6a8f34', '#83a844', '#4f6f24'],
  ['#a5762c', '#c4913c', '#7d5a20'],
  ['#9c5f2a', '#bd7c3c', '#73421f'],
];

/** 用整行矩形画出一个像素圆 */
function pixelDisc(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  const ri = Math.max(1, Math.round(r));
  const c = Math.round(cx), y0 = Math.round(cy);
  for (let dy = -ri; dy <= ri; dy++) {
    const w = Math.round(Math.sqrt(Math.max(0, ri * ri - dy * dy)));
    if (w <= 0) continue;
    ctx.fillRect(c - w, y0 + dy, w * 2, 1);
  }
}

export function drawTree(ctx, t, cam) {
  const x = Math.round(cam.sx(t.x));
  const y = Math.round(cam.sy(t.y));
  const s = t.s * cam.zoom;
  const tone = FOLIAGE[t.tone % FOLIAGE.length];

  // 硬边投影
  ctx.fillStyle = 'rgba(36,46,30,.20)';
  const rs = Math.max(2, Math.round(5 * s));
  for (let dy = -1; dy <= 1; dy++) {
    const w = Math.round(rs * Math.cos(dy / 3));
    ctx.fillRect(x + 2 + -w, y + 1 + dy * 1.4, w * 2, 1);
  }
  // 树干
  ctx.fillStyle = '#5d4130';
  ctx.fillRect(x - 1, y - Math.round(3 * s), 2, Math.max(2, Math.round(4 * s)));

  if (t.kind === 'pine') {
    for (let i = 0; i < 3; i++) {
      const w = Math.round((4.6 - i * 1.2) * s);
      const yy = Math.round(y - (3 + i * 3.2) * s);
      ctx.fillStyle = i === 0 ? tone[2] : i === 1 ? tone[0] : tone[1];
      ctx.fillRect(x - w, yy, w * 2, Math.max(1, Math.round(2.6 * s)));
      ctx.fillRect(x - Math.round(w * 0.6), yy - 1, Math.round(w * 1.2), 1);
    }
    ctx.fillStyle = tone[2];
    ctx.fillRect(x - 1, Math.round(y - 13 * s), 2, Math.max(1, Math.round(1.6 * s)));
  } else if (t.kind === 'willow') {
    const r = Math.round(5.4 * s);
    pixelDisc(ctx, x, y - 6 * s, r, tone[0]);
    pixelDisc(ctx, x - r * 0.25, y - 7 * s, r * 0.7, tone[1]);
    ctx.fillStyle = tone[1];
    for (let i = -3; i <= 3; i++) {
      const dx = Math.round(i * 1.6 * s);
      ctx.fillRect(x + dx, Math.round(y - 4 * s), 1, Math.round(3.4 * s));
      ctx.fillRect(x + dx + (i > 0 ? 1 : -1), Math.round(y - 1.4 * s), 1, Math.round(1.4 * s));
    }
  } else {
    const r = (t.kind === 'round' ? 7.4 : 8.6) * s;
    // 主冠
    pixelDisc(ctx, x, y - 6.4 * s, r, tone[2]);
    pixelDisc(ctx, x - r * 0.18, y - 7.4 * s, r * 0.84, tone[0]);
    // 侧冠，打散"棒棒糖"轮廓
    pixelDisc(ctx, x + r * 0.62, y - 5.0 * s, r * 0.52, tone[2]);
    pixelDisc(ctx, x - r * 0.66, y - 4.6 * s, r * 0.46, tone[0]);
    // 顶部亮面
    pixelDisc(ctx, x - r * 0.3, y - 9.2 * s, r * 0.44, tone[1]);
    ctx.fillStyle = 'rgba(244,248,206,.34)';
    ctx.fillRect(Math.round(x - r * 0.55), Math.round(y - 10 * s), Math.max(1, Math.round(r * 0.36)), 1);
    // 边缘暗线
    ctx.fillStyle = 'rgba(28,40,24,.18)';
    ctx.fillRect(Math.round(x - r), Math.round(y - 3.2 * s), Math.round(r * 2), 1);
  }
}

// ---------------- 水面动效 ----------------
export function drawWaterAnim(ctx, world, cam, time) {
  const [vx0, vy0, vx1, vy1] = cam.viewRect(0);
  ctx.save();
  for (const w of world.water) {
    if (!hit(w.bbox, vx0, vy0, vx1, vy1)) continue;
    for (const ring of w.rings) {
      const bb = polyBBox(ring);
      const rng = mulberry32(777 + Math.floor(time / 420));
      for (let i = 0; i < 10; i++) {
        const px = bb[0] + rng() * (bb[2] - bb[0]);
        const py = bb[1] + rng() * (bb[3] - bb[1]);
        const sx = Math.round(cam.sx(px)), sy = Math.round(cam.sy(py));
        ctx.fillStyle = 'rgba(214,240,248,.75)';
        ctx.fillRect(sx, sy, Math.max(1, Math.round(1.6 * cam.zoom)), 1);
      }
    }
  }
  ctx.restore();
}

// ---------------- 夜晚 ----------------
export function nightStrength(hour) {
  if (hour >= 19 || hour < 5.5) return 1;
  if (hour >= 17.5) return (hour - 17.5) / 1.5;
  if (hour < 6.5) return Math.max(0, 1 - (hour - 5.5));
  return 0;
}

export function drawNightLights(ctx, world, cam, hour) {
  const k = nightStrength(hour);
  if (k <= 0.02) return;
  const [vx0, vy0, vx1, vy1] = cam.viewRect(3);
  for (const lamp of world.lamps) {
    if (lamp.x < vx0 || lamp.x > vx1 || lamp.y < vy0 || lamp.y > vy1) continue;
    const x = Math.round(cam.sx(lamp.x)), y = Math.round(cam.sy(lamp.y));
    ctx.fillStyle = `rgba(255,196,120,${0.16 * k})`;
    ctx.fillRect(x - 12, y - 12, 24, 24);
    ctx.fillStyle = `rgba(255,214,150,${0.20 * k})`;
    ctx.fillRect(x - 7, y - 7, 14, 14);
    ctx.fillStyle = `rgba(255,240,200,${0.95 * k})`;
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
}

export function dayTint(hour) {
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
