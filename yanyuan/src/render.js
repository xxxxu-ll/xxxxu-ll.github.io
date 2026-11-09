// 像素渲染：低分辨率缓冲 + 整数倍放大（真正的像素网格，不是矢量贴图）
// 世界按 RENDER_PPM 像素/米 绘制到离屏画布，再由 game.js 整数倍放大到屏幕。
import { clamp, shade, mixHex, rgba, mulberry32, polyBBox } from './util.js?v=202611090602';

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
    // 建筑周边铺装（立面地标不铺，避免地面留空框）
    this.aprons = world.buildings
      .filter(b => b.area > 60 && !b.hero)
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

    // 草地大块色差（远看有层次，近看仍是像素颗粒）
    const grng = mulberry32((cx * 7919) ^ (cy * 104729));
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? 'rgba(214,236,160,.06)' : 'rgba(46,82,26,.06)';
      g.beginPath();
      g.ellipse(w0 + grng() * this.chunkM, h0 + grng() * this.chunkM,
        7 + grng() * 15, 5 + grng() * 11, grng() * 3.14, 0, Math.PI * 2);
      g.fill();
    }

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

    // 建筑周边铺装：窄一圈，颜色压暗，避免变成画框
    for (const a of this.aprons) {
      if (!hit(a.bbox, x0 - 4, y0 - 4, x1 + 4, y1 + 4)) continue;
      g.beginPath();
      for (const p of a.polys) for (const ring of p) poly(g, ring);
      g.strokeStyle = 'rgba(150,140,118,.55)';
      g.lineWidth = 1.6;
      g.stroke();
      g.strokeStyle = 'rgba(120,112,94,.28)';
      g.lineWidth = 0.9;
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
  b._hpx = clamp(Math.round(Math.sqrt(Math.max(3, b.h)) * 4.4), 8, 30);
  return b;
}

// 各类建筑用 3 组屋顶色，同类别也有变化
const ROOF_VARIANTS = {
  '教学': [['#8d8779', '#635c50'], ['#958f80', '#6a6456'], ['#867f71', '#5b544a']],
  '生活': [['#9c6151', '#74483a'], ['#a56a58', '#7c5040'], ['#925847', '#6b4235']],
  '食堂': [['#b28b5b', '#8a6938'], ['#bb9666', '#93713f'], ['#a98252', '#806031']],
  '园林': [['#5f7266', '#46564b'], ['#68796c', '#4b5b50'], ['#566a5e', '#3f4f45']],
  '体育': [['#7c848c', '#5a626a'], ['#848c94', '#606870'], ['#747c84', '#535b63']],
  '校园服务': [['#8d8779', '#635c50'], ['#958f80', '#6a6456'], ['#867f71', '#5b544a']],
  '校门': [['#4f5a63', '#39434b'], ['#4f5a63', '#39434b'], ['#4f5a63', '#39434b']],
};

export function drawBuilding(ctx, b, cam, hour) {
  prepareBuilding(b);
  const S = cam.scale;
  const ox = cam.w / 2 - cam.x * S;
  const oy = cam.h / 2 - cam.y * S;
  const at = (dx, dy) => { ctx.translate(ox + dx, oy + dy); ctx.scale(S, S); };
  const hpx = b._hpx;
  const st = b._style;
  const bb = b.bbox;
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  const seed = (b.id | 0) || 1;
  const variants = ROOF_VARIANTS[b.cat] || ROOF_VARIANTS['教学'];
  const [roof, roofDark] = variants[seed % variants.length];
  const night = nightStrength(hour) > 0.15;
  const rng = mulberry32(seed * 131 + 7);

  // 地面投影（两层，近实远虚）
  ctx.save();
  at(hpx * 0.22 + 2, hpx * 0.5 + 3);
  ctx.fillStyle = 'rgba(34,44,30,.18)';
  ctx.fill(b._path);
  ctx.restore();
  ctx.save();
  at(hpx * 0.1 + 1, hpx * 0.24 + 1.5);
  ctx.fillStyle = 'rgba(34,44,30,.20)';
  ctx.fill(b._path);
  ctx.restore();

  // 东侧立面
  ctx.save();
  at(1.8, hpx);
  ctx.fillStyle = 'rgba(24,28,22,.36)';
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
  ctx.fillStyle = 'rgba(26,30,24,.34)';
  ctx.fillRect(bb[0], wallTop, w, Math.min(2.2, hpx * 0.45));
  // 立面竖向渐变（上暗下亮），用几条横带近似
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `rgba(255,250,235,${0.05 - i * 0.015})`;
    ctx.fillRect(bb[0], wallTop + hpx * (0.45 + i * 0.18), w, hpx * 0.16);
  }
  // 窗
  const rows = hpx >= 16 ? 2 : 1;
  const winH = Math.max(1.6, Math.min(2.8, hpx * 0.32));
  for (let r = 0; r < rows; r++) {
    const y = bb[3] - 1.2 - (r + 1) * (hpx / (rows + 0.6)) + 0.9;
    for (let x = bb[0] + 1.1; x < bb[2] - 1.1; x += 2.4) {
      const q = rng();
      if (q < 0.14) continue;
      const lit = night && q > 0.55;
      ctx.fillStyle = lit ? '#f7dd9c' : 'rgba(46,60,68,.6)';
      ctx.fillRect(x, y, 1.4, winH);
      ctx.fillStyle = lit ? 'rgba(255,236,180,.55)' : 'rgba(226,220,202,.6)';
      ctx.fillRect(x - 0.1, y + winH, 1.6, 0.35);
    }
  }
  // 主入口雨篷（较大的楼给一个）
  if (b.area > 300 && w > 10) {
    const ew = Math.min(7, w * 0.26);
    const ex = bb[0] + (w - ew) / 2;
    ctx.fillStyle = 'rgba(30,32,26,.35)';
    ctx.fillRect(ex + 0.4, bb[3] - 0.4, ew, 1.0);
    ctx.fillStyle = '#dfd7c2';
    ctx.fillRect(ex, bb[3] - 1.4, ew, 1.0);
    ctx.fillStyle = 'rgba(70,80,86,.5)';
    ctx.fillRect(ex + ew * 0.4, bb[3] - 1.2, ew * 0.2, hpx * 0.5);
  }
  // 勒脚
  ctx.fillStyle = 'rgba(28,30,24,.32)';
  ctx.fillRect(bb[0], bb[3] - 0.8, w, 0.8);
  ctx.restore();
  ctx.restore();

  // 屋顶
  ctx.save();
  at(0, 0);
  ctx.fillStyle = roof;
  ctx.fill(b._path, 'evenodd');
  ctx.save();
  ctx.clip(b._path, 'evenodd');

  // 檐口环（内压一圈深色）
  ctx.strokeStyle = roofDark;
  ctx.lineWidth = st.pitched ? 2.4 : 1.8;
  ctx.stroke(b._path);

  if (st.pitched) {
    const horiz = w >= h;
    // 瓦垄：平行于正脊的细线，读起来像传统坡瓦
    ctx.fillStyle = 'rgba(28,30,26,.10)';
    if (horiz) {
      for (let y = bb[1] + 1.2; y < bb[3]; y += 1.8) ctx.fillRect(bb[0], y, w, 0.32);
    } else {
      for (let x = bb[0] + 1.2; x < bb[2]; x += 1.8) ctx.fillRect(x, bb[1], 0.32, h);
    }
    // 坡度分级：靠近屋脊更亮，靠近檐口更暗（三段硬边色阶）
    const midY = (bb[1] + bb[3]) / 2, midX = (bb[0] + bb[2]) / 2;
    if (horiz) {
      const q = h / 4;
      ctx.fillStyle = 'rgba(255,250,235,.06)';
      ctx.fillRect(bb[0], midY - q, w, q);
      ctx.fillStyle = 'rgba(22,26,24,.10)';
      ctx.fillRect(bb[0], midY, w, q);
      ctx.fillStyle = 'rgba(22,26,24,.20)';
      ctx.fillRect(bb[0], midY + q, w, h - (midY - bb[1]) - q);
    } else {
      const q = w / 4;
      ctx.fillStyle = 'rgba(255,250,235,.06)';
      ctx.fillRect(midX - q, bb[1], q, h);
      ctx.fillStyle = 'rgba(22,26,24,.10)';
      ctx.fillRect(midX, bb[1], q, h);
      ctx.fillStyle = 'rgba(22,26,24,.20)';
      ctx.fillRect(midX + q, bb[1], w - (midX - bb[0]) - q, h);
    }
    // 正脊 + 脊上高光
    if (horiz) {
      ctx.fillStyle = 'rgba(20,24,22,.55)';
      ctx.fillRect(bb[0], (bb[1] + bb[3]) / 2 - 0.9, w, 1.8);
      ctx.fillStyle = 'rgba(255,250,235,.22)';
      ctx.fillRect(bb[0], (bb[1] + bb[3]) / 2 - 0.9, w, 0.5);
    } else {
      ctx.fillStyle = 'rgba(20,24,22,.55)';
      ctx.fillRect((bb[0] + bb[2]) / 2 - 0.9, bb[1], 1.8, h);
      ctx.fillStyle = 'rgba(255,250,235,.22)';
      ctx.fillRect((bb[0] + bb[2]) / 2 - 0.9, bb[1], 0.5, h);
    }

  } else {
    // 平屋顶：女儿墙 + 天窗 + 设备
    ctx.strokeStyle = 'rgba(255,250,235,.10)';
    ctx.lineWidth = 0.8;
    ctx.stroke(b._path);
    if (w > 12 && h > 8) {
      ctx.fillStyle = 'rgba(150,196,214,.42)';
      ctx.fillRect(bb[0] + w * 0.28, bb[1] + h * 0.2, Math.min(9, w * 0.3), Math.min(2.8, h * 0.1));
      ctx.fillStyle = 'rgba(240,250,255,.35)';
      ctx.fillRect(bb[0] + w * 0.28, bb[1] + h * 0.2, Math.min(9, w * 0.3), 0.5);
    }
    const n = Math.min(6, Math.max(1, Math.round(w * h / 500)));
    for (let i = 0; i < n; i++) {
      const uw = 1.6 + rng() * 2.6, uh = 1.4 + rng() * 2.2;
      const ux = bb[0] + 1.6 + rng() * Math.max(1, w - uw - 3);
      const uy = bb[1] + 1.6 + rng() * Math.max(1, h - uh - 3);
      ctx.fillStyle = 'rgba(38,42,38,.4)';
      ctx.fillRect(ux + 0.4, uy + 0.4, uw, uh);
      ctx.fillStyle = 'rgba(222,218,204,.6)';
      ctx.fillRect(ux, uy, uw, uh * 0.55);
      ctx.fillStyle = 'rgba(255,250,235,.3)';
      ctx.fillRect(ux, uy, uw, 0.4);
    }
  }

  // 屋顶烟囱/通风口（坡顶也有）
  if (st.pitched) {
    const n2 = Math.min(3, Math.max(1, Math.round(b.area / 1100)));
    for (let i = 0; i < n2; i++) {
      const uw = 1.4, uh = 1.2;
      const ux = bb[0] + 2 + rng() * Math.max(1, w - 4);
      const uy = bb[1] + 2 + rng() * Math.max(1, h - 4);
      ctx.fillStyle = 'rgba(30,34,30,.35)';
      ctx.fillRect(ux + 0.4, uy + 0.4, uw, uh);
      ctx.fillStyle = 'rgba(226,222,208,.7)';
      ctx.fillRect(ux, uy, uw, uh);
      ctx.fillStyle = 'rgba(120,118,108,.6)';
      ctx.fillRect(ux + 0.3, uy + 0.3, uw - 0.6, uh - 0.6);
    }
  }
  ctx.restore();

  // 内院（有洞的楼：铺装 + 一圈阴影）
  for (const poly of b.polys) {
    for (let hi = 1; hi < poly.length; hi++) {
      const ring = poly[hi];
      ctx.beginPath();
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
      ctx.closePath();
      ctx.fillStyle = '#c3b9a2';
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,58,48,.28)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // 屋顶南缘的暗线：把屋面与立面分开
  ctx.save();
  ctx.clip(b._path, 'evenodd');
  ctx.fillStyle = 'rgba(24,28,24,.28)';
  ctx.fillRect(bb[0], bb[3] - 0.9, w, 0.9);
  ctx.restore();

  // 外轮廓
  ctx.strokeStyle = P.outline;
  ctx.lineWidth = 0.55;
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
    // 高塔用"立面"画：以占地南沿为基点向上立起（俯视画不出塔高）
    const cx = Math.round(cam.sx(bb[0] + w / 2));
    const baseY = Math.round(cam.sy(bb[3]));
    const S = cam.scale;
    const H = 27 * S;
    const baseW = Math.max(12, Math.round(10 * S));
    const tiers = 13;
    // 投影
    ctx.fillStyle = 'rgba(36,46,32,.26)';
    const sr = Math.round(baseW * 0.8);
    for (let dy = -3; dy <= 3; dy++) {
      const ww = Math.round(sr * Math.cos(dy / 4));
      ctx.fillRect(cx - ww + 7, baseY + dy * 1.5 + 2, ww * 2, 1);
    }
    // 须弥座
    const plinthH = Math.max(4, Math.round(2.6 * S));
    ctx.fillStyle = '#a9a293';
    ctx.fillRect(cx - Math.round(baseW * 0.66), baseY - plinthH, Math.round(baseW * 1.32), plinthH);
    ctx.fillStyle = 'rgba(255,250,235,.18)';
    ctx.fillRect(cx - Math.round(baseW * 0.66), baseY - plinthH, Math.round(baseW * 1.32), 1);
    ctx.fillStyle = 'rgba(40,40,34,.3)';
    ctx.fillRect(cx - Math.round(baseW * 0.66), baseY - 1, Math.round(baseW * 1.32), 1);

    // 13 层：塔身 + 出檐
    let y = baseY - plinthH;
    const tierH = Math.max(2, Math.round((H - plinthH) / tiers));
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const tw = Math.max(5, Math.round(baseW * (1 - t * 0.40)));
      const bodyH = Math.max(2, Math.round(tierH * 0.62));
      const eaveH = Math.max(1, tierH - bodyH);
      const eaveW = tw + Math.max(3, Math.round((3.4 - t * 1.6) * S));
      // 塔身（砖色，交替明暗）
      ctx.fillStyle = i % 2 ? '#c2ab8c' : '#b39b7c';
      ctx.fillRect(cx - Math.round(tw / 2), y - bodyH, tw, bodyH);
      // 侧向明暗
      const sideW = Math.max(2, Math.round(tw * 0.26));
      ctx.fillStyle = 'rgba(255,248,230,.18)';
      ctx.fillRect(cx - Math.round(tw / 2) + tw - sideW, y - bodyH, sideW, bodyH);
      ctx.fillStyle = 'rgba(38,36,30,.20)';
      ctx.fillRect(cx - Math.round(tw / 2), y - bodyH, Math.max(1, Math.round(tw * 0.18)), bodyH);
      // 出檐（深灰，两端外挑，下方一条阴影）
      ctx.fillStyle = '#5f5a4f';
      ctx.fillRect(cx - Math.round(eaveW / 2), y - bodyH - eaveH, eaveW, eaveH);
      ctx.fillStyle = 'rgba(255,250,235,.28)';
      ctx.fillRect(cx - Math.round(eaveW / 2), y - bodyH - eaveH, eaveW, 1);
      ctx.fillStyle = 'rgba(20,22,18,.28)';
      ctx.fillRect(cx - Math.round(eaveW / 2), y - bodyH, eaveW, 1);
      // 小窗
      if (tw > 7 && i % 2 === 0) {
        ctx.fillStyle = 'rgba(50,44,36,.55)';
        ctx.fillRect(cx - 1, y - bodyH + Math.max(1, Math.round(bodyH * 0.3)), 2, Math.max(1, Math.round(bodyH * 0.4)));
      }
      y -= tierH;
    }
    // 塔刹
    ctx.fillStyle = '#4e4a41';
    ctx.fillRect(cx - 1, y - Math.round(5 * S), 2, Math.round(5 * S));
    ctx.fillStyle = P.gold;
    ctx.fillRect(cx - 2, y - Math.round(6 * S), 4, 2);
    ctx.fillRect(cx - 2, y - Math.round(8 * S), 4, 2);
    ctx.fillRect(cx - 1, y - Math.round(10 * S), 2, Math.round(2 * S));
    cam.label('博雅塔', bb[0] + w / 2, bb[3] - 27 - 3, 10.5, '#ffeccc', 0.95);  } else if (kind === 'westgate') {
    // 西门画成立面：三开间朱红大门 + 灰瓦歇山顶 + 石狮
    const S = cam.scale;
    const cx = Math.round(cam.sx(bb[0] + w / 2));
    const baseY = Math.round(cam.sy(bb[3]));
    const GW = Math.max(34, Math.round(w * S * 1.8));   // 门面宽度
    const wallH = Math.max(10, Math.round(3.6 * S));
    const roofH = Math.max(8, Math.round(3.2 * S));
    const half = GW / 2;
    // 地面投影
    ctx.fillStyle = 'rgba(36,46,32,.24)';
    for (let dy = -2; dy <= 2; dy++) {
      const ww = Math.round(half * Math.cos(dy / 3.4));
      ctx.fillRect(cx - ww + 5, baseY + dy * 1.4 + 1, ww * 2, 1);
    }
    // 台基
    ctx.fillStyle = '#a9a293';
    ctx.fillRect(cx - half - 3, baseY - 3, GW + 6, 3);
    // 朱红墙体
    ctx.fillStyle = '#a84636';
    ctx.fillRect(cx - half, baseY - 3 - wallH, GW, wallH);
    // 三开间：明间通行（深色），两次间朱红门
    const bayW = Math.floor(GW / 3);
    const doorH = Math.round(wallH * 0.72);
    const doorY = baseY - 3 - doorH;
    ctx.fillStyle = '#5a3226';
    ctx.fillRect(cx - Math.floor(bayW / 2), doorY, bayW, doorH);
    ctx.fillStyle = '#8f3a2c';
    ctx.fillRect(cx - half + 2, doorY, bayW - 4, doorH);
    ctx.fillRect(cx + half - bayW + 2, doorY, bayW - 4, doorH);
    // 门钉
    ctx.fillStyle = P.gold;
    for (let r = 0; r < 2; r++) {
      for (let cI = 0; cI < 3; cI++) {
        ctx.fillRect(cx - half + 5 + cI * 4, doorY + 3 + r * 4, 1, 1);
        ctx.fillRect(cx + half - bayW + 5 + cI * 4, doorY + 3 + r * 4, 1, 1);
      }
    }
    // 彩画额枋
    const beamY = baseY - 3 - wallH;
    ctx.fillStyle = '#3f7a86';
    ctx.fillRect(cx - half, beamY - 3, GW, 3);
    ctx.fillStyle = '#2f5f6a';
    ctx.fillRect(cx - half, beamY - 1, GW, 1);
    // 匾额
    ctx.fillStyle = '#1f3f4a';
    ctx.fillRect(cx - 6, beamY - 3, 12, 3);
    ctx.fillStyle = P.gold;
    ctx.fillRect(cx - 4, beamY - 2, 8, 1);
    // 屋顶：梯形灰瓦 + 两端起翘
    ctx.fillStyle = '#4f5a63';
    ctx.beginPath();
    ctx.moveTo(cx - half - 6, beamY - 3);
    ctx.lineTo(cx - half + 5, beamY - 3 - roofH);
    ctx.lineTo(cx + half - 5, beamY - 3 - roofH);
    ctx.lineTo(cx + half + 6, beamY - 3);
    ctx.closePath();
    ctx.fill();
    // 瓦垄
    ctx.fillStyle = 'rgba(24,28,26,.28)';
    for (let x = cx - half - 2; x < cx + half + 2; x += 3) {
      ctx.fillRect(x, beamY - 3 - roofH + 2, 1, roofH - 2);
    }
    // 正脊 + 檐口高光
    ctx.fillStyle = '#39434b';
    ctx.fillRect(cx - half + 4, beamY - 4 - roofH, GW - 8, 2);
    ctx.fillStyle = 'rgba(255,250,235,.3)';
    ctx.fillRect(cx - half + 5, beamY - 3 - roofH, GW - 10, 1);
    // 两端起翘
    ctx.fillStyle = '#39434b';
    ctx.fillRect(cx - half - 7, beamY - 5 - roofH + 1, 3, 2);
    ctx.fillRect(cx + half + 4, beamY - 5 - roofH + 1, 3, 2);
    // 石狮
    ctx.fillStyle = '#b8b2a0';
    ctx.fillRect(cx - half - 8, baseY - 8, 6, 8);
    ctx.fillRect(cx + half + 2, baseY - 8, 6, 8);
    ctx.fillStyle = 'rgba(60,58,48,.3)';
    ctx.fillRect(cx - half - 8, baseY - 3, 6, 3);
    ctx.fillRect(cx + half + 2, baseY - 3, 6, 3);
    cam.label('北京大学西门', bb[0] + w / 2, bb[3] - 11, 10.5, '#ffeccc', 0.95);  } else if (kind === 'library') {
    drawBuilding(ctx, b, cam, hour);   // 先画墙体与檐口，保证有体积
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
    drawBuilding(ctx, b, cam, hour);
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
