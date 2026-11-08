// 校园猫：位置、性格、漫游与关系养成
// 说明：这些猫是《像素燕园》的原创游戏设定角色，不是对真实校园猫的记录。
// 真实校园猫的姓名、性格与出没点需要另行核实后才能加入。
import { mulberry32, clamp } from './util.js';

export const CAT_DEFS = [
  {
    id: 'weiming', name: '未名', color: 'black', anchor: [-182, -132], radius: 16,
    personality: '话少，喜欢在石舫边看水。摸它之前最好先站着不动一会儿。',
    home: '未名湖西岸 · 石舫附近',
    lines: ['未名抬眼看你一眼，又转回去看湖水。', '未名把尾巴绕到脚边，允许你坐在旁边。', '未名轻轻碰了碰你的手背。'],
    gift: '一根猫毛',
  },
  {
    id: 'tata', name: '塔塔', color: 'orange', anchor: [146, -66], radius: 14,
    personality: '博雅塔下的橘猫，热衷霸占阳光最好的那块石头。',
    home: '博雅塔下',
    lines: ['塔塔在石头上来回踩了两下，把位置让出一小块。', '塔塔盯着塔尖看了一会儿，打了个哈欠。', '塔塔用脑袋顶你的手心。'],
    gift: '半片银杏叶',
  },
  {
    id: 'shuye', name: '书页', color: 'tabby', anchor: [-3, 226], radius: 12,
    personality: '图书馆台阶的常客，对书包有强烈兴趣。',
    home: '图书馆南门台阶',
    lines: ['书页嗅了嗅你的书包，失望地走开。', '书页在台阶上摊成一张饼。', '书页允许你摸三下，第四下就起身走了。'],
    gift: '一张旧书签',
  },
  {
    id: 'mantou', name: '馒头', color: 'white', anchor: [186, 494], radius: 18,
    personality: '农园后门的白猫，谁手里有吃的谁就是朋友。',
    home: '农园餐厅后门',
    lines: ['馒头绕着你转了一圈，确认你没带饭。', '馒头蹭了蹭你的裤脚，留下两根白毛。', '馒头发出很轻的一声。'],
    gift: '食堂的饭粒',
  },
  {
    id: 'yinxing', name: '银杏', color: 'orange', anchor: [-118, 206], radius: 20,
    personality: '静园草坪的橘白猫，秋天会睡在落叶堆里。',
    home: '静园草坪',
    lines: ['银杏从草里抬起头，耳朵动了一下。', '银杏翻了个身，把肚皮对着太阳。', '银杏跟着你走了几步，又停下来。'],
    gift: '一片完整的银杏叶',
  },
  {
    id: 'laoxuejiu', name: '老学究', color: 'black', anchor: [-112, 392], radius: 20,
    personality: '燕南园的黑猫，走路很慢，像在思考什么。',
    home: '燕南园小楼之间',
    lines: ['老学究打量你一会儿，慢慢眨了下眼。', '老学究在你脚边坐下，像在听你说话。', '老学究用尾巴扫了扫地上的落叶。'],
    gift: '一枚旧纽扣',
  },
  {
    id: 'cheling', name: '车铃', color: 'gray', anchor: [186, -186], radius: 26,
    personality: '东操场边的灰猫，对自行车铃特别敏感。',
    home: '东操场看台',
    lines: ['车铃的耳朵跟着远处的车铃转了一下。', '车铃绕着你的车轮走了半圈。', '车铃在跑道边上打了个滚。'],
    gift: '一颗小铃铛',
  },
  {
    id: 'shaozi', name: '勺子', color: 'calico', anchor: [-372, 178], radius: 22,
    personality: '勺园的三花猫，会跟着晚归的人走一段路。',
    home: '勺园宿舍区',
    lines: ['勺子从车棚顶上跳下来，落在你面前。', '勺子在路灯下坐得很端正。', '勺子跟着你走了十几米才停下。'],
    gift: '一截红绳',
  },
  {
    id: 'heye', name: '荷叶', color: 'calico', anchor: [-392, -226], radius: 20,
    personality: '鸣鹤园的猫，喜欢在池塘边的石头上待着。',
    home: '鸣鹤园池塘',
    lines: ['荷叶看着水面，尾巴一甩一甩。', '荷叶跳上石头，把位置让给你一半。', '荷叶用爪子碰了碰水。'],
    gift: '一片浮萍',
  },
  {
    id: 'xiaoman', name: '小满', color: 'orange', anchor: [34, 372], radius: 16,
    personality: '百周年纪念讲堂门口的小橘猫，人来人往也不怕。',
    home: '百周年纪念讲堂门口',
    lines: ['小满在台阶上伸了个很长的懒腰。', '小满蹭了蹭你的鞋。', '小满对你的镜头毫不在意。'],
    gift: '一张拍糊的照片',
  },
];

export const AFF = { met: 8, pet: 7, follow: 40, photo: 60, codex: 82 };

export class Cat {
  constructor(def, world, rngSeed) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.color = def.color;
    const [fx, fy] = world.findFree(def.anchor[0], def.anchor[1], 0.7, 14);
    this.x = fx; this.y = fy;
    this.homeX = fx; this.homeY = fy;
    this.rng = mulberry32(rngSeed);
    this.timer = this.rng() * 4;
    this.pose = 'sit';
    this.facingLeft = false;
    this.state = 'idle';
    this.tx = fx; this.ty = fy;
    this.following = false;
  }

  update(dt, player) {
    this.timer -= dt;
    if (this.following && player) {
      const d = Math.hypot(player.x - this.x, player.y - this.y);
      if (d > 2.0) {
        const sp = Math.min(3.4, 1.4 + d * 0.35);
        this._step(dt, player.x, player.y, sp);
        this.pose = (this._walkPhase = (this._walkPhase || 0) + dt * 6) % 2 < 1 ? 'walk1' : 'walk2';
        this.facingLeft = player.x < this.x;
      } else if (this.pose !== 'sit') {
        this.pose = 'sit';
      }
      return;
    }
    if (this.timer <= 0) {
      this.timer = 2.5 + this.rng() * 5;
      if (this.pose === 'sit' && this.rng() < 0.55) {
        const a = this.rng() * Math.PI * 2;
        const r = this.rng() * this.def.radius;
        this.tx = this.homeX + Math.cos(a) * r;
        this.ty = this.homeY + Math.sin(a) * r;
        this.pose = 'walk1';
      } else {
        this.pose = this.rng() < 0.25 ? 'sit' : (this.rng() < 0.5 ? 'sleep' : 'sit');
      }
    }
    if (this.pose === 'walk1' || this.pose === 'walk2') {
      const d = Math.hypot(this.tx - this.x, this.ty - this.y);
      if (d < 0.4) {
        this.pose = 'sit';
        this.timer = 3 + this.rng() * 4;
      } else {
        this._step(dt, this.tx, this.ty, 1.1);
        this.pose = (this._walkPhase = (this._walkPhase || 0) + dt * 5) % 2 < 1 ? 'walk1' : 'walk2';
        this.facingLeft = this.tx < this.x;
        if (this.rng() < 0.004) this.pose = 'sit';
      }
    }
  }

  _step(dt, tx, ty, speed) {
    const dx = tx - this.x, dy = ty - this.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = this.x + (dx / len) * speed * dt;
    const ny = this.y + (dy / len) * speed * dt;
    if (!this.worldBlocked(nx, ny)) { this.x = nx; this.y = ny; }
    else { this.timer = 0.6; this.pose = 'sit'; }
  }

  worldBlocked(x, y) {
    return this._blocked ? this._blocked(x, y) : false;
  }
}

/** 关系等级描述 */
export function affinityLabel(aff) {
  if (aff >= AFF.codex) return '很亲近';
  if (aff >= AFF.photo) return '信任你';
  if (aff >= AFF.follow) return '愿意跟着你';
  if (aff >= 20) return '认识你了';
  if (aff > 0) return '有点眼熟';
  return '还没见过';
}

export function catProgress(aff) {
  return clamp(aff, 0, 100) / 100;
}
