// 界面层：HUD、提示、聊天、手册、弹窗
import { escapeHtml, pad2 } from './util.js?v=202611091300';
import { ACHIEVEMENTS } from './progress.js?v=202611091300';
import { affinityLabel, AFF, HABIT_TEXT, catAwake } from './cats.js?v=202611091300';

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

/** 存档状态：saved / pending / saving / offline */
export function setSaveState(state, attempts = 0) {
  const chip = document.getElementById('chipSave');
  if (!chip) return;
  chip.classList.remove('save-warn', 'save-bad');
  if (state === 'saving') { chip.textContent = '保存中…'; }
  else if (state === 'pending') { chip.textContent = '待同步'; chip.classList.add('save-warn'); }
  else if (state === 'offline') {
    chip.textContent = attempts > 1 ? `未保存·重试(${attempts})` : '未保存';
    chip.classList.add('save-bad');
  } else { chip.textContent = '已保存'; }
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
      const hour = new Date().getHours() + new Date().getMinutes() / 60;
      const around = c ? catAwake(c.def, hour) : true;
      const habit = c ? (HABIT_TEXT[c.def.habit] || '') : '';
      const li = document.createElement('li');
      li.innerHTML = `<span style="min-width:0">
          <b>${escapeHtml(name)}</b>
          <span class="muted small">${escapeHtml(affinityLabel(aff))}</span>
          ${around ? '' : '<span class="small tag-away">此刻不在</span>'}
          ${habit ? `<br><span class="small muted">${escapeHtml(habit)}</span>` : ''}
        </span>` +
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

// ---------------- 地点卡片 ----------------
export function showPlace(place, name) {
  const ov = document.getElementById('placeOverlay');
  document.getElementById('placeTitle').textContent = place.title || name;
  document.getElementById('placeStory').textContent = place.story || '';
  document.getElementById('placeDetail').textContent = place.detail || '';
  document.getElementById('placeRemember').textContent = place.act || '记进手册';
  ov.classList.remove('hidden');
  ov.dataset.name = name || '';
  return ov;
}

export function hidePlace() {
  document.getElementById('placeOverlay').classList.add('hidden');
}

// ---------------- 玩家名片 ----------------
export function showPlayerCard(p) {
  const ov = document.getElementById('cardOverlay');
  document.getElementById('pcName').textContent = p.name || '同学';
  const meta = [p.dept, p.grade].filter(Boolean).join(' · ');
  document.getElementById('pcMeta').textContent = meta || '燕园里的同学';
  document.getElementById('pcBio').textContent = p.bio || '';
  const hint = document.getElementById('pcHint');
  const dist = p.dist != null ? `距离你 ${Math.round(p.dist)} 米` : '';
  hint.textContent = dist ? dist + ' · 只能看到公开资料' : '只能看到公开资料';
  ov.classList.remove('hidden');
  ov.dataset.id = p.id;
  return ov;
}

export function hidePlayerCard() {
  document.getElementById('cardOverlay').classList.add('hidden');
}

/** 前五分钟的邀请卡片 */
export function showInvites(items, onPick, onSkip) {
  const card = document.getElementById('inviteCard');
  const list = document.getElementById('inviteList');
  list.innerHTML = '';
  for (const it of items) {
    const btn = document.createElement('button');
    btn.className = 'invite-item';
    btn.innerHTML = `<b>${escapeHtml(it.title)}</b><span>${escapeHtml(it.desc)}</span>`;
    btn.onclick = () => { hideInvites(); onPick(it); };
    list.appendChild(btn);
  }
  document.getElementById('inviteSkip').onclick = () => { hideInvites(); onSkip && onSkip(); };
  card.classList.remove('hidden');
}

export function hideInvites() {
  document.getElementById('inviteCard').classList.add('hidden');
}

/** 致命错误：给出可读的提示，而不是黑屏 */export function showFatal(message) {
  let box = document.getElementById('fatalBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fatalBox';
    box.className = 'fatal';
    document.body.appendChild(box);
  }
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = '出了点问题';
  const p = document.createElement('p');
  p.style.whiteSpace = 'pre-wrap';
  p.textContent = String(message || '未知错误');
  const btn = document.createElement('button');
  btn.className = 'primarybtn';
  btn.textContent = '刷新页面';
  btn.onclick = () => location.reload();
  box.appendChild(h);
  box.appendChild(p);
  box.appendChild(btn);
  box.classList.remove('hidden');
}

export function hideBoot() {
  el.boot.classList.add('done');
  setTimeout(() => el.boot.classList.add('hidden'), 420);
}

export { $ };
