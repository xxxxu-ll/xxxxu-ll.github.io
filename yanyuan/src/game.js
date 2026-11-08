// 游戏主循环：移动、碰撞、镜头、多人同步、互动、地图、拍照
import { Camera, Ground, drawBuilding, drawTree, drawWaterAnim, drawTint, drawLabel, drawNightLights } from './render.js';
import { getCharacterSheet, drawCharacter, getCatSheet, drawCat, drawNameTag } from './sprites.js';
import { CAT_DEFS, Cat, AFF, affinityLabel } from './cats.js';
import {
  normalizeProgress, discoverNearby, evaluateAchievements, exploreCount,
  catState, bumpCat, setCatFollowing, addItem, ProgressStore,
} from './progress.js';
import { capturePhoto, savePhoto } from './photo.js';
import { MapView, MiniMap } from './minimap.js';
import * as ui from './ui.js';
import { clamp, dist, sanitizeText } from './util.js';

const SPEED = { walk: 3.4, run: 6.4, bike: 9.8 };
const BODY_R = 0.52;
const SYNC_MS = 1100;
const INTERACT_R = 2.8;

export class Game {
  constructor({ world, api, character, progress, layers, offline = false }) {
    this.world = world;
    this.api = api;
    this.character = character;
    this.offline = offline;
    this.progress = normalizeProgress(progress);
    this.store = new ProgressStore(api, this.progress);
    if (offline) {
      this.store.touch = () => {};
      this.store.flush = async () => {};
    }

    this.canvas = ui.el.canvas;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.cam = new Camera();
    this.ground = new Ground(world);
    this.layers = layers;

    const [sx, sy] = world.findFree(character.x ?? -158, character.y ?? 178, BODY_R, 12);
    this.me = {
      x: sx, y: sy, dir: character.dir || 'down', moving: false, mode: 'walk',
      anim: 0, frame: 0, dist: 0, bike: 0,
    };
    this.cam.x = this.me.x; this.cam.y = this.me.y;

    this.remotes = new Map();
    this.seenMessages = new Set();
    this.lastMsgAt = 0;
    this.waypoint = null;
    this.heartParticles = [];

    this.cats = CAT_DEFS.map((d, i) => {
      const c = new Cat(d, world, 9001 + i * 37);
      c._blocked = (x, y) => world.blocked(x, y, 0.35);
      c.petAt = 0;
      c.following = !!catState(this.progress, c.id).f;
      return c;
    });
    world.__cats = this.cats;

    this.keys = new Set();
    this.joy = { active: false, x: 0, y: 0, id: null };
    this.nearest = null;
    this.syncFails = 0;
    this.syncBusy = false;
    this.running = false;
    this.paused = false;
    this.showHud = true;
    this.lastFrame = 0;
    this.tAcc = 0;
    this.discoverAcc = 0;
    this.achAcc = 0;
    this.frameTime = 0;
    this.fpsSamples = [];

    this.store.onError = () => ui.toast('存档暂未保存，正在重试…', 'warn');
    this.store.onSaved = () => {};

    this._bindInput();
    this._bindUi();
  }

  // ---------------- 启动 ----------------
  start() {
    if (this.started) return;
    this.started = true;
    this.running = true;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 150));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.paused = true;
        this.store.flush(true);
      } else {
        this.paused = false;
        this.lastFrame = performance.now();
        this.sync(true);
      }
    });
    window.addEventListener('pagehide', () => {
      try { this.store.flush(true); } catch { /* ignore */ }
    });

    ui.el.hud.classList.remove('hidden');
    ui.setLocation('静园草坪');
    ui.clearChat();
    if (this.offline) {
      ui.pushChatLine({ sys: true, text: '离线漫游：进度不会保存，也看不到其他玩家。连上世界服务后重新进入即可联机。' });
      ui.showBanner('离线漫游 · 不保存进度', { info: true });
      setTimeout(() => ui.hideBanner(), 5000);
    } else {
      ui.pushChatLine({ sys: true, text: '欢迎来到像素燕园。用 WASD 或摇杆走走看，靠近猫按 E。' });
    }

    // 首次进入视为一次探索
    this.progress.ach.enter = this.progress.ach.enter || Date.now();
    this.checkAchievements();

    this.loop(performance.now());
    if (!this.offline) {
      this.sync(true);
      this.syncTimer = setInterval(() => this.sync(), SYNC_MS);
    }
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.cam.updateSize(w, h);
    this.cam.zoom = w < 760 ? 0.82 : 1;
    this.ctx.imageSmoothingEnabled = false;
    this.updateTouchUi(w);
  }

  /** 触屏设备或窄屏显示摇杆；两者都不满足时用键盘提示 */
  updateTouchUi(w = window.innerWidth) {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const show = coarse || w < 820;
    const joy = document.getElementById('joystick');
    if (joy) joy.classList.toggle('hidden', !show);
    document.body.classList.toggle('is-touch', show);
  }

  // ---------------- 输入 ----------------
  _bindInput() {
    window.addEventListener('keydown', (e) => {
      if (this.chatOpen) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      this.keys.add(k);
      if (k === 'e') this.interact();
      if (k === 'b') this.toggleBike();
      if (k === 'p') { e.preventDefault(); this.takePhoto(); }
      if (k === 'm') { e.preventDefault(); this.openMap(); }
      if (k === 'j') { e.preventDefault(); this.openJournal(); }
      if (k === 't' || k === 'enter') { e.preventDefault(); this.openChat(); }
      if (k === 'shift') this.keys.add('shift');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    // 虚拟摇杆
    const joy = document.getElementById('joystick');
    const knob = joy.querySelector('.joystick-knob');
    const R = 46;
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const move = (e) => {
      const r = joy.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      setKnob(dx, dy);
      this.joy.x = dx / R;
      this.joy.y = dy / R;
    };
    joy.addEventListener('pointerdown', (e) => {
      this.joy.active = true; this.joy.id = e.pointerId;
      joy.setPointerCapture(e.pointerId);
      move(e);
      e.preventDefault();
    });
    joy.addEventListener('pointermove', (e) => {
      if (!this.joy.active || e.pointerId !== this.joy.id) return;
      move(e);
    });
    const end = (e) => {
      if (e.pointerId !== this.joy.id) return;
      this.joy.active = false; this.joy.x = 0; this.joy.y = 0;
      setKnob(0, 0);
    };
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);

    if (matchMedia('(pointer: coarse)').matches) joy.classList.remove('hidden');
    // 触屏按钮
    const tap = (id, fn) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    };
    tap('btnInteract', () => this.interact());
    tap('btnBike', () => this.toggleBike());
    tap('btnChat', () => this.openChat());
    const runBtn = document.getElementById('btnRun');
    runBtn.addEventListener('pointerdown', () => this.keys.add('shift'));
    runBtn.addEventListener('pointerup', () => this.keys.delete('shift'));
    runBtn.addEventListener('pointerleave', () => this.keys.delete('shift'));

    // 画布点击：走路？
    this.canvas.addEventListener('dblclick', () => this.takePhoto());
  }

  _bindUi() {
    document.getElementById('btnMap').onclick = () => this.openMap();
    document.getElementById('minimap').onclick = () => this.openMap();
    document.getElementById('btnJournal').onclick = () => this.openJournal();
    document.getElementById('btnHelp').onclick = () => ui.el.helpOverlay.classList.remove('hidden');
    document.getElementById('helpClose').onclick = () => ui.el.helpOverlay.classList.add('hidden');
    document.getElementById('btnPhoto').onclick = () => this.takePhoto();
    document.getElementById('mapClose').onclick = () => this.closeMap();
    document.getElementById('journalClose').onclick = () => ui.el.journalOverlay.classList.add('hidden');
    document.getElementById('destClear').onclick = () => { this.waypoint = null; this.refreshMap(); ui.toast('已清除目的地'); };

    const chatInput = ui.el.chatInput;
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.sendChat(); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeChat(); }
      e.stopPropagation();
    });
    document.getElementById('chatSend').onclick = () => this.sendChat();

    // 全图
    this.mapView = null;
    ui.el.mapSearch.addEventListener('input', () => this.renderSearch());
    ui.el.mapSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.pickFirstResult(); });
  }

  // ---------------- 循环 ----------------
  loop(now) {
    if (!this.running) return;
    requestAnimationFrame((t) => this.loop(t));
    const dtRaw = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (this.paused) return;
    const dt = Math.min(0.05, dtRaw || 0.016);
    this.frameTime = dtRaw;
    this.update(dt);
    this.render(now);
    this.updateHud(now);
  }

  update(dt) {
    const me = this.me;
    const blockedByUi = this.chatOpen || this.overlayOpen();
    let ix = 0, iy = 0;
    if (!blockedByUi) {
      if (this.keys.has('a') || this.keys.has('arrowleft')) ix -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) ix += 1;
      if (this.keys.has('w') || this.keys.has('arrowup')) iy -= 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) iy += 1;
      if (this.joy.active) { ix += this.joy.x; iy += this.joy.y; }
    }

    const len = Math.hypot(ix, iy);
    const moving = len > 0.12;
    if (moving) {
      ix /= len; iy /= len;
      const running = this.keys.has('shift') || len > 1.05;
      const mode = me.mode === 'bike' ? 'bike' : (running ? 'run' : 'walk');
      const speed = SPEED[mode] || SPEED.walk;
      const step = speed * dt;
      const nx = me.x + ix * step;
      const ny = me.y + iy * step;
      // 轴分离碰撞，贴墙时不抖
      if (!this.world.blocked(nx, me.y, BODY_R)) me.x = nx;
      else if (!this.world.blocked(nx, me.y, BODY_R * 0.6) && Math.abs(ix) > 0.4) me.x = nx;
      if (!this.world.blocked(me.x, ny, BODY_R)) me.y = ny;
      else if (!this.world.blocked(me.x, ny, BODY_R * 0.6) && Math.abs(iy) > 0.4) me.y = ny;

      if (Math.abs(ix) > Math.abs(iy)) me.dir = ix > 0 ? 'right' : 'left';
      else me.dir = iy > 0 ? 'down' : 'up';

      me.moving = true;
      me.anim += dt * (mode === 'bike' ? 12 : mode === 'run' ? 11 : 8);
      me.frame = Math.floor(me.anim) % 3;
      const d = step;
      me.dist += d;
      if (mode === 'bike') me.bike += d;
    } else {
      me.moving = false;
      me.frame = 0;
      me.anim = 0;
    }

    me.mode = me.mode === 'bike' ? 'bike' : (this.keys.has('shift') && moving ? 'run' : 'walk');

    // 镜头
    const targetX = me.x + (me.dir === 'left' ? -1.6 : me.dir === 'right' ? 1.6 : 0);
    const targetY = me.y - 1.2 + (me.dir === 'up' ? -1.4 : 0);
    this.cam.x += (targetX - this.cam.x) * Math.min(1, dt * 7);
    this.cam.y += (targetY - this.cam.y) * Math.min(1, dt * 7);

    // 猫
    for (const c of this.cats) c.update(dt, this.me);

    // 远端玩家插值
    for (const [id, r] of this.remotes) {
      r.x += (r.tx - r.x) * Math.min(1, dt * 9);
      r.y += (r.ty - r.y) * Math.min(1, dt * 9);
      if (r.moving) r.frame = Math.floor((performance.now() / 130) % 3);
      if (performance.now() - r.lastSeen > 8000) this.remotes.delete(id);
    }

    // 心形粒子
    for (const p of this.heartParticles) {
      p.life -= dt;
      p.y -= dt * 16;
      p.x += dt * 6 * p.vx;
    }
    this.heartParticles = this.heartParticles.filter(p => p.life > 0);

    // 探索
    this.discoverAcc += dt;
    if (this.discoverAcc > 0.6) {
      this.discoverAcc = 0;
      const found = discoverNearby(this.world, this.progress, me.x, me.y);
      if (found.length) {
        const names = found.map(f => f.name);
        const label = names.length <= 3
          ? names.join('、')
          : names.slice(0, 3).join('、') + ` 等 ${names.length} 处`;
        ui.toast('发现新地点：' + label, 'good', 3000);
        this.store.touch();
        this.checkAchievements();
        if (!ui.el.journalOverlay.classList.contains('hidden')) ui.renderJournal(this.world, this.progress);
      }
      const place = this.world.placeAt(me.x, me.y, 70);
      if (place && place.name !== this._placeName) {
        this._placeName = place.name;
        ui.setLocation(place.name);
      }
    }

    // 成就
    this.achAcc += dt;
    if (this.achAcc > 2) { this.achAcc = 0; this.checkAchievements(); }

    // 互动目标
    this.nearest = this.findNearest();
    ui.setPrompt(this.nearest ? this.nearest.prompt : '');

    // 目的地
    if (this.waypoint) {
      const d = dist(me.x, me.y, this.waypoint.x, this.waypoint.y);
      if (d < 7) {
        ui.toast('到达 ' + (this.waypoint.name || '目的地'), 'good');
        this.waypoint = null;
      }
    }
  }

  checkAchievements() {
    const now = new Date();
    const ctx = { hour: now.getHours(), world: this.world, player: this.me };
    const before = { ...this.progress.ach };
    const unlocked = evaluateAchievements(this.progress, ctx);
    if (unlocked.length) {
      for (const a of unlocked) {
        ui.toast(`成就解锁：${a.name}${a.title ? ' · 称号「' + a.title + '」' : ''}`, 'good', 3200);
      }
      this.store.touch();
    }
    if (Object.keys(before).length !== Object.keys(this.progress.ach).length) {
      if (!ui.el.journalOverlay.classList.contains('hidden')) ui.renderJournal(this.world, this.progress);
    }
  }

  findNearest() {
    const me = this.me;
    let best = null, bd = INTERACT_R;
    for (const c of this.cats) {
      const d = dist(me.x, me.y, c.x, c.y);
      if (d < bd) {
        const st = catState(this.progress, c.id);
        const following = st.f;
        bd = d;
        best = {
          type: 'cat', cat: c,
          prompt: following ? `让 ${c.name} 自己走走（E）` : (st.a >= AFF.follow ? `和 ${c.name} 一起走走（E）` : `摸摸 ${c.name}（E）`),
        };
      }
    }
    if (best) return best;
    for (const h of this.world.heritage) {
      const d = dist(me.x, me.y, h.x, h.y);
      if (d < 2.6 && d < bd) { bd = d; best = { type: 'heritage', item: h, prompt: `看看「${h.name}」（E）` }; }
    }
    for (const g of this.world.gates) {
      const d = dist(me.x, me.y, g.x, g.y);
      if (d < 5 && d < bd) { bd = d; best = { type: 'gate', item: g, prompt: `在校门打卡：${g.name}（E）` }; }
    }
    return best;
  }

  interact() {
    if (this.chatOpen) return;
    if (!this.nearest) return;
    const me = this.me;
    if (this.nearest.type === 'cat') {
      const c = this.nearest.cat;
      const st = catState(this.progress, c.id);
      const now = Date.now();
      if (st.a >= AFF.follow) {
        setCatFollowing(this.progress, c.id, !st.f);
        c.following = !st.f;
        ui.toast(st.f ? `${c.name} 停下来看着你走开` : `${c.name} 决定跟着你走`, st.f ? '' : 'good');
        this.store.touch();
      }
      if (now - c.petAt > 5000) {
        c.petAt = now;
        const gain = st.a < 35 ? 8 : 5;
        const next = bumpCat(this.progress, c.id, gain);
        const line = c.def.lines[Math.floor(Math.random() * c.def.lines.length)];
        ui.toast(line, '', 3000);
        this.spawnHearts(c);
        if (next >= AFF.photo && st.a < AFF.photo && !this.progress.items.includes(c.def.gift)) {
          if (addItem(this.progress, c.def.gift)) ui.toast(`${c.name} 留下了一样东西：${c.def.gift}`, 'good', 3200);
        }
        if (next >= AFF.codex && st.a < AFF.codex) {
          ui.toast(`${c.name} 已经把你当成熟人了（${affinityLabel(next)}）`, 'good', 3200);
        }
        this.store.touch();
        this.checkAchievements();
      }
    } else if (this.nearest.type === 'heritage') {
      const h = this.nearest.item;
      ui.toast(`「${h.name}」：${h.kind === '景观' ? '校园里的一个地标' : '燕园的一处老地方'}`, '', 3000);
      if (!this.progress.visited[h.name]) {
        this.progress.visited[h.name] = Date.now();
        this.store.touch();
        this.checkAchievements();
      }
    } else if (this.nearest.type === 'gate') {
      const g = this.nearest.item;
      this.progress.visited[g.name] = Date.now();
      ui.toast(`打卡：${g.name}`, 'good');
      this.store.touch();
      this.checkAchievements();
    }
  }

  spawnHearts(c) {
    for (let i = 0; i < 4; i++) {
      this.heartParticles.push({
        x: c.x + (Math.random() - 0.5) * 0.6,
        y: c.y - 1.1,
        vx: (Math.random() - 0.5) * 2,
        life: 1.1 + Math.random() * 0.5,
      });
    }
  }

  toggleBike() {
    this.me.mode = this.me.mode === 'bike' ? 'walk' : 'bike';
    document.getElementById('btnBike').classList.toggle('on', this.me.mode === 'bike');
    ui.toast(this.me.mode === 'bike' ? '骑上了自行车' : '下车走路');
  }

  // ---------------- 渲染 ----------------
  render(now) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.cam.w, H = this.cam.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#7cb342';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;

    this.ground.draw(ctx, this.cam);
    drawWaterAnim(ctx, this.world, this.cam, now);

    const view = this.cam.viewRect(6);
    const now2 = new Date();
    const hour = this.hourOverride ?? (now2.getHours() + now2.getMinutes() / 60);
    const items = [];

    for (const b of this.world.buildings) {
      if (b.bbox[2] < view[0] || b.bbox[0] > view[2] || b.bbox[3] < view[1] || b.bbox[1] > view[3]) continue;
      items.push({ y: b.bbox[3], k: 'b', o: b });
    }
    for (const t of this.world.trees) {
      if (t.x < view[0] || t.x > view[2] || t.y < view[1] || t.y > view[3]) continue;
      items.push({ y: t.y, k: 't', o: t });
    }
    for (const c of this.cats) {
      if (c.x < view[0] - 2 || c.x > view[2] + 2 || c.y < view[1] - 2 || c.y > view[3] + 2) continue;
      items.push({ y: c.y, k: 'c', o: c });
    }
    for (const r of this.remotes.values()) {
      if (r.x < view[0] - 2 || r.x > view[2] + 2 || r.y < view[1] - 2 || r.y > view[3] + 2) continue;
      items.push({ y: r.y, k: 'r', o: r });
    }
    items.push({ y: this.me.y, k: 'me', o: this.me });
    items.sort((a, b) => a.y - b.y);

    // 地面标记
    this.drawGroundMarks(ctx);

    for (const it of items) {
      if (it.k === 'b') drawBuilding(ctx, it.o, this.cam, hour);
      else if (it.k === 't') drawTree(ctx, it.o, this.cam);
      else if (it.k === 'c') this.drawCatEntity(ctx, it.o);
      else if (it.k === 'r') this.drawRemote(ctx, it.o);
      else this.drawSelf(ctx);
    }

    // 粒子
    for (const p of this.heartParticles) {
      const x = this.cam.sx(p.x), y = this.cam.sy(p.y);
      ctx.fillStyle = `rgba(216,97,120,${clamp(p.life, 0, 1) * 0.9})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.4 * this.cam.zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // 目的地指示
    this.drawWaypoint(ctx);

    // 昼夜
    drawTint(ctx, W, H, hour);
    drawNightLights(ctx, this.world, this.cam, hour);

    // 拍照取景框
    if (this.photoMode) this.drawPhotoFrame(ctx, W, H);
  }

  drawGroundMarks(ctx) {
    const cam = this.cam;
    // 文物点
    for (const h of this.world.heritage) {
      const x = cam.sx(h.x), y = cam.sy(h.y);
      if (x < -20 || y < -20 || x > cam.w + 20 || y > cam.h + 20) continue;
      ctx.fillStyle = 'rgba(217,164,65,.85)';
      ctx.beginPath();
      ctx.arc(x, y, 2.2 * cam.zoom, 0, Math.PI * 2);
      ctx.fill();
      if (dist(h.x, h.y, cam.x, cam.y) < 18) drawLabel(ctx, h.name, x, y - 8, 10, 0.6, '#5a4a22');
    }
    // 校门：画成一座小牌楼（若校门本身有建筑轮廓，则只标注名字）
    for (const g of this.world.gates) {
      const x = cam.sx(g.x), y = cam.sy(g.y);
      if (x < -40 || y < -40 || x > cam.w + 40 || y > cam.h + 40) continue;
      const z = cam.zoom;
      const hasBuilding = this.world.buildings.some(b =>
        g.x > b.bbox[0] - 3 && g.x < b.bbox[2] + 3 && g.y > b.bbox[1] - 3 && g.y < b.bbox[3] + 3);
      if (!hasBuilding) {
        ctx.save();
        ctx.fillStyle = '#b8553f';
        ctx.fillRect(x - 15 * z, y - 16 * z, 4 * z, 16 * z);
        ctx.fillRect(x + 11 * z, y - 16 * z, 4 * z, 16 * z);
        ctx.fillStyle = '#8f3a2a';
        ctx.fillRect(x - 18 * z, y - 20 * z, 36 * z, 5 * z);
        ctx.fillStyle = '#5c5a52';
        ctx.beginPath();
        ctx.moveTo(x - 22 * z, y - 20 * z);
        ctx.lineTo(x - 12 * z, y - 27 * z);
        ctx.lineTo(x + 12 * z, y - 27 * z);
        ctx.lineTo(x + 22 * z, y - 20 * z);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#e8d9a8';
        ctx.fillRect(x - 6 * z, y - 19 * z, 12 * z, 3.2 * z);
        ctx.restore();
      }
      if (dist(g.x, g.y, cam.x, cam.y) < 45) {
        drawLabel(ctx, g.name, x, y - (hasBuilding ? 10 : 30) * z, 10.5, 0.85, '#6f2a1c');
      }
    }
  }

  drawCatEntity(ctx, c) {
    const st = catState(this.progress, c.id);
    const sheet = getCatSheet(c.color);
    const x = this.cam.sx(c.x), y = this.cam.sy(c.y);
    let pose = c.pose;
    if (pose === 'walk1' || pose === 'walk2') pose = c.walkFrame || 'walk1';
    drawCat(ctx, sheet, pose, c.facingLeft, x, y, this.cam.zoom);
    const near = dist(c.x, c.y, this.me.x, this.me.y);
    if (st.a > 0 && near < 26) {
      drawNameTag(ctx, c.name, x, y - 16 * this.cam.zoom, this.cam.zoom, '#ffe9b8');
      if (st.f) {
        ctx.fillStyle = 'rgba(216,97,120,.9)';
        ctx.beginPath();
        ctx.arc(x + 9 * this.cam.zoom, y - 22 * this.cam.zoom, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (near < 13) {
      drawNameTag(ctx, '？', x, y - 16 * this.cam.zoom, this.cam.zoom, 'rgba(255,255,255,.8)');
    }
  }

  drawSelf(ctx) {
    const me = this.me;
    const sheet = getCharacterSheet(this.character.appearance);
    const x = this.cam.sx(me.x), y = this.cam.sy(me.y);
    drawCharacter(ctx, sheet, me.dir, me.frame, x, y, this.cam.zoom, { bike: me.mode === 'bike' });
    drawNameTag(ctx, this.character.name, x, y - 32 * this.cam.zoom, this.cam.zoom, '#fff8dc');
  }

  drawRemote(ctx, r) {
    const sheet = getCharacterSheet(r.appearance || {});
    const x = this.cam.sx(r.x), y = this.cam.sy(r.y);
    drawCharacter(ctx, sheet, r.dir || 'down', r.frame || 0, x, y, this.cam.zoom, { bike: r.mode === 'bike' });
    drawNameTag(ctx, r.name, x, y - 32 * this.cam.zoom, this.cam.zoom, '#d9ecff');
  }

  drawWaypoint(ctx) {
    if (!this.waypoint) return;
    const cam = this.cam;
    const { x, y } = this.waypoint;
    const sx = cam.sx(x), sy = cam.sy(y);
    const onScreen = sx > 30 && sy > 30 && sx < cam.w - 30 && sy < cam.h - 30;
    if (onScreen) {
      const d = Math.round(dist(this.me.x, this.me.y, x, y));
      ctx.save();
      ctx.fillStyle = 'rgba(200,85,61,.92)';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - 7, sy - 16);
      ctx.lineTo(sx + 7, sy - 16);
      ctx.closePath();
      ctx.fill();
      drawLabel(ctx, (this.waypoint.name || '目的地') + ` · ${d}m`, sx, sy - 26, 11, 0.95, '#7a2e20');
      ctx.restore();
    } else {
      // 屏幕边缘指示
      const dx = sx - cam.w / 2, dy = sy - cam.h / 2;
      const ang = Math.atan2(dy, dx);
      const rx = Math.min(cam.w / 2 - 34, Math.abs(Math.cos(ang)) * 1e9);
      const ry = Math.min(cam.h / 2 - 34, Math.abs(Math.sin(ang)) * 1e9);
      const r = Math.min(rx / Math.max(0.001, Math.abs(Math.cos(ang))), ry / Math.max(0.001, Math.abs(Math.sin(ang))));
      const px = cam.w / 2 + Math.cos(ang) * r, py = cam.h / 2 + Math.sin(ang) * r;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.fillStyle = 'rgba(200,85,61,.92)';
      ctx.beginPath();
      ctx.moveTo(12, 0); ctx.lineTo(-8, -7); ctx.lineTo(-8, 7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      const d = Math.round(dist(this.me.x, this.me.y, x, y));
      drawLabel(ctx, `${d}m`, px, py + 14, 11, 0.9, '#7a2e20');
    }
  }

  updateHud(now) {
    const t = new Date();
    ui.setClock(t.getHours(), t.getMinutes());
    if (this.miniTimer && now - this.miniTimer < 120) return;
    this.miniTimer = now;
    if (!this.miniMap) this.miniMap = null;
    // 小地图
    this.drawMini();
    const ex = exploreCount(this.world, this.progress);
    ui.setExplore(ex.found, ex.total);
  }

  drawMini() {
    if (!this.mini) this.mini = new MiniMap(ui.el.minimapCanvas, this.world, this.layers);
    const view = this.cam.viewRect(0);
    this.mini.draw(this.me, [...this.remotes.values()], this.waypoint, view);
  }

  overlayOpen() {
    return !ui.el.mapOverlay.classList.contains('hidden')
      || !ui.el.journalOverlay.classList.contains('hidden')
      || !ui.el.helpOverlay.classList.contains('hidden')
      || !ui.el.codeOverlay.classList.contains('hidden');
  }

  // ---------------- 同步 ----------------
  async sync(force = false) {
    if (this.offline) return;
    if (this.syncBusy) return;
    if (!this.api.token) return;
    this.syncBusy = true;
    try {
      const res = await this.api.sync({
        x: this.me.x, y: this.me.y, dir: this.me.dir,
        moving: this.me.moving, mode: this.me.mode, since: this.lastMsgAt,
      });
      this.syncFails = 0;
      if (this.wasOffline) {
        this.wasOffline = false;
        ui.hideBanner();
        ui.toast('已重新连接世界', 'good');
      }
      const now = performance.now();
      const alive = new Set();
      for (const p of res.players) {
        alive.add(p.id);
        let r = this.remotes.get(p.id);
        if (!r) {
          r = { id: p.id, x: p.x, y: p.y, tx: p.x, ty: p.y, dir: p.dir, moving: p.moving, mode: p.mode, name: p.name, appearance: p.appearance, frame: 0, lastSeen: now };
          this.remotes.set(p.id, r);
        } else {
          r.tx = p.x; r.ty = p.y;
          if (Math.hypot(p.x - r.x, p.y - r.y) > 40) { r.x = p.x; r.y = p.y; }
          r.dir = p.dir; r.moving = p.moving; r.mode = p.mode;
          r.name = p.name; r.appearance = p.appearance;
          r.lastSeen = now;
        }
      }
      ui.setOnline(res.online || 1);
      for (const m of res.messages) {
        if (this.seenMessages.has(m.id)) continue;
        this.seenMessages.add(m.id);
        if (m.playerId === this.character.id) continue;
        ui.pushChatLine({ name: m.name, text: m.text });
        this.lastMsgAt = Math.max(this.lastMsgAt, m.at);
      }
      if (res.messages.length) this.lastMsgAt = Math.max(this.lastMsgAt, res.messages[res.messages.length - 1].at);
      if (force) this.drawMini();
    } catch (e) {
      this.syncFails++;
      this.wasOffline = true;
      if (this.syncFails === 1) ui.showBanner('与世界的连接中断，正在重连…', { info: true });
      if (this.syncFails === 4 && e && e.status === 401) {
        ui.showBanner('身份已失效，请刷新页面用恢复码重新登录', { info: true });
      }
    } finally {
      this.syncBusy = false;
    }
  }

  // ---------------- 聊天 ----------------
  openChat() {
    if (this.chatOpen) return;
    this.chatOpen = true;
    ui.el.chatbar.classList.remove('hidden');
    ui.el.chatInput.value = '';
    setTimeout(() => ui.el.chatInput.focus(), 30);
  }

  closeChat() {
    this.chatOpen = false;
    ui.el.chatbar.classList.add('hidden');
    ui.el.chatInput.blur();
  }

  async sendChat() {
    const raw = ui.el.chatInput.value;
    const text = sanitizeText(raw, 120);
    if (!text) { this.closeChat(); return; }
    if (this.offline) {
      this.closeChat();
      ui.toast('离线漫游时不能聊天', 'warn');
      return;
    }
    ui.el.chatInput.value = '';
    try {
      const res = await this.api.chat(text);
      if (res && res.message) {
        this.seenMessages.add(res.message.id);
        ui.pushChatLine({ name: res.message.name, text: res.message.text, mine: true });
        this.progress.stats.chats = (this.progress.stats.chats || 0) + 1;
        this.store.touch();
        this.checkAchievements();
      }
      this.lastMsgAt = Math.max(this.lastMsgAt, Date.now());
    } catch (e) {
      ui.toast(e.message || '消息发送失败', 'bad');
      ui.el.chatInput.value = text;
    }
    this.closeChat();
  }

  // ---------------- 地图 ----------------
  openMap() {
    ui.el.mapOverlay.classList.remove('hidden');
    if (!this.mapView) {
      this.mapView = new MapView(ui.el.fullmap, this.world, this.layers);
      this.mapView.onPick = (p) => this.setWaypoint(p);
      ui.el.mapFooter.textContent = `地图数据：OpenStreetMap（ODbL）+ 公开影像配准 · ${this.world.buildings.length} 栋建筑 / ${this.world.roads.length} 段道路 / ${this.world.exploreTotal} 处地点`;
    }
    this.mapView.player = this.me;
    this.mapView.others = [...this.remotes.values()];
    this.mapView.waypoint = this.waypoint;
    this.mapView.draw();
    this.renderSearch();
    this.updateDestText();
  }

  closeMap() {
    ui.el.mapOverlay.classList.add('hidden');
  }

  refreshMap() {
    if (!this.mapView) return;
    this.mapView.waypoint = this.waypoint;
    this.mapView.player = this.me;
    this.mapView.others = [...this.remotes.values()];
    this.mapView.draw();
    this.updateDestText();
  }

  updateDestText() {
    ui.el.destText.textContent = this.waypoint
      ? `${this.waypoint.name || '自定义位置'} · 距离 ${Math.round(dist(this.me.x, this.me.y, this.waypoint.x, this.waypoint.y))} 米`
      : '未设置';
  }

  setWaypoint(p) {
    const name = p.landmark ? p.landmark.name : '自定义位置';
    this.waypoint = { x: p.x, y: p.y, name };
    this.refreshMap();
    ui.toast('目的地：' + name, 'good');
  }

  renderSearch() {
    const q = ui.el.mapSearch.value;
    const list = this.world.search(q, 24);
    const ul = ui.el.searchResults;
    ul.innerHTML = '';
    for (const l of list) {
      const li = document.createElement('li');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = l.type || '地点';
      const b = document.createElement('b');
      b.textContent = l.name;
      li.appendChild(b);
      li.appendChild(tag);
      if (l.aliasOf) {
        const s = document.createElement('span');
        s.className = 'muted small';
        s.textContent = ' 别名·' + l.aliasOf;
        li.appendChild(s);
      }
      li.onclick = () => {
        this.waypoint = { x: l.x, y: l.y, name: l.name };
        this.refreshMap();
        ui.toast('目的地：' + l.name, 'good');
        // 地图平移过去
        if (this.mapView) {
          const img = this.mapView.layers.full.canvas;
          const f = img.width / (this.world.world[2] - this.world.world[0]);
          this.mapView.offsetX = this.mapView.canvas.width / 2 - (l.x - this.world.world[0]) * f * this.mapView.scale;
          this.mapView.offsetY = this.mapView.canvas.height / 2 - (l.y - this.world.world[1]) * f * this.mapView.scale;
          this.mapView.draw();
        }
      };
      ul.appendChild(li);
    }
    if (!list.length) {
      ul.innerHTML = '<li class="muted">没有找到匹配的地点</li>';
    }
  }

  pickFirstResult() {
    const q = ui.el.mapSearch.value.trim();
    if (!q) return;
    const first = this.world.search(q, 1)[0];
    if (first) {
      this.waypoint = { x: first.x, y: first.y, name: first.name };
      this.refreshMap();
      this.closeMap();
      ui.toast('目的地：' + first.name, 'good');
    }
  }

  // ---------------- 手册 ----------------
  openJournal() {
    ui.renderJournal(this.world, this.progress);
    ui.el.journalOverlay.classList.remove('hidden');
  }

  // ---------------- 拍照 ----------------
  async takePhoto() {
    if (this.photoBusy) return;
    this.photoBusy = true;
    this.photoMode = true;
    ui.el.hud.classList.add('hidden');
    this.render(performance.now());
    await new Promise(r => requestAnimationFrame(r));
    try {
      const here = this.world.placeAt(this.me.x, this.me.y, 80);
      const nearCat = this.cats
        .filter(c => dist(c.x, c.y, this.me.x, this.me.y) < 4)
        .sort((a, b) => dist(a.x, a.y, this.me.x, this.me.y) - dist(b.x, b.y, this.me.x, this.me.y))[0];
      const out = capturePhoto(this.canvas, {
        place: here ? here.name : '燕园',
        name: this.character.name,
        cat: nearCat ? nearCat.name : null,
      });
      const ts = new Date();
      const fname = `yanyuan-${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}.png`;
      await savePhoto(out, fname);
      ui.flash();
      ui.toast('照片已保存 · ' + (here ? here.name : '燕园'), 'good');
      this.progress.stats.photos = (this.progress.stats.photos || 0) + 1;
      this.store.touch();
      this.checkAchievements();
    } catch (e) {
      ui.toast('拍照失败：' + (e.message || '未知错误'), 'bad');
    } finally {
      this.photoMode = false;
      ui.el.hud.classList.remove('hidden');
      this.photoBusy = false;
    }
  }

  drawPhotoFrame(ctx, W, H) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.lineWidth = 3;
    ctx.strokeRect(14, 14, W - 28, H - 28);
    ctx.restore();
  }
}
