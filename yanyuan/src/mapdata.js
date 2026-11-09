// 地图数据装载与索引：碰撞、空间网格、树木生成、地标检索
import { toFlat, polyBBox, pointInPoly, circlePoly, mulberry32, distToSeg, clamp } from './util.js?v=202611090903';

export const PPM = 8; // 每米像素数（世界渲染基准）

// 需要专属造型的地标
export const HERO_BY_NAME = {
  '博雅塔': 'boya',
  '北京大学图书馆': 'library',
  '百周年纪念讲堂': 'podium',
  '北大西门': 'westgate',
};
// 用立面绘制的高结构：不铺地面铺装，避免地面上留一个空框
export const BILLBOARD_HEROES = new Set(['boya', 'westgate']);

export class World {
  constructor(raw) {
    this.raw = raw;
    this.meta = raw.meta || {};
    // 分米 -> 米
    const S = 0.1;
    this.world = raw.world.map(v => v * S);           // [x0,y0,x1,y1]
    this.boundary = this._ring(raw.boundary, S);

    this.water = (raw.water || []).map(w => {
      const rings = w.polys.map(p => this._ring(p, S));
      return { name: w.name, rings, bbox: unionBBox(rings), label: w.label.map(v => v * S) };
    });

    this.buildings = (raw.buildings || []).map(b => {
      const polys = b.polys.map(rings => rings.map(r => this._ring(r, S)));
      const outer = polys.map(p => p[0]);
      const bbox = unionBBox(outer);
      let area = 0;
      for (const r of outer) area += Math.abs(ringArea(r));
      return {
        id: b.id, name: b.name, cat: b.cat, h: b.h, fl: b.fl, roof: b.roof, style: b.style,
        label: [b.label[0] * S, b.label[1] * S], polys, outer, bbox, area,
        alias: b.alias || [], heritage: !!b.heritage, sortY: bbox[3],
        hero: HERO_BY_NAME[b.name] || null,
      };
    });

    this.roads = (raw.roads || []).map(r => {
      const pts = new Float32Array(r.pts.length * 2);
      for (let i = 0; i < r.pts.length; i++) { pts[i * 2] = r.pts[i][0] * S; pts[i * 2 + 1] = r.pts[i][1] * S; }
      const xs = [], ys = [];
      for (let i = 0; i < pts.length; i += 2) { xs.push(pts[i]); ys.push(pts[i + 1]); }
      return { name: r.name, w: r.w, kind: r.kind, pts, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    });

    this.landcover = (raw.landcover || []).map(l => {
      const ring = this._ring(l.ring, S);
      return { name: l.name, wooded: l.wooded, ring, bbox: polyBBox(ring) };
    });

    this.sports = (raw.sports || []).map(s => {
      const ring = this._ring(s.ring, S);
      return { name: s.name, sport: s.sport, ring, bbox: polyBBox(ring) };
    });

    this.precincts = (raw.precincts || []).map(p => {
      const ring = this._ring(p.ring, S);
      return { name: p.name, ring, bbox: polyBBox(ring) };
    });

    this.piers = (raw.piers || []).map(p => {
      const ring = this._ring(p.ring, S);
      return { name: p.name, ring, bbox: polyBBox(ring) };
    });

    this.gates = (raw.gates || []).map(g => ({ name: g.name, x: g.pt[0] * S, y: g.pt[1] * S }));
    this.heritage = (raw.heritage || []).map(h => ({ name: h.name, x: h.pt[0] * S, y: h.pt[1] * S, kind: h.kind }));

    this.bridges = (raw.bridges || []).map(b => ({
      ax: b.a[0] * S, ay: b.a[1] * S, bx: b.b[0] * S, by: b.b[1] * S, w: b.width * S * 0.5,
    }));

    // 地标：用于搜索与探索
    // p = 标注点（多在建筑中心），a = 最近可达点（导航终点用这个）
    this.landmarks = [];
    for (const l of raw.landmarks || []) {
      const a = l.a || l.p;
      this.landmarks.push({
        name: l.n, type: l.t, x: l.p[0] * S, y: l.p[1] * S, kind: l.k,
        ax: a[0] * S, ay: a[1] * S, moved: (l.moved || 0),
      });
    }
    for (const a of raw.aliases || []) {
      const p = a.a || a.p;
      this.landmarks.push({
        name: a.n, type: a.t, x: a.p[0] * S, y: a.p[1] * S, kind: a.k, aliasOf: a.aliasOf,
        ax: p[0] * S, ay: p[1] * S, moved: 0,
      });
    }
    // 去重：同名同坐标，以及同一位置上近似的多个名字（如「北大西门」与「北京大学西门」）
    const seen = new Set();
    const byPlace = new Map();
    const kept = [];
    for (const l of this.landmarks) {
      const key = l.name + '|' + Math.round(l.x) + '|' + Math.round(l.y);
      if (seen.has(key)) continue;
      seen.add(key);
      if (l.aliasOf) { kept.push(l); continue; }
      const placeKey = Math.round(l.x / 8) + ',' + Math.round(l.y / 8);
      const prev = byPlace.get(placeKey);
      if (prev && samePlaceName(prev.name, l.name) && Math.hypot(prev.x - l.x, prev.y - l.y) < 12) {
        // 同一位置、同类地标：保留名字更短的那个，另一个并入检索别名
        if ([...l.name].length < [...prev.name].length) {
          prev.aliasOf = l.name;
          const idx = kept.indexOf(prev);
          if (idx >= 0) kept[idx] = l;
          byPlace.set(placeKey, l);
        } else {
          l.aliasOf = prev.name;
          kept.push(l);
        }
        continue;
      }
      byPlace.set(placeKey, l);
      kept.push(l);
    }
    this.landmarks = kept;
    this.exploreTotal = this.landmarks.filter(l => !l.aliasOf).length;

    this._fixWater();
    this._fixWaterBuildings();
    this._buildCollision();
    this._buildTrees();
  }

  /**
   * 数据里有个别水面多边形明显过大（把整片园区都盖成水）。
   * 判据：水面里压着 2 栋以上实体建筑 → 这个水面标错了，剔除。
   */
  _fixWater() {
    if (!this.water.length) return;
    const kept = [];
    let dropped = 0;
    for (const w of this.water) {
      let inside = 0;
      for (const b of this.buildings) {
        if (b.area < 40) continue;
        const [x0, y0, x1, y1] = b.bbox;
        const cx2 = (x0 + x1) / 2, cy2 = (y0 + y1) / 2;
        if (cx2 < w.bbox[0] || cx2 > w.bbox[2] || cy2 < w.bbox[1] || cy2 > w.bbox[3]) continue;
        if (w.rings.some(ring => pointInPoly(cx2, cy2, ring))) inside++;
        if (inside >= 2) break;
      }
      if (inside >= 2) { dropped++; continue; }
      kept.push(w);
    }
    this.water = kept;
    this.droppedWater = dropped;
  }

  /** 剔除压在水面上的无名小棚子；有名气的保留并标记，渲染时补一圈石台 */
  _fixWaterBuildings() {
    if (!this.water.length) return;
    const kept = [];
    let dropped = 0;
    for (const b of this.buildings) {
      const [x0, y0, x1, y1] = b.bbox;
      let wet = 0, tot = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const x = x0 + (x1 - x0) * (i + 0.5) / 4;
          const y = y0 + (y1 - y0) * (j + 0.5) / 4;
          if (!pointInPoly(x, y, b.outer[0])) continue;
          tot++;
          for (const w of this.water) {
            if (x < w.bbox[0] || x > w.bbox[2] || y < w.bbox[1] || y > w.bbox[3]) continue;
            if (w.rings.some(ring => pointInPoly(x, y, ring))) { wet++; break; }
          }
        }
      }
      b.wetRatio = tot ? wet / tot : 0;
      const anonymous = !b.name || /^\(?无名/.test(b.name);
      if (b.wetRatio > 0.5 && anonymous && b.area < 600) { dropped++; continue; }
      kept.push(b);
    }
    this.buildings = kept;
    this.droppedWet = dropped;
  }

  _ring(pairs, S) {
    const f = new Float32Array(pairs.length * 2);
    for (let i = 0; i < pairs.length; i++) { f[i * 2] = pairs[i][0] * S; f[i * 2 + 1] = pairs[i][1] * S; }
    return f;
  }

  // ---------- 碰撞 ----------
  _buildCollision() {
    this.CELL = 24;
    this.grid = new Map();
    this.obstacles = [];
    const add = (kind, ref, flat) => {
      const bb = polyBBox(flat);
      const idx = this.obstacles.length;
      this.obstacles.push({ kind, ref, flat, bbox: bb });
      const cs = this.CELL;
      const cx0 = Math.floor(bb[0] / cs), cx1 = Math.floor(bb[2] / cs);
      const cy0 = Math.floor(bb[1] / cs), cy1 = Math.floor(bb[3] / cs);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cx + ',' + cy;
          let arr = this.grid.get(k);
          if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push(idx);
        }
      }
    };

    for (const b of this.buildings) for (const ring of b.outer) add('building', b, ring);
    for (const w of this.water) for (const ring of w.rings) add('water', w, ring);
    // 水域掩码：判断点是否在桥面走廊内
  }

  _candidates(x, y, r) {
    const cs = this.CELL;
    const cx0 = Math.floor((x - r) / cs), cx1 = Math.floor((x + r) / cs);
    const cy0 = Math.floor((y - r) / cs), cy1 = Math.floor((y + r) / cs);
    const out = new Set();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const arr = this.grid.get(cx + ',' + cy);
        if (arr) for (const i of arr) out.add(i);
      }
    }
    return out;
  }

  onBridge(x, y) {
    for (const b of this.bridges) {
      if (distToSeg(x, y, b.ax, b.ay, b.bx, b.by) <= b.w) return true;
    }
    return false;
  }

  /** 角色能否站在 (x,y)：半径 r 的圆不与建筑/水面相交 */
  blocked(x, y, r = 0.5) {
    if (x < this.world[0] + 1 || y < this.world[1] + 1 || x > this.world[2] - 1 || y > this.world[3] - 1) return true;
    for (const i of this._candidates(x, y, r)) {
      const o = this.obstacles[i];
      if (o.kind === 'water') {
        if (this.onBridge(x, y)) continue;
        if (circlePoly(x, y, r * 0.6, o.flat)) return true;
      } else if (circlePoly(x, y, r, o.flat)) return true;
    }
    return false;
  }

  isWater(x, y) {
    for (const i of this._candidates(x, y, 0.1)) {
      const o = this.obstacles[i];
      if (o.kind === 'water' && pointInPoly(x, y, o.flat) && !this.onBridge(x, y)) return true;
    }
    return false;
  }

  // ---------- 树木（程序化装饰，固定随机种子保证一致） ----------
  _buildTrees() {
    const rng = mulberry32(20251108);
    const trees = [];
    const farFromRoad = (x, y, pad) => {
      for (const r of this.roads) {
        if (x < r.bbox[0] - pad || x > r.bbox[2] + pad || y < r.bbox[1] - pad || y > r.bbox[3] + pad) continue;
        const half = r.w * 0.5 + pad;
        for (let i = 0; i < r.pts.length - 2; i += 2) {
          if (distToSeg(x, y, r.pts[i], r.pts[i + 1], r.pts[i + 2], r.pts[i + 3]) < half) return false;
        }
      }
      return true;
    };
    const inBuilding = (x, y) => {
      for (const b of this.buildings) {
        if (x < b.bbox[0] - 2 || x > b.bbox[2] + 2 || y < b.bbox[1] - 2 || y > b.bbox[3] + 2) continue;
        for (const ring of b.outer) if (pointInPoly(x, y, ring)) return true;
      }
      return false;
    };
    const inWater = (x, y) => {
      for (const w of this.water) {
        if (x < w.bbox[0] || x > w.bbox[2] || y < w.bbox[1] || y > w.bbox[3]) continue;
        for (const ring of w.rings) if (pointInPoly(x, y, ring)) return true;
      }
      return false;
    };

    // 1) 绿地内成片树
    for (const lc of this.landcover) {
      const [x0, y0, x1, y1] = lc.bbox;
      const step = lc.wooded ? 5.5 : 8;
      const prob = lc.wooded ? 0.88 : 0.60;
      for (let y = y0 + 3; y < y1 - 3; y += step) {
        for (let x = x0 + 3; x < x1 - 3; x += step) {
          const px = x + (rng() - 0.5) * step * 0.8;
          const py = y + (rng() - 0.5) * step * 0.8;
          if (rng() > prob) continue;
          if (!pointInPoly(px, py, lc.ring)) continue;
          if (!farFromRoad(px, py, 1.8)) continue;
          if (inBuilding(px, py) || inWater(px, py)) continue;
          trees.push(this._tree(px, py, rng, this._nearWater(px, py)));
        }
      }
    }

    // 2) 主要道路两侧行道树
    for (const r of this.roads) {
      if (r.kind === 'steps' || r.w < 2.2) continue;
      const step = 12;
      for (let i = 0; i < r.pts.length - 2; i += 2) {
        const ax = r.pts[i], ay = r.pts[i + 1], bx = r.pts[i + 2], by = r.pts[i + 3];
        const segLen = Math.hypot(bx - ax, by - ay);
        if (segLen < 0.01) continue;
        const nx = -(by - ay) / segLen, ny = (bx - ax) / segLen;
        for (let d = 0; d < segLen; d += step) {
          if (rng() > 0.86) continue;
          const side = rng() > 0.5 ? 1 : -1;
          const off = r.w * 0.5 + 1.7 + rng() * 1.4;
          const sx = ax + (bx - ax) * (d / segLen) + nx * off * side;
          const sy = ay + (by - ay) * (d / segLen) + ny * off * side;
          if (inBuilding(sx, sy) || inWater(sx, sy)) continue;
          if (!farFromRoad(sx, sy, 0.9)) continue;
          trees.push(this._tree(sx, sy, rng, this._nearWater(sx, sy)));
        }
      }
    }
    // 3) 建筑周边灌木
    for (const b of this.buildings) {
      if (b.area < 90 || (b.wetRatio || 0) > 0.4) continue;
      const [x0, y0, x1, y1] = b.bbox;
      const n = Math.min(7, Math.max(1, Math.round(b.area / 300)));
      for (let i = 0; i < n; i++) {
        const pad = 2.2 + rng() * 3.2;
        const side = (rng() * 4) | 0;
        let x, y;
        if (side === 0) { x = x0 + rng() * (x1 - x0); y = y0 - pad; }
        else if (side === 1) { x = x1 + pad; y = y0 + rng() * (y1 - y0); }
        else if (side === 2) { x = x0 + rng() * (x1 - x0); y = y1 + pad; }
        else { x = x0 - pad; y = y0 + rng() * (y1 - y0); }
        if (!farFromRoad(x, y, 0.8)) continue;
        if (inBuilding(x, y) || inWater(x, y)) continue;
        trees.push({ x, y, kind: 'bush', s: 0.75 + rng() * 0.7, tone: (rng() * 4) | 0, seed: 0, flip: false });
      }
    }

    this.trees = trees;
    this._buildLamps();
  }

  /** 路灯：沿道路等距布置，供夜间照明 */
  _buildLamps() {
    const lamps = [];
    for (const r of this.roads) {
      if (r.kind === 'steps' || r.w < 2.2) continue;
      const gap = r.w >= 4 ? 38 : 54;
      let acc = 999;
      for (let i = 0; i < r.pts.length - 2; i += 2) {
        const ax = r.pts[i], ay = r.pts[i + 1], bx = r.pts[i + 2], by = r.pts[i + 3];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.01) continue;
        acc += len;
        if (acc < gap) continue;
        acc = 0;
        const nx = -(by - ay) / len, ny = (bx - ax) / len;
        const off = r.w * 0.5 + 1.4;
        const x = ax + nx * off, y = ay + ny * off;
        if (this.blocked(x, y, 0.35)) continue;
        lamps.push({ x, y });
      }
    }
    this.lamps = lamps;
  }

  _tree(x, y, rng, nearWater = false) {
    const r = rng();
    let kind;
    if (nearWater) {
      // 水边：柳树为主，少量槐
      kind = r < 0.62 ? 'willow' : r < 0.82 ? 'broad' : 'round';
    } else if (r < 0.10) kind = 'pine';
    else if (r < 0.20) kind = 'cypress';
    else if (r < 0.34) kind = 'ginkgo';
    else if (r < 0.44) kind = 'maple';
    else if (r < 0.50) kind = 'willow';
    else if (r < 0.74) kind = 'broad';
    else kind = 'round';
    return {
      x, y, kind,
      s: 0.85 + rng() * 1.15,
      tone: (rng() * 4) | 0,
      flip: rng() > 0.5,
      seed: (rng() * 65535) | 0,
    };
  }

  _nearWater(x, y, pad = 14) {
    for (const w of this.water) {
      if (x < w.bbox[0] - pad || x > w.bbox[2] + pad || y < w.bbox[1] - pad || y > w.bbox[3] + pad) continue;
      for (const ring of w.rings) if (pointInPoly(x, y, ring)) return true;
      // 岸边一圈也算
      for (const ring of w.rings) {
        for (let i = 0; i < ring.length - 2; i += 2) {
          if (distToSeg(x, y, ring[i], ring[i + 1], ring[i + 2], ring[i + 3]) < pad) return true;
        }
      }
    }
    return false;
  }

  // ---------- 查询 ----------
  /** 找到 (x,y) 附近的地标（用于地名显示） */
  placeAt(x, y, maxDist = 60) {
    let best = null, bestD = maxDist;
    for (const l of this.precincts) {
      if (pointInPoly(x, y, l.ring)) return { name: l.name, type: '片区' };
    }
    for (const l of this.landmarks) {
      if (l.aliasOf) continue;
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bestD) { bestD = d; best = l; }
    }
    if (best) return { name: best.name, type: best.type };
    // 湖面
    for (const w of this.water) if (w.name && inBBox(x, y, w.bbox)) return { name: w.name, type: '水域' };
    return { name: '燕园', type: '校园' };
  }

  /**
   * 用于探索进度：附近未发现的地标。
   * 判定用「到可达点的距离」而不是到建筑质心的距离——
   * 大建筑（如图书馆）质心离最近可走位置有 46 米，用质心永远判定不到。
   */
  nearbyLandmarks(x, y, r) {
    const out = [];
    for (const l of this.landmarks) {
      if (l.aliasOf) continue;
      const d = Math.hypot(l.ax - x, l.ay - y);
      const reach = (l.moved || 0) + r;
      if (d <= reach || Math.hypot(l.x - x, l.y - y) <= reach) out.push(l);
    }
    return out;
  }

  /** 地标导航终点（可达点）；玩家点在地图上的位置若不可走，就近吸附 */
  waypointFor(l) {
    return { x: l.ax, y: l.ay, name: l.name };
  }

  snapToWalkable(x, y, r = 0.8) {
    if (!this.blocked(x, y, r)) return [x, y];
    return this.findFree(x, y, r, 40);
  }

  search(query, limit = 40) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.landmarks.filter(l => !l.aliasOf).slice(0, limit);
    const scored = [];
    for (const l of this.landmarks) {
      const n = l.name.toLowerCase();
      let score = -1;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 80;
      else if (n.includes(q)) score = 60;
      else if (q.length > 1 && levenshtein(n, q) <= Math.max(1, Math.floor(q.length / 3))) score = 30;
      if (score > 0) scored.push([score, l]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
    return scored.slice(0, limit).map(s => s[1]);
  }

  /** 从起点往外找最近的可站立点，防止出生卡墙 */
  findFree(x, y, r = 0.6, maxR = 30) {
    if (!this.blocked(x, y, r)) return [x, y];
    for (let d = 1; d < maxR; d += 1) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const nx = x + Math.cos(a) * d, ny = y + Math.sin(a) * d;
        if (!this.blocked(nx, ny, r)) return [nx, ny];
      }
    }
    return [x, y];
  }
}

function inBBox(x, y, b) { return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]; }

/** 两个地名是否基本指同一处（如「北大西门」与「北京大学西门」） */
function samePlaceName(a, b) {
  if (a === b) return true;
  const A = new Set([...a]), B = new Set([...b]);
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.8;
}

function unionBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) {
    const b = polyBBox(r);
    if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3];
  }
  return [x0, y0, x1, y1];
}

function ringArea(f) {
  let a = 0;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    a += f[j] * f[i + 1] - f[i] * f[j + 1];
  }
  return a / 2;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

export async function loadMap(onProgress) {
  const { BUILD_ID } = await import('./api-base.js');
  const q = BUILD_ID && BUILD_ID !== 'dev' ? '?v=' + encodeURIComponent(BUILD_ID) : '';
  const url = new URL('../data/map.json' + q, import.meta.url).href;
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('地图数据加载失败：HTTP ' + res.status);
  const text = await res.text();
  onProgress && onProgress(0.6, '解析地图数据…');
  const raw = JSON.parse(text);
  onProgress && onProgress(0.8, '构建碰撞与植被…');
  const world = new World(raw);
  onProgress && onProgress(1, '准备就绪');
  return world;
}
