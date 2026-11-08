// 程序化像素精灵：角色四向行走、校园猫、玩家名牌
import { clamp } from './util.js';

export const SKINS = ['#f3d3b0', '#ecc19a', '#dfa878', '#c98a5c', '#a86f45', '#7d4f31'];
export const HAIRS = ['#2a2118', '#4a3524', '#6d4a2c', '#a8703e', '#cf9a52', '#e0bb72', '#9a9a9a', '#42425a'];
export const TOPS = ['#c8553d', '#3f6fa8', '#5a8a3c', '#d9a441', '#7a5aa0', '#3f8a8a', '#e6e1d4', '#4a4a52'];
export const PANTS = ['#33415c', '#4a3b31', '#2f3b2f', '#5a5a66', '#7a5a3a', '#d8d0c0'];
export const SHOES = ['#2a2118', '#5a3a2a', '#8a8a8a', '#c8553d'];
export const HAIR_STYLES = ['短发', '齐耳', '长发', '丸子', '卷发', '光头'];
export const ACCESSORIES = ['无', '眼镜', '围巾', '背包', '帽子'];

const DIRS = ['down', 'left', 'right', 'up'];
const FW = 16, FH = 24;

function px(g, x, y, w, h, color) {
  g.fillStyle = color;
  g.fillRect(x | 0, y | 0, w | 0, h | 0);
}

/** 生成一张角色精灵表：48x96，横向 3 帧，纵向 4 朝向 */
export function buildCharacterSheet(app) {
  const c = document.createElement('canvas');
  c.width = FW * 3; c.height = FH * 4;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  const skin = SKINS[clamp(app.skin | 0, 0, SKINS.length - 1)];
  const hair = HAIRS[clamp(app.hairColor | 0, 0, HAIRS.length - 1)];
  const top = TOPS[clamp(app.top | 0, 0, TOPS.length - 1)];
  const pants = PANTS[clamp(app.pants | 0, 0, PANTS.length - 1)];
  const shoes = SHOES[clamp(app.shoes | 0, 0, SHOES.length - 1)];
  const hairStyle = clamp(app.hair | 0, 0, 5);
  const acc = clamp(app.acc | 0, 0, 4);

  for (let d = 0; d < 4; d++) {
    for (let f = 0; f < 3; f++) {
      g.save();
      g.translate(f * FW, d * FH);
      drawChar(g, { dir: DIRS[d], frame: f, skin, hair, top, pants, shoes, hairStyle, acc });
      g.restore();
    }
  }
  return c;
}

function drawChar(g, o) {
  const { dir, frame, skin, hair, top, pants, shoes, hairStyle, acc } = o;
  const bob = frame === 0 ? 0 : -1;
  const back = dir === 'up';
  const side = dir === 'left' || dir === 'right';

  // 腿与鞋（先画，被躯干压住）
  const legY = 20 + bob;
  if (frame === 0) {
    px(g, 5, 17, 2, 4, pants); px(g, 9, 17, 2, 4, pants);
    px(g, 5, 21, 2, 2, shoes); px(g, 9, 21, 2, 2, shoes);
  } else if (frame === 1) {
    px(g, 4, 17, 2, 4, pants); px(g, 10, 17, 2, 4, pants);
    px(g, 4, legY + 1, 2, 2, shoes); px(g, 10, legY, 2, 2, shoes);
  } else {
    px(g, 5, 17, 2, 4, pants); px(g, 9, 17, 2, 4, pants);
    px(g, 5, legY, 2, 2, shoes); px(g, 9, legY + 1, 2, 2, shoes);
  }

  // 躯干
  px(g, 5, 11 + bob, 6, 6, top);
  px(g, 5, 16 + bob, 6, 1, pants);
  // 衣服细节：领口 / 拉链
  px(g, 7, 11 + bob, 2, 1, 'rgba(255,255,255,.42)');
  // 手臂
  px(g, 3, 11 + bob, 2, 4, top);
  px(g, 11, 11 + bob, 2, 4, top);
  px(g, 3, 15 + bob, 2, 1, skin);
  px(g, 11, 15 + bob, 2, 1, skin);

  if (acc === 3 && !back) {
    // 背包（只在侧面/背面明显）
    px(g, 11, 10 + bob, 2, 5, '#8a6a4a');
  }

  // 脖子
  px(g, 7, 9 + bob, 2, 2, skin);

  // 头
  if (back) {
    px(g, 4, 2 + bob, 8, 8, skin);
  } else if (side) {
    px(g, 5, 2 + bob, 7, 8, skin);
  } else {
    px(g, 4, 2 + bob, 8, 8, skin);
  }

  // 头发
  drawHair(g, { dir, bob, hair, hairStyle });

  // 面部
  if (!back) {
    if (side) {
      const ex = dir === 'left' ? 5 : 10;
      px(g, ex, 5 + bob, 1, 2, '#2a2118');
      if (acc === 1) px(g, ex - (dir === 'left' ? 0 : 1), 5 + bob, 2, 2, 'rgba(60,60,70,.5)');
    } else {
      px(g, 6, 5 + bob, 1, 2, '#2a2118');
      px(g, 9, 5 + bob, 1, 2, '#2a2118');
      px(g, 7, 8 + bob, 2, 1, '#c08878');
      if (acc === 1) {
        px(g, 5, 5 + bob, 2, 2, 'rgba(60,60,70,.45)');
        px(g, 9, 5 + bob, 2, 2, 'rgba(60,60,70,.45)');
        px(g, 7, 5 + bob, 2, 1, 'rgba(60,60,70,.45)');
      }
    }
    if (acc === 2) {
      px(g, 5, 9 + bob, 6, 1, '#e0c060');
      px(g, 7, 10 + bob, 2, 2, '#e0c060');
    }
  }

  // 帽子
  if (acc === 4) {
    px(g, 3, 1 + bob, 10, 2, '#3f6fa8');
    px(g, 4, -1 + bob, 8, 2, '#3f6fa8');
    if (!back) px(g, 4, 3 + bob, 8, 1, '#2f5688');
  }

  // 描边（简单加深边缘，增强像素质感）
  g.globalAlpha = 0.18;
  g.fillStyle = '#1c2418';
  g.fillRect(4, 10 + bob, 1, 6);
  g.fillRect(11, 10 + bob, 1, 6);
  g.globalAlpha = 1;
}

function drawHair(g, { dir, bob, hair, hairStyle }) {
  const back = dir === 'up';
  // 基础覆盖
  px(g, 4, 1 + bob, 8, 3, hair);
  px(g, 3, 2 + bob, 1, 4, hair);
  px(g, 12, 2 + bob, 1, 4, hair);
  if (hairStyle === 0) { // 短发
    px(g, 4, 1 + bob, 8, 2, hair);
  } else if (hairStyle === 1) { // 齐耳
    px(g, 3, 1 + bob, 10, 3, hair);
    px(g, 3, 4 + bob, 1, 3, hair);
    px(g, 12, 4 + bob, 1, 3, hair);
  } else if (hairStyle === 2) { // 长发
    px(g, 3, 1 + bob, 10, 3, hair);
    px(g, 3, 4 + bob, 1, 7, hair);
    px(g, 12, 4 + bob, 1, 7, hair);
    if (back) px(g, 4, 3 + bob, 8, 7, hair);
  } else if (hairStyle === 3) { // 丸子头
    px(g, 4, 1 + bob, 8, 2, hair);
    px(g, 6, -2 + bob, 4, 3, hair);
  } else if (hairStyle === 4) { // 卷发
    px(g, 3, 1 + bob, 2, 2, hair); px(g, 6, 0 + bob, 4, 2, hair);
    px(g, 11, 1 + bob, 2, 2, hair); px(g, 4, 3 + bob, 8, 1, hair);
  } else { // 光头：只留两侧一点
    px(g, 3, 3 + bob, 1, 2, hair); px(g, 12, 3 + bob, 1, 2, hair);
  }
  if (back && hairStyle !== 5) {
    px(g, 4, 2 + bob, 8, 5, hair);
  }
}

export const characterSheetCache = new Map();
export function getCharacterSheet(app) {
  const key = [app.skin, app.hair, app.hairColor, app.top, app.pants, app.shoes, app.acc].join(':');
  let s = characterSheetCache.get(key);
  if (!s) {
    s = buildCharacterSheet(app);
    if (characterSheetCache.size > 120) characterSheetCache.clear();
    characterSheetCache.set(key, s);
  }
  return s;
}

const DIR_ROW = { down: 0, left: 1, right: 2, up: 3 };

/** 画一个角色（世界坐标已转屏幕坐标） */
export function drawCharacter(ctx, sheet, dir, frame, x, y, zoom, opts = {}) {
  const row = DIR_ROW[dir] ?? 0;
  const scale = 1.35 * zoom;
  const w = FW * scale, h = FH * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (opts.ghost) ctx.globalAlpha = 0.5;
  // 脚下阴影
  ctx.fillStyle = 'rgba(30,42,26,.24)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 5.5 * zoom, 2.4 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  if (opts.bike) drawBike(ctx, x, y, dir, zoom);
  ctx.drawImage(sheet, frame * FW, row * FH, FW, FH,
    Math.round(x - w / 2), Math.round(y - h + 2), Math.round(w), Math.round(h));
  ctx.restore();
}

function drawBike(ctx, x, y, dir, zoom) {
  ctx.save();
  ctx.strokeStyle = 'rgba(40,50,36,.75)';
  ctx.lineWidth = Math.max(1, 1.2 * zoom);
  const w = 13 * zoom;
  ctx.beginPath();
  ctx.ellipse(x - w * 0.55, y - 2 * zoom, 3.6 * zoom, 3.6 * zoom, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x + w * 0.55, y - 2 * zoom, 3.6 * zoom, 3.6 * zoom, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - w * 0.55, y - 2 * zoom);
  ctx.lineTo(x, y - 7 * zoom);
  ctx.lineTo(x + w * 0.55, y - 2 * zoom);
  ctx.stroke();
  ctx.restore();
}

// ---------- 校园猫 ----------
const CAT_POSES = ['sit', 'walk1', 'walk2', 'sleep', 'happy'];
const CW = 18, CH = 14;

const CAT_COLORS = {
  orange: ['#e29a52', '#b9732f', '#f4c088'],
  black: ['#3a3a40', '#26262b', '#55555e'],
  white: ['#f2ece0', '#d8cfc0', '#ffffff'],
  gray: ['#9a9a96', '#77776f', '#bcbcb4'],
  calico: ['#f0e6d6', '#c8783c', '#4a4a50'],
  tabby: ['#c8a274', '#8a6a44', '#e0c69a'],
};

export function buildCatSheet(colorKey) {
  const c = document.createElement('canvas');
  c.width = CW * CAT_POSES.length; c.height = CH * 2; // 2 行：朝右 / 朝左（镜像）
  const g = c.getContext('2d');
  const [body, dark, light] = CAT_COLORS[colorKey] || CAT_COLORS.orange;
  CAT_POSES.forEach((pose, i) => {
    g.save();
    g.translate(i * CW, 0);
    drawCatBody(g, pose, body, dark, light);
    g.restore();
  });
  // 朝左：镜像第一行
  g.save();
  g.translate(0, CH);
  g.scale(1, 1);
  for (let i = 0; i < CAT_POSES.length; i++) {
    g.save();
    g.translate(i * CW + CW, 0);
    g.scale(-1, 1);
    drawCatBody(g, CAT_POSES[i], body, dark, light);
    g.restore();
  }
  g.restore();
  return c;
}

function drawCatBody(g, pose, body, dark, light) {
  const baseY = 12;
  if (pose === 'sleep') {
    px(g, 3, baseY - 4, 11, 4, body);
    px(g, 4, baseY - 6, 6, 3, body);
    px(g, 4, baseY - 6, 2, 1, light);
    px(g, 11, baseY - 3, 4, 1, dark);
    px(g, 5, baseY - 4, 1, 1, dark);
    return;
  }
  const sitting = pose === 'sit';
  const bob = pose === 'walk2' ? 0 : 0;
  // 身体
  if (sitting) {
    px(g, 4, baseY - 5, 7, 5, body);
    px(g, 4, baseY - 1, 7, 1, dark);
    px(g, 10, baseY - 4, 2, 4, body);
  } else {
    px(g, 3, baseY - 5, 10, 4, body);
    px(g, 3, baseY - 1, 10, 1, dark);
  }
  // 头
  const hx = sitting ? 9 : 11;
  px(g, hx, baseY - 9, 6, 5, body);
  px(g, hx, baseY - 9, 6, 1, light);
  // 耳朵
  px(g, hx, baseY - 11, 1, 2, body);
  px(g, hx + 4, baseY - 11, 1, 2, body);
  px(g, hx + 1, baseY - 10, 1, 1, dark);
  // 脸
  if (pose === 'happy') {
    px(g, hx + 1, baseY - 7, 1, 1, dark);
    px(g, hx + 3, baseY - 7, 1, 1, dark);
    px(g, hx + 2, baseY - 6, 1, 1, dark);
  } else {
    px(g, hx + 1, baseY - 7, 1, 2, dark);
    px(g, hx + 3, baseY - 7, 1, 2, dark);
    px(g, hx + 2, baseY - 5, 1, 1, '#c86a6a');
  }
  // 尾巴
  if (sitting) {
    px(g, 2, baseY - 3, 2, 3, body);
    px(g, 2, baseY - 5, 1, 2, body);
  } else {
    px(g, 1, baseY - 6, 2, 1, body);
    px(g, 1, baseY - 5, 1, 3, body);
  }
  // 腿
  if (!sitting) {
    if (pose === 'walk1') {
      px(g, 4, baseY, 1, 2, dark); px(g, 9, baseY, 1, 2, dark);
    } else {
      px(g, 5, baseY, 1, 2, dark); px(g, 10, baseY, 1, 2, dark);
    }
  }
}

export const catSheetCache = new Map();
export function getCatSheet(colorKey) {
  let s = catSheetCache.get(colorKey);
  if (!s) { s = buildCatSheet(colorKey); catSheetCache.set(colorKey, s); }
  return s;
}

export function catPoseIndex(pose) { return Math.max(0, CAT_POSES.indexOf(pose)); }

export function drawCat(ctx, sheet, pose, facingLeft, x, y, zoom) {
  const idx = catPoseIndex(pose);
  const row = facingLeft ? 1 : 0;
  const scale = 1.3 * zoom;
  const w = CW * scale, h = CH * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = 'rgba(30,42,26,.22)';
  ctx.beginPath();
  ctx.ellipse(x, y, 5 * zoom, 2 * zoom, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(sheet, idx * CW, row * CH, CW, CH,
    Math.round(x - w / 2), Math.round(y - h + 3), Math.round(w), Math.round(h));
  ctx.restore();
}

/** 玩家名牌 */
export function drawNameTag(ctx, name, x, y, zoom, color = '#ffffff', online = true) {
  const size = Math.max(10, Math.round(11 * Math.min(1.25, zoom)));
  ctx.save();
  ctx.font = `600 ${size}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(name).width;
  ctx.fillStyle = 'rgba(24,36,20,.52)';
  const padX = 4, h = size + 4;
  roundRect(ctx, x - w / 2 - padX, y - h, w + padX * 2, h, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(name, x, y - 2);
  if (!online) {
    ctx.fillStyle = 'rgba(200,85,61,.9)';
    ctx.fillRect(x - w / 2 - padX, y - 1, w + padX * 2, 1);
  }
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
