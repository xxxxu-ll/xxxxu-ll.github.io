// 启动流程：加载地图 → 连接世界 → 创建角色 / 恢复存档 → 进入游戏
import { loadMap } from './mapdata.js';
import { buildMapLayers } from './minimap.js';
import { Api, retry, ApiError } from './net.js';
import { Game } from './game.js';
import * as ui from './ui.js';
import {
  SKINS, HAIRS, TOPS, PANTS, SHOES, HAIR_STYLES, ACCESSORIES, buildCharacterSheet,
} from './sprites.js';
import { normalizeRecovery } from './util.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

const state = {
  world: null,
  layers: null,
  api: new Api(),
  appearance: { skin: 1, hair: 1, hairColor: 0, top: 0, pants: 0, shoes: 0, acc: 0 },
  game: null,
};

// ---------------- 启动 ----------------
async function boot() {
  try {
    ui.bootProgress(0.08, '正在加载燕园地图…');
    const world = await loadMap((p, text) => ui.bootProgress(0.08 + p * 0.55, text));
    state.world = world;

    ui.bootProgress(0.66, '正在绘制校园底图…');
    await frame();
    state.layers = buildMapLayers(world);

    ui.bootProgress(0.86, '正在连接世界服务…');
    await frame();
    let online = false;
    try {
      const h = await retry(() => state.api.health(), { tries: 3, base: 500 });
      online = !!h.ok;
    } catch (e) {
      online = false;
    }
    ui.bootProgress(1, online ? '准备就绪' : '世界服务暂时连不上');
    await frame();
    ui.hideBoot();

    if (!online) {
      $('startStatus').textContent = '世界服务暂时连不上，稍后可以重试。';
      $('btnOffline').classList.remove('hidden');
      toast('世界服务连接失败，可以先离线漫游校园', 'warn', 4200);
    } else {
      $('startStatus').textContent = '世界在线 · 校园里有 ' + (await safeOnline()) + ' 位同学';
    }

    await tryResume();
  } catch (e) {
    console.error(e);
    ui.hideBoot();
    $('startStatus').textContent = '加载失败：' + (e.message || e);
    ui.toast('加载失败：' + (e.message || e), 'bad', 6000);
  }
}

function frame() { return new Promise(r => requestAnimationFrame(() => r())); }

async function safeOnline() {
  try { const h = await state.api.health(); return h.online ?? 0; } catch { return 0; }
}

async function tryResume() {
  const token = localStorage.getItem('yanyuan.token');
  if (!token) return;
  try {
    const res = await state.api.session(token);
    enterGame(res.character, res.progress || {});
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 400)) {
      localStorage.removeItem('yanyuan.token');
      $('startStatus').textContent = '保存的登录状态已失效，请用恢复码重新登录。';
    } else {
      $('startStatus').textContent = '连接世界服务失败：' + e.message;
    }
  }
}

// ---------------- 进入游戏 ----------------
function enterGame(character, progress, opts = {}) {
  $('startScreen').classList.add('hidden');
  $('createScreen').classList.add('hidden');
  $('restoreScreen').classList.add('hidden');

  const game = new Game({
    world: state.world,
    api: state.api,
    character,
    progress,
    layers: state.layers,
    offline: !!opts.offline,
  });
  state.game = game;
  game.start();
  window.__yanyuan = game; // 便于调试与自动化验证
}

// ---------------- 创建角色 ----------------
function buildCreator() {
  const rows = $('styleRows');
  rows.innerHTML = '';

  const group = (label, items, key, kind = 'color') => {
    const wrap = document.createElement('div');
    wrap.className = 'swatch-group';
    const lab = document.createElement('div');
    lab.className = 'label';
    lab.textContent = label;
    wrap.appendChild(lab);
    const list = document.createElement('div');
    list.className = 'swatches';
    items.forEach((item, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (kind === 'style' ? ' style' : '') + (state.appearance[key] === i ? ' sel' : '');
      if (kind === 'color') b.style.background = item;
      else b.textContent = item;
      b.title = kind === 'style' ? item : '';
      b.onclick = () => {
        state.appearance[key] = i;
        [...list.children].forEach((c, j) => c.classList.toggle('sel', j === i));
        drawPreview();
      };
      list.appendChild(b);
    });
    wrap.appendChild(list);
    rows.appendChild(wrap);
  };

  group('肤色', SKINS, 'skin');
  group('发型', HAIR_STYLES, 'hair', 'style');
  group('发色', HAIRS, 'hairColor');
  group('上衣', TOPS, 'top');
  group('裤子', PANTS, 'pants');
  group('鞋子', SHOES, 'shoes');
  group('配饰', ACCESSORIES, 'acc', 'style');

  const randomBtn = document.createElement('button');
  randomBtn.type = 'button';
  randomBtn.className = 'ghostbtn';
  randomBtn.textContent = '随机搭配';
  randomBtn.style.marginTop = '4px';
  randomBtn.onclick = () => {
    const r = (n) => Math.floor(Math.random() * n);
    state.appearance = {
      skin: r(SKINS.length), hair: r(HAIR_STYLES.length), hairColor: r(HAIRS.length),
      top: r(TOPS.length), pants: r(PANTS.length), shoes: r(SHOES.length), acc: r(ACCESSORIES.length),
    };
    buildCreator();
    drawPreview();
  };
  rows.appendChild(randomBtn);

  $('inName').addEventListener('input', () => {
    $('previewName').textContent = $('inName').value || '未命名';
  });
  $('inDept').addEventListener('input', () => {
    $('previewSub').textContent = [$('inDept').value, $('inGrade').value].filter(Boolean).join(' · ');
  });
  $('inGrade').addEventListener('input', () => {
    $('previewSub').textContent = [$('inDept').value, $('inGrade').value].filter(Boolean).join(' · ');
  });
}

function drawPreview() {
  const c = $('previewCanvas');
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  const grd = ctx.createLinearGradient(0, 0, 0, c.height);
  grd.addColorStop(0, '#dff0c8');
  grd.addColorStop(1, '#b9d99a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, c.width, c.height);
  // 地面影子
  ctx.fillStyle = 'rgba(60,90,40,.16)';
  ctx.beginPath();
  ctx.ellipse(c.width / 2, c.height - 16, 26, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  const sheet = buildCharacterSheet(state.appearance);
  const scale = 5.2;
  const w = 16 * scale, h = 24 * scale;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, 0, 0, 16, 24, Math.round(c.width / 2 - w / 2), Math.round(c.height - h - 12), Math.round(w), Math.round(h));
}

// ---------------- 恢复码 ----------------
function formatInputRecovery(el) {
  el.addEventListener('input', () => {
    const raw = el.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 20);
    el.value = (raw.match(/.{1,4}/g) || []).join('-');
  });
}

// ---------------- 事件绑定 ----------------
function bindScreens() {
  $('btnCreate').onclick = () => {
    $('startScreen').classList.add('hidden');
    $('createScreen').classList.remove('hidden');
    drawPreview();
    setTimeout(() => $('inName').focus(), 50);
  };
  $('btnBackStart').onclick = () => {
    $('createScreen').classList.add('hidden');
    $('startScreen').classList.remove('hidden');
  };
  $('btnRestore').onclick = () => {
    $('startScreen').classList.add('hidden');
    $('restoreScreen').classList.remove('hidden');
    setTimeout(() => $('inRecovery').focus(), 50);
  };
  $('btnOffline').onclick = () => {
    enterGame(
      { id: 'local', name: '离线漫游者', appearance: { skin: 1, hair: 1, hairColor: 0, top: 2, pants: 0, shoes: 0, acc: 0 }, x: -158, y: 178, dir: 'down', profile: {} },
      {},
      { offline: true },
    );
  };
  $('btnBackStart2').onclick = () => {
    $('restoreScreen').classList.add('hidden');
    $('startScreen').classList.remove('hidden');
  };

  $('btnEnter').onclick = async () => {
    const name = $('inName').value.trim();
    const err = $('createError');
    if ([...name].length < 2 || [...name].length > 12) {
      err.textContent = '昵称需要 2–12 个字符';
      return;
    }
    err.textContent = '';
    const btn = $('btnEnter');
    btn.disabled = true;
    btn.textContent = '正在创建…';
    try {
      const res = await state.api.createPlayer(name, state.appearance, {
        dept: $('inDept').value.trim(),
        grade: $('inGrade').value.trim(),
        bio: $('inBio').value.trim(),
      });
      state.api.setToken(res.token);
      localStorage.setItem('yanyuan.token', res.token);
      localStorage.setItem('yanyuan.name', res.character.name);
      ui.showRecovery(res.recovery);
      ui.el.codeOverlay.dataset.pending = JSON.stringify({ character: res.character, progress: res.progress || {} });
    } catch (e) {
      err.textContent = e.message || '创建失败，请稍后再试';
    } finally {
      btn.disabled = false;
      btn.textContent = '进入燕园';
    }
  };

  $('codeOk').onclick = () => {
    const pending = ui.el.codeOverlay.dataset.pending;
    ui.hideRecovery();
    if (!pending) return;
    const { character, progress } = JSON.parse(pending);
    delete ui.el.codeOverlay.dataset.pending;
    enterGame(character, progress);
  };
  $('codeCopy').onclick = async () => {
    const code = ui.el.codeOverlay.dataset.code || '';
    try {
      await navigator.clipboard.writeText(code);
      ui.toast('恢复码已复制', 'good');
    } catch {
      ui.toast('复制失败，请手动记录', 'warn');
    }
  };
  $('codeSave').onclick = () => {
    const code = ui.el.codeOverlay.dataset.code || '';
    const blob = new Blob([`像素燕园 · 角色恢复码\n\n${code}\n\n请妥善保存。任何人拿到它都能登录你的角色。\n`], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'yanyuan-恢复码.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const rec = $('inRecovery');
  formatInputRecovery(rec);
  $('btnDoRestore').onclick = async () => {
    const raw = normalizeRecovery(rec.value);
    const err = $('restoreError');
    if (raw.length < 16) { err.textContent = '恢复码格式不对，应该是 5 组 4 位字符'; return; }
    err.textContent = '';
    const btn = $('btnDoRestore');
    btn.disabled = true;
    btn.textContent = '正在登录…';
    try {
      const res = await state.api.session(raw);
      localStorage.setItem('yanyuan.token', raw);
      localStorage.setItem('yanyuan.name', res.character.name);
      enterGame(res.character, res.progress || {});
    } catch (e) {
      err.textContent = e.status === 401 ? '恢复码无效，检查一下有没有输错' : (e.message || '登录失败');
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  };

  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
  });
}

// ---------------- 启动 ----------------
buildCreator();
bindScreens();
boot();
