// 界面层：HUD、提示、聊天、手册、弹窗
import { escapeHtml, pad2 } from './util.js';
import { ACHIEVEMENTS } from './progress.js';
import { affinityLabel, AFF } from './cats.js';

const $ = (id) => document.getElementById(id);

export const el = {
  hud: $('hud'),
  canvas: $('game'),
  locName: $('locName'),
  chipOnline: $('chipOnline'),
  chipExplore: $('chipExplore'),
  chipClock: $('chipClock'),
  prompt: $('prompt'),
  promptText: $('promptText'),
  chatlog: $('chatlog'),
  chatbar: $('chatbar'),
  chatInput: $('chatInput'),
  banner: $('banner'),
  toasts: $('toasts'),
  minimap: $('minimap'),
  minimapCanvas: $('minimapCanvas'),
  mapOverlay: $('mapOverlay'),
  fullmap: $('fullmap'),
  mapSearch: $('mapSearch'),
  searchResults: $('searchResults'),
  destText: $('destText'),
  mapFooter: $('mapFooter'),
  journalOverlay: $('journalOverlay'),
  helpOverlay: $('helpOverlay'),
  codeOverlay: $('codeOverlay'),
  codeBox: $('codeBox'),
  flash: $('flash'),
  boot: $('boot'),
  bootBar: $('bootBar'),
  bootText: $('bootText'),
};

export function toast(text, type = '', ms = 2600) {
  const d = document.createElement('div');
  d.className = 'toast ' + type;
  d.textContent = text;
  el.toasts.appendChild(d);
  setTimeout(() => d.remove(), ms + 400);
  while (el.toasts.children.length > 4) el.toasts.firstChild.remove();
}

let bannerTimer = null;
export function showBanner(text, { info = false, ms = 0 } = {}) {
  el.banner.textContent = text;
  el.banner.className = 'banner' + (info ? ' info' : '');
  if (bannerTimer) clearTimeout(bannerTimer);
  if (ms > 0) {
    bannerTimer = setTimeout(() => el.banner.classList.add('hidden'), ms);
  }
}
export function hideBanner() {
  if (bannerTimer) clearTimeout(bannerTimer);
  el.banner.classList.add('hidden');
}

let promptText = null;
export function setPrompt(text) {
  if (text === promptText) return;
  promptText = text;
  if (!text) { el.prompt.classList.add('hidden'); return; }
  el.promptText.textContent = text;
  el.prompt.classList.remove('hidden');
}

const chatLines = [];
export function pushChatLine({ name, text, sys = false, mine = false }) {
  const d = document.createElement('div');
  d.className = 'line' + (sys ? ' sys' : '');
  if (sys) {
    d.textContent = text;
  } else {
    d.innerHTML = `<b>${escapeHtml(name)}</b>${mine ? '（我）' : ''}：${escapeHtml(text)}`;
  }
  el.chatlog.appendChild(d);
  chatLines.push({ el: d, at: Date.now() });
  while (chatLines.length > 7) {
    const old = chatLines.shift();
    old.el.remove();
  }
  setTimeout(() => { if (d.parentNode) d.classList.add('fade'); }, 26000);
}

export function clearChat() {
  el.chatlog.innerHTML = '';
  chatLines.length = 0;
}

export function setLocation(name) {
  el.locName.textContent = name;
}

export function setOnline(n) {
  el.chipOnline.innerHTML = `在线 <b>${n}</b>`;
}

export function setExplore(found, total) {
  el.chipExplore.innerHTML = `探索 <b>${found}</b>/${total}`;
}

export function setClock(hour, minute) {
  el.chipClock.textContent = `${pad2(hour)}:${pad2(minute)}`;
}

// ---------------- 手册 ----------------
export function renderJournal(world, progress) {
  const found = world.landmarks.filter(l => !l.aliasOf && progress.visited[l.name]).length;
  const total = world.exploreTotal;
  $('exploreBar').style.width = (total ? (found / total) * 100 : 0) + '%';
  $('exploreText').textContent = `已发现 ${found} / ${total} 处地点`;

  const catList = $('catList');
  catList.innerHTML = '';
  const seenAny = Object.keys(progress.cats).length > 0;
  if (!seenAny) {
    catList.innerHTML = `<li class="muted">还没有认识校园猫。它们分散在湖边、图书馆、食堂和宿舍区，靠近后按 E 互动。</li>`;
  } else {
    for (const [id, st] of Object.entries(progress.cats)) {
      const c = world.__cats ? world.__cats.find(x => x.id === id) : null;
      const name = c ? c.name : id;
      const aff = st.a || 0;
      const li = document.createElement('li');
      li.innerHTML = `<span><b>${escapeHtml(name)}</b> <span class="muted small">${escapeHtml(affinityLabel(aff))}</span></span>` +
        `<span class="aff">${aff}/100${st.f ? ' · 跟随中' : ''}</span>`;
      catList.appendChild(li);
    }
  }

  const achList = $('achList');
  achList.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const got = !!progress.ach[a.id];
    const li = document.createElement('li');
    li.className = got ? 'unlocked' : 'locked';
    li.innerHTML = `<b>${got ? '✓ ' : ''}${escapeHtml(a.name)}</b>` +
      `<span class="muted small"> · ${escapeHtml(a.desc)}${got && a.title ? ' · 称号「' + escapeHtml(a.title) + '」' : ''}</span>`;
    achList.appendChild(li);
  }

  const itemList = $('itemList');
  itemList.innerHTML = '';
  if (!progress.items.length) {
    itemList.innerHTML = `<li class="muted">还没有收到猫的礼物。关系变好时，它们会留下点什么。</li>`;
  } else {
    for (const it of progress.items) {
      const li = document.createElement('li');
      li.textContent = it;
      itemList.appendChild(li);
    }
  }
}

// ---------------- 恢复码 ----------------
export function showRecovery(code) {
  el.codeBox.textContent = code;
  el.codeOverlay.classList.remove('hidden');
  el.codeOverlay.dataset.code = code;
}

export function hideRecovery() {
  el.codeOverlay.classList.add('hidden');
}

export function flash() {
  el.flash.classList.add('on');
  setTimeout(() => el.flash.classList.remove('on'), 130);
}

export function bootProgress(p, text) {
  el.bootBar.style.width = Math.round(p * 100) + '%';
  if (text) el.bootText.textContent = text;
}

export function hideBoot() {
  el.boot.classList.add('done');
  setTimeout(() => el.boot.classList.add('hidden'), 420);
}

export { $ };
