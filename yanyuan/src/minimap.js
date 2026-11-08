// 小地图与全图：静态底图预渲染 + 玩家/目的地叠加
import { clamp } from './util.js';

const MAP_COLORS = {
  bg: '#eef2e3',
  green: '#cfe2b1',
  wooded: '#b9d69a',
  sport: '#c8ddb0',
  water: '#a5d3e8',
  waterEdge: '#7fb8d2',
  roadCase: '#d8d2c2',
  road: '#fdfcf6',
  path: '#efe9d8',
  building: '#c8bfae',
  buildingEdge: '#9a9284',
  heritage: '#d9a441',
  gate: '#c8553d',
};

const LABEL_SET = new Set([
  '未名湖', '博雅塔', '北京大学图书馆', '百周年纪念讲堂', '静园草坪', '燕南园',
  '北京大学西门', '东操场', '五四体育场', '勺园 · 住宿与交流片区', '鸣鹤园', '办公楼（贝公楼）',
  '农园餐厅', '学一食堂', '第二体育馆', '朗润园', '镜春园', '邱德拔体育馆',
]);

function ringPath(g, f, tx, ty, s) {
  g.moveTo(tx(f[0]), ty(f[1]));
  for (let i = 2; i < f.length; i += 2) g.lineTo(tx(f[i]), ty(f[i + 1]));
  g.closePath();
}

export function buildMapLayers(world) {
  const [wx0, wy0, wx1, wy1] = world.world;
  const wm = wx1 - wx0, hm = wy1 - wy0;

  function render(scale) {
    const W = Math.round(wm * scale), H = Math.round(hm * scale);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const tx = (x) => (x - wx0) * scale;
    const ty = (y) => (y - wy0) * scale;

    g.fillStyle = MAP_COLORS.bg;
    g.fillRect(0, 0, W, H);

    for (const lc of world.landcover) {
      g.beginPath(); ringPath(g, lc.ring, tx, ty, scale);
      g.fillStyle = lc.wooded ? MAP_COLORS.wooded : MAP_COLORS.green;
      g.fill();
    }
    for (const s of world.sports) {
      g.beginPath(); ringPath(g, s.ring, tx, ty, scale);
      g.fillStyle = MAP_COLORS.sport; g.fill();
      g.strokeStyle = '#a9c58c'; g.lineWidth = 0.5; g.stroke();
    }
    for (const w of world.water) {
      for (const ring of w.rings) {
        g.beginPath(); ringPath(g, ring, tx, ty, scale);
        g.fillStyle = MAP_COLORS.water; g.fill();
        g.strokeStyle = MAP_COLORS.waterEdge; g.lineWidth = Math.max(0.5, 0.6 * scale); g.stroke();
      }
    }
    for (const b of world.buildings) {
      for (const poly of b.polys) {
        g.beginPath();
        for (const ring of poly) ringPath(g, ring, tx, ty, scale);
        g.fillStyle = b.heritage ? '#d8c9a6' : MAP_COLORS.building;
        g.fill('evenodd');
        g.strokeStyle = MAP_COLORS.buildingEdge;
        g.lineWidth = Math.max(0.35, 0.22 * scale);
        g.stroke();
      }
    }
    const roads = world.roads.slice().sort((a, b) => b.w - a.w);
    for (const r of roads) {
      g.beginPath();
      g.moveTo(tx(r.pts[0]), ty(r.pts[1]));
      for (let i = 2; i < r.pts.length; i += 2) g.lineTo(tx(r.pts[i]), ty(r.pts[i + 1]));
      const w = Math.max(0.7, r.w * scale);
      g.strokeStyle = r.kind === 'steps' ? MAP_COLORS.path : MAP_COLORS.roadCase;
      g.lineWidth = w + Math.max(0.8, 0.7 * scale);
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.stroke();
      g.strokeStyle = r.kind === 'steps' ? MAP_COLORS.path : MAP_COLORS.road;
      g.lineWidth = w;
      g.stroke();
    }
    // 边界
    g.beginPath(); ringPath(g, world.boundary, tx, ty, scale);
    g.strokeStyle = 'rgba(90,110,80,.45)';
    g.setLineDash([3, 3]);
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);

    for (const h of world.heritage) {
      g.beginPath(); g.arc(tx(h.x), ty(h.y), Math.max(1, 1.4 * scale), 0, Math.PI * 2);
      g.fillStyle = MAP_COLORS.heritage; g.fill();
    }
    for (const gate of world.gates) {
      g.beginPath(); g.arc(tx(gate.x), ty(gate.y), Math.max(1.6, 2.2 * scale), 0, Math.PI * 2);
      g.fillStyle = MAP_COLORS.gate; g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    }
    return { canvas: c, scale, tx, ty };
  }

  const full = render(0.62);
  return { full, world };
}

export class MapView {
  constructor(canvas, world, layers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.layers = layers;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.waypoint = null;
    this.player = null;
    this.others = [];
    this.fit();
    this._bind();
  }

  fit() {
    const cw = this.canvas.width, ch = this.canvas.height;
    const img = this.layers.full.canvas;
    const s = Math.min(cw / img.width, ch / img.height) * 0.96;
    this.scale = s;
    this.offsetX = (cw - img.width * s) / 2;
    this.offsetY = (ch - img.height * s) / 2;
  }

  _bind() {
    const c = this.canvas;
    let dragging = false, moved = 0, last = null;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const px = (e.clientX - r.left) * (c.width / r.width);
      const py = (e.clientY - r.top) * (c.height / r.height);
      return [px, py];
    };
    c.addEventListener('pointerdown', (e) => {
      dragging = true; moved = 0; last = pos(e); c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const [px, py] = pos(e);
      if (dragging && last) {
        const dx = px - last[0], dy = py - last[1];
        moved += Math.abs(dx) + Math.abs(dy);
        this.offsetX += dx; this.offsetY += dy;
        this._clamp();
        last = [px, py];
        this.draw();
      } else {
        this.hoverAt(px, py);
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (dragging && moved < 6) {
        const [px, py] = pos(e);
        this.clickAt(px, py);
      }
      dragging = false; last = null;
    });
    c.addEventListener('pointerleave', () => { dragging = false; last = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = pos(e);
      const [wx, wy] = this.toWorld(px, py);
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      this.scale = clamp(this.scale * factor, 0.2, 6);
      // 保持光标下的世界点不动
      const img = this.layers.full.canvas;
      const f = img.width / (this.world.world[2] - this.world.world[0]);
      this.offsetX = px - (wx - this.world.world[0]) * f * this.scale;
      this.offsetY = py - (wy - this.world.world[1]) * f * this.scale;
      this._clamp();
      this.draw();
    }, { passive: false });
  }

  _imgScale() { return this.scale; }

  _clamp() {
    const img = this.layers.full.canvas;
    const w = img.width * this.scale, h = img.height * this.scale;
    const cw = this.canvas.width, ch = this.canvas.height;
    this.offsetX = clamp(this.offsetX, Math.min(0, cw - w), Math.max(0, cw - w));
    this.offsetY = clamp(this.offsetY, Math.min(0, ch - h), Math.max(0, ch - h));
  }

  /** 画布像素 -> 世界米 */
  toWorld(px, py) {
    const [wx0, wy0] = this.world.world;
    const ix = (px - this.offsetX) / this.scale;
    const iy = (py - this.offsetY) / this.scale;
    const f = this.layers.full.canvas.width / (this.world.world[2] - wx0);
    return [wx0 + ix / f * 1, wy0 + iy / f * 1];
  }

  toScreen(x, y) {
    const [wx0, wy0] = this.world.world;
    const f = this.layers.full.canvas.width / (this.world.world[2] - wx0);
    return [this.offsetX + (x - wx0) * f * this.scale, this.offsetY + (y - wy0) * f * this.scale];
  }

  setWaypoint(pt) { this.waypoint = pt; this.draw(); }

  clickAt(px, py) {
    const [x, y] = this.toWorld(px, py);
    if (!this.onPick) return;
    // 找最近的地标（12 米内）
    let best = null, bd = 14;
    for (const l of this.world.landmarks) {
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bd) { bd = d; best = l; }
    }
    this.onPick({ x, y, landmark: best });
  }

  hoverAt(px, py) {
    const [x, y] = this.toWorld(px, py);
    let best = null, bd = 10;
    for (const l of this.world.landmarks) {
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bd) { bd = d; best = l; }
    }
    const tip = document.getElementById('mapTip');
    if (tip) tip.textContent = best ? best.name : '拖动查看 · 滚轮缩放 · 点击设为目的地';
    this.canvas.style.cursor = best ? 'pointer' : 'crosshair';
  }

  draw() {
    const g = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#dfe7d2';
    g.fillRect(0, 0, cw, ch);
    g.imageSmoothingEnabled = true;
    const img = this.layers.full.canvas;
    g.drawImage(img, this.offsetX, this.offsetY, img.width * this.scale, img.height * this.scale);

    const f = img.width / (this.world.world[2] - this.world.world[0]);
    const sc = f * this.scale;

    // 主要地标文字
    if (sc > 0.5) {
      g.font = `${Math.round(clamp(11 * sc, 10, 16))}px "PingFang SC","Microsoft YaHei",sans-serif`;
      g.textAlign = 'center';
      for (const l of this.world.landmarks) {
        if (!LABEL_SET.has(l.name)) continue;
        const [sx, sy] = this.toScreen(l.x, l.y);
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(253,250,243,.9)';
        g.strokeText(l.name, sx, sy - 5);
        g.fillStyle = '#3c4a34';
        g.fillText(l.name, sx, sy - 5);
      }
    }

    // 目的地
    if (this.waypoint) {
      const [sx, sy] = this.toScreen(this.waypoint.x, this.waypoint.y);
      g.fillStyle = '#c8553d';
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx - 6, sy - 13);
      g.lineTo(sx + 6, sy - 13);
      g.closePath();
      g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
      g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    }

    // 其他玩家
    for (const p of this.others) {
      const [sx, sy] = this.toScreen(p.x, p.y);
      g.beginPath(); g.arc(sx, sy, 3.5, 0, Math.PI * 2);
      g.fillStyle = 'rgba(63,111,168,.9)'; g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    }

    // 自己
    if (this.player) {
      const [sx, sy] = this.toScreen(this.player.x, this.player.y);
      g.beginPath(); g.arc(sx, sy, 5.5, 0, Math.PI * 2);
      g.fillStyle = '#c8553d'; g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
    }
  }
}

/** 小地图 + 视野框 + 目的地 + 附近玩家 */
export class MiniMap {
  constructor(canvas, world, layers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.layers = layers;
    this.base = null;
  }

  _ensureBase() {
    if (this.base) return;
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    const img = this.layers.full.canvas;
    const s = Math.min(c.width / img.width, c.height / img.height);
    const w = img.width * s, h = img.height * s;
    g.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    this.base = c;
    this.baseRect = { x: (c.width - w) / 2, y: (c.height - h) / 2, w, h };
  }

  /** 世界米 -> 小地图像素 */
  _toScreen(x, y) {
    this._ensureBase();
    const [wx0, wy0, wx1, wy1] = this.world.world;
    const r = this.baseRect;
    return [r.x + ((x - wx0) / (wx1 - wx0)) * r.w, r.y + ((y - wy0) / (wy1 - wy0)) * r.h];
  }

  draw(player, others, waypoint, viewRect) {
    this._ensureBase();
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.base, 0, 0);

    // 视野框
    if (viewRect) {
      const [ax, ay] = this._toScreen(viewRect[0], viewRect[1]);
      const [bx, by] = this._toScreen(viewRect[2], viewRect[3]);
      g.strokeStyle = 'rgba(60,80,50,.55)';
      g.lineWidth = 1.5;
      g.strokeRect(ax, ay, Math.max(3, bx - ax), Math.max(3, by - ay));
    }
    for (const p of others) {
      const [sx, sy] = this._toScreen(p.x, p.y);
      g.beginPath(); g.arc(sx, sy, 2.6, 0, Math.PI * 2);
      g.fillStyle = 'rgba(63,111,168,.95)'; g.fill();
    }
    if (waypoint) {
      const [sx, sy] = this._toScreen(waypoint.x, waypoint.y);
      g.fillStyle = '#c8553d';
      g.beginPath();
      g.moveTo(sx, sy); g.lineTo(sx - 4, sy - 9); g.lineTo(sx + 4, sy - 9);
      g.closePath(); g.fill();
    }
    if (player) {
      const [sx, sy] = this._toScreen(player.x, player.y);
      g.beginPath(); g.arc(sx, sy, 4, 0, Math.PI * 2);
      g.fillStyle = '#c8553d'; g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.8; g.stroke();
    }
  }
}
