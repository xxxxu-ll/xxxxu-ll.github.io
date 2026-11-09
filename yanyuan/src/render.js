// 像素渲染：低分辨率缓冲 + 整数倍放大（真正的像素网格，不是矢量贴图）
// 世界按 RENDER_PPM 像素/米 绘制到离屏画布，再由 game.js 整数倍放大到屏幕。
import { clamp, shade, mixHex, rgba, mulberry32, polyBBox, distToSeg } from './util.js?v=202611090903';
import { heritageType } from './heritage.js?v=202611090903';

export let RENDER_PPM = 4;             // 低分辨率缓冲每米像素数（图块模式切成 8）
export function setRenderPPM(v) { RENDER_PPM = v; }
export const UPSCALE = 2;             // 放大倍数（game.js 使用）

// ---------------- 调色板（低饱和、统一明度关系） ----------------
// 扁平色块风格：饱和、硬边、无渐变（参照像素校园地图）
const P = {
  grass: ['#57a03c', '#5aa53f', '#549c39', '#5fa842'],
  grassFlower: ['#eef0c0', '#f2dcd6'],
  lawn: '#4d9636',
  lawnDark: '#3f7f2c',
  plaza: '#cfd3c6',
  plazaDark: '#b3b9ab',
  water: ['#3aa5d6', '#3aa5d6', '#46b1df'],
  waterDeep: '#2f8fc0',
  shore: '#cfd8cc',
  shoreDark: '#a9b4a9',
  reed: '#3f7f33',
  asphalt: '#3f4e60',
  asphaltDark: '#333f4d',
  curb: '#c9d1cc',
  path: '#cdd4c8',
  pathEdge: '#b1baae',
  stone: '#c2c8bd',
  outline: 'rgba(26,34,42,.72)',
  wallLight: '#f3ebd7',
  wallMid: '#ddd2b9',
  wallDark: '#b6aa91',
  timber: '#9a5a3d',
  timberDark: '#75412c',
  roofGrey: '#5d6a78',
  roofGreyDark: '#404b57',
  roofTile: '#bf5330',
  roofTileDark: '#8d3520',
  roofDorm: '#c85f38',
  roofDormDark: '#96401f',
  roofGreen: '#4f7d5a',
  roofGreenDark: '#3a5f42',
  glass: '#9ac9dc',
  glassDark: '#5f93a8',
  gold: '#e0b64a',
  red: '#c0532c',
  redDark: '#8d3520',
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
    this.wetBases = world.buildings.filter(b => (b.wetRatio || 0) > 0.3);

    // 道路预处理：端头延长 + 标记与其它路相接的端点（路口）
    for (const r of world.roads) r._pts = extendEnds(r.pts, Math.min(1.1, r.w * 0.42));
    // 斑马线：步道的端点落在车行道范围内
    for (const r of world.roads) {
      if (r.w >= 3.2) continue;
      const n0 = r._pts.length;
      const ends0 = [[r._pts[0], r._pts[1]], [r._pts[n0 - 2], r._pts[n0 - 1]]];
      for (const e of ends0) {
        for (const o of world.roads) {
          if (o === r || o.w < 3.2) continue;
          if (e[0] < o.bbox[0] - 4 || e[0] > o.bbox[2] + 4 || e[1] < o.bbox[1] - 4 || e[1] > o.bbox[3] + 4) continue;
          let near0 = false;
          for (let i = 0; i < o.pts.length - 2; i += 2) {
            if (distToSeg(e[0], e[1], o.pts[i], o.pts[i + 1], o.pts[i + 2], o.pts[i + 3]) < o.w * 0.5) { near0 = true; break; }
          }
          if (!near0) continue;
          if (!o._crossings) o._crossings = [];
          const k2 = 2;
          o._crossings.push({
            x: e[0], y: e[1],
            dx: o.pts[k2] - o.pts[0], dy: o.pts[k2 + 1] - o.pts[1],
          });
          break;
        }
      }
    }
    for (const r of world.roads) {
      r._junction = [];
      const n = r._pts.length;
      const ends = [[r._pts[0], r._pts[1]], [r._pts[n - 2], r._pts[n - 1]]];
      for (const e of ends) {
        for (const o of world.roads) {
          if (o === r) continue;
          if (o.w > r.w + 0.3) continue;                       // 只补到更宽或同级的路
          if (e[0] < o.bbox[0] - 6 || e[0] > o.bbox[2] + 6 || e[1] < o.bbox[1] - 6 || e[1] > o.bbox[3] + 6) continue;
          let near = false;
          for (let i = 0; i < o.pts.length - 2; i += 2) {
            if (distToSeg(e[0], e[1], o.pts[i], o.pts[i + 1], o.pts[i + 2], o.pts[i + 3]) < o.w * 0.5 + 0.8) { near = true; break; }
          }
          if (near) {
            r._junction.push(e);
            r._junctionCore = (ROAD_STYLE[o.kind] || ROAD_STYLE.footway).core;
            // 窄路撞宽路：在宽路上记一个斑马线位置
            if (o.w >= 3.2 && r.w < 3.2) {
              if (!o._crossings) o._crossings = [];
              const k2 = Math.min(i + 2, o.pts.length - 2);
              o._crossings.push({
                x: e[0], y: e[1],
                dx: o.pts[k2] - o.pts[i], dy: o.pts[k2 + 1] - o.pts[i + 1],
              });
            }
            break;
          }
        }
      }
    }

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
    // 深浅斑点
    for (let i = 0; i < 58; i++) {
      const x = (rng() * 24) | 0, y = (rng() * 24) | 0;
      const r = rng();
      g.fillStyle = r < 0.42 ? P.grass[1] : r < 0.78 ? P.grass[2] : 'rgba(232,244,178,.35)';
      g.fillRect(x, y, r < 0.3 ? 2 : 1, 1);
    }
    // 草簇：两三根一起，高低不一
    for (let i = 0; i < 11; i++) {
      const x = (rng() * 22) | 0, y = (rng() * 21) | 0;
      g.fillStyle = P.grass[3];
      g.fillRect(x, y, 1, 2 + ((rng() * 2) | 0));
      g.fillRect(x + 1, y + 1, 1, 1);
      if (rng() < 0.4) g.fillRect(x + 2, y + ((rng() * 2) | 0), 1, 1);
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

    // 草叶、三叶草、野花：让大片草地不是纯色
    {
      const drng = mulberry32((cx * 3571) ^ (cy * 6151) ^ 0x9e37);
      const marks = 90;
      for (let i = 0; i < marks; i++) {
        const mx = w0 + drng() * this.chunkM;
        const my = h0 + drng() * this.chunkM;
        const r = drng();
        if (r < 0.66) {
          g.fillStyle = drng() < 0.55 ? 'rgba(56,100,32,.30)' : 'rgba(132,176,70,.32)';
          g.fillRect(mx, my, 0.5, 0.75);
        } else if (r < 0.9) {
          g.fillStyle = 'rgba(150,192,88,.28)';
          g.fillRect(mx, my, 0.75, 0.5);
        } else {
          g.fillStyle = drng() < 0.55 ? 'rgba(250,250,224,.8)' : 'rgba(246,214,104,.8)';
          g.fillRect(mx, my, 0.5, 0.5);
        }
      }
      // 两小丛三叶草
      for (let i = 0; i < 2; i++) {
        const mx = w0 + drng() * this.chunkM, my = h0 + drng() * this.chunkM;
        g.fillStyle = 'rgba(74,124,44,.30)';
        for (let k = 0; k < 4; k++) g.fillRect(mx + drng() * 2.2, my + drng() * 1.6, 0.6, 0.6);
      }
    }

    // 绿地（更深的草坪）
    for (const lc of this.world.landcover) {
      if (!hit(lc.bbox, x0, y0, x1, y1)) continue;
      g.beginPath(); poly(g, lc.ring);
      g.fillStyle = lc.wooded ? '#5d8a34' : P.lawn;
      g.fill();
      g.save();
      g.clip();
      // 割草条纹 + 草叶 + 野花
      const lrng = mulberry32((Math.round(lc.bbox[0]) * 2654435761 ^ Math.round(lc.bbox[1]) * 97) >>> 0);
      const lw = lc.bbox[2] - lc.bbox[0], lh = lc.bbox[3] - lc.bbox[1];
      if (lw * lh > 300) {
        // 草坪分块：几块略深/略浅的矩形，模拟不同长势的草皮
        for (let i = 0; i < 3; i++) {
          const pw = lw * (0.18 + lrng() * 0.30);
          const ph = lh * (0.14 + lrng() * 0.26);
          const px = lc.bbox[0] + lrng() * Math.max(0, lw - pw);
          const py = lc.bbox[1] + lrng() * Math.max(0, lh - ph);
          g.fillStyle = i % 2 ? 'rgba(120,180,70,.10)' : 'rgba(46,110,40,.10)';
          g.fillRect(px, py, pw, ph);
        }
      }
      const tufts = Math.min(90, Math.round((lw * lh) / 220));
      for (let i = 0; i < tufts; i++) {
        const tx = lc.bbox[0] + lrng() * lw;
        const ty = lc.bbox[1] + lrng() * lh;
        const r = lrng();
        if (r < 0.6) {
          g.fillStyle = lrng() < 0.5 ? 'rgba(58,104,34,.45)' : 'rgba(126,168,66,.42)';
          g.fillRect(tx, ty, 0.5, 1.1);
        } else if (r < 0.88) {
          g.fillStyle = 'rgba(150,190,86,.35)';
          g.fillRect(tx, ty, 1, 0.5);
        } else {
          g.fillStyle = lrng() < 0.5 ? 'rgba(250,250,220,.75)' : 'rgba(244,214,110,.75)';
          g.fillRect(tx, ty, 0.5, 0.5);
        }
      }
      g.restore();
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

    // 水上建筑的石台（避免看起来漂在水里）
    for (const b of this.wetBases) {
      if (!hit(b.bbox, x0, y0, x1, y1)) continue;
      g.beginPath();
      for (const poly2 of b.polys) for (const ring of poly2) poly(g, ring);
      g.strokeStyle = '#a9a294';
      g.lineWidth = 5;
      g.lineJoin = 'round';
      g.stroke();
      g.strokeStyle = '#8b8478';
      g.lineWidth = 1.2;
      g.stroke();
    }

    // 桥面：道路跨水时先铺一层石桥，再让路压在上面
    for (const br of this.world.bridges) {
      const bx = Math.min(br.ax, br.bx), by = Math.min(br.ay, br.by);
      if (!hit([bx - 8, by - 8, bx + 8, by + 8], x0, y0, x1, y1)) continue;
      g.lineCap = 'round';
      // 桥下阴影
      g.beginPath();
      g.moveTo(br.ax + 0.8, br.ay + 1.6);
      g.lineTo(br.bx + 0.8, br.by + 1.6);
      g.strokeStyle = 'rgba(24,36,40,.28)';
      g.lineWidth = br.w * 2 + 1.6;
      g.stroke();
      // 桥面
      g.beginPath();
      g.moveTo(br.ax, br.ay);
      g.lineTo(br.bx, br.by);
      g.strokeStyle = '#b8b1a0';
      g.lineWidth = br.w * 2;
      g.stroke();
      // 桥栏（两侧深色线）
      const dx = br.bx - br.ax, dy = br.by - br.ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(br.ax + nx * br.w * side, br.ay + ny * br.w * side);
        g.lineTo(br.bx + nx * br.w * side, br.by + ny * br.w * side);
        g.strokeStyle = 'rgba(90,84,70,.75)';
        g.lineWidth = 0.5;
        g.stroke();
      }
    }

    // 道路：同层一起画，路口才不会互相切出深色缺口
    const roads = this.world.roads
      .filter(r => hit(r.bbox, x0, y0, x1, y1))
      .sort((a, b) => b.w - a.w);
    const sty = (r) => ROAD_STYLE[r.kind] || ROAD_STYLE.footway;
    // 人行道：车行道两侧先铺 3.5 米浅色铺装，再让路面压在中间
    for (const r of roads) {
      if (r.w < 3.2) continue;
      g.beginPath(); traceLine(g, r._pts);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#c3c9bd';
      g.lineWidth = r.w + 7;
      g.stroke();
      g.strokeStyle = 'rgba(150,158,146,.55)';
      g.lineWidth = r.w + 7;
      g.setLineDash([1.2, 3.4]);
      g.stroke();
      g.setLineDash([]);
    }
    const narrow = roads.filter(r => r.w < 3.2);
    const wide = roads.filter(r => r.w >= 3.2);
    // 先画步道，再画车行道：车行道压住步道的穿越部分，步道就"停在路边"
    for (const r of narrow) roadShoulder(g, r, sty(r));
    for (const r of narrow) roadSurface(g, r, sty(r), roadRng(r));
    for (const r of narrow) roadTexture(g, r, sty(r), roadRng(r));
    for (const r of narrow) roadMarking(g, r, sty(r));
    for (const r of wide) roadShoulder(g, r, sty(r));
    for (const r of wide) roadSurface(g, r, sty(r), roadRng(r));
    for (const r of wide) roadTexture(g, r, sty(r), roadRng(r));
    for (const r of wide) roadMarking(g, r, sty(r));
    for (const r of wide) roadCrossings(g, r);

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

// ---------- 体育场地 ----------
function stadiumPath(g, cx, cy, half, r, horiz) {
  g.beginPath();
  if (horiz) {
    g.moveTo(cx - half, cy - r);
    g.lineTo(cx + half, cy - r);
    g.arc(cx + half, cy, r, -Math.PI / 2, Math.PI / 2, false);
    g.lineTo(cx - half, cy + r);
    g.arc(cx - half, cy, r, Math.PI / 2, Math.PI * 1.5, false);
  } else {
    g.moveTo(cx + r, cy - half);
    g.lineTo(cx + r, cy + half);
    g.arc(cx, cy + half, r, 0, Math.PI, false);
    g.lineTo(cx - r, cy - half);
    g.arc(cx, cy - half, r, Math.PI, Math.PI * 2, false);
  }
  g.closePath();
}

/** 足球场：割草条纹 + 标准线 */
function drawPitch(g, x, y, w, h, horiz = true) {
  const long = horiz ? w : h, short = horiz ? h : w;
  // 条纹
  const stripe = Math.max(3, long / 12);
  for (let i = 0, n = Math.ceil(long / stripe); i < n; i++) {
    g.fillStyle = i % 2 ? '#5c9a3f' : '#68a948';
    if (horiz) g.fillRect(x + i * stripe, y, stripe, h);
    else g.fillRect(x, y + i * stripe, w, stripe);
  }
  g.strokeStyle = 'rgba(255,255,255,.72)';
  g.lineWidth = 0.32;
  const m = Math.min(1.5, short * 0.03);        // 边线内缩
  g.strokeRect(x + m, y + m, w - m * 2, h - m * 2);
  const cx = x + w / 2, cy = y + h / 2;
  // 中线 + 中圈
  if (horiz) {
    g.beginPath(); g.moveTo(cx, y + m); g.lineTo(cx, y + h - m); g.stroke();
  } else {
    g.beginPath(); g.moveTo(x + m, cy); g.lineTo(x + w - m, cy); g.stroke();
  }
  const R = Math.min(9.15, short * 0.15);
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.6)';
  g.fillRect(cx - 0.25, cy - 0.25, 0.5, 0.5);
  // 禁区
  const boxD = Math.min(16.5, long * 0.16);
  const boxW = Math.min(40.3, short * 0.62);
  for (const side of [-1, 1]) {
    const bx = horiz ? (side < 0 ? x + m : x + w - m - boxD) : cx - boxW / 2;
    const by = horiz ? cy - boxW / 2 : (side < 0 ? y + m : y + h - m - boxD);
    g.strokeRect(bx, by, horiz ? boxD : boxW, horiz ? boxW : boxD);
    // 球门
    const gw = Math.min(7.32, boxW * 0.28);
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.lineWidth = 0.45;
    if (horiz) {
      const gx = side < 0 ? x + m : x + w - m;
      g.beginPath();
      g.moveTo(gx, cy - gw / 2);
      g.lineTo(gx + side * 1.8, cy - gw / 2);
      g.moveTo(gx, cy + gw / 2);
      g.lineTo(gx + side * 1.8, cy + gw / 2);
      g.stroke();
    } else {
      const gy = side < 0 ? y + m : y + h - m;
      g.beginPath();
      g.moveTo(cx - gw / 2, gy);
      g.lineTo(cx - gw / 2, gy + side * 1.8);
      g.moveTo(cx + gw / 2, gy);
      g.lineTo(cx + gw / 2, gy + side * 1.8);
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,.72)';
    g.lineWidth = 0.32;
  }
}

function drawTrack(g, bb, vert) {
  const W = bb[2] - bb[0], H = bb[3] - bb[1];
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const short = vert ? W : H;
  const long = vert ? H : W;
  const r = short / 2;
  const half = Math.max(4, long / 2 - r);
  const trackW = Math.min(9.2, short * 0.085);
  // 场外草地
  g.fillStyle = '#5c9640';
  g.fillRect(bb[0], bb[1], W, H);
  // 跑道红色
  g.fillStyle = '#b1533a';
  stadiumPath(g, cx, cy, half, r, !vert);
  g.fill();
  // 内圈草坪
  g.fillStyle = '#5d9a41';
  stadiumPath(g, cx, cy, half, r - trackW, !vert);
  g.fill();
  // 分道线
  const lanes = 8;
  g.strokeStyle = 'rgba(255,255,255,.55)';
  for (let i = 0; i <= lanes; i++) {
    const rr = r - (i / lanes) * trackW;
    g.lineWidth = i === 0 || i === lanes ? 0.42 : 0.2;
    stadiumPath(g, cx, cy, half, Math.max(1, rr), !vert);
    g.stroke();
  }
  // 内场足球场
  const fw = vert ? (r - trackW) * 2 : half * 2;
  const fh = vert ? half * 2 : (r - trackW) * 2;
  if (fw > 30 && fh > 20) {
    drawPitch(g, cx - fw / 2 + 1.5, cy - fh / 2 + 1.5, fw - 3, fh - 3, !vert);
  }
}

/** 一片片小场地（篮球/网球/排球） */
function drawCourts(g, bb, cols, rows, kind) {
  const W = bb[2] - bb[0], H = bb[3] - bb[1];
  const cw = W / cols, ch = H / rows;
  const base = kind === 'basketball' ? '#4d7b90' : kind === 'tennis' ? '#3f7a63' : '#b8863f';
  g.fillStyle = base;
  g.fillRect(bb[0], bb[1], W, H);
  const line = 'rgba(255,255,255,.62)';
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = bb[0] + i * cw, y = bb[1] + j * ch;
      g.fillStyle = (i + j) % 2 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)';
      g.fillRect(x + 0.6, y + 0.6, cw - 1.2, ch - 1.2);
      g.strokeStyle = line;
      g.lineWidth = 0.28;
      g.strokeRect(x + 1.4, y + 1.4, cw - 2.8, ch - 2.8);
      const mx = x + cw / 2, my = y + ch / 2;
      if (kind === 'basketball') {
        // 中线 + 中圈 + 两端禁区
        g.beginPath(); g.moveTo(mx, y + 1.4); g.lineTo(mx, y + ch - 1.4); g.stroke();
        g.beginPath(); g.arc(mx, my, Math.min(cw, ch) * 0.11, 0, Math.PI * 2); g.stroke();
        for (const s2 of [-1, 1]) {
          const ky = my + s2 * (ch / 2 - 1.4) * 0.52;
          g.strokeRect(mx - cw * 0.16, s2 < 0 ? y + 1.4 : my + ch * 0.22, cw * 0.32, ch * 0.26);
        }
        // 篮筐
        g.fillStyle = 'rgba(250,250,240,.85)';
        g.fillRect(mx - 0.4, y + 2.2, 0.8, 0.8);
        g.fillRect(mx - 0.4, y + ch - 3.0, 0.8, 0.8);
      } else if (kind === 'tennis') {
        // 网 + 发球区
        g.beginPath(); g.moveTo(x + 1.4, my); g.lineTo(x + cw - 1.4, my); g.stroke();
        g.beginPath(); g.moveTo(x + cw * 0.3, my - ch * 0.2); g.lineTo(x + cw * 0.7, my - ch * 0.2); g.stroke();
        g.beginPath(); g.moveTo(x + cw * 0.3, my + ch * 0.2); g.lineTo(x + cw * 0.7, my + ch * 0.2); g.stroke();
        g.beginPath(); g.moveTo(mx, my - ch * 0.2); g.lineTo(mx, my + ch * 0.2); g.stroke();
      } else {
        // 排球：中线 + 三米线
        g.beginPath(); g.moveTo(mx, y + 1.4); g.lineTo(mx, y + ch - 1.4); g.stroke();
        g.beginPath(); g.moveTo(mx - cw * 0.16, y + 1.4); g.lineTo(mx - cw * 0.16, y + ch - 1.4); g.stroke();
        g.beginPath(); g.moveTo(mx + cw * 0.16, y + 1.4); g.lineTo(mx + cw * 0.16, y + ch - 1.4); g.stroke();
      }
    }
  }
}

function drawSport(g, s) {
  const sp = (s.sport || '').toLowerCase();
  const bb = polyBBox(s.ring);
  const W = bb[2] - bb[0], H = bb[3] - bb[1];
  g.save();
  g.beginPath(); poly(g, s.ring); g.clip();

  if (sp === 'running' || sp === 'athletics' || sp === 'multi') {
    drawTrack(g, bb, H > W);
  } else if (sp === 'soccer') {
    g.fillStyle = '#5f9a44';
    g.fillRect(bb[0], bb[1], W, H);
    drawPitch(g, bb[0] + 2, bb[1] + 2, W - 4, H - 4, W >= H);
  } else if (sp === 'basketball') {
    const cols = Math.max(1, Math.round(Math.max(W, H) / 28));
    const rows = Math.max(1, Math.round(Math.min(W, H) / 16));
    drawCourts(g, bb, W >= H ? cols : rows, W >= H ? rows : cols, 'basketball');
  } else if (sp === 'tennis') {
    const cols = Math.max(1, Math.round(Math.max(W, H) / 24));
    const rows = Math.max(1, Math.round(Math.min(W, H) / 12));
    drawCourts(g, bb, W >= H ? cols : rows, W >= H ? rows : cols, 'tennis');
  } else if (sp === 'volleyball') {
    const cols = Math.max(1, Math.round(Math.max(W, H) / 20));
    const rows = Math.max(1, Math.round(Math.min(W, H) / 10));
    drawCourts(g, bb, W >= H ? cols : rows, W >= H ? rows : cols, 'volleyball');
  } else if (sp === 'climbing') {
    g.fillStyle = '#8f8a7c';
    g.fillRect(bb[0], bb[1], W, H);
    g.fillStyle = 'rgba(60,58,50,.35)';
    g.fillRect(bb[0] + W * 0.12, bb[1] + H * 0.18, W * 0.76, H * 0.64);
    const rng = mulberry32((Math.round(bb[0]) * 13 + Math.round(bb[1]) * 7) | 0);
    const holds = ['#d4753f', '#e0b04a', '#4f8ec4', '#c9534a'];
    for (let i = 0; i < 22; i++) {
      g.fillStyle = holds[(rng() * holds.length) | 0];
      g.fillRect(bb[0] + W * 0.16 + rng() * W * 0.68, bb[1] + H * 0.22 + rng() * H * 0.56, 0.9, 0.9);
    }
  } else {
    g.fillStyle = '#6f9a4a';
    g.fillRect(bb[0], bb[1], W, H);
    g.strokeStyle = 'rgba(255,255,255,.5)';
    g.lineWidth = 0.3;
    g.strokeRect(bb[0] + 2, bb[1] + 2, W - 4, H - 4);
  }
  g.restore();
  g.strokeStyle = 'rgba(60,70,55,.4)';
  g.lineWidth = 0.4;
  g.beginPath(); poly(g, s.ring); g.stroke();
}
function drawWater(g, ring, name) {
  const bb = polyBBox(ring);
  // 岸线：一圈浅色石岸 + 深色描边
  g.beginPath(); poly(g, ring);
  g.strokeStyle = P.shoreDark; g.lineWidth = 2.4; g.stroke();
  g.strokeStyle = P.shore; g.lineWidth = 1.2; g.stroke();
  // 水面：平涂
  g.beginPath(); poly(g, ring);
  g.fillStyle = P.water[0];
  g.fill();
  g.save();
  g.beginPath(); poly(g, ring); g.clip();
  // 靠岸一圈更浅
  g.beginPath(); poly(g, ring);
  g.strokeStyle = 'rgba(126,208,236,.55)';
  g.lineWidth = 3.2;
  g.stroke();
  // 少量扁平高光短条
  const rng = mulberry32((Math.round(bb[0]) * 31 + Math.round(bb[1]) * 17) | 0);
  const n = Math.min(40, Math.max(4, Math.round((bb[2] - bb[0]) * (bb[3] - bb[1]) / 260)));
  g.fillStyle = 'rgba(180,228,246,.65)';
  for (let i = 0; i < n; i++) {
    const x = bb[0] + rng() * (bb[2] - bb[0]);
    const y = bb[1] + rng() * (bb[3] - bb[1]);
    g.fillRect(x, y, 2 + (rng() * 3 | 0), 0.5);
  }
  g.restore();
  g.strokeStyle = 'rgba(20,60,80,.35)';
  g.lineWidth = 0.4;
  g.beginPath(); poly(g, ring); g.stroke();
}
// ---------- 道路：分层绘制（肩部→路面→颗粒→标线），路口自然衔接 ----------
const ROAD_STYLE = {
  footway:     { core: '#cdd4c8', edge: '#b1baae', speck: ['#c4cbbf', '#d7ddd0'], kind: 'path' },
  path:        { core: '#c6cec1', edge: '#aab4a8', speck: ['#bcc4b7', '#d2d8cc'], kind: 'path' },
  steps:       { core: '#c2c8bd', edge: '#a3ab9f', speck: ['#b6bdb1', '#d3d8cd'], kind: 'steps' },
  service:     { core: '#3f4e60', edge: '#333f4d', speck: ['#455468', '#39485a'], kind: 'asphalt' },
  residential: { core: '#3b4a5b', edge: '#303b48', speck: ['#415163', '#354455'], kind: 'asphalt' },
  cycleway:    { core: '#cad1c5', edge: '#aeb7ab', speck: ['#c1c9bd', '#d5dbcf'], kind: 'path', bike: true },
  pedestrian:  { core: '#d0d7cb', edge: '#b3bcb0', speck: ['#c8cfc3', '#dae0d4'], kind: 'path' },
};

const _roadRng = new WeakMap();
function roadRng(r) {
  let g = _roadRng.get(r);
  if (!g) { g = mulberry32(((r.id | 0) * 2654435761 ^ Math.round((r.pts[0] || 0) * 97)) >>> 0); _roadRng.set(r, g); }
  return g;
}

function roadPieces(pts, seg = 5) {
  const out = [];
  for (let i = 0; i < pts.length - 2; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.05) continue;
    const n = Math.max(1, Math.round(len / seg));
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      out.push([
        ax + (bx - ax) * t0, ay + (by - ay) * t0,
        ax + (bx - ax) * t1, ay + (by - ay) * t1,
        len,
      ]);
    }
  }
  return out;
}

/** 把路的两端各延长一点，端头埋进相交的路里，避免圆帽露出 */
function extendEnds(pts, ext) {
  const n = pts.length;
  if (n < 4) return pts;
  const out = pts.slice();
  const d0x = pts[0] - pts[2], d0y = pts[1] - pts[3];
  const l0 = Math.hypot(d0x, d0y);
  if (l0 > 0.01) { out[0] = pts[0] + (d0x / l0) * ext; out[1] = pts[1] + (d0y / l0) * ext; }
  const d1x = pts[n - 2] - pts[n - 4], d1y = pts[n - 1] - pts[n - 3];
  const l1 = Math.hypot(d1x, d1y);
  if (l1 > 0.01) {
    out[n - 2] = pts[n - 2] + (d1x / l1) * ext;
    out[n - 1] = pts[n - 1] + (d1y / l1) * ext;
  }
  return out;
}

function roadShoulder(g, r, st) {
  const w = r.w;
  g.beginPath(); traceLine(g, r._pts);
  g.strokeStyle = st.kind === 'asphalt' ? 'rgba(48,58,70,.35)' : 'rgba(140,150,132,.22)';
  g.lineWidth = w + (st.kind === 'asphalt' ? 1.9 : 1.5);
  g.stroke();
}

function roadSurface(g, r, st, rng) {
  const w = r.w;
  const pieces = roadPieces(r._pts, st.kind === 'path' ? 4 : 6);
  for (const p of pieces) {
    const jitter = 0.94 + rng() * 0.12;
    g.beginPath();
    g.moveTo(p[0], p[1]);
    g.lineTo(p[2], p[3]);
    g.strokeStyle = st.core;
    g.lineWidth = w * jitter;
    g.stroke();
  }
  // 路口补一块圆形铺装，把两条路的端头连成一片
  if (r._junction && r._junction.length) {
    g.fillStyle = r._junctionCore || st.core;
    for (const j of r._junction) {
      g.beginPath();
      g.arc(j[0], j[1], w * 0.52, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function roadTexture(g, r, st, rng) {
  const w = r.w;
  const step = st.kind === 'path' ? 1.5 : 0.9;
  for (let i = 0; i < r._pts.length - 2; i += 2) {
    const ax = r._pts[i], ay = r._pts[i + 1], bx = r._pts[i + 2], by = r._pts[i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.05) continue;
    const nx = -(by - ay) / len, ny = (bx - ax) / len;
    for (let d = 0; d < len; d += step) {
      const t = d / len;
      const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t;
      const n = st.kind === 'asphalt' ? 1 : (rng() < 0.45 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const off = (rng() - 0.5) * w * 0.86;
        g.fillStyle = st.speck[(rng() * st.speck.length) | 0];
        g.fillRect(cx + nx * off, cy + ny * off, st.kind === 'asphalt' ? 0.55 : 0.5, 0.5);
      }
      if (rng() < 0.05) {
        g.fillStyle = st.kind === 'asphalt' ? 'rgba(120,120,114,.35)' : 'rgba(206,196,168,.45)';
        g.fillRect(cx - w * 0.25 + (rng() - 0.5) * w * 0.3, cy - 0.6, w * 0.5, 1.2);
      }
      // 边缘碎化
      if (rng() < 0.55) {
        const side = rng() < 0.5 ? 1 : -1;
        const off = side * (w * 0.5 + (rng() - 0.3) * 0.55);
        g.fillStyle = st.kind === 'asphalt' ? 'rgba(120,140,80,.5)' : 'rgba(124,168,66,.55)';
        g.fillRect(cx + nx * off, cy + ny * off, 0.5, 0.5);
      }
    }
  }
}

function roadMarking(g, r, st) {
  const w = r.w;
  if (st.bike && w >= 3) {
    g.strokeStyle = 'rgba(150,86,66,.55)';
    g.lineWidth = Math.max(0.6, w * 0.24);
    g.beginPath(); traceLine(g, r._pts); g.stroke();
  }
  if (st.kind === 'asphalt' && w >= 3.4) {
    g.beginPath(); traceLine(g, r._pts);
    g.strokeStyle = 'rgba(226,232,224,.55)';
    g.lineWidth = 0.5;
    g.setLineDash([]);
    g.stroke();
  }
  if (st.kind === 'asphalt' && w >= 4.4) {
    g.strokeStyle = 'rgba(240,244,238,.85)';
    g.lineWidth = 0.3;
    g.setLineDash([2.2, 2.8]);
    g.beginPath(); traceLine(g, r._pts); g.stroke();
    g.setLineDash([]);
  } else if (st.kind === 'steps') {
    for (let i = 0; i < r._pts.length - 2; i += 2) {
      const ax = r._pts[i], ay = r._pts[i + 1], bx = r._pts[i + 2], by = r._pts[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      g.strokeStyle = 'rgba(92,90,82,.45)';
      g.lineWidth = 0.22;
      for (let d = 0.6; d < len; d += 0.9) {
        const cx = ax + (bx - ax) * (d / len), cy = ay + (by - ay) * (d / len);
        g.beginPath();
        g.moveTo(cx - nx * w * 0.46, cy - ny * w * 0.46);
        g.lineTo(cx + nx * w * 0.46, cy + ny * w * 0.46);
        g.stroke();
      }
    }
  }
}
/** 斑马线：步道横穿车行道的位置，画几条横向白线 */
function roadCrossings(g, r) {
  if (!r._crossings || !r._crossings.length) return;
  const half = r.w * 0.5 - 0.6;
  g.strokeStyle = 'rgba(242,246,240,.88)';
  g.lineWidth = 0.55;
  for (const c of r._crossings) {
    const len = Math.hypot(c.dx, c.dy) || 1;
    const px = c.dx / len, py = c.dy / len;
    const nx = -py, ny = px;
    for (let k = -2; k <= 2; k++) {
      const ox = c.x + nx * k * 1.15, oy = c.y + ny * k * 1.15;
      g.beginPath();
      g.moveTo(ox + px * half, oy + py * half);
      g.lineTo(ox - px * half, oy - py * half);
      g.stroke();
    }
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
  const flN = Number(b.fl) || Math.max(1, Math.round(Math.sqrt(Math.max(3, b.h)) / 3.2));
  b._hpx = clamp(Math.round(Math.max(flN, Math.sqrt(Math.max(3, b.h)) / 2.2) * 7.5), 14, 64);
  return b;
}

// ---------- 建筑原型：同一类别也分不同体型，避免整片一个样 ----------
// 屋顶材质族：不再按类别一刀切，按名字哈希 + 类别权重取用，同一片里灰瓦红瓦混着
const ROOF_FAMILY = [
  ['#bf5330', '#8d3520'],   // 红瓦
  ['#b8482b', '#83311b'],   // 深红瓦
  ['#6f6a60', '#4a463e'],   // 灰瓦
  ['#57534b', '#3a3731'],   // 深灰瓦
  ['#8a6a48', '#5f4830'],   // 褐瓦
  ['#5d6a78', '#3f4a56'],   // 青灰（现代）
  ['#4f7d5a', '#3a5f42'],   // 琉璃绿（古建）
];
const CAT_ROOF_WEIGHTS = {
  '教学': [0, 1, 2, 3, 4, 5, 0, 1, 2, 5],
  '生活': [0, 1, 4, 0, 1, 4, 2],
  '食堂': [0, 4, 1, 4],
  '园林': [3, 6, 2, 1, 3, 6],
  '体育': [5, 5, 2, 4],
  '校园服务': [1, 2, 4, 0],
  '校门': [0, 0, 1],
};
const WALL_TYPE = {
  '教学': ['#f3ebd7', '#e9e6dc', '#efe4cc'],
  '生活': ['#e8d9bf', '#e2d3b6', '#efdfc4'],
  '食堂': ['#e6d3ae', '#efe0c2'],
  '园林': ['#f0e8d6', '#e8ddc2'],
  '体育': ['#dfe3e4', '#d3d8da'],
  '校园服务': ['#e4dcc9', '#eae2d0'],
  '校门': ['#c0532c', '#b8492a'],
};
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

/** 决定这栋楼的体型：gable 双坡 / hip 四坡 / flat 平顶 / tower 塔楼 / classic 古建 / dorm 宿舍 / hall 大跨 */
function pickVariant(b) {
  const h = hashStr((b.name || '') + '#' + b.id);
  const r = h % 100;
  if (b.heritage || /楼$|阁$|轩$|斋$|亭$/.test(b.name || '') === false) {
    // 落到下面按类别判断
  }
  if (b.heritage) return 'classic';
  switch (b.cat) {
    case '教学':
      if (r < 34) return 'gable';
      if (r < 56) return 'hip';
      if (r < 80) return 'flat';
      return 'tower';
    case '生活':
      if (r < 52) return 'dorm';
      if (r < 82) return 'gable';
      return 'flat';
    case '食堂':
      return r < 62 ? 'hall' : 'flat';
    case '园林':
      return r < 55 ? 'classic' : 'gable';
    case '体育':
      return r < 70 ? 'hall' : 'flat';
    case '校园服务':
      return r < 55 ? 'flat' : 'gable';
    case '校门':
      return 'classic';
    default:
      return r < 50 ? 'gable' : 'flat';
  }
}

export function drawBuilding(ctx, b, cam, hour) {
  prepareBuilding(b);
  const S = cam.scale;
  const ox = cam.w / 2 - cam.x * S;
  const oy = cam.h / 2 - cam.y * S;
  const at = (dx, dy) => { ctx.translate(ox + dx, oy + dy); ctx.scale(S, S); };
  const hpx = Math.max(6, Math.round(b._hpx * cam.zoom));
  const hpxZoom = Math.round(b._hpx * cam.zoom);
  const bb = b.bbox;
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  const seed = hashStr((b.name || '') + b.id);
  const rng = mulberry32(seed);
  const night = nightStrength(hour) > 0.15;
  let variant = pickVariant(b);
  // ---- 有 style.csv 的真实数据时优先 ----------------
  const stData = b.st;
  if (stData) {
    const rf = stData.rf || '';
    if (rf.includes('平顶')) variant = 'flat';
    else if (rf.includes('塔楼') || rf.includes('攒尖')) variant = 'tower';
    else if (rf.includes('歇山') || rf.includes('四坡')) variant = 'hip';
    else if (rf.includes('双坡') || rf.includes('悬山')) variant = 'gable';
  }

  const weights = CAT_ROOF_WEIGHTS[b.cat] || CAT_ROOF_WEIGHTS['教学'];
  let fam = ROOF_FAMILY[weights[seed % weights.length] % ROOF_FAMILY.length];
  if (stData) {
    const tile = stData.tile || '';
    if (tile.includes('灰瓦')) fam = ROOF_FAMILY[3];
    else if (tile.includes('红瓦')) fam = ROOF_FAMILY[0];
    else if (tile.includes('琉璃')) fam = ROOF_FAMILY[6];
    else if (tile.includes('青瓦')) fam = ROOF_FAMILY[2];
  }
  const walls = WALL_TYPE[b.cat] || WALL_TYPE['教学'];
  let [roof, roofDark] = fam;
  const wall = walls[seed % walls.length];
  // 每栋 ±5% 明度抖动
  const jitter = ((seed >> 3) % 11 - 5) / 100;
  roof = mixHex(roof, jitter > 0 ? '#fff3e0' : '#2a1a12', Math.abs(jitter) * 2.2);
  const flat = variant === 'flat' || variant === 'tower';
  const classic = variant === 'classic';

  // ===== 2.5D 正确叠法：地基 = 占地轮廓，墙往上长，屋顶盖在墙顶 =====
  // 墙高：既跟层数走，也不少于进深的 30%，否则屋顶会把墙压没
  const depthPx = Math.max(1, Math.round(h * S));
  const wallPx = Math.max(12, Math.round(Math.max(hpx * 0.92, Math.min(depthPx * 0.32, 110))));
  const wallH = wallPx / S;                              // 墙高（米）
  const wallTop = bb[3] - wallH;                         // 墙顶所在世界 y
  const wallX0 = bb[0], wallX1 = bb[2];
  const wallW = wallX1 - wallX0;

  // 地基投影（贴地一圈，向下偏 1~2px）
  ctx.save();
  at(1.5, 2.5);
  ctx.fillStyle = 'rgba(30,42,30,.20)';
  ctx.fill(b._path);
  ctx.restore();

  // ---- 墙体：矩形立面，不沿多边形轮廓裁，保证窗是正的 ----
  ctx.save();
  at(0, 0);
  // 墙体形状 = 占地轮廓的底部一条带（不会伸出建筑外）
  // 墙裙：沿每条朝南的边向下拉 wallH，贴着真实轮廓
  const skirt = new Path2D();
  for (const ring of b.outer) {
    const n2 = ring.length;
    for (let i = 0; i < n2; i += 2) {
      const j = (i + 2) % n2;
      const x1 = ring[i], y1 = ring[i + 1], x2 = ring[j], y2 = ring[j + 1];
      const dyE = y2 - y1, dxE = Math.abs(x2 - x1);
      // 朝南的边一定拉；水平边也拉（否则水平南墙会整段缺失）
      if (dyE <= 0.01 && !(Math.abs(dyE) <= 0.05 && dxE > 0.5)) continue;
      skirt.moveTo(x1, y1);
      skirt.lineTo(x2, y2);
      skirt.lineTo(x2, y2 - wallH);
      skirt.lineTo(x1, y1 - wallH);
      skirt.closePath();
    }
  }
  ctx.fillStyle = wall;
  ctx.fill(skirt);
  ctx.strokeStyle = 'rgba(60,44,30,.35)';
  ctx.lineWidth = 0.4;
  ctx.stroke(skirt);
  // 立面底色：左右各压一点，读作转角
  ctx.fillStyle = 'rgba(60,44,30,.10)';
  ctx.fillRect(wallX0, wallTop, Math.min(1.2, wallW * 0.04), wallH);
  ctx.fillStyle = 'rgba(255,250,240,.14)';
  ctx.fillRect(wallX1 - Math.min(1.2, wallW * 0.04), wallTop, Math.min(1.2, wallW * 0.04), wallH);
  // 墙顶压暗（屋顶落影）
  ctx.fillStyle = 'rgba(48,38,28,.32)';
  ctx.fillRect(wallX0, wallTop, wallW, Math.min(0.8, wallH * 0.1));
  // 墙脚
  ctx.fillStyle = 'rgba(30,22,14,.30)';
  ctx.fillRect(wallX0, bb[3] - Math.min(0.7, wallH * 0.09), wallW, Math.min(0.7, wallH * 0.09));
  ctx.restore();

  // ---- 立面细节（全部在矩形里排版，不会歪）----
  ctx.save();
  at(0, 0);
  ctx.clip(skirt);
  const eaveM = Math.min(0.9, wallH * 0.13);
  const floorsF = clamp(Math.round(wallH / 3.4), 1, 5);
  const floorH = (wallH - eaveM) / floorsF;

  const facades = {
    '教学': ['glass', 'arch', 'brick', 'banner', 'arch', 'glass'],
    '生活': ['balcony', 'brick', 'balcony', 'banner'],
    '食堂': ['shop', 'shop', 'glass'],
    '园林': ['classic', 'classic', 'arch'],
    '体育': ['glass', 'glass', 'banner'],
    '校园服务': ['shop', 'glass', 'brick'],
    '校门': ['classic'],
  };
  const fList = facades[b.cat] || facades['教学'];
  const facade = variant === 'classic' ? 'classic' : (stData && stData.win === '拱窗' ? 'arch' : (stData && stData.win === '木格窗' ? 'classic' : fList[seed % fList.length]));

  if (facade === 'classic') {
    const cols = Math.max(2, Math.round(wallW / 4.2));
    const gap = wallW / (cols - 1 || 1);
    ctx.fillStyle = '#b23a28';
    for (let i = 0; i < cols; i++) ctx.fillRect(wallX0 + i * gap - 0.28, wallTop + eaveM, 0.56, wallH - eaveM);
    for (let f = 0; f < floorsF; f++) {
      const fy = wallTop + eaveM + f * floorH + floorH * 0.24;
      const wh = Math.min(1.7, floorH * 0.46);
      for (let i = 0; i < cols - 1; i++) {
        const wx = wallX0 + i * gap + gap * 0.22, ww = gap * 0.56;
        ctx.fillStyle = 'rgba(112,68,48,.8)';
        ctx.fillRect(wx, fy, ww, wh);
        ctx.fillStyle = 'rgba(240,220,180,.35)';
        ctx.fillRect(wx, fy, ww, 0.18);
        ctx.fillRect(wx + ww * 0.5, fy, 0.16, wh);
      }
    }
  } else if (facade === 'glass') {
    ctx.fillStyle = 'rgba(96,132,156,.85)';
    ctx.fillRect(wallX0 + 0.4, wallTop + eaveM, wallW - 0.8, wallH - eaveM);
    for (let x = wallX0 + 1.1; x < wallX1 - 0.6; x += 1.9) {
      ctx.fillStyle = 'rgba(226,238,244,.45)';
      ctx.fillRect(x, wallTop + eaveM, 0.2, wallH - eaveM);
    }
    for (let f = 1; f < floorsF; f++) {
      ctx.fillStyle = 'rgba(190,206,216,.55)';
      ctx.fillRect(wallX0 + 0.4, wallTop + eaveM + f * floorH - 0.2, wallW - 0.8, 0.26);
    }
    const gx = wallX0 + wallW * (0.2 + (seed % 5) * 0.12);
    ctx.fillStyle = 'rgba(232,244,250,.55)';
    ctx.fillRect(gx, wallTop + eaveM + floorH * 0.3, Math.min(3.4, wallW * 0.16), floorH * 0.5);
  } else if (facade === 'shop') {
    const shopH = Math.min(floorH * 1.15, wallH * 0.52);
    const sy = bb[3] - shopH;
    ctx.fillStyle = '#f0e6d0';
    ctx.fillRect(wallX0, sy, wallW, shopH);
    const units = Math.max(2, Math.round(wallW / 3.6));
    const ug = wallW / units;
    for (let i = 0; i < units; i++) {
      const wx = wallX0 + i * ug + ug * 0.12;
      ctx.fillStyle = night ? 'rgba(255,226,150,.9)' : 'rgba(92,124,146,.85)';
      ctx.fillRect(wx, sy + shopH * 0.26, ug * 0.76, shopH * 0.58);
      ctx.fillStyle = 'rgba(240,248,252,.35)';
      ctx.fillRect(wx + ug * 0.08, sy + shopH * 0.3, ug * 0.24, shopH * 0.5);
    }
    const aw = wallW * 0.9, ax = wallX0 + wallW * 0.05;
    ctx.fillStyle = '#b23a2a';
    ctx.fillRect(ax, sy + shopH * 0.2, aw, Math.max(0.6, shopH * 0.1));
    ctx.fillStyle = 'rgba(246,238,220,.9)';
    for (let x = ax; x < ax + aw; x += 1.6) ctx.fillRect(x, sy + shopH * 0.2, 0.8, Math.max(0.6, shopH * 0.1));
    ctx.fillStyle = '#8f3a24';
    ctx.fillRect(ax, sy + shopH * 0.02, aw, Math.max(0.8, shopH * 0.14));
    ctx.fillStyle = 'rgba(255,240,210,.85)';
    for (let i = 0; i < 4; i++) ctx.fillRect(ax + 1 + i * 1.7, sy + shopH * 0.06, 1, Math.max(0.4, shopH * 0.06));
    for (let f = 0; f < floorsF - 1; f++) {
      const fy = wallTop + eaveM + f * floorH + floorH * 0.24;
      for (let x = wallX0 + 1.4; x < wallX1 - 1.4; x += 3.2) {
        ctx.fillStyle = night && rng() > 0.5 ? '#ffe9a8' : 'rgba(86,114,134,.7)';
        ctx.fillRect(x, fy, 1.7, Math.min(1.5, floorH * 0.42));
      }
    }
  } else if (facade === 'arch') {
    ctx.fillStyle = 'rgba(150,74,52,.14)';
    ctx.fillRect(wallX0, wallTop, wallW, wallH);
    const cols = Math.max(2, Math.round(wallW / 3.4));
    const gap = wallW / cols;
    for (let f = 0; f < floorsF; f++) {
      const fy = wallTop + eaveM + f * floorH + floorH * 0.2;
      const wh = Math.min(2.1, floorH * 0.58);
      for (let c = 0; c < cols; c++) {
        const wx = wallX0 + c * gap + gap * 0.24, ww = gap * 0.52;
        ctx.fillStyle = 'rgba(250,244,230,.9)';
        ctx.fillRect(wx - 0.3, fy - 0.3, ww + 0.6, wh + 0.6);
        ctx.fillStyle = night && rng() > 0.55 ? '#ffe9a8' : 'rgba(84,110,128,.8)';
        ctx.fillRect(wx, fy, ww, wh);
        ctx.fillStyle = 'rgba(250,244,230,.9)';
        ctx.fillRect(wx - 0.3, fy - 0.3, ww + 0.6, 0.3);
        ctx.fillRect(wx + ww * 0.35, fy - 0.7, ww * 0.3, 0.45);
      }
    }
    ctx.fillStyle = 'rgba(252,246,232,.7)';
    ctx.fillRect(wallX0, wallTop + eaveM, wallW, 0.3);
  } else if (facade === 'banner') {
    ctx.fillStyle = 'rgba(210,198,176,.3)';
    ctx.fillRect(wallX0, wallTop, wallW, wallH);
    const cols = Math.max(3, Math.round(wallW / 5));
    const gap = wallW / (cols - 1 || 1);
    ctx.fillStyle = 'rgba(255,250,236,.5)';
    for (let i = 0; i < cols; i++) ctx.fillRect(wallX0 + i * gap - 0.3, wallTop + eaveM, 0.6, wallH - eaveM);
    const wins = Math.max(1, Math.round(wallW / 7));
    for (let i = 0; i < wins; i++) {
      const wx = wallX0 + (i + 0.5) * (wallW / wins) - 1.1;
      ctx.fillStyle = 'rgba(90,116,134,.7)';
      ctx.fillRect(wx, wallTop + eaveM + floorH * 0.3, 2.2, floorH * 0.4);
    }
    const bw = Math.min(wallW * 0.42, 12), bx = wallX0 + (wallW - bw) / 2;
    const bh = Math.min(1.6, wallH * 0.2), byy = wallTop + eaveM + wallH * 0.12;
    ctx.fillStyle = '#b23a2a';
    ctx.fillRect(bx, byy, bw, bh);
    ctx.fillStyle = 'rgba(255,242,214,.9)';
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(bx + 0.7 + i * (bw - 1.4) / 6, byy + bh * 0.25, (bw - 1.4) / 6 * 0.6, bh * 0.5);
    }
  } else {
    const cols = Math.max(2, Math.round(wallW / 3.6));
    const gap = wallW / cols;
    for (let f = 0; f < floorsF; f++) {
      const fy = wallTop + eaveM + f * floorH;
      const railH = Math.min(0.9, floorH * 0.26);
      for (let c = 0; c < cols; c++) {
        const wx = wallX0 + c * gap + gap * 0.12, ww = gap * 0.76;
        ctx.fillStyle = 'rgba(255,250,238,.5)';
        ctx.fillRect(wx, fy + floorH - railH - 0.2, ww, railH);
        ctx.fillStyle = 'rgba(120,104,82,.35)';
        ctx.fillRect(wx, fy + floorH - 0.35, ww, 0.35);
        const lit = night && rng() > 0.4;
        ctx.fillStyle = lit ? '#ffe9a8' : 'rgba(86,114,134,.7)';
        ctx.fillRect(wx + ww * 0.08, fy + floorH * 0.2, ww * 0.36, floorH * 0.46);
        ctx.fillStyle = lit ? 'rgba(255,240,200,.5)' : 'rgba(120,90,70,.55)';
        ctx.fillRect(wx + ww * 0.56, fy + floorH * 0.24, ww * 0.34, floorH * 0.42);
        if (rng() > 0.72) {
          ctx.fillStyle = ['#d98a6a', '#7f9ec4', '#c4b06a'][(rng() * 3) | 0];
          ctx.fillRect(wx + ww * 0.2, fy + floorH - railH - 0.9, ww * 0.5, 0.7);
        }
      }
    }
  }

  // 入口
  if (wallW > 8 && facade !== 'glass' && facade !== 'shop') {
    const dw = Math.min(5, wallW * 0.16);
    const dh = Math.min(floorH * 0.8, 3.2);
    const dx = wallX0 + (wallW - dw) / 2;
    const dy = bb[3] - dh - Math.min(0.5, wallH * 0.06);
    if (facade !== 'classic') {
      ctx.fillStyle = 'rgba(40,34,26,.28)';
      ctx.fillRect(dx - 1.2, dy - 0.5, dw + 2.4, 0.5);
      ctx.fillStyle = '#e6dcc4';
      ctx.fillRect(dx - 1.4, dy - 1.1, dw + 2.8, 0.7);
    }
    ctx.fillStyle = facade === 'classic' ? 'rgba(150,54,36,.95)' : 'rgba(52,54,50,.85)';
    ctx.fillRect(dx, dy, dw, dh);
    ctx.fillStyle = 'rgba(255,240,200,.2)';
    ctx.fillRect(dx + dw * 0.12, dy + dh * 0.12, dw * 0.28, dh * 0.76);
    ctx.fillRect(dx + dw * 0.56, dy + dh * 0.12, dw * 0.28, dh * 0.76);
  }
  ctx.restore();

  // ---- 屋顶：盖在墙顶之上（向上平移 wallPx）----
  ctx.save();
  at(0, -wallPx);
  ctx.fillStyle = roof;
  ctx.fill(b._path, 'evenodd');
  ctx.save();
  ctx.clip(b._path, 'evenodd');
  ctx.strokeStyle = roofDark;
  ctx.lineWidth = 2.2;
  ctx.stroke(b._path);
  ctx.strokeStyle = mixHex(roof, '#fff6e6', 0.18);
  ctx.lineWidth = 0.8;
  ctx.stroke(b._path);
  if (!flat) {
    const s1 = bb[1] + h * 0.38, s2 = bb[1] + h * 0.66;
    ctx.fillStyle = 'rgba(255,246,226,.13)';
    ctx.fillRect(bb[0], bb[1], w, Math.max(0.6, s1 - bb[1]));
    ctx.fillStyle = 'rgba(40,22,12,.10)';
    ctx.fillRect(bb[0], s2, w, Math.max(0.6, bb[3] - s2));
  }
  const horiz = w >= h;
  const midX = (bb[0] + bb[2]) / 2, midY = (bb[1] + bb[3]) / 2;
  if (flat) {
    ctx.strokeStyle = 'rgba(255,248,236,.28)';
    ctx.lineWidth = 1;
    ctx.stroke(b._path);
    if (w > 26 || h > 26) {
      ctx.fillStyle = 'rgba(58,64,60,.10)';
      for (let x = bb[0] + 8; x < bb[2]; x += 8) ctx.fillRect(x, bb[1], 0.5, h);
      for (let y = bb[1] + 8; y < bb[3]; y += 8) ctx.fillRect(bb[0], y, w, 0.5);
    }
    const n = Math.min(5, Math.max(1, Math.round(w * h / 700)));
    for (let i = 0; i < n; i++) {
      const uw = 1.8 + rng() * 2.6, uh = 1.6 + rng() * 2.2;
      const ux = bb[0] + 2 + rng() * Math.max(1, w - uw - 4);
      const uy = bb[1] + 2 + rng() * Math.max(1, h - uh - 4);
      ctx.fillStyle = 'rgba(40,36,30,.3)';
      ctx.fillRect(ux + 0.4, uy + 0.4, uw, uh);
      ctx.fillStyle = roofDark;
      ctx.fillRect(ux, uy, uw, uh);
      ctx.fillStyle = 'rgba(255,248,232,.4)';
      ctx.fillRect(ux, uy, uw, 0.5);
    }
  } else {
    ctx.fillStyle = 'rgba(60,30,18,.12)';
    if (horiz) for (let y = bb[1] + 1.4; y < bb[3]; y += 1.7) ctx.fillRect(bb[0], y, w, 0.26);
    else for (let x = bb[0] + 1.4; x < bb[2]; x += 1.7) ctx.fillRect(x, bb[1], 0.26, h);
    if (horiz) {
      ctx.fillStyle = roofDark;
      ctx.fillRect(bb[0], midY - 0.9, w, 1.8);
      ctx.fillStyle = 'rgba(255,240,220,.25)';
      ctx.fillRect(bb[0], midY - 0.9, w, 0.5);
    } else {
      ctx.fillStyle = roofDark;
      ctx.fillRect(midX - 0.9, bb[1], 1.8, h);
      ctx.fillStyle = 'rgba(255,240,220,.25)';
      ctx.fillRect(midX - 0.9, bb[1], 0.5, h);
    }
  }
  // 内院
  for (const poly2 of b.polys) {
    for (let hi = 1; hi < poly2.length; hi++) {
      const ring = poly2[hi];
      ctx.beginPath();
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
      ctx.closePath();
      ctx.fillStyle = '#e6dcc4';
      ctx.fill();
      ctx.strokeStyle = roofDark;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }
  ctx.strokeStyle = 'rgba(28,22,18,.62)';
  ctx.lineWidth = 0.75;
  ctx.stroke(b._path);
  ctx.restore();
  ctx.restore();

  // 内院铺装
  for (const poly2 of b.polys) {
    for (let hi = 1; hi < poly2.length; hi++) {
      const ring = poly2[hi];
      ctx.beginPath();
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
      ctx.closePath();
      ctx.fillStyle = '#e6dcc4';
      ctx.fill();
      ctx.strokeStyle = roofDark;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  ctx.strokeStyle = 'rgba(28,22,18,.62)';
  ctx.lineWidth = 0.75;
  ctx.stroke(b._path);
  ctx.restore();
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
  const outline2 = (x, y, wm, hm, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.8, S * 0.22);
    ctx.strokeRect(X(x), Y(y), PW(wm), PW(hm));
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
    drawBuilding(ctx, b, cam, hour);
    // 主屋面（暖红） + 深色檐圈
    rect(0, 0, w, h, '#b84e2c');
    ctx.strokeStyle = '#8d3520';
    ctx.lineWidth = 2.4;
    ctx.strokeRect(X(0.6), Y(0.6), PW(w - 1.2), PW(h - 1.2));
    // 退台体量：更亮一层红
    rect(w * 0.16, h * 0.14, w * 0.68, h * 0.46, '#c65b35');
    outline2(w * 0.16, h * 0.14, w * 0.68, h * 0.46, '#8d3520');
    rect(w * 0.23, h * 0.21, w * 0.54, h * 0.32, '#d2693f');
    outline2(w * 0.23, h * 0.21, w * 0.54, h * 0.32, '#8d3520');
    // 玻璃天窗
    rect(w * 0.3, h * 0.3, w * 0.4, h * 0.1, night ? '#6aa9c4' : '#9fd4e8');
    rect(w * 0.3, h * 0.3, w * 0.4, h * 0.02, '#d8eef6');
    // 屋面分缝（暗红细线）
    ctx.fillStyle = 'rgba(120,44,26,.35)';
    for (let x = 7; x < w; x += 9) ctx.fillRect(X(x), Y(0.8), 0.5, PW(h - 1.6));
    // 内院（米白）
    rect(w * 0.42, h * 0.7, w * 0.16, h * 0.22, '#e6dcc4');
    outline2(w * 0.42, h * 0.7, w * 0.16, h * 0.22, '#8d3520');
    // 南侧入口
    rect(w * 0.4, h * 0.9, w * 0.2, h * 0.05, '#f3ebd7');
    outline2(0, 0, w, h, 'rgba(28,22,18,.62)');
    cam.label('北京大学图书馆', bb[0] + w / 2, bb[1] - 1.2, 10.5, '#ffeccc', 0.95);
  } else if (kind === 'podium') {
    drawBuilding(ctx, b, cam, hour);
    // 主体：米白石材 + 红色两翼
    rect(0, 0, w, h, '#e6dcc4');
    outline2(0, 0, w, h, 'rgba(28,22,18,.55)');
    rect(w * 0.3, h * 0.05, w * 0.4, h * 0.5, '#d9cdb2');
    outline2(w * 0.3, h * 0.05, w * 0.4, h * 0.5, '#8d3520');
    rect(w * 0.36, h * 0.12, w * 0.28, h * 0.32, '#efe2c4');
    // 中央竖窗
    ctx.fillStyle = '#5f93a8';
    for (let i = 0; i < 5; i++) ctx.fillRect(X(w * 0.4 + i * w * 0.05), Y(h * 0.16), Math.max(1, PW(1.2)), PW(h * 0.22));
    // 两侧红坡屋顶
    rect(0.6, h * 0.05, w * 0.26, h * 0.34, '#bf5330');
    outline2(0.6, h * 0.05, w * 0.26, h * 0.34, '#8d3520');
    rect(w * 0.734, h * 0.05, w * 0.26, h * 0.34, '#bf5330');
    outline2(w * 0.734, h * 0.05, w * 0.26, h * 0.34, '#8d3520');
    // 南侧柱廊
    ctx.fillStyle = 'rgba(90,80,60,.35)';
    for (let i = 0; i < 16; i++) ctx.fillRect(X(w * 0.05 + i * w * 0.06), Y(h * 0.72), Math.max(1, PW(1)), PW(h * 0.16));
    // 台阶
    rect(w * 0.36, h * 0.9, w * 0.28, h * 0.07, '#cfd3c6');
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

// 树种配色（同一棵树在 4 组色里取一组，避免整片同色）
const SPECIES = {
  round:   { tones: [['#4f8a3a', '#6fae4c', '#3c7030'], ['#558f3e', '#75b452', '#3f7533'], ['#487f36', '#67a646', '#36672c'], ['#5c9442', '#7cb856', '#447a37']] },
  broad:   { tones: [['#467f34', '#66a544', '#35622b'], ['#4d8839', '#6dae4c', '#396a2f'], ['#427a31', '#61a041', '#315c28'], ['#518c3c', '#72b250', '#3b6d31']] },
  pine:    { tones: [['#2f6a3e', '#3f7f4b', '#245431'], ['#2b6339', '#387645', '#204d2c'], ['#336f42', '#438550', '#275a35'], ['#2e6740', '#3d7c4c', '#224f30']] },
  cypress: { tones: [['#2c5f38', '#3a7545', '#214a2b'], ['#2a5b35', '#376f41', '#1e4427'], ['#31653c', '#3f7a49', '#24502e'], ['#2d6139', '#3b7646', '#224c2d']] },
  willow:  { tones: [['#5f9440', '#82b455', '#4a7a33'], ['#67a047', '#8cbe5c', '#517f38'], ['#588c3c', '#79ad51', '#446f2f'], ['#6aa54b', '#90c260', '#54833b']] },
  ginkgo:  { tones: [['#7fa63a', '#a3c554', '#64852d'], ['#89b040', '#aecf5e', '#6b8c31'], ['#76a137', '#9bc04e', '#5d7f2a'], ['#93b845', '#b8d766', '#749434']] },
  maple:   { tones: [['#8f5f3c', '#a87a4a', '#6f4630'], ['#4f8338', '#6fa84a', '#3a652a'], ['#9a6a42', '#b58954', '#7a5033'], ['#578c3c', '#77b250', '#3e6d2f']] },
  bush:    { tones: [['#3f7a33', '#58983f', '#2f5d27'], ['#45822f', '#5da03c', '#335f24'], ['#3a7230', '#52913c', '#2b5523'], ['#4a8836', '#63a544', '#375f28']] },
};

export function drawTree(ctx, t, cam) {
  const x = Math.round(cam.sx(t.x));
  const y = Math.round(cam.sy(t.y));
  const s = t.s * cam.zoom;
  const sp = SPECIES[t.kind] || SPECIES.round;
  const tone = sp.tones[t.tone % sp.tones.length];

  // 硬投影（1px 偏移，不模糊）
  ctx.fillStyle = 'rgba(30,50,26,.22)';
  const rs = Math.max(2, Math.round((t.kind === 'bush' ? 2.6 : 4.4) * s));
  ctx.fillRect(x - rs + 1, y + 1, rs * 2, 1);
  ctx.fillRect(x - rs + 2, y + 2, rs * 2 - 2, 1);

  if (t.kind === 'bush') {
    ctx.fillStyle = tone[0];
    ctx.fillRect(x - Math.round(2.6 * s), y - Math.round(1.6 * s), Math.round(5.2 * s), Math.max(1, Math.round(2.2 * s)));
    ctx.fillStyle = tone[1];
    ctx.fillRect(x - Math.round(1.8 * s), y - Math.round(2.4 * s), Math.round(3.4 * s), Math.max(1, Math.round(1.4 * s)));
    return;
  }

  // 树干
  ctx.fillStyle = '#4a3325';
  ctx.fillRect(x - 1, y - Math.round(2.6 * s), 2, Math.max(2, Math.round(3.4 * s)));

  if (t.kind === 'pine') {
    for (let i = 0; i < 3; i++) {
      const w = Math.round((4.4 - i * 1.15) * s);
      const yy = Math.round(y - (2.6 + i * 2.9) * s);
      ctx.fillStyle = i === 0 ? tone[0] : tone[1];
      ctx.fillRect(x - w, yy, w * 2, Math.max(1, Math.round(2.2 * s)));
    }
    ctx.fillStyle = tone[0];
    ctx.fillRect(x - 1, Math.round(y - 12 * s), 2, Math.max(1, Math.round(1.4 * s)));
  } else if (t.kind === 'cypress') {
    for (let i = 0; i < 5; i++) {
      const w = Math.round((3.3 - i * 0.55) * s);
      const yy = Math.round(y - (3.0 + i * 2.2) * s);
      ctx.fillStyle = i % 2 ? tone[0] : tone[1];
      ctx.fillRect(x - w, yy, w * 2, Math.max(1, Math.round(2.2 * s)));
    }
  } else if (t.kind === 'willow') {
    ctx.fillStyle = tone[0];
    pixelDisc(ctx, x, y - Math.round(5.6 * s), Math.round(4.8 * s), tone[0]);
    ctx.fillStyle = tone[1];
    pixelDisc(ctx, x - Math.round(0.8 * s), y - Math.round(6.6 * s), Math.round(3.4 * s), tone[1]);
    // 垂枝
    ctx.fillStyle = tone[0];
    for (let i = -3; i <= 3; i++) {
      const dx = Math.round(i * 1.5 * s);
      ctx.fillRect(x + dx, Math.round(y - 3.4 * s), 1, Math.round(3.2 * s));
    }
  } else {
    // 阔叶/银杏/枫/圆冠：暗描边 + 深色树冠 + 中间层受光（避免同心圆）
    const r = (t.kind === 'round' ? 6.2 : t.kind === 'ginkgo' ? 6.8 : 7.4) * s;
    pixelDisc(ctx, x, y - Math.round(5.6 * s), Math.round(r + 0.8), 'rgba(22,38,20,.55)');
    pixelDisc(ctx, x, y - Math.round(5.6 * s), Math.round(r), tone[2]);
    pixelDisc(ctx, x - Math.round(r * 0.26), y - Math.round(6.4 * s), Math.round(r * 0.66), tone[0]);
    ctx.fillStyle = tone[1];
    ctx.fillRect(x - Math.round(r * 0.34), y - Math.round(8.6 * s), Math.max(1, Math.round(r * 0.4)), 1);
  }
}
// ---------------- 石碑 / 石像 / 华表 / 石刻 ----------------
const STONE = '#d6d1c4';
const STONE_DARK = '#a9a396';
const STONE_EDGE = 'rgba(32,36,32,.62)';
const BRONZE = '#7d6b4c';
const BRONZE_DARK = '#5b4c34';

export function drawHeritage(ctx, h, cam) {
  const S = cam.scale;
  const x = Math.round(cam.sx(h.x));
  const y = Math.round(cam.sy(h.y));
  const u = Math.max(1, Math.round(S * 0.5));      // 半米
  const t = heritageType(h.name);
  const box = (dx, dy, w, hh, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + dx, y + dy, w, hh);
  };
  const outline = (dx, dy, w, hh) => {
    ctx.strokeStyle = STONE_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + dx + 0.5, y + dy + 0.5, w - 1, hh - 1);
  };

  // 投影
  ctx.fillStyle = 'rgba(32,44,30,.22)';
  ctx.fillRect(x - u * 2 + 1, y + 1, u * 4, 1);

  if (t === 'column') {
    box(-u * 2, -u * 2, u * 4, u * 2, STONE_DARK);       // 台基
    outline(-u * 2, -u * 2, u * 4, u * 2);
    const sw = Math.max(3, Math.round(u * 1.5));         // 柱身
    box(-Math.round(sw / 2), -u * 20, sw, u * 18, STONE);
    ctx.strokeStyle = STONE_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - Math.round(sw / 2) + 0.5, y - u * 20 + 0.5, sw - 1, u * 18 - 1);
    box(-u * 3, -u * 17, u * 6, Math.max(2, u), STONE_DARK);  // 云板
    box(-u, -u * 22, u * 2, u * 2, STONE);               // 承露盘
    ctx.fillStyle = 'rgba(255,252,240,.5)';
    ctx.fillRect(x - Math.round(sw / 2) + 1, y - u * 20, Math.max(1, Math.round(u * 0.4)), u * 18);
  } else if (t === 'statue') {
    box(-u * 3.5, -u * 3, u * 7, u * 3, STONE_DARK);     // 基座
    outline(-u * 3.5, -u * 3, u * 7, u * 3);
    box(-u * 1.5, -u * 9, u * 3, u * 6, BRONZE);         // 身体
    box(-u, -u * 12, u * 2, u * 3, BRONZE);              // 头+肩
    box(-u * 1.5, -u * 8, Math.max(1, Math.round(u * 0.7)), u * 4, BRONZE_DARK);
    ctx.fillStyle = 'rgba(255,240,200,.28)';
    ctx.fillRect(x - u + 1, y - u * 11, 1, u * 7);
  } else if (t === 'bell') {
    box(-u * 2, -u * 1, u * 4, u, STONE_DARK);
    box(-u, -u * 6, u * 2, u * 5, '#8a6a3a');
    box(-u * 2, -u * 7, u * 4, Math.max(1, u * 0.6), '#9a7742');
    box(-u, -u * 1, u * 2, Math.max(1, u * 0.5), '#6d5227');
  } else if (t === 'belltower') {
    box(-u * 3, -u * 2, u * 6, u * 2, STONE_DARK);
    box(-u * 3, -u * 8, u, u * 6, '#8d3520');            // 柱
    box(u * 2, -u * 8, u, u * 6, '#8d3520');
    box(-u * 4, -u * 10, u * 8, u * 2, '#8a6a3a');       // 亭顶
    box(-u * 5, -u * 10, u * 10, Math.max(1, u * 0.6), '#6d5227');
    box(-u, -u * 8, u * 2, u * 3, '#a8873f');            // 钟
  } else if (t === 'fish') {
    box(-u * 3, -u, u * 5, u * 2, STONE);
    box(u * 2, -u * 2, u * 2, u * 2, STONE_DARK);        // 翻尾
    box(-u * 4, -u, u, Math.max(1, u), STONE_DARK);      // 头
    outline(-u * 3, -u, u * 5, u * 2);
  } else if (t === 'offering') {
    for (let i = -2; i <= 2; i++) {
      const hh = u * (i === 0 ? 3 : 2);
      box(i * u * 2 - u * 0.5, -hh, u, hh, i === 0 ? STONE : STONE_DARK);
      outline(i * u * 2 - u * 0.5, -hh, u, hh);
    }
  } else if (t === 'tomb') {
    ctx.fillStyle = '#4f8a3c';
    ctx.fillRect(x - u * 5, y - u * 3, u * 10, u * 3);
    ctx.fillStyle = 'rgba(40,80,30,.35)';
    ctx.fillRect(x - u * 5, y - 1, u * 10, 1);
    box(-u * 2, -u * 11, u * 4, u * 8, STONE);
    box(-u * 3, -u * 3, u * 6, u, STONE_DARK);
    outline(-u * 2, -u * 11, u * 4, u * 8);
    outline(-u * 3, -u * 3, u * 6, u);
    ctx.fillStyle = 'rgba(60,58,48,.45)';
    for (let i = 0; i < 3; i++) ctx.fillRect(x - 1, y - u * 10 + i * u * 2.2, 2, Math.max(1, u * 0.8));
  } else if (t === 'gate') {
    box(-u * 3, -u * 2, u * 6, u * 2, STONE_DARK);
    box(-u * 3, -u * 8, u, u * 6, '#8d3520');
    box(u * 2, -u * 8, u, u * 6, '#8d3520');
    box(-u * 4, -u * 10, u * 8, u * 2, '#5d6a78');
    box(-u * 5, -u * 10, u * 10, Math.max(1, u * 0.6), '#404b57');
  } else if (t === 'screen') {
    box(-u * 3, -u * 5, u * 6, u * 4, STONE);
    box(-u * 4, -u * 2, u * 8, u * 2, STONE_DARK);
    outline(-u * 3, -u * 5, u * 6, u * 4);
    ctx.fillStyle = 'rgba(90,86,70,.45)';
    ctx.fillRect(x - u * 2, y - u * 4, u * 4, 1);
    ctx.fillRect(x - u * 2, y - u * 3, u * 2, 1);
  } else if (t === 'trough') {
    box(-u * 4, -u * 2, u * 8, u * 2, STONE);
    ctx.fillStyle = STONE_DARK;
    ctx.fillRect(x - u * 3, y - u * 1.6, u * 6, Math.max(1, u * 0.5));
    outline(-u * 4, -u * 2, u * 8, u * 2);
  } else if (t === 'fragment') {
    box(-u * 3, -u * 2, u * 2, u * 2, STONE);
    box(0, -u * 3, u * 2, u * 3, STONE_DARK);
    box(u * 2, -u, u * 2, u, STONE);
    outline(-u * 3, -u * 2, u * 2, u * 2);
  } else if (t === 'plank') {
    box(-u * 4, -u * 2, u * 8, u * 2, '#c6c1b1');
    box(-u * 4, -u * 2, u * 8, 1, '#e6e1d0');
    ctx.fillStyle = 'rgba(90,86,70,.5)';
    for (let i = -3; i < 4; i += 2) ctx.fillRect(x + i * u, y - u * 2, 1, u * 2);
  } else if (t === 'star') {
    box(-u * 2, -u * 3, u * 4, u * 3, STONE_DARK);
    box(-u * 1.5, -u * 2.8, u * 3, u * 2.2, STONE);
    ctx.fillStyle = '#e8d58a';
    ctx.fillRect(x - 1, y - u * 2, 2, 2);
  } else if (t === 'stone') {
    box(-u * 2, -u * 2, u * 4, u * 2, STONE);
    box(-u * 2, -u * 3, u * 3, u, STONE);
    outline(-u * 2, -u * 2, u * 4, u * 2);
  } else {
    // 石碑：台座 + 碑身 + 碑首
    box(-u * 2.5, -u, u * 5, u, STONE_DARK);
    outline(-u * 2.5, -u, u * 5, u);
    box(-u * 2, -u * 8, u * 4, u * 7, STONE);
    box(-u * 1.5, -u * 9, u * 3, u, STONE);
    outline(-u * 2, -u * 8, u * 4, u * 7);
    ctx.fillStyle = 'rgba(92,88,72,.55)';
    for (let i = 0; i < 3; i++) ctx.fillRect(x - 1, y - u * 7 + i * u * 1.6, 2, Math.max(1, u * 0.7));
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
