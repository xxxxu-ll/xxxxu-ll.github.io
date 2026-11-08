// 拍照：把当前画面连同一枚校园印章保存为 PNG
import { pad2 } from './util.js';

export function capturePhoto(sourceCanvas, { place = '燕园', name = '', date = new Date(), cat = null } = {}) {
  const src = sourceCanvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // 以较小边为基准输出，控制体积
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, w, h);

  // 底部渐隐 + 信息条
  const barH = Math.max(64, Math.round(h * 0.11));
  const grad = g.createLinearGradient(0, h - barH * 1.6, 0, h);
  grad.addColorStop(0, 'rgba(20,30,18,0)');
  grad.addColorStop(1, 'rgba(20,30,18,.72)');
  g.fillStyle = grad;
  g.fillRect(0, h - barH * 1.6, w, barH * 1.6);

  const fs = Math.round(barH * 0.30);
  g.textBaseline = 'alphabetic';
  g.font = `700 ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
  g.fillStyle = '#fdfaf3';
  const title = place || '燕园';
  g.fillText(title, barH * 0.45, h - barH * 0.52);

  g.font = `500 ${Math.round(fs * 0.72)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  g.fillStyle = 'rgba(253,250,243,.82)';
  const stamp = `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  g.fillText(stamp, barH * 0.45, h - barH * 0.22);

  // 右下角印章
  const seal = Math.round(barH * 0.9);
  const sx = w - seal - barH * 0.5, sy = h - seal - barH * 0.32;
  g.save();
  g.globalAlpha = 0.9;
  g.fillStyle = '#c8553d';
  roundRectPath(g, sx, sy, seal, seal, seal * 0.16);
  g.fill();
  g.fillStyle = '#fdfaf3';
  g.font = `700 ${Math.round(seal * 0.34)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  g.textAlign = 'center';
  g.fillText('像素', sx + seal / 2, sy + seal * 0.44);
  g.fillText('燕园', sx + seal / 2, sy + seal * 0.80);
  g.restore();

  if (cat) {
    g.font = `600 ${Math.round(fs * 0.74)}px "PingFang SC","Microsoft YaHei",sans-serif`;
    g.fillStyle = 'rgba(253,250,243,.9)';
    g.textAlign = 'left';
    g.fillText('和 ' + cat + ' 在一起', barH * 0.45 + g.measureText(title).width + fs * 1.2, h - barH * 0.52);
  }

  const who = name ? ` · ${name}` : '';
  g.font = `500 ${Math.round(fs * 0.6)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  g.fillStyle = 'rgba(253,250,243,.55)';
  g.textAlign = 'right';
  g.fillText('像素燕园' + who, w - barH * 0.45, h - barH * 0.22);

  return c;
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export async function savePhoto(canvas, filename) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('图片生成失败');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `yanyuan-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  return blob;
}
