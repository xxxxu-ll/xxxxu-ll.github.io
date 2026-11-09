// 校园石碑 / 石像 / 石刻 / 华表：造型分类与说明
// 说明取自公开资料与校方常见介绍，只写确定的部分

export const HERITAGE_INFO = {
  '蔡元培像': { type: 'statue', text: '未名湖畔的蔡元培铜像，纪念这位主张“思想自由、兼容并包”的老校长。' },
  '李大钊像': { type: 'statue', text: '李大钊曾在北大任图书馆主任，校园里立有他的铜像。' },
  '塞万提斯像': { type: 'statue', text: '西班牙政府赠送给北大的塞万提斯铜像，《堂吉诃德》的作者。' },
  '老子塑像': { type: 'statue', text: '校园里的一尊老子塑像。' },
  '民主与科学雕像': { type: 'statue', text: 'D&S 雕塑，取“民主（Democracy）与科学（Science）”之意。' },
  '教师之家旁铜钟': { type: 'bell', text: '一口铜钟，靠近教师之家。' },
  '钟亭': { type: 'belltower', text: '未名湖畔的钟亭，亭内悬着一口清代铜钟。' },
  '南华表': { type: 'column', text: '圆明园遗物，一对汉白玉华表之一，立于西门内。' },
  '北华表': { type: 'column', text: '圆明园遗物，与南华表成对。' },
  '翻尾石鱼': { type: 'fish', text: '圆明园遗物，一条翻着尾巴的石鱼，现在卧在未名湖边。' },
  '未名湖石': { type: 'stele', text: '湖边的刻石，写着“未名湖”三个字。' },
  '石五供': { type: 'offering', text: '圆明园遗物，一组石雕供器，共五件。' },
  '埃德加·斯诺之墓': { type: 'tomb', text: '斯诺的部分骨灰安葬在未名湖畔，墓碑上写着“中国人民的美国朋友”。' },
  '葛利普教授之墓': { type: 'tomb', text: '地质学家葛利普（A. W. Grabau）之墓。' },
  '西南联大纪念碑': { type: 'stele', text: '纪念国立西南联合大学，碑文记述那段南迁办学的历史。' },
  '北京大学烈士纪念碑': { type: 'stele', text: '纪念在革命与战争中牺牲的北大师生。' },
  '“振兴中华”石碑': { type: 'stele', text: '1981 年北大学生喊出“团结起来，振兴中华”，后来立碑纪念。' },
  '茜园梅石碑': { type: 'stele', text: '圆明园茜园遗物，石上刻梅。' },
  '乾隆半月台诗碑': { type: 'stele', text: '圆明园遗物，刻乾隆诗句的石碑。' },
  '乾隆石屏风': { type: 'screen', text: '圆明园遗物，一座石制屏风。' },
  '植树碑': { type: 'stele', text: '植树纪念的石碑。' },
  '“燕宫太液”石刻': { type: 'stone', text: '一块刻着“燕宫太液”的石头，出自圆明园旧物。' },
  '“挹翠”石刻': { type: 'stone', text: '刻着“挹翠”二字的石刻。' },
  '北大百年纪念': { type: 'stele', text: '百年校庆留下的纪念物。' },
  '北京大学星': { type: 'star', text: '以北京大学命名的小行星纪念石。' },
  '光华院训石': { type: 'stone', text: '光华管理学院门前的院训石。' },
  '经济学院院名石': { type: 'stone', text: '经济学院门口的院名石。' },
  '柳浪闻莺石坊构件': { type: 'fragment', text: '圆明园“柳浪闻莺”景区石坊的残件。' },
  '断桥残雪石坊构件': { type: 'fragment', text: '圆明园“断桥残雪”景区石坊的残件。' },
  '海晏堂引水槽': { type: 'trough', text: '圆明园海晏堂的引水石槽残件。' },
  '花神庙山门 · 慈济寺山门': { type: 'gate', text: '慈济寺（俗称花神庙）的山门。' },
  '湖心岛短平桥': { type: 'plank', text: '通往湖心岛的一座短平石桥。' },
  '校友桥': { type: 'plank', text: '西门内的一座石桥。' },
};

const KIND_BY_NAME = [
  [/华表/, 'column'],
  [/像$|雕像|塑像/, 'statue'],
  [/铜钟/, 'bell'],
  [/钟亭/, 'belltower'],
  [/石鱼/, 'fish'],
  [/石五供/, 'offering'],
  [/之墓|墓$/, 'tomb'],
  [/山门/, 'gate'],
  [/石坊构件/, 'fragment'],
  [/引水槽/, 'trough'],
  [/石屏风/, 'screen'],
  [/石刻|院训石|院名石|湖石/, 'stone'],
  [/星/, 'star'],
  [/桥/, 'plank'],
];

/** 造型类型（找不到就按石碑处理） */
export function heritageType(name) {
  const hit = HERITAGE_INFO[name];
  if (hit) return hit.type;
  for (const [re, t] of KIND_BY_NAME) if (re.test(name)) return t;
  return 'stele';
}

/** 说明文本（没收录的给一句通用描述） */
export function heritageText(name) {
  const hit = HERITAGE_INFO[name];
  if (hit) return hit.text;
  return '校园里的一处旧物，具体来历可以在图书馆或校史馆查到。';
}
