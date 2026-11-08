// 玩家进度：探索记录、校园猫关系、成就、物品、统计
import { clamp } from './util.js';
import { AFF } from './cats.js';

export function defaultProgress() {
  return {
    ver: 1,
    visited: {},
    cats: {},
    items: [],
    ach: {},
    title: '',
    stats: { dist: 0, bike: 0, photos: 0, chats: 0 },
  };
}

export function normalizeProgress(raw) {
  const p = defaultProgress();
  if (!raw || typeof raw !== 'object') return p;
  if (raw.visited && typeof raw.visited === 'object') p.visited = { ...raw.visited };
  if (raw.cats && typeof raw.cats === 'object') p.cats = { ...raw.cats };
  if (Array.isArray(raw.items)) p.items = raw.items.filter(x => typeof x === 'string').slice(0, 60);
  if (raw.ach && typeof raw.ach === 'object') p.ach = { ...raw.ach };
  if (typeof raw.title === 'string') p.title = raw.title.slice(0, 20);
  if (raw.stats) {
    p.stats = {
      dist: Number(raw.stats.dist) || 0,
      bike: Number(raw.stats.bike) || 0,
      photos: Number(raw.stats.photos) || 0,
      chats: Number(raw.stats.chats) || 0,
    };
  }
  return p;
}

// ---------------- 成就 ----------------
export const ACHIEVEMENTS = [
  { id: 'enter', name: '初入燕园', desc: '进入校园', title: '新生', test: () => true },
  { id: 'lake', name: '未名湖边', desc: '走到未名湖', title: '湖边散步的人', test: (p) => !!p.visited['未名湖'] },
  { id: 'tower', name: '塔影', desc: '走到博雅塔下', title: '塔下常客', test: (p) => !!p.visited['博雅塔'] },
  { id: 'library', name: '藏书楼', desc: '走到图书馆前', title: '借书的人', test: (p) => !!p.visited['北京大学图书馆'] },
  { id: 'westgate', name: '从西门进来', desc: '走到西门', title: '走西门的人', test: (p) => Object.keys(p.visited).some(k => k.includes('西门')) },
  { id: 'photo1', name: '第一张照片', desc: '在校园里拍一张照片', title: '摄影新手', test: (p) => p.stats.photos >= 1 },
  { id: 'cat1', name: '遇见一只猫', desc: '认识第一只校园猫', title: '猫的朋友', test: (p) => Object.keys(p.cats).length >= 1 },
  { id: 'cat3', name: '猫缘', desc: '认识 3 只校园猫', title: '猫缘很好', test: (p) => Object.keys(p.cats).length >= 3 },
  { id: 'cat_follow', name: '它跟着你', desc: '让一只猫愿意跟着你', title: '被猫选中的人', test: (p) => Object.values(p.cats).some(c => (c.a || 0) >= AFF.follow) },
  { id: 'walk1000', name: '走过一千米', desc: '累计步行 1 公里', title: '散步者', test: (p) => p.stats.dist >= 1000 },
  { id: 'bike500', name: '骑车穿过校园', desc: '累计骑行 500 米', title: '骑车的人', test: (p) => p.stats.bike >= 500 },
  { id: 'explore30', name: '燕园三十处', desc: '发现 30 个地点', title: '燕园通', test: (p) => Object.keys(p.visited).length >= 30 },
  { id: 'chat1', name: '打个招呼', desc: '在校园频道发出第一条消息', title: '健谈的人', test: (p) => p.stats.chats >= 1 },
  { id: 'night', name: '夜色燕园', desc: '在 20:00 之后仍在校内', title: '夜猫子', test: (p, ctx) => ctx.hour >= 20 || ctx.hour < 5 },
];

export const TITLE_ORDER = ACHIEVEMENTS.map(a => a.title);

/** 返回本次新解锁的成就 ID 列表，并写入 progress */
export function evaluateAchievements(progress, ctx) {
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (progress.ach[a.id]) continue;
    let ok = false;
    try { ok = !!a.test(progress, ctx); } catch { ok = false; }
    if (ok) {
      progress.ach[a.id] = Date.now();
      unlocked.push(a);
    }
  }
  return unlocked;
}

export function achievementName(id) {
  const a = ACHIEVEMENTS.find(x => x.id === id);
  return a ? a.name : id;
}

// ---------------- 探索 ----------------
export const DISCOVER_RADIUS = 30; // 米

export function discoverNearby(world, progress, x, y) {
  const found = [];
  for (const l of world.nearbyLandmarks(x, y, DISCOVER_RADIUS)) {
    if (progress.visited[l.name]) continue;
    progress.visited[l.name] = Date.now();
    found.push(l);
  }
  return found;
}

export function exploreCount(world, progress) {
  let n = 0;
  for (const l of world.landmarks) {
    if (l.aliasOf) continue;
    if (progress.visited[l.name]) n++;
  }
  return { found: n, total: world.exploreTotal };
}

// ---------------- 校园猫 ----------------
export function catState(progress, id) {
  const c = progress.cats[id];
  return { a: (c && c.a) || 0, t: (c && c.t && c.t) || 0, f: !!(c && c.f) };
}

export function bumpCat(progress, id, amount, { max = 100 } = {}) {
  const cur = catState(progress, id);
  const next = clamp(Math.round(cur.a + amount), 0, max);
  progress.cats[id] = { a: next, t: Date.now(), f: cur.f };
  return next;
}

export function setCatFollowing(progress, id, on) {
  const cur = catState(progress, id);
  progress.cats[id] = { a: cur.a, t: Date.now(), f: !!on };
}

export function addItem(progress, name) {
  if (!name) return false;
  if (progress.items.includes(name)) return false;
  if (progress.items.length >= 60) progress.items.shift();
  progress.items.push(name);
  return true;
}

// ---------------- 存档节流 ----------------
export class ProgressStore {
  constructor(api, progress) {
    this.api = api;
    this.progress = progress;
    this.dirty = false;
    this.timer = null;
    this.saving = false;
    this.lastSaved = 0;
    this.onError = null;
    this.onSaved = null;
  }

  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 4000);
  }

  async flush(force = false) {
    if (this.saving) return;
    if (!this.dirty && !force) return;
    this.saving = true;
    this.dirty = false;
    try {
      const res = await this.api.saveProgress(this.progress);
      this.lastSaved = Date.now();
      this.onSaved && this.onSaved(res);
    } catch (e) {
      this.dirty = true;
      this.onError && this.onError(e);
    } finally {
      this.saving = false;
    }
  }
}
