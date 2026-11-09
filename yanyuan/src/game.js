// 游戏主循环：移动、碰撞、镜头、多人同步、互动、地图、拍照
import { Camera, Ground, drawBuilding, drawLandmark, drawTree, drawHeritage, drawWaterAnim, drawTint, drawLabel, drawNightLights, UPSCALE } from './render.js?v=202611091238';
import { getCharacterSheet, drawCharacter, getCatSheet, drawCat, drawNameTag } from './sprites.js?v=202611091238';
import { CAT_DEFS, Cat, AFF, affinityLabel, catAwake } from './cats.js?v=202611091238';
import { heritageText } from './heritage.js?v=202611091238';
import { PILOT, inPilot, buildCells, drawPilotGround, drawTileBuilding, drawTileTree } from './tilepilot.js?v=202611091238';
import {
  normalizeProgress, discoverNearby, evaluateAchievements, exploreCount,
  catState, bumpCat, setCatFollowing, addItem, ProgressStore,
} from './progress.js?v=202611091238';
import { capturePhoto, savePhoto } from './photo.js?v=202611091238';
import { MapView, MiniMap } from './minimap.js?v=202611091238';
import { placeFor } from './places.js?v=202611091238';
import * as ui from './ui.js?v=202611091238';
import { clamp, dist, sanitizeText, formatRecovery } from './util.js?v=202611091238';

const SPEED = { walk: 3.4, run: 6.4, bike: 9.8 };
const BODY_R = 0.52;
const SYNC_MS = 1100;
const INTERACT_R = 2.8;

export class Game {
  constructor({ world, api, character, progress, layers, offline = false }) {
    this.world = world;
    this.tileMode = new URLSearchParams(location.search).get('tile') === '1';
    if (this.tileMode) buildCells(world);
    this.api = api;
    this.character = character;
    this.offline = offline;
    this.progress = normalizeProgress(progress);
    this.store = new ProgressStore(api, this.progress);
    if (offline) {
      this.store.touch = () => {};
      this.store.flush = async () => {};
    }
    this.store.onState = (s, attempts) => ui.setSaveState(s, attempts);
    this.store.onError = (e, attempts) => {
      if (attempts === 1) ui.toast('存档还没保存上，正在自动重试…', 'warn');
    };

    // 有内容的地标（E 键可查看卡片）
    this.placeMarks = world.landmarks
      .filter(l => !l.aliasOf && placeFor(l.name))
      .map(l => ({ l, place: placeFor(l.name) }));
    this.followId = null;
    this.activeQuest = localStorage.getItem('yanyuan.quest') || '';

    this.canvas = ui.el.canvas;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    // 低分辨率像素缓冲：世界画在这里，再整数倍放大到屏幕
    this.low = document.createElement('canvas');
    this.lowCtx = this.low.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.tagQueue = [];
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
      try { this.store.flushKeepalive(); } catch { /* ignore */ }
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

    // 第一次进来：给三个可选邀请（可直接跳过）
    const inviteSeen = localStorage.getItem('yanyuan.inviteSeen') === '1';
    if (!this.offline && !inviteSeen && !this.activeQuest && Object.keys(this.progress.visited).length <= 3) {
      setTimeout(() => {
        if (!this.overlayOpen() && !this.chatOpen) this.offerQuests();
      }, 2200);
    }

    // 本机有未同步的存档就补传一次（只在与当前身份匹配时）
    if (!this.offline) {
      ui.setSaveState('saved');
      this.store.recoverDraft().then((ok) => {
        if (ok) ui.toast('已补传本机未同步的进度', 'good');
      }).catch(() => {});
    }

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
    this.cssW = w; this.cssH = h;
    // 低分辨率缓冲：CSS 尺寸的一半，最后 2 倍最近邻放大
    this.low.width = Math.max(2, Math.floor(w / UPSCALE / 2) * 2);
    this.low.height = Math.max(2, Math.floor(h / UPSCALE / 2) * 2);
    this.lowFactor = w / this.low.width;
    this.cam.updateSize(this.low.width, this.low.height);
    this.cam.zoom = 1;
    this.ctx.imageSmoothingEnabled = false;
    this.lowCtx.imageSmoothingEnabled = false;
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
    const isTyping = (el) => {
      if (!el) return false;
      const tag = (el.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
    };

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      const typing = isTyping(e.target);

      // 1) 正在输入框里打字：只处理 Esc，其余交给输入框（含输入法）
      if (typing) {
        if (k === 'escape') e.target.blur();
        return;
      }

      // 2) 有弹窗开着：只允许 Esc / 同键关闭，不触发游戏快捷键
      if (this.overlayOpen()) {
        if (k === 'escape') { this.closeTopOverlay(); return; }
        if (k === 'm' && !ui.el.mapOverlay.classList.contains('hidden')) { this.closeMap(); return; }
        if (k === 'j' && !ui.el.journalOverlay.classList.contains('hidden')) {
          ui.el.journalOverlay.classList.add('hidden'); return;
        }
        return;
      }

      // 3) 聊天输入中
      if (this.chatOpen) {
        if (k === 'escape') this.closeChat();
        return;
      }

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
    window.addEventListener('keyup', (e) => {
      if (isTyping(e.target)) return;
      this.keys.delete(e.key.toLowerCase());
    });
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

    // 画布点击：点附近玩家看名片
    this.canvas.addEventListener('pointerup', (e) => this.handleCanvasClick(e));
    this.canvas.addEventListener('dblclick', () => this.takePhoto());
  }

  _bindUi() {
    document.getElementById('btnMap').onclick = () => this.openMap();
    document.getElementById('minimap').onclick = () => this.openMap();
    document.getElementById('btnJournal').onclick = () => this.openJournal();
    document.getElementById('btnHelp').onclick = () => this.showHelp();
    document.getElementById('helpClose').onclick = () => ui.el.helpOverlay.classList.add('hidden');
    document.getElementById('helpCodeCopy').onclick = async () => {
      const code = localStorage.getItem('yanyuan.token') || '';
      if (!code) return;
      try { await navigator.clipboard.writeText(formatRecovery(code)); ui.toast('恢复码已复制', 'good'); }
      catch { ui.toast('复制失败，请手动抄写', 'warn'); }
    };
    document.getElementById('helpCodeSave').onclick = () => {
      const code = localStorage.getItem('yanyuan.token') || '';
      if (!code) return;
      const blob = new Blob([`像素燕园 · 角色恢复码\n\n${formatRecovery(code)}\n\n请妥善保存。任何人拿到它都能登录你的角色。\n`], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'yanyuan-恢复码.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    document.getElementById('helpLogout').onclick = () => {
      const hasCode = !!localStorage.getItem('yanyuan.token');
      const msg = hasCode
        ? '退出后这台设备就不再保存登录状态。请确认你已经抄下恢复码（帮助里可以复制），否则将无法再进入这个角色。\n\n确定退出？'
        : '确定退出？';
      if (!confirm(msg)) return;
      this.store.flush(true).catch(() => {});
      localStorage.removeItem('yanyuan.token');
      localStorage.removeItem('yanyuan.name');
      location.reload();
    };
    document.getElementById('btnPhoto').onclick = () => this.takePhoto();
    document.getElementById('mapClose').onclick = () => this.closeMap();
    document.getElementById('journalClose').onclick = () => ui.el.journalOverlay.classList.add('hidden');
    document.getElementById('destClear').onclick = () => { this.waypoint = null; this.refreshMap(); ui.toast('已清除目的地'); };

    // 地点卡片
    document.getElementById('placeClose').onclick = () => ui.hidePlace();
    document.getElementById('placeRemember').onclick = () => {
      const name = document.getElementById('placeOverlay').dataset.name || '';
      const ok = addItem(this.progress, `观察笔记：${name}`);
      ui.toast(ok ? `已记入手册：${name}` : '这条已经记过了', ok ? 'good' : '');
      ui.hidePlace();
      this.store.touch();
    };
    document.getElementById('placePhoto').onclick = () => { ui.hidePlace(); this.takePhoto(); };

    // 玩家名片
    document.getElementById('pcClose').onclick = () => ui.hidePlayerCard();
    document.getElementById('pcWave').onclick = async () => {
      const id = document.getElementById('cardOverlay').dataset.id;
      if (!id) return;
      try {
        await this.api.wave(id);
        const r = this.remotes.get(id);
        ui.toast(`向 ${r ? r.name : '对方'} 挥了挥手`, 'good');
      } catch (e) {
        ui.toast(e.status === 409 ? '对方已经离线了' : (e.message || '挥手失败'), 'warn');
      }
    };
    document.getElementById('pcFollow').onclick = () => {
      const id = document.getElementById('cardOverlay').dataset.id;
      const r = this.remotes.get(id);
      if (!r) return;
      this.followId = id;
      ui.hidePlayerCard();
      ui.toast(`跟着 ${r.name} 走，屏幕上会持续标出他的位置`, 'good', 3200);
    };
    document.getElementById('pcPhoto').onclick = () => {
      const id = document.getElementById('cardOverlay').dataset.id;
      const r = this.remotes.get(id);
      ui.hidePlayerCard();
      if (!r) return;
      const d = dist(this.me.x, this.me.y, r.x, r.y);
      if (d > 8) { ui.toast('离得太远了，走近一点再合影', 'warn'); return; }
      this.takePhoto({ withName: r.name });
    };

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
    // 显示器缩放/浏览器缩放变化时重建缓冲
    if (Math.abs((window.devicePixelRatio || 1) - this.dpr) > 0.01 ||
        Math.abs(window.innerWidth - this.cssW) > 1 ||
        Math.abs(window.innerHeight - this.cssH) > 1) {
      this.resize();
    }
    const dtRaw = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (this.paused) return;
    const dt = Math.min(0.05, dtRaw || 0.016);
    this.frameTime = dtRaw;
    try {
      this.update(dt);
      this.render(now);
      this.updateHud(now);
    } catch (e) {
      this.renderErrors = (this.renderErrors || 0) + 1;
      if (this.renderErrors === 1) {
        console.error('[yanyuan] 渲染异常', e);
      }
      if (this.renderErrors === 8) {
        this.running = false;
        ui.showFatal('画面渲染出错：' + (e && e.message ? e.message : String(e)) +
          '\n请刷新页面重试；如果反复出现，把这行文字发给开发者。');
      }
    }
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
    // 像素对齐：镜头落在整数低分辨率像素上，各层不会互相差 1 像素地抖
    const qs = this.cam.scale;
    this.cam.x = Math.round(this.cam.x * qs) / qs;
    this.cam.y = Math.round(this.cam.y * qs) / qs;

    // 猫：有作息，不在时段内的不出现、不可互动
    const hourNow = this.nowHour();
    for (const c of this.cats) {
      c.awake = catAwake(c.def, hourNow);
      if (c.awake) c.update(dt, this.me);
    }

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

    // 成就 + 里程结算（每 2 秒把移动距离写进存档）
    this.achAcc += dt;
    if (this.achAcc > 2) {
      this.achAcc = 0;
      const dd = this.me.dist - (this._statDist || 0);
      const db = this.me.bike - (this._statBike || 0);
      if (dd > 0.3 || db > 0.3) {
        this.progress.stats.dist = (this.progress.stats.dist || 0) + Math.max(0, dd);
        this.progress.stats.bike = (this.progress.stats.bike || 0) + Math.max(0, db);
        this._statDist = this.me.dist;
        this._statBike = this.me.bike;
        this.store.touch();
      }
      this.checkAchievements();
    }

    // 互动目标
    this.nearest = this.findNearest();
    ui.setPrompt(this.nearest ? this.nearest.prompt : '');

    // 跟随某个玩家：目的地实时跟着他
    if (this.followId) {
      const r = this.remotes.get(this.followId);
      if (r) {
        this.waypoint = { x: r.x, y: r.y, name: '跟着 ' + r.name };
      } else {
        this.followId = null;
        this.waypoint = null;
        ui.toast('跟丢了，他已经离开', 'warn');
      }
    }

    // 目的地
    if (this.waypoint) {
      const d = dist(me.x, me.y, this.waypoint.x, this.waypoint.y);
      if (d < 8) {
        ui.toast('到达 ' + (this.waypoint.name || '目的地'), 'good');
        this.waypoint = null;
      }
    }
  }

  /** 陪走型的猫更容易愿意跟着你 */
  followAt(c) {
    return c.def.habit === 'companion' ? 25 : AFF.follow;
  }

  nowHour() {
    if (this.hourOverride != null) return this.hourOverride;
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
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
      if (c.awake === false) continue;
      const d = dist(me.x, me.y, c.x, c.y);
      if (d < bd) {
        const st = catState(this.progress, c.id);
        const following = st.f;
        bd = d;
        best = {
          type: 'cat', cat: c,
          prompt: following ? `让 ${c.name} 自己走走（E）` : (st.a >= this.followAt(c) ? `和 ${c.name} 一起走走（E）` : `摸摸 ${c.name}（E）`),
        };
      }
    }
    if (best) return best;
    // 有内容的地点：走到可达点附近就能看
    for (const { l, place } of this.placeMarks) {
      const d = dist(me.x, me.y, l.ax, l.ay);
      if (d < 14 && d < bd) {
        bd = d;
        best = { type: 'place', landmark: l, place, prompt: `看看「${l.name}」（E）` };
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
      if (st.a >= this.followAt(c)) {
        setCatFollowing(this.progress, c.id, !st.f);
        c.following = !st.f;
        ui.toast(st.f ? `${c.name} 停下来看着你走开` : `${c.name} 决定跟着你走`, st.f ? '' : 'good');
        this.store.touch();
      }
      if (now - c.petAt > 5000) {
        c.petAt = now;
        const habit = c.def.habit;
        // 怕生的猫：短时间内重复打扰只会敷衍你
        if (habit === 'distant' && st.t && now - st.t < 5 * 60 * 1000) {
          bumpCat(this.progress, c.id, 1);
          ui.toast(c.name + ' 还记得你刚来过，只是抬眼看了看你', '', 3000);
          this.store.touch();
          return;
        }
        // 睡着被摸醒：涨幅小
        const asleep = habit === 'sleepy' && c.pose === 'sleep';
        let gain = st.a < 35 ? 8 : 5;
        if (asleep) gain = 3;
        const next = bumpCat(this.progress, c.id, gain);
        const line = c.def.lines[Math.floor(Math.random() * c.def.lines.length)];
        ui.toast(line, '', 3000);
        this.spawnHearts(c);
        this.completeQuest('pet:any');
        if (next >= AFF.photo && st.a < AFF.photo && !this.progress.items.includes(c.def.gift)) {
          if (addItem(this.progress, c.def.gift)) ui.toast(`${c.name} 留下了一样东西：${c.def.gift}`, 'good', 3200);
        }
        if (next >= AFF.codex && st.a < AFF.codex) {
          ui.toast(`${c.name} 已经把你当成熟人了（${affinityLabel(next)}）`, 'good', 3200);
        }
        this.store.touch();
        this.checkAchievements();
      }
    } else if (this.nearest.type === 'place') {
      const { landmark, place } = this.nearest;
      ui.showPlace(place, landmark.name);
      if (!this.progress.visited[landmark.name]) {
        this.progress.visited[landmark.name] = Date.now();
        this.store.touch();
        this.checkAchievements();
      }
      this.completeQuest('visit:' + landmark.name);
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
    const g = this.lowCtx;
    const cam = this.cam;
    cam.labels.length = 0;
    this.tagQueue.length = 0;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#6e9c37';
    g.fillRect(0, 0, this.low.width, this.low.height);
    g.imageSmoothingEnabled = false;

    this.ground.draw(g, cam);

    if (this.tileMode) drawPilotGround(g, cam);
    drawWaterAnim(g, this.world, cam, now);

    const view = cam.viewRect(3);
    const now2 = new Date();
    const hour = this.hourOverride ?? (now2.getHours() + now2.getMinutes() / 60);
    const items = [];

    for (const b of this.world.buildings) {
      if (b.bbox[2] < view[0] || b.bbox[0] > view[2] || b.bbox[3] < view[1] || b.bbox[1] > view[3]) continue;
      items.push({ y: b.bbox[3], k: this.tileMode && inPilot((b.bbox[0]+b.bbox[2])/2, (b.bbox[1]+b.bbox[3])/2) ? 'tb' : 'b', o: b });
      if (b.name && b.area > 240 && !this.heroKind(b)) {
        const d = Math.hypot(b.label[0] - cam.x, b.label[1] - cam.y);
        if (d < 110) {
          const a = Math.max(0.25, Math.min(0.9, 1 - (d - 60) / 60));
          cam.label(b.name, b.label[0], b.label[1], 10.5, b.heritage ? '#ffe9b8' : '#fdfaf3', a);
        }
      }
    }
    for (const t of this.world.trees) {
      if (t.x < view[0] || t.x > view[2] || t.y < view[1] || t.y > view[3]) continue;
      items.push({ y: t.y, k: this.tileMode && inPilot(t.x, t.y) ? 'tt' : 't', o: t });
    }
    for (const c of this.cats) {
      if (c.awake === false) continue;
      if (c.x < view[0] - 2 || c.x > view[2] + 2 || c.y < view[1] - 2 || c.y > view[3] + 2) continue;
      items.push({ y: c.y, k: 'c', o: c });
    }
    for (const h of this.world.heritage) {
      if (h.x < view[0] - 3 || h.x > view[2] + 3 || h.y < view[1] - 3 || h.y > view[3] + 3) continue;
      items.push({ y: h.y, k: 'h', o: h });
    }
    for (const r of this.remotes.values()) {
      if (r.x < view[0] - 2 || r.x > view[2] + 2 || r.y < view[1] - 2 || r.y > view[3] + 2) continue;
      items.push({ y: r.y, k: 'r', o: r });
    }
    items.push({ y: this.me.y, k: 'me', o: this.me });
    items.sort((a, b) => a.y - b.y);

    this.drawGroundMarks(g);

    for (const it of items) {
      if (it.k === 'b') {
        const kind = this.heroKind(it.o);
        if (kind) drawLandmark(g, it.o, cam, hour, kind);
        else drawBuilding(g, it.o, cam, hour);
      } else if (it.k === 'tb') {
        this.drawTileBuildingEntity(g, it.o, cam);
      } else if (it.k === 'tt') drawTileTree(g, it.o, cam);
      else if (it.k === 't') drawTree(g, it.o, cam);
      else if (it.k === 'h') drawHeritage(g, it.o, cam);
      else if (it.k === 'c') this.drawCatEntity(g, it.o);
      else if (it.k === 'r') this.drawRemote(g, it.o);
      else this.drawSelf(g);
    }

    // 心形粒子
    for (const p of this.heartParticles) {
      const x = Math.round(cam.sx(p.x)), y = Math.round(cam.sy(p.y));
      g.fillStyle = `rgba(216,97,120,${clamp(p.life, 0, 1)})`;
      g.fillRect(x - 1, y - 1, 2, 2);
    }

    this.drawWaypoint(g);

    // 昼夜
    drawTint(g, this.low.width, this.low.height, hour);
    drawNightLights(g, this.world, cam, hour);

    // 整数倍放大到屏幕（最近邻，像素块清晰）
    // 注意：这里必须铺满 canvas 的设备像素，而不是 low.width*2 ——
    // 在 devicePixelRatio>1（Windows 125%/150% 缩放、手机）时否则只画左上一块
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.low, 0, 0, this.canvas.width, this.canvas.height);

    // 高清文字层（建筑名、玩家名牌、目的地距离）
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.flushText(ctx);

    if (this.photoMode) this.drawPhotoFrame(ctx, this.cssW, this.cssH);
  }

  /** 世界坐标 → 屏幕 CSS 像素 */
  px(x) { return this.cam.sx(x) * this.lowFactor; }
  py(y) { return this.cam.sy(y) * this.lowFactor; }

  heroKind(b) {
    return b.hero || null;
  }

  flushText(ctx) {
    const cam = this.cam;
    const f = this.lowFactor;
    for (const l of cam.labels) {
      const x = cam.sx(l.x) * f, y = cam.sy(l.y) * f;
      if (x < -60 || y < -20 || x > this.cssW + 60 || y > this.cssH + 20) continue;
      drawLabel(ctx, l.text, x, y, Math.max(10, l.size), l.alpha, '#2c3527');
    }
    for (const t of this.tagQueue) {
      const x = cam.sx(t.x) * f, y = cam.sy(t.y) * f;
      if (x < -60 || y < -30 || x > this.cssW + 60 || y > this.cssH + 30) continue;
      drawNameTag(ctx, t.text, x, y, 1, t.color, t.dim);
    }
  }

  /** 图块模式的建筑：颜色取自 style.csv 的瓦色/墙体 */
  drawTileBuildingEntity(ctx, b, cam) {
    // ---- 每栋楼一套"外观参数"：墙色 / 窗型 / 底层 / 檐口 ----
    const h = ((b.id | 0) * 2654435761) >>> 0;
    const tile = (b.st && b.st.tile) || '';
    const wallStyle = (b.st && b.st.wall) || '';
    const winStyle = (b.st && b.st.win) || '';
    const catRoof = {
      '教学': '#6b665c', '生活': '#a8503a', '食堂': '#b4643c', '园林': '#585349',
      '体育': '#4f5a66', '校园服务': '#7a5140', '校门': '#8d3520',
    };
    const roof = tile.includes('灰瓦') ? '#5a564e'
      : tile.includes('琉璃') ? '#4f7d5a'
        : tile.includes('红瓦') ? '#bf5330'
          : (catRoof[b.cat] || '#6b665c');
    // 墙色：材质优先，否则按类别 + 哈希给 5 种
    const WALLS = {
      '白灰墙': ['#efe6d2', '#e9dfc9', '#f2ecdc'],
      '红砖': ['#d9b8a4', '#cfae98', '#e0c4b0'],
      '石材': ['#d6d1c4', '#cbc6b8'],
      '木构': ['#c8a888', '#bd9e7e'],
    };
    let wallSet = WALLS[wallStyle];
    if (!wallSet) {
      wallSet = b.cat === '生活' ? ['#e6d3b4', '#dcc7a6', '#efdcbe']
        : b.cat === '食堂' ? ['#e8d5ae', '#f0dfc0']
          : b.cat === '体育' ? ['#d8dcdd', '#c9ced0']
            : ['#efe6d2', '#e9e0cc', '#f3ecdc', '#e4d9c0'];
    }
    const wall = wallSet[h % wallSet.length];
    // 窗型：拱窗→3，木格→5，带窗→4，否则在 1/4/7 里按哈希
    let band = winStyle.includes('拱窗') ? 3
      : winStyle.includes('木格') ? 5
        : winStyle.includes('带窗') ? 4
          : [1, 4, 7, 1, 8][h % 5];
    // 食堂/服务：底层做橱窗
    const groundBand = (b.cat === '食堂' || b.cat === '校园服务') ? 6 : 2;
    // 檐口颜色：深一档的屋顶色
    const eave = b.cat === '园林' || tile.includes('灰瓦') ? '#8d3520' : '#7a2f18';
    drawTileBuilding(ctx, b, cam, roof, wall, band, groundBand, eave);
  }

  drawGroundMarks(ctx) {
    const cam = this.cam;
    for (const h of this.world.heritage) {
      const x = Math.round(cam.sx(h.x)), y = Math.round(cam.sy(h.y));
      if (x < -8 || y < -8 || x > cam.w + 8 || y > cam.h + 8) continue;

      if (dist(h.x, h.y, cam.x, cam.y) < 20) {
        cam.label(h.name, h.x, h.y - 1.2, 10, '#f6e2a8', 0.75);
      }
    }
    for (const gt of this.world.gates) {
      const x = Math.round(cam.sx(gt.x)), y = Math.round(cam.sy(gt.y));
      if (x < -30 || y < -30 || x > cam.w + 30 || y > cam.h + 30) continue;
      const hasBuilding = this.world.buildings.some(b =>
        gt.x > b.bbox[0] - 3 && gt.x < b.bbox[2] + 3 && gt.y > b.bbox[1] - 3 && gt.y < b.bbox[3] + 3);
      if (!hasBuilding) {
        // 小牌楼
        ctx.fillStyle = '#b04a38';
        ctx.fillRect(x - 6, y - 7, 2, 7);
        ctx.fillRect(x + 4, y - 7, 2, 7);
        ctx.fillStyle = '#4f5a63';
        ctx.fillRect(x - 8, y - 9, 16, 3);
        ctx.fillStyle = '#8a3a2c';
        ctx.fillRect(x - 7, y - 8, 14, 2);
        if (dist(gt.x, gt.y, cam.x, cam.y) < 40) cam.label(gt.name, gt.x, gt.y - 2.6, 10, '#ffd9b0', 0.85);
      }
    }
  }

  drawCatEntity(ctx, c) {
    const st = catState(this.progress, c.id);
    const sheet = getCatSheet(c.color);
    const x = Math.round(this.cam.sx(c.x)), y = Math.round(this.cam.sy(c.y));
    let pose = c.pose;
    if (pose === 'walk1' || pose === 'walk2') pose = c.walkFrame || 'walk1';
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const S = 0.85;
    const w = 18 * S, h = 14 * S;
    ctx.fillStyle = 'rgba(36,46,30,.22)';
    ctx.beginPath();
    ctx.ellipse(x, y, 5, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
    const idx = { sit: 0, walk1: 1, walk2: 2, sleep: 3, happy: 4 }[pose] ?? 0;
    const row = c.facingLeft ? 1 : 0;
    ctx.drawImage(sheet, idx * 18, row * 14, 18, 14, Math.round(x - w / 2), Math.round(y - h + 1), Math.round(w), Math.round(h));
    ctx.restore();
    const near = dist(c.x, c.y, this.me.x, this.me.y);
    if (st.a > 0 && near < 26) this.tagQueue.push({ text: c.name, x: c.x, y: c.y - 1.4, color: '#ffe9b8' });
    else if (near < 13) this.tagQueue.push({ text: '？', x: c.x, y: c.y - 1.4, color: 'rgba(255,255,255,.85)' });
  }

  drawSelf(ctx) {
    const me = this.me;
    const sheet = getCharacterSheet(this.character.appearance);
    const x = this.cam.sx(me.x), y = this.cam.sy(me.y);
    drawCharacter(ctx, sheet, me.dir, me.frame, x, y, 0.7, { bike: me.mode === 'bike' });
    this.tagQueue.push({ text: this.character.name, x: me.x, y: me.y - 1.85, color: '#fff8dc' });
  }

  drawRemote(ctx, r) {
    const sheet = getCharacterSheet(r.appearance || {});
    const x = this.cam.sx(r.x), y = this.cam.sy(r.y);
    drawCharacter(ctx, sheet, r.dir || 'down', r.frame || 0, x, y, 0.7, { bike: r.mode === 'bike' });
    if (r.waveUntil && performance.now() < r.waveUntil) {
      const t = Math.round(Math.sin(performance.now() / 90) * 2);
      ctx.fillStyle = '#f0c060';
      ctx.fillRect(Math.round(x + 8), Math.round(y - 24 + t), 3, 3);
      ctx.fillRect(Math.round(x + 9), Math.round(y - 27 + t), 1, 3);
    }
    this.tagQueue.push({ text: r.name, x: r.x, y: r.y - 1.85, color: '#d9ecff' });
  }

  drawWaypoint(ctx) {
    if (!this.waypoint) return;
    const cam = this.cam;
    const { x, y } = this.waypoint;
    const sx = Math.round(cam.sx(x)), sy = Math.round(cam.sy(y));
    const onScreen = sx > 10 && sy > 10 && sx < cam.w - 10 && sy < cam.h - 10;
    if (onScreen) {
      ctx.fillStyle = '#c8553d';
      ctx.fillRect(sx - 1, sy - 10, 2, 10);
      ctx.fillRect(sx - 4, sy - 11, 8, 4);
      ctx.fillStyle = '#fdfaf3';
      ctx.fillRect(sx - 1, sy - 10, 2, 2);
      cam.label((this.waypoint.name || '目的地') + ' · ' + Math.round(dist(this.me.x, this.me.y, x, y)) + 'm',
        x, y - 3.2, 10.5, '#ffd0c0', 0.95);
    } else {
      const dx = cam.sx(x) - cam.w / 2, dy = cam.sy(y) - cam.h / 2;
      const ang = Math.atan2(dy, dx);
      const r = Math.min(cam.w / 2 - 8, cam.h / 2 - 8);
      const px = Math.round(cam.w / 2 + Math.cos(ang) * r);
      const py = Math.round(cam.h / 2 + Math.sin(ang) * r);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.fillStyle = '#c8553d';
      ctx.fillRect(-1, -4, 8, 8);
      ctx.restore();
      cam.label(Math.round(dist(this.me.x, this.me.y, x, y)) + 'm', x, y, 10, '#ffd0c0', 0.9);
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

  closeTopOverlay() {
    if (!ui.el.helpOverlay.classList.contains('hidden')) { ui.el.helpOverlay.classList.add('hidden'); return; }
    if (!ui.el.journalOverlay.classList.contains('hidden')) { ui.el.journalOverlay.classList.add('hidden'); return; }
    if (!ui.el.mapOverlay.classList.contains('hidden')) { this.closeMap(); return; }
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
          r = { id: p.id, x: p.x, y: p.y, tx: p.x, ty: p.y, dir: p.dir, moving: p.moving, mode: p.mode, name: p.name, appearance: p.appearance, profile: p.profile, frame: 0, lastSeen: now };
          this.remotes.set(p.id, r);
        } else {
          r.tx = p.x; r.ty = p.y;
          if (Math.hypot(p.x - r.x, p.y - r.y) > 40) { r.x = p.x; r.y = p.y; }
          r.dir = p.dir; r.moving = p.moving; r.mode = p.mode;
          r.name = p.name; r.appearance = p.appearance; r.profile = p.profile;
          r.lastSeen = now;
        }
      }
      // 别人向我挥手
      for (const g of (res.gestures || [])) {
        if (this.seenGestures && this.seenGestures.has(g.id)) continue;
        (this.seenGestures || (this.seenGestures = new Set())).add(g.id);
        ui.toast(`${g.fromName} 向你挥了挥手`, 'good', 3200);
        const r = this.remotes.get(g.fromId);
        if (r) r.waveUntil = performance.now() + 1800;
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
        // 只把游标推进到这条消息的服务端时间，不能推到本地当前时刻，
        // 否则会跳过这期间别人发的消息
        this.lastMsgAt = Math.max(this.lastMsgAt, res.message.at || 0);
      }
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
    let name = p.landmark ? p.landmark.name : '自定义位置';
    let x = p.x, y = p.y;
    if (p.landmark && p.landmark.ax !== undefined) {
      // 地标：终点放在最近可达点（门口/路边），而不是建筑中心
      x = p.landmark.ax; y = p.landmark.ay;
    } else {
      const [sx, sy] = this.world.snapToWalkable(x, y);
      x = sx; y = sy;
    }
    this.waypoint = { x, y, name };
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
        this.waypoint = this.world.waypointFor(l);
        this.refreshMap();
        ui.toast('目的地：' + l.name, 'good');
        // 地图平移过去
        if (this.mapView) {
          const img = this.mapView.layers.full.canvas;
          const f = img.width / (this.world.world[2] - this.world.world[0]);
          this.mapView.offsetX = this.mapView.canvas.width / 2 - (this.waypoint.x - this.world.world[0]) * f * this.mapView.scale;
          this.mapView.offsetY = this.mapView.canvas.height / 2 - (this.waypoint.y - this.world.world[1]) * f * this.mapView.scale;
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
      this.waypoint = this.world.waypointFor(first);
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

  showHelp() {
    const code = localStorage.getItem('yanyuan.token') || '';
    const box = document.getElementById('helpCode');
    if (box) box.textContent = code ? formatRecovery(code) : '（本机没有登录状态）';
    ui.el.helpOverlay.classList.remove('hidden');
  }

  // ---------------- 前五分钟：三个邀请 ----------------
  quests() {
    const near = this.cats
      .map(c => ({ c, d: dist(c.x, c.y, this.me.x, this.me.y) }))
      .sort((a, b) => a.d - b.d)[0];
    return [
      {
        id: 'cat',
        title: '跟着一只猫认识附近',
        desc: near ? `最近的是 ${near.c.name}，在 ${Math.round(near.d)} 米外` : '去附近找一只校园猫',
        run: () => {
          if (!near) return;
          this.waypoint = { x: near.c.x, y: near.c.y, name: near.c.name };
          ui.toast(`已把 ${near.c.name} 的位置标在地图上`, 'good');
        },
      },
      {
        id: 'lake',
        title: '去未名湖拍一张照片',
        desc: '湖在校园北侧，走到湖边按 P 拍照',
        run: () => {
          const lake = this.world.landmarks.find(l => l.name === '未名湖' && !l.aliasOf);
          if (lake) { this.waypoint = this.world.waypointFor(lake); ui.toast('已标记未名湖', 'good'); }
        },
      },
      {
        id: 'route',
        title: '走一段燕园经典路线',
        desc: '西门 → 办公楼 → 未名湖 → 博雅塔，先去博雅塔',
        run: () => {
          const tower = this.world.landmarks.find(l => l.name === '博雅塔' && !l.aliasOf);
          if (tower) { this.waypoint = this.world.waypointFor(tower); ui.toast('已标记博雅塔', 'good'); }
        },
      },
    ];
  }

  offerQuests() {
    const items = this.quests();
    ui.showInvites(items, (it) => {
      this.activeQuest = it.id;
      try { localStorage.setItem('yanyuan.quest', it.id); } catch { /* ignore */ }
      it.run();
      ui.toast('完成它会得到一枚印章', 'good', 3000);
    }, () => {
      try { localStorage.setItem('yanyuan.inviteSeen', '1'); } catch { /* ignore */ }
      ui.toast('随意逛逛也很好，需要时按 M 看地图', '', 3000);
    });
  }

  completeQuest(tag) {
    const q = this.activeQuest;
    if (!q) return;
    const hit =
      (q === 'cat' && tag === 'pet:any') ||
      (q === 'lake' && tag === 'photo:lake') ||
      (q === 'route' && tag === 'visit:博雅塔');
    if (!hit) return;
    const stamps = {
      cat: '燕园印章 · 猫缘',
      lake: '燕园印章 · 湖光',
      route: '燕园印章 · 塔影',
    };
    this.activeQuest = '';
    try { localStorage.removeItem('yanyuan.quest'); } catch { /* ignore */ }
    addItem(this.progress, stamps[q]);
    this.progress.ach['quest_' + q] = Date.now();
    ui.toast(`第一枚印章：${stamps[q]}`, 'good', 4200);
    this.store.touch();
    this.checkAchievements();
  }

  // ---------------- 玩家名片 ----------------
  handleCanvasClick(e) {
    if (this.photoBusy || this.chatOpen) return;
    const rect = this.canvas.getBoundingClientRect();
    const lx = ((e.clientX - rect.left) / rect.width) * this.low.width;
    const ly = ((e.clientY - rect.top) / rect.height) * this.low.height;
    const wx = this.cam.wx(lx), wy = this.cam.wy(ly);
    let best = null, bd = 2.6;
    for (const r of this.remotes.values()) {
      const d = Math.hypot(r.x - wx, r.y - wy);
      if (d < bd) { bd = d; best = r; }
    }
    if (best) this.openPlayerCard(best);
  }

  openPlayerCard(r) {
    const prof = r.profile || {};
    ui.showPlayerCard({
      id: r.id, name: r.name,
      dept: prof.dept, grade: prof.grade, bio: prof.bio,
      dist: dist(this.me.x, this.me.y, r.x, r.y),
    });
    // 头像
    const c = document.getElementById('pcAvatar');
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const grd = ctx.createLinearGradient(0, 0, 0, c.height);
    grd.addColorStop(0, '#dff0c8'); grd.addColorStop(1, '#b9d99a');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, c.width, c.height);
    const sheet = getCharacterSheet(r.appearance || {});
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, 0, 0, 16, 24, 16, 26, 64, 96);
  }

  // ---------------- 拍照 ----------------
  async takePhoto(opts = {}) {
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
      const withName = opts.withName || (nearCat ? null : null);
      const out = capturePhoto(this.canvas, {
        place: here ? here.name : '燕园',
        name: this.character.name,
        cat: nearCat ? nearCat.name : null,
        withName: opts.withName || null,
      });
      const ts = new Date();
      const fname = `yanyuan-${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}.png`;
      await savePhoto(out, fname);
      ui.flash();
      ui.toast('照片已保存 · ' + (here ? here.name : '燕园'), 'good');
      this.progress.stats.photos = (this.progress.stats.photos || 0) + 1;
      this.store.touch();
      this.checkAchievements();
      const lake = this.world.landmarks.find(l => l.name === '未名湖' && !l.aliasOf);
      if (lake && dist(this.me.x, this.me.y, lake.ax, lake.ay) < 90) this.completeQuest('photo:lake');
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
