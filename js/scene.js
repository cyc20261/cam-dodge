/**
 * scene.js —— Three.js 3D 场景层（多主题版）
 *
 * 只负责"好看"和"把状态画出来"，不含任何游戏规则。
 *
 * ── 主题系统 ─────────────────────────────────────
 * 4 套地图：樱花（二次元浪漫）/ 地狱 / 赛博霓虹 / 星海
 * 每套主题包含：渐变天空、雾、跑道配色、场景物件、粒子、灯光、卡通材质开关
 * 切换主题时整棵 themeRoot 重建并释放旧资源，避免显存泄漏
 *
 * ── 性能 ────────────────────────────────────────
 * - 障碍物对象池（预分配，运行时不 new）
 * - 跑道/场景/粒子全部循环复用，不做无限增长
 * - 粒子用单个 THREE.Points 一次绘制
 * - update() 内不产生新对象，避免 GC 抖动
 * - 关闭阴影；像素比由外部按帧率动态调整
 */

import * as THREE from 'three';

export const LANE_X = [-2.4, 0, 2.4];
export const TRACK_LEN = 120;
const TILE_COUNT = 6;

/**
 * 路边景物总开关（四张地图通用）。
 *
 * 现在关掉：街屋 / 樱树 / 岩石 / 霓虹竖牌 / 水晶柱这些"两侧道具"是全场最贵的一批
 * 物件（樱树一件就 30+ 网格，花团靠 InstancedMesh 才勉强压住 draw call），
 * 先整体下掉、给后面的真图素材腾位置。
 *
 * 恢复只改这一个值 —— _buildScenery 直接 return，滚动循环跑空数组，天生安全。
 * 注意：draw call 预算断言（tools/key-e2e.mjs < 1400）是上界，下掉后只会更松。
 */
export const SCENERY_ON = false;

/**
 * 地狱图两侧的「修罗魔相」——外部真实雕像模型，不再用我们自己的方块拼。
 *
 * 来源：法国巴黎吉美博物馆（Musée Guimet）馆藏扫描件，
 *      Scan the World（MyMiniFactory 的非营利数字化项目）发布在 Zenodo 上。
 *      授权 **CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享）——
 *      答辩/演示等**非商业**用途可以直接用，但要保留署名（见 README 的素材署名一节）；
 *      若要商业化，必须先换掉这三份模型。
 *
 * 为什么是这三种：Asura（修罗）本体 + Dvarapala / Door Guardian（怒目金刚门神），
 * 三尊都是"怒相"，正好是「修罗魔相」该有的狰狞感，且同属一套馆藏、风格统一。
 *
 * x=6.6 这个距离是算出来的，不是拍脑袋：跑道三条道在 x=±2.4（含车宽约 ±3.4），
 * 相机在 x≈±0.84 摆动。雕像高度定死后半宽约 1.2m，6.6-1.2=5.4 ——
 * 离跑道边缘还有 2 米余量，任何视角下都压不到路上。
 */
// 模型路径必须按**模块所在位置**推，不能写 './assets/…'：
// GLTFLoader 是按当前页面 URL 解析相对路径的，游戏页在根目录时蒙对了，
// 但 tools/ 下的截图展台会解析到 /tools/assets/… 直接 404（踩过）。
const STATUE_BASE = new URL('../assets/models/hell/asura-standee/', import.meta.url).href;
export const STATUE_CFG = {
  files: ['asura-1', 'asura-2', 'asura-3'],
  dir: STATUE_BASE,
  mode: 'standee',    // 'standee'=透明 PNG 立牌（Sprite）；扫描件 GLB 方案已弃用：
                      // 博物馆扫描件残缺素色，被雾一压就是一坨白疙瘩，毫无威严。
                      // 立牌用 AI 生成的高清修罗立绘，威风感直接拉满。
  /* 真 3D 升级（2026-10-07）：立绘走图生3D（腾讯混元）得到的带贴图网格，
     有体积、掠过时能看到侧面起伏，逼真度远超平面立牌。加载失败自动回退
     files 里的立牌平面 —— 模型永远不能成为"两侧空空"的原因。 */
  models: { dir: STATUE_BASE, files: ['asura3d'] },
  height: 9.2,        // 立牌显示高度（米）—— 威风感的关键：比玩家高 4 倍，
                      // 从身边掠过时是"仰视魔神"的压迫感；半宽 ≈3.0m
  x: 7.0,             // 距跑道中线的距离 —— 立牌内缘 ≈3.96m，离路缘(3.4m)仍有余量
  perSide: 3,         // 每侧几尊
  gap: 26,            // 同侧前后间距（米）
  z0: 16,             // 第一尊离相机多远
  tilt: 0.10,         // 向跑道中线微倾（弧度），显威仪
  yaw: Math.PI * 0.5, // 兼容字段（平面立牌不转向）
  glow: 0.14,         // 立牌自带发光质感，无需额外 emissive（保留兼容）
  glowColor: '#ff4a12',
};

// 樱花两侧的樱花树立牌 —— 素材流程与修罗魔像同一套（壁纸参考 → AI 重绘立绘 → 抠图）。
// 树冠悬到路缘上空是刻意的"樱花隧道"：树干在 x=6.4 远离路面，判定层根本没有
// 景物碰撞体，玩家最高跳跃 ~2m 也碰不到 5m 以上的树冠。
const SAKURA_BASE = new URL('../assets/models/sakura/standee-src/', import.meta.url).href;
export const TREE_CFG = {
  files: ['sakura-tree-1', 'sakura-tree-2'],
  dir: SAKURA_BASE,
  height: 12,         // 树高（米）—— 冠幅 ≈9m，气势要压过跑道
  x: 7.0,             // 树干距中线（离路缘 3.6m）；树冠内缘 ≈2.5m 悬在路缘上空成樱花隧道
  perSide: 3,
  gap: 26,
  z0: 16,
};

/**
 * 把连续的横向位置(0..2)换算成世界 x 坐标。
 * 渲染和碰撞统一走这里 —— 两者读同一个 laneF，画面所见就是判定所依据的位置。
 */
export function laneToX(f) {
  const t = Math.max(0, Math.min(2, f));
  return LANE_X[0] + t * (LANE_X[1] - LANE_X[0]);
}

/* ================= 主题配置 ================= */

export const THEMES = {
  sakura: {
    name: '樱花·二次元浪漫',
    swatch: ['#ffd7e8', '#ff8fb1', '#fff1f6'],
    anime: true,                    // 用卡通材质，强化二次元感
    // 天幕图组：B 键在本组内轮换。每张附一句氛围说明（toast 提示用）
    bgImages: [
      { file: 'sakura_ancient.jpg', label: '古樱建筑·白昼' },
      { file: 'sakura_falling.jpg', label: '粉樱飘落' },
      { file: 'sakura_night.jpg',   label: '夜樱·月光' },
      { file: 'sakura_rain.jpg',    label: '樱雨满屏' },
    ],
    // 参考图：上半是蓝天白云，贴近地平线才泛粉 —— 不能整片粉
    sky: { top: '#5fb2ef', mid: '#d8f0fe', bottom: '#ffd9ec' },
    fog: { color: '#ffe3ef', near: 50, far: 120 },
    stone: true,                    // 石板路纹理（参考图里的石板街道）
    ground: ['#f2ece4', '#e9e0d6'],
    laneLine: '#ff9ec4',
    rail: '#ffc2d8',
    player: { body: '#ff7fa8', limb: '#c86b92', head: '#fff5f9', visor: '#ff4d88' },
    obstacle: {
      hurdle: { color: '#7ecb8f', emissive: '#1d5c33' },
      overhead: { color: '#ffb347', emissive: '#7a4a00' },
      block: { color: '#ff6b8a', emissive: '#7a1030' },
    },
    scenery: 'sakura',
    particle: { type: 'petal', color: '#ffb3d1', count: 340, size: 0.17, fall: 2.2 },
    lights: { hemiSky: '#fff0f6', hemiGround: '#e8b7cc', hemiInt: 1.45, key: '#ffffff', keyInt: 1.05, rim: '#ff9ec4', rimInt: 0.55 },
  },

  hell: {
    name: '地狱·熔岩',
    swatch: ['#3a0a0a', '#ff5722', '#8b0000'],
    anime: false,
    bgImages: [
      { file: 'hell_throne.jpg',      label: '暗黑王座' },
      { file: 'hell_lava_cracks.jpg', label: '熔岩裂缝大地' },
      { file: 'hell_lava_river.jpg',  label: '岩浆河流' },
      { file: 'hell_splash.jpg',      label: '熔岩飞溅' },
    ],
    sky: { top: '#070102', mid: '#4a0a0c', bottom: '#d8391a' },
    fog: { color: '#2a0605', near: 20, far: 85 },   // 更浓更暗 → 压迫感
    lava: true,                     // 地面用熔岩裂缝黑岩纹理
    ground: ['#120a0c', '#0d0607'],
    laneLine: '#ff5a1f',
    rail: '#8a1f0e',
    player: { body: '#ffd166', limb: '#8d6e3a', head: '#fff3d6', visor: '#ff3d00' },
    obstacle: {
      hurdle: { color: '#ffca28', emissive: '#7a4a00' },
      overhead: { color: '#ff7043', emissive: '#8a2400' },
      block: { color: '#b71c1c', emissive: '#5a0000' },
    },
    scenery: 'rock',
    particle: { type: 'ember', color: '#ff8a3d', count: 260, size: 0.13, fall: -1.6 },
    ash: { count: 200, size: 0.09, fall: 0.55 },  // 飘落的灰烬（压迫氛围）
    lights: { hemiSky: '#ff5a2a', hemiGround: '#1a0403', hemiInt: 1.0, key: '#ff9a70', keyInt: 0.8, rim: '#ff2d00', rimInt: 1.1 },
  },

  neon: {
    name: '赛博霓虹',
    swatch: ['#7b5cff', '#2de2ff', '#070b1a'],
    anime: false,
    bgImages: [
      { file: 'star_nebula.jpg',   label: '暗色星云' },
      { file: 'star_deadtree.jpg', label: '深蓝星空·枯树' },
      { file: 'star_beams.jpg',    label: '光束穿透云层' },
      { file: 'star_meteor.jpg',   label: '纯黑极简流星' },
      { file: 'star_golden.jpg',   label: '黑地枯树·金光点' },
    ],
    sky: { top: '#070b1a', mid: '#1a1140', bottom: '#2de2ff' },
    fog: { color: '#0a0f22', near: 40, far: 110 },
    ground: ['#121a33', '#0e1428'],
    laneLine: '#2de2ff',
    rail: '#7b5cff',
    player: { body: '#ffd166', limb: '#ef476f', head: '#ffffff', visor: '#2de2ff' },
    obstacle: {
      hurdle: { color: '#06d6a0', emissive: '#04513c' },
      overhead: { color: '#ff9f1c', emissive: '#7a4a00' },
      block: { color: '#ef476f', emissive: '#6a1024' },
    },
    scenery: 'pillar',
    particle: { type: 'spark', color: '#7b5cff', count: 150, size: 0.1, fall: -0.6 },
    lights: { hemiSky: '#8ea2ff', hemiGround: '#0a0f22', hemiInt: 1.15, key: '#ffffff', keyInt: 1.05, rim: '#2de2ff', rimInt: 0.6 },
  },

  galaxy: {
    name: '星海·云端',
    swatch: ['#0b1026', '#8a7bff', '#e8e4ff'],
    anime: false,
    bgImages: [
      { file: 'sea_pinkblue.jpg',   label: '粉蓝星云海面' },
      { file: 'sea_blueorange.jpg', label: '蓝橙流星海面' },
      { file: 'sea_golden.jpg',     label: '金色星点·枯树' },
      { file: 'cloud_golden.jpg',   label: '金色阳光云海' },
      { file: 'cloud_white.jpg',    label: '柔和白云海' },
      { file: 'cloud_sunset.jpg',   label: '夕阳橙调云海' },
    ],
    sky: { top: '#05061a', mid: '#2a1b5e', bottom: '#8a7bff' },
    fog: { color: '#101a3a', near: 40, far: 120 },
    ground: ['#1b2247', '#151a38'],
    laneLine: '#c3b5ff',
    rail: '#8a7bff',
    player: { body: '#e8e4ff', limb: '#8a7bff', head: '#ffffff', visor: '#00e5ff' },
    obstacle: {
      hurdle: { color: '#00e5ff', emissive: '#005f6b' },
      overhead: { color: '#ffd166', emissive: '#6b5200' },
      block: { color: '#ff5ea8', emissive: '#6b0f3d' },
    },
    scenery: 'crystal',
    particle: { type: 'star', color: '#ffffff', colors: ['#ffffff', '#8fc2ff', '#ffb36b', '#ff6b6b', '#fff2b0'], count: 380, size: 0.12, fall: 0.25 },
    lights: { hemiSky: '#b9a9ff', hemiGround: '#101538', hemiInt: 1.25, key: '#ffffff', keyInt: 1.0, rim: '#00e5ff', rimInt: 0.7 },
  },
};

export const THEME_KEYS = Object.keys(THEMES);

/* 天空渐变着色器（1 个 draw call，比贴图省） */
const SKY_VERT = `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const SKY_FRAG = `
  uniform vec3 topColor; uniform vec3 midColor; uniform vec3 bottomColor;
  uniform float uOpacity;
  varying vec3 vWorld;
  void main() {
    float h = normalize(vWorld).y * 0.5 + 0.5;
    vec3 c = h < 0.5
      ? mix(bottomColor, midColor, h * 2.0)
      : mix(midColor, topColor, (h - 0.5) * 2.0);
    gl_FragColor = vec4(c, uOpacity);
  }
`;

/* ================= 樱花花瓣着色器 ================= */
/* 让方点变成会旋转、随风翻飞的花瓣：顶点着色器做大小衰减 + 横向飘摆，
   片元着色器把贴图按每片随机相位旋转，于是每片花瓣各转各的，不再是方块。 */
const PETAL_VERT = `
  attribute float aSeed;
  attribute float aSize;
  uniform float uTime;
  varying float vSeed;
  void main() {
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    mv.x += sin(uTime * 1.3 + aSeed * 6.28) * 0.5;
    mv.z += cos(uTime * 0.9 + aSeed * 6.28) * 0.35;
    gl_PointSize = aSize * (320.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const PETAL_FRAG = `
  uniform sampler2D uTex;
  varying float vSeed;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float a = vSeed * 6.28 + vSeed * 2.0;
    float s = sin(a), c = cos(a);
    uv = mat2(c, -s, s, c) * uv + 0.5;
    vec4 tex = texture2D(uTex, uv);
    if (tex.a < 0.08) discard;
    gl_FragColor = vec4(tex.rgb, tex.a * 0.95);
  }
`;

/* ================= 共享几何体缓存 =================
   障碍物/小恶魔在换主题时会被整棵销毁重建，如果每个网格都自己 new 一份
   BoxGeometry，光是障碍池就会堆出上百个只差几个小数的重复几何体。
   这里按尺寸记忆化：同尺寸只创建一次，所有网格共享（几何体可安全共享，
   它不含任何逐实例状态；材质才必须逐实例）。

   注意：共享几何体**不能**进 disposeTree —— 用 userData.__shared 打标让清理器跳过，
   否则第一次换主题就会把还在用的几何体 dispose 掉（第二次换主题直接渲染空白）。 */
const _geoCache = new Map();
function _geo(key, make) {
  let g = _geoCache.get(key);
  if (!g) { g = make(); g.userData.__shared = true; _geoCache.set(key, g); }
  return g;
}
const boxGeo = (w, h, d) => _geo(`b|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
const cylGeo = (rt, rb, h, seg = 12) => _geo(`c|${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const coneGeo = (r, h, seg = 12) => _geo(`n|${r}|${h}|${seg}`, () => new THREE.ConeGeometry(r, h, seg));
const sphereGeo = (r, w = 18, h = 14) => _geo(`s|${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h));
const torusGeo = (r, t, rs = 8, ts = 16) => _geo(`t|${r}|${t}|${rs}|${ts}`, () => new THREE.TorusGeometry(r, t, rs, ts));
const circleGeo = (r, seg = 20) => _geo(`o|${r}|${seg}`, () => new THREE.CircleGeometry(r, seg));
const planeGeo = (w, h) => _geo(`p|${w}|${h}`, () => new THREE.PlaneGeometry(w, h));
const icoGeo = (r, d = 0) => _geo(`i|${r}|${d}`, () => new THREE.IcosahedronGeometry(r, d));

/**
 * 顶点抖动：把规则的多面体揉成"天然岩石"。
 * ⚠ 必须用在**新创建**的几何体上，绝不能喂 _geo 缓存里的共享几何体 ——
 * 那会把抖动永久写进所有使用者的形状里（换主题后全场岩石一起变形）。
 */
function jitterGeo(geo, amp) {
  const p = geo.attributes.position;
  const k = 1 + amp;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(
      i,
      p.getX(i) * (1 + (Math.random() - 0.5) * k),
      p.getY(i) + (Math.random() - 0.5) * amp * 0.22,
      p.getZ(i) * (1 + (Math.random() - 0.5) * k),
    );
  }
  geo.computeVertexNormals();
  return geo;
}

/* ================= 程序化贴图（canvas，避免外部依赖） ================= */
function _cv(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
function makePetalTexture() {
  const s = 64, c = _cv(s), x = c.getContext('2d');
  const g = x.createRadialGradient(32, 22, 4, 32, 32, 30);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#ffd1e6'); g.addColorStop(1, '#ff8fbf');
  x.fillStyle = g; x.beginPath();
  x.moveTo(32, 6); x.bezierCurveTo(54, 14, 50, 52, 32, 60); x.bezierCurveTo(14, 52, 10, 14, 32, 6);
  x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
function makeGlowTexture() {
  const s = 64, c = _cv(s), x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
function makeTrailTexture() {
  const w = 128, h = 16, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
function makeBillboardTexture() {
  const w = 128, h = 172, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  x.strokeStyle = 'rgba(255,255,255,0.85)'; x.lineWidth = 2;
  for (let i = 0; i < h; i += 10) { x.beginPath(); x.moveTo(0, i); x.lineTo(w, i); x.stroke(); }
  x.strokeStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < w; i += 14) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
  x.strokeRect(4, 4, w - 8, h - 8);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
function makeNebulaTexture() {
  const s = 256, c = _cv(s), x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0, 'rgba(168,123,255,0.9)'); g.addColorStop(0.4, 'rgba(120,80,200,0.4)'); g.addColorStop(1, 'rgba(20,10,60,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
/** 石板路：暖灰石块 + 深色错缝（参考图1/2 的石板街道） */
function makeStoneTexture() {
  const s = 256, c = _cv(s), x = c.getContext('2d');
  x.fillStyle = '#efe8de'; x.fillRect(0, 0, s, s);
  const rows = 8, h = s / rows;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * h; // 错缝
    for (let px = -h; px < s; px += h * 2) {
      const shade = 236 + Math.floor(Math.random() * 18) - 9;
      x.fillStyle = `rgb(${shade},${shade - 6},${shade - 14})`;
      x.fillRect(px + off + 2, r * h + 2, h * 2 - 4, h - 4);
    }
  }
  x.strokeStyle = 'rgba(150,135,120,0.55)'; x.lineWidth = 2;
  for (let r = 0; r <= rows; r++) { x.beginPath(); x.moveTo(0, r * h); x.lineTo(s, r * h); x.stroke(); }
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * h;
    for (let px = 0; px <= s; px += h * 2) { x.beginPath(); x.moveTo(px + off, r * h); x.lineTo(px + off, (r + 1) * h); x.stroke(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true; return t;
}
/** 障子/格子窗：暖白纸面 + 深色木格（樱花建筑用，替代满墙的空白盒子） */
function makeShojiTexture() {
  const s = 128, c = _cv(s), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, '#fff8ea'); g.addColorStop(1, '#f3e3c6');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  x.strokeStyle = '#6a4c34'; x.lineWidth = 5;
  for (let i = 1; i < 4; i++) {
    const p = (i * s) / 4;
    x.beginPath(); x.moveTo(p, 0); x.lineTo(p, s); x.stroke();
    x.beginPath(); x.moveTo(0, p); x.lineTo(s, p); x.stroke();
  }
  x.strokeStyle = '#40291a'; x.lineWidth = 10;
  x.strokeRect(5, 5, s - 10, s - 10);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}

/** 火山岩：黑岩底 + 颗粒 + 横向岩层（地狱石柱的底色贴图） */
function makeRockTexture() {
  const s = 256, c = _cv(s), x = c.getContext('2d');
  x.fillStyle = '#151013'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 1100; i++) {
    const v = 16 + Math.random() * 40;
    x.fillStyle = `rgba(${v + 16},${v},${v + 6},${0.18 + Math.random() * 0.45})`;
    x.beginPath(); x.arc(Math.random() * s, Math.random() * s, Math.random() * 3.4 + 0.5, 0, 6.28); x.fill();
  }
  x.strokeStyle = 'rgba(0,0,0,0.55)'; x.lineWidth = 2;
  for (let i = 0; i < 11; i++) {
    const y = Math.random() * s;
    x.beginPath(); x.moveTo(0, y);
    for (let px = 0; px <= s; px += 16) x.lineTo(px, y + (Math.random() - 0.5) * 9);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; return t;
}

/** 熔岩裂纹：黑底 + 发光裂缝（作 emissiveMap，让岩石"从内部透出红光"） */
function makeLavaVeinTexture() {
  const s = 256, c = _cv(s), x = c.getContext('2d');
  x.fillStyle = '#000000'; x.fillRect(0, 0, s, s);
  x.shadowBlur = 7;
  for (let i = 0; i < 8; i++) {
    let px = Math.random() * s, py = 0;
    x.strokeStyle = i % 3 === 0 ? '#ffb03a' : (i % 3 === 1 ? '#ff5a12' : '#e02a06');
    x.shadowColor = '#ff6a18';
    x.lineWidth = 1.4 + Math.random() * 2.4;
    x.beginPath(); x.moveTo(px, py);
    while (py < s) {
      px += (Math.random() - 0.5) * 32; py += 13 + Math.random() * 20;
      x.lineTo(px, py);
    }
    x.stroke();
    // 分叉
    if (Math.random() < 0.7) {
      x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(px, py * 0.6);
      x.lineTo(px + (Math.random() - 0.5) * 40, py * 0.6 + 26);
      x.stroke();
    }
  }
  x.shadowBlur = 0;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; return t;
}

/** 电路纹：暗底 + 发光走线 + 节点圆点（参考图4 的楼身电路） */
function makeCircuitTexture(hex) {
  const s = 256, c = _cv(s), x = c.getContext('2d');
  x.fillStyle = 'rgba(6,10,26,0.92)'; x.fillRect(0, 0, s, s);
  x.strokeStyle = hex; x.lineWidth = 3; x.lineCap = 'square';
  for (let i = 0; i < 14; i++) {
    let px = Math.random() * s, py = Math.random() * s;
    x.beginPath(); x.moveTo(px, py);
    for (let k = 0; k < 4; k++) {
      if (Math.random() < 0.5) px += (Math.random() - 0.5) * 90;
      else py += (Math.random() - 0.5) * 90;
      x.lineTo(px, py);
    }
    x.stroke();
    x.fillStyle = hex;
    for (let k = 0; k < 3; k++) {
      x.beginPath(); x.arc(Math.random() * s, Math.random() * s, 3.2, 0, 6.28); x.fill();
    }
  }
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
/** 云朵 sprite：几团圆斑叠成积云（参考图1/2 的大块白云） */
function makeCloudTexture() {
  const w = 256, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const puff = (cx, cy, r, a) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  };
  puff(78, 78, 52, 0.95); puff(128, 62, 62, 0.95); puff(178, 80, 50, 0.9);
  puff(104, 92, 46, 0.85); puff(152, 94, 44, 0.85);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
/** 地平线辉光：中下部亮橙、向上过渡到透明的横条（参考图5 右下的橙色辉光） */
function makeHorizonTexture() {
  const w = 256, h = 64, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, h, 0, 0);
  g.addColorStop(0, 'rgba(255,150,60,0.95)'); g.addColorStop(0.5, 'rgba(200,90,90,0.4)'); g.addColorStop(1, 'rgba(120,60,180,0)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const g2 = x.createLinearGradient(0, 0, w, 0);
  g2.addColorStop(0, 'rgba(0,0,0,1)'); g2.addColorStop(0.5, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)');
  x.globalCompositeOperation = 'destination-out';
  x.fillStyle = g2; x.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}

/**
 * 渐变天幕兜底贴图：用主题 sky 三色生成一张竖直渐变，
 * 在天幕真图加载完成前/加载失败时顶上，避免出现纯黑天空。
 */
function makeGradientSkyTexture(sky) {
  const W = 32, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.0, sky.top);
  g.addColorStop(0.55, sky.mid);
  g.addColorStop(1.0, sky.bottom);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true; return t;
}

/**
 * 地狱天幕：程序化绘制的大幅场景画（参考提示词：
 * "dark hell landscape, glowing lava cracks on black ground, red and orange magma,
 *  smoke and embers, oppressive atmosphere, cinematic lighting"）。
 * 从下到上依次画：熔岩地平线辉光 → 火山群剪影 → 翻滚暗红云层 → 高空黑红天穹 → 飘浮灰烬。
 * 作为远景曲面天幕贴在远处，负责"静谧宏大的氛围"，比纯色渐变精细得多。
 */
function makeHellSkyTexture() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');

  // 1) 天穹底色：上黑下暗红
  const base = x.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0.00, '#070102');
  base.addColorStop(0.28, '#1c0407');
  base.addColorStop(0.52, '#43100d');
  base.addColorStop(0.70, '#8a1f0e');
  base.addColorStop(0.83, '#d64513');
  base.addColorStop(0.92, '#ff8a24');
  base.addColorStop(1.00, '#ffc457');
  x.fillStyle = base; x.fillRect(0, 0, W, H);

  // 2) 翻滚云层：多层柔和暗红/暗紫椭圆叠加，做出体积感
  const puff = (cx, cy, rx, ry, col) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.save(); x.translate(cx, cy); x.scale(1, ry / Math.max(rx, ry)); x.translate(-cx, -cy);
    x.fillStyle = g; x.fillRect(cx - rx * 1.2, cy - rx * 1.2, rx * 2.4, rx * 2.4);
    x.restore();
  };
  for (let i = 0; i < 46; i++) {
    const cy = H * (0.06 + Math.random() * 0.5);
    puff(Math.random() * W, cy, 60 + Math.random() * 180, 22 + Math.random() * 54,
      `rgba(${60 + Math.random() * 90 | 0},${8 + Math.random() * 22 | 0},${6 + Math.random() * 14 | 0},0.30)`);
  }
  // 云层被下方熔岩照亮的暖色晕
  for (let i = 0; i < 26; i++) {
    const cy = H * (0.42 + Math.random() * 0.28);
    puff(Math.random() * W, cy, 70 + Math.random() * 150, 24 + Math.random() * 40,
      `rgba(${190 + Math.random() * 60 | 0},${70 + Math.random() * 60 | 0},20,0.26)`);
  }

  // 3) 火山群剪影（近黑，带顶端熔岩红光）
  x.fillStyle = '#0a0304';
  const drawVolcano = (cx, hw, h) => {
    x.beginPath();
    x.moveTo(cx - hw, H);
    x.lineTo(cx - hw * 0.18, H - h);
    x.lineTo(cx - hw * 0.06, H - h * 0.92);   // 火山口
    x.lineTo(cx + hw * 0.06, H - h * 0.92);
    x.lineTo(cx + hw * 0.18, H - h);
    x.lineTo(cx + hw, H);
    x.closePath(); x.fill();
    // 火山口熔岩光
    const g = x.createRadialGradient(cx, H - h * 0.94, 0, cx, H - h * 0.94, hw * 0.5);
    g.addColorStop(0, 'rgba(255,190,90,0.9)'); g.addColorStop(1, 'rgba(255,90,20,0)');
    x.fillStyle = g;
    x.beginPath(); x.ellipse(cx, H - h * 0.9, hw * 0.5, hw * 0.28, 0, 0, 6.28); x.fill();
  };
  drawVolcano(W * 0.16, 150, 150);
  drawVolcano(W * 0.38, 110, 100);
  drawVolcano(W * 0.62, 170, 175);
  drawVolcano(W * 0.85, 130, 120);

  // 4) 地平线熔岩辉光带
  const hg = x.createLinearGradient(0, H * 0.80, 0, H);
  hg.addColorStop(0, 'rgba(255,140,40,0)');
  hg.addColorStop(0.5, 'rgba(255,120,30,0.55)');
  hg.addColorStop(1, 'rgba(255,214,120,0.95)');
  x.fillStyle = hg; x.fillRect(0, H * 0.80, W, H * 0.2);

  // 5) 飘浮的灰烬与火花
  for (let i = 0; i < 320; i++) {
    const px = Math.random() * W, py = H * (0.35 + Math.random() * 0.62);
    const r = 0.5 + Math.random() * 1.6;
    const warm = Math.random() < 0.55;
    x.fillStyle = warm
      ? `rgba(255,${140 + Math.random() * 90 | 0},60,${0.25 + Math.random() * 0.6})`
      : `rgba(160,150,150,${0.10 + Math.random() * 0.3})`;
    x.beginPath(); x.arc(px, py, r, 0, 6.28); x.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.needsUpdate = true; return t;
}

/** 熔岩裂缝黑岩地面：近黑岩面 + 发光熔岩裂缝网（参考 "glowing lava cracks on black ground"） */
function makeLavaCrackTexture() {
  const s = 512, c = _cv(s), x = c.getContext('2d');
  x.fillStyle = '#120a0c'; x.fillRect(0, 0, s, s);
  // 岩面颗粒
  for (let i = 0; i < 2600; i++) {
    const v = Math.random();
    x.fillStyle = `rgba(${20 + v * 30 | 0},${14 + v * 18 | 0},${16 + v * 20 | 0},0.7)`;
    x.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // 裂缝：随机游走的折线，越靠中心越亮
  const drawCrack = () => {
    let px = Math.random() * s, py = Math.random() * s;
    const pts = [[px, py]];
    for (let k = 0; k < 7; k++) {
      px += (Math.random() - 0.5) * 130; py += (Math.random() - 0.5) * 130;
      pts.push([px, py]);
    }
    for (const pass of [{ w: 9, col: 'rgba(255,70,10,0.30)' }, { w: 4, col: 'rgba(255,130,30,0.65)' }, { w: 1.6, col: 'rgba(255,225,150,0.95)' }]) {
      x.strokeStyle = pass.col; x.lineWidth = pass.w; x.lineCap = 'round'; x.lineJoin = 'round';
      x.beginPath(); x.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) x.lineTo(pts[k][0], pts[k][1]);
      x.stroke();
    }
  };
  for (let i = 0; i < 5; i++) drawCrack();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true; return t;
}

/** 岩浆河流：橙红流动熔岩（参考 "flowing lava river"），带亮芯暗壳的流纹 */
function makeLavaFlowTexture() {
  const W = 256, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#3a0a04'; x.fillRect(0, 0, W, H);
  // 流纹：横向拉长的亮带
  for (let i = 0; i < 60; i++) {
    const py = Math.random() * H;
    const g = x.createLinearGradient(0, py, W, py + (Math.random() - 0.5) * 40);
    const a = 0.35 + Math.random() * 0.5;
    g.addColorStop(0, 'rgba(255,220,140,0)');
    g.addColorStop(0.45, `rgba(255,${170 + Math.random() * 70 | 0},60,${a})`);
    g.addColorStop(1, 'rgba(255,90,20,0)');
    x.strokeStyle = g; x.lineWidth = 2 + Math.random() * 8;
    x.beginPath(); x.moveTo(0, py);
    x.bezierCurveTo(W * 0.3, py + (Math.random() - 0.5) * 30, W * 0.7, py + (Math.random() - 0.5) * 30, W, py + (Math.random() - 0.5) * 20);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true; return t;
}

/** 灰烬点精灵：暗色不透明小颗粒（与发光火星区分开，做"oppressive atmosphere"） */
function makeAshTexture() {
  const s = 32, c = _cv(s), x = c.getContext('2d');
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(190,180,175,0.95)');
  g.addColorStop(0.55, 'rgba(120,110,105,0.45)');
  g.addColorStop(1, 'rgba(80,70,70,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}

/**
 * 天幕贴图加载器：把 assets/sky/*.jpg 作为远景天幕。
 * 异步加载 + 静态缓存（同一张图多主题复用只加载一次）。
 * 加载完成前先用程序化渐变兜底，不阻塞游戏开始。
 *
 * 纹理参数刻意设成"贴图最清晰、开销最小"：
 * - colorSpace = SRGB，颜色不被伽马二次校正（发灰/发暗的元凶）
 * - generateMipmaps = false + LinearFilter：球面天幕全程贴脸看，
 *   不需要 mipmap 链，省掉约 1/3 显存，也消掉"远处一闪一闪"的摩尔纹
 * - CLAMP 寻址：天幕 UV 在 0..1，REPEAT 只会在接缝处拉出细线
 */
const SKY_LOADER = new THREE.TextureLoader();
const SKY_CACHE = {};

/**
 * 取/加载一张天幕贴图。
 * @returns {THREE.Texture|null} 命中缓存则返回**纹理本身**；首次调用返回 null
 *   （真正就绪时通过 onReady 回调把纹理交出来）。
 *
 * ── 这里踩过一个很隐蔽的坑，别再犯 ─────────────────────
 * 早先缓存里存的是 `{ isTexture, tex, waiters }` 这个"登记条目"，
 * 命中时顺手把**条目对象** return 了出去，调用方 `if (cached) apply(cached)`
 * 就把条目当纹理塞进了 material.map。它恰好有 isTexture 属性，
 * three.js 的类型判断放行，直到 WebGL 渲染阶段才发现它没有 .matrix：
 *     Cannot read properties of undefined (reading 'elements')
 *       at Matrix3.copy ← refreshTransformUniform
 * 报错点在 three.js 内部，跟调用处隔着好几层，非常难查。
 * 所以约定：本函数只交出纹理（entry.tex），绝不交出登记条目。
 * 用 isTexture 这种"沾边的标志位"做类型判断，一定要连带校验核心属性（.matrix 等）。
 */
function loadSkyTexture(file, onReady) {
  const hit = SKY_CACHE[file];
  if (hit) {
    if (hit.tex) { onReady && onReady(hit.tex); return hit.tex; }
    hit.waiters.push(onReady);
    return null;
  }
  const entry = { tex: null, waiters: [onReady] };
  SKY_CACHE[file] = entry;
  SKY_LOADER.load(
    './assets/sky/' + file,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      entry.tex = tex;
      const ws = entry.waiters;
      entry.waiters = [];
      for (const w of ws) w && w(tex);
    },
    undefined,
    () => { entry.waiters = []; }  // 加载失败：保持程序化兜底
  );
  return null;
}

/**
 * 预加载一整个主题的图组。
 * 目的只有一个：按下切换键的那一刻必须"立刻见画"。
 * 不做预加载的话，切到没缓存过的图会先看到渐变色兜底，
 * 隔一两秒才"啪"地跳成真图 —— 演示时非常掉价。
 * 低画质档不预加载全组，只预加载当前一张，省流量也省显存。
 */
function preloadSkyGroup(files, all = true) {
  if (!files || !files.length) return;
    const list = all ? files : files.slice(0, 1);
  for (const f of list) loadSkyTexture(f);
}

/**
 * 分层天幕球：给"多背景轮换"提供带交叉淡入的天幕显示。
 *
 * 结构：两个同球心、同几何体的球面 —— face 显示当前图，prev 显示正在淡出的旧图。
 * 切图时 face 从 0 淡入、prev 同步淡出，交叉过渡 → 完全没有"跳图"的突兀感。
 *
 * ── 为什么换图要新建材质，而不是复用两个材质来回倒 ──────────────
 * 这是实测踩到的坑。原实现为了省内存只建两个材质，切图时把 face / prev
 * 的材质对调复用。跑起来就报：
 *     TypeError: Cannot read properties of undefined (reading 'elements')
 *       at Matrix3.copy ← refreshTransformUniform ← refreshUniformsCommon
 * 根因：three.js 的着色器程序是按"材质当时有没有 map"来编译的。
 * 复用回来的那个材质，上一轮当淡出层时 map 被摘掉了，
 * 它的已编译程序里根本没有 mapTransform 这个 uniform → uniforms.mapTransform
 * 是 undefined，再交给 Matrix3.copy 就炸。只设 needsUpdate = true 也不稳，
 * 程序重编译走 program cache key，切换时机会命中缓存的旧程序。
 * 所以：每次换图 new 一个材质（一个 MeshBasicMaterial 极轻），旧的就地 dispose，
 * 让"程序状态与材质状态不一致"这件事从根上不可能发生。
 *
 * 另一个坑：disposeTree 遍历主题子树时会把几何体/材质一起 dispose。
 * 天幕的 map 来自全局缓存（SKY_CACHE）被多主题共享，一旦被误 dispose，
 * 切回旧主题就是黑屏 + WebGL 警告。所以 group 上打了 __keep 标记，
 * disposeTree 见到它就整棵跳过，天幕的生命周期完全由本类自己管。
 */
const SKY_FADE_SEC = 1.05;

class SkyBackdrop {
  constructor(radius = 200) {
    /* 两层共用一个几何体：切图不用重建，dispose 也只需处理一次 */
    this.geo = new THREE.SphereGeometry(radius, 48, 32);
    this.face = new THREE.Mesh(this.geo, this._mkMat());
    this.prev = new THREE.Mesh(this.geo, this._mkMat());
    /* 淡出层不写深度，纯做视觉过渡 */
    this.prev.visible = false;
    this.face.renderOrder = 1;
    this.prev.renderOrder = 0;
    this.group = new THREE.Group();
    this.group.userData.__keep = true;   // 见上方说明：别让 disposeTree 碰它
    this.group.add(this.prev, this.face);
    this.fading = false;
    this.t = 0;
    this.owner = null;      // 当前显示的主题，防止迟到的异步回调错改新主题
    this.n = 0;             // 已显示的图序号（调试用）
    this._tex = null;       // face 当前用的贴图；同一张图重复 show 时直接跳过
  }

  _mkMat() {
    const m = new THREE.MeshBasicMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, transparent: true, opacity: 1,
    });
    m.userData.__keep = true;
    return m;
  }

  /** 挂到主题子树；返回自身方便链式调用 */
  addTo(root) { root.add(this.group); return this; }

  /**
   * 换一张天幕（自动决定"直接换"还是"交叉淡入"）。
   * @param {THREE.Texture} tex 新图（真实位图，或主题渐变兜底图）
   * @param {string} owner 主题名，用于丢弃过期回调
   * @param {boolean} immediate 主题刚重建时直接换（没有旧内容可交叉）
   */
  show(tex, owner, immediate = false) {
    // 防御性校验：只接受真正的纹理。
    // 只判断 isTexture 不够 —— 曾经有个"长得像纹理但其实是缓存登记对象"的东西
    // 混进来过（见 loadSkyTexture 的注释），它有 isTexture 却没有 matrix，
    // 结果在 WebGL 渲染阶段才炸。这里连带校验 .matrix，把问题挡在最前面。
    if (!tex || !tex.isTexture || !tex.matrix) return;
    if (tex === this._tex) return;                 // 同一张图，不必动
    const canFade = !immediate && this.owner === owner && !!this._tex;

    const oldFaceMat = this.face.material;
    this.face.material = this._mkMat();            // 新建，杜绝程序状态不一致
    this.face.material.map = tex;
    this.face.material.color.set(0xffffff);
    this.face.material.needsUpdate = true;
    this._tex = tex;

    if (canFade) {
      /* 交叉过渡：旧材质顶到 prev 层继续显示并淡出，新材质从透明淡入 */
      this.face.material.opacity = 0;
      const spent = this.prev.material;            // 上上张的材质，使命已尽
      this.prev.material = oldFaceMat;
      this.prev.material.opacity = 1;
      this.prev.visible = true;
      spent.dispose();
      this.t = 0;
      this.fading = true;
    } else {
      this.prev.visible = false;
      this.fading = false;
      oldFaceMat.dispose();
    }
    this.owner = owner;
    this.n++;
  }

  /** 每帧推进过渡；smoothstep 让起止都不生硬 */
  update(dt) {
    if (!this.fading) return;
    this.t = Math.min(1, this.t + dt / SKY_FADE_SEC);
    const k = this.t * this.t * (3 - 2 * this.t);
    this.face.material.opacity = k;
    this.prev.material.opacity = 1 - k;
    if (this.t >= 1) {
      this.fading = false;
      this.prev.visible = false;
      this.prev.material.dispose();
      this.prev.material = this._mkMat();          // 备好下一次接手
    }
  }

  dispose() {
    this.geo.dispose();
    this.face.material.dispose();
    this.prev.material.dispose();
    /* 注意：材质上的 map 来自全局缓存（SKY_CACHE），被多个主题共享，
       绝不能在这里 dispose —— 否则切回旧主题会拿到已释放的纹理。 */
  }
}

/**
 * 程序化环境贴图：深色基底 + 几处柔光斑，作为场景的环境反射源。
 * 赋给 scene.environment 后，所有 MeshStandardMaterial 立即获得金属/玻璃反射质感，
 * 是"高大上"观感的最大杠杆，且完全本地生成、零外部依赖。
 */
function makeEnvTexture() {
  const s = 256, c = _cv(s), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, '#0a0e1a'); g.addColorStop(0.5, '#1a2238'); g.addColorStop(1, '#2a3350');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  const blob = (cx, cy, r, col) => {
    const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = rg; x.fillRect(0, 0, s, s);
  };
  blob(64, 80, 72, 'rgba(180,210,255,0.55)');
  blob(190, 60, 60, 'rgba(255,180,220,0.40)');
  blob(128, 205, 92, 'rgba(255,205,150,0.35)');
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.needsUpdate = true; return t;
}

/* ================= 世界 ================= */

export class World {
  constructor(container) {
    this.container = container;
    this.themeName = null;
    this.themeRoot = null;
    this.pools = { hurdle: [], overhead: [], block: [], demon: [] };
    this.tiles = [];
    this.scenery = [];
    this.statues = [];        // 地狱两侧的外部雕像（跨主题复用，不随主题释放）
    this.statueRoot = null;
    this._statueTpl = null;   // 加载 Promise（模板只加载一次，clone 复用同一份几何体/材质）
    this._statueModelTpl = null;   // 修罗真 3D 模型模板（GLB；加载失败回退 _statueTpl 立牌）
    this.trees = [];          // 樱花两侧的樱花树立牌（同上，跨主题复用）
    this.treeRoot = null;
    this._treeTpl = null;
    this.fx = [];      // 击杀特效（冲击波/闪光），自管理生命周期
    // 拳弹（挥拳时从玩家手里打出的光弹）。为什么要池：出拳频率能到 5 拳/秒，
    // 每拳新建 Sprite + 材质会在连打时不断触发 GC，卡顿恰好落在"最需要跟手"的时刻。
    this.shots = [];        // 在飞的
    this._shotPool = [];    // 闲置待复用
    this._shotSeen = 0;     // 已消费到的发射事件 id（规则层每发一个递增 id）
    // 累计打出多少发。为什么不数"此刻在飞的"：弹丸 150 m/s，飞完全程只要 0.2 秒出头，
    // 外部（e2e / 探针）按几百毫秒采样会整段错过。累计数只增不减，采样再稀疏也抓得住。
    this.shotCount = 0;
    this.runPhase = 0;
    this.shakeT = 0;
    this.particles = null;
    this.quality = 1; // 1 = 全效果；0.5 = 精简
  }

  init(themeName = 'sakura') {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = false;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // 程序化环境贴图：让所有标准材质获得金属/玻璃反射，瞬间拉高质感
    // （静谧·高大上的关键杠杆，零外部依赖）
    if (!World._envTex) World._envTex = makeEnvTexture();
    this.scene.environment = World._envTex;
    this.camera = new THREE.PerspectiveCamera(62, w / h, 0.1, 400);
    this.camera.position.set(0, 3.4, 8);
    this.camera.lookAt(0, 1.4, -10);

    this.applyTheme(themeName);
    return this;
  }

  /** 切换主题：释放旧资源，按新主题重建整棵子树 */
  applyTheme(name) {
    const theme = THEMES[name] || THEMES.sakura;
    if (this.themeName === name && this.themeRoot) return theme;
    this.themeName = name;

    if (this.themeRoot) {
      // 天幕带 __keep 标记，disposeTree 会整体跳过它 —— 所以要在这里
      // 主动销毁（几何体 + 当前两个材质），再由 disposeTree 清理其余子树。
      if (this.backdrop) { this.backdrop.dispose(); this.backdrop = null; }
      this.scene.remove(this.themeRoot);
      disposeTree(this.themeRoot);
      this.themeRoot = null;
    }
    // 重置引用，避免指向已释放的对象
    this.tiles = []; this.scenery = [];
    this.pools = { hurdle: [], overhead: [], block: [], demon: [] };
    this.particles = null;
    this.ashLayer = null;
    this.decor = null;
    this.sky = null;
    this.skyDome = null;
    this.backdrop = null;

    const root = new THREE.Group();
    this.themeRoot = root;
    this.scene.add(root);

    // 天空 + 雾
    this.scene.fog = new THREE.Fog(new THREE.Color(theme.fog.color), theme.fog.near, theme.fog.far);

    /* 天幕图组：没有 bgImages 的主题（理论上不存在，留个兜底）退回单图数组 */
    const bgs = theme.bgImages && theme.bgImages.length
      ? theme.bgImages
      : (theme.bgImage ? [{ file: theme.bgImage, label: '' }] : []);
    /* 换主题时从本组第一张起；同一主题重建（如降画质）保持当前张，不跳图 */
    if (this._bgTheme !== name) { this.bgIndex = 0; this._bgTheme = name; }
    if (this.bgIndex >= bgs.length) this.bgIndex = 0;

    this.backdrop = new SkyBackdrop(200).addTo(root);
    this.sky = this.backdrop.group;   // 兼容：update() 里跟着相机横向平移

    /* 兜底：先用主题三色渐变，避免真图到位前出现纯黑天空 */
    const fallback = makeGradientSkyTexture(theme.sky);
    this.backdrop.show(fallback, name, true);

    /* 真图：先挂当前这张，其余的全组预加载（缓存命中后切图零等待） */
    if (bgs.length) {
      const cur = bgs[this.bgIndex];
      const apply = (tex) => {
        if (!this.backdrop || this.backdrop.owner !== name) return; // 已换主题，丢弃
        this.backdrop.show(tex, name);
      };
      const cached = loadSkyTexture(cur.file, apply);
      if (cached) apply(cached);
      preloadSkyGroup(bgs.map((b) => b.file), this.quality !== 0);
    }

    // 天空穹顶（穹顶渐变层，位于天幕球内侧，给上方补一层深邃感）
    if (theme.skyDome !== false) {
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(190, 24, 16),
        new THREE.ShaderMaterial({
          side: THREE.BackSide, depthWrite: false, fog: false, transparent: true,
          vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
          uniforms: {
            topColor: { value: new THREE.Color(theme.sky.top) },
            midColor: { value: new THREE.Color(theme.sky.mid) },
            bottomColor: { value: new THREE.Color(theme.sky.bottom) },
            uOpacity: { value: bgs.length ? 0.35 : 1.0 },
          },
        })
      );
      dome.position.y = 0;
      root.add(dome);
      this.skyDome = dome;
    }

    // 灯光
    const L = theme.lights;
    root.add(new THREE.HemisphereLight(new THREE.Color(L.hemiSky), new THREE.Color(L.hemiGround), L.hemiInt));
    const key = new THREE.DirectionalLight(new THREE.Color(L.key), L.keyInt);
    key.position.set(3, 8, 6);
    root.add(key);
    const rim = new THREE.DirectionalLight(new THREE.Color(L.rim), L.rimInt);
    rim.position.set(-4, 3, -6);
    root.add(rim);

    this._buildTrack(theme, root);
    this._buildPlayer(theme, root);
    this._buildScenery(theme, root);
    this._buildObstaclePool(theme, root);
    this._buildParticles(theme, root);
    this._buildDecor(theme, root);
    // 修罗魔相：不属于主题子树，这里只决定出镜与否；首次进地狱图才真正加载（异步，
    // 加载慢或加载失败都不会拖慢开局的渲染 —— 缺了它游戏照常跑）。
    if (this.statueRoot) this.statueRoot.visible = name === 'hell';
    if (this.treeRoot) this.treeRoot.visible = name === 'sakura';
    this._mountStatues();
    this._mountTrees();
    return theme;
  }

  /**
   * 在当前主题的图组里轮换到下一张天幕（B 键）。
   *
   * 返回新背景的说明文字给上层做 toast；没得切就返回 null。
   * 切图只换天幕，跑道/景物/灯光一概不动 —— 这样"换景"是零成本的，
   * 玩家不会看到障碍物闪一下。
   */
  cycleBg(dir = 1) {
    const theme = THEMES[this.themeName];
    const bgs = theme && theme.bgImages;
    if (!bgs || bgs.length < 2) return null;

    this.bgIndex = (this.bgIndex + dir + bgs.length) % bgs.length;
    const cur = bgs[this.bgIndex];
    const apply = (tex) => {
      if (!this.backdrop || this.backdrop.owner !== this.themeName) return;
      this.backdrop.show(tex, this.themeName);
    };
    const cached = loadSkyTexture(cur.file, apply);
    if (cached) apply(cached);
    return { label: cur.label, index: this.bgIndex, total: bgs.length };
  }

  /** 供 UI / 调试面板读取当前背景信息 */
  get bgInfo() {
    const theme = THEMES[this.themeName];
    const bgs = theme && theme.bgImages;
    if (!bgs || !bgs.length) return { label: '—', index: 0, total: 0 };
    return { label: bgs[this.bgIndex].label, index: this.bgIndex, total: bgs.length };
  }

  /**
   * 二次元主题用卡通材质（MeshToonMaterial），其余用标准材质。
   * 标准材质支持金属/玻璃质感（metalness/roughness）、自发光（emissive）与环境反射强度
   * （envMapIntensity，配合 scene.environment 的 envMap 反射，做出高大上质感）。
   * 控制字段会被剔除后再 spread，避免被 undefined 覆盖默认值。
   */
  _mat(theme, color, extra = {}) {
    const c = new THREE.Color(color);
    const ctrl = ['roughness', 'metalness', 'emissive', 'emissiveIntensity', 'envMapIntensity', 'transparent', 'opacity'];
    const pure = {};
    for (const k in extra) if (!ctrl.includes(k)) pure[k] = extra[k];
    if (theme.anime) {
      return new THREE.MeshToonMaterial({
        color: c, transparent: !!extra.transparent, opacity: extra.opacity ?? 1, ...pure,
      });
    }
    return new THREE.MeshStandardMaterial({
      color: c,
      roughness: extra.roughness ?? 0.4,
      metalness: extra.metalness ?? 0.2,
      emissive: extra.emissive instanceof THREE.Color ? extra.emissive : new THREE.Color(extra.emissive ?? 0x000000),
      emissiveIntensity: extra.emissiveIntensity ?? 1.0,
      envMapIntensity: extra.envMapIntensity ?? 0.9,
      transparent: !!extra.transparent,
      opacity: extra.opacity ?? 1,
      ...pure,
    });
  }

  /* ---- 跑道 ---- */
  _buildTrack(theme, root) {
    const segLen = TRACK_LEN / TILE_COUNT;
    const tileGeo = new THREE.PlaneGeometry(9, segLen);
    const lineGeo = new THREE.PlaneGeometry(9, 0.12);
    // 石板路：参考图1/2 的石板街道（樱花主题）
    let stoneTex = null;
    if (theme.stone) {
      stoneTex = makeStoneTexture();
      stoneTex.repeat.set(3, 10);
    }
    // 熔岩裂缝黑岩：地狱主题地面（"glowing lava cracks on black ground"）
    let lavaTex = null;
    if (theme.lava) {
      lavaTex = makeLavaCrackTexture();
      lavaTex.repeat.set(2, 6);
    }

    for (let i = 0; i < TILE_COUNT; i++) {
      const m = new THREE.Mesh(tileGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.ground[i % 2]),
        map: stoneTex || lavaTex,
      }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, 0, -i * segLen);
      root.add(m);

      // 熔岩裂缝的发光叠加层：让地面"透红"，比单纯贴图更有熔岩从地下涌出的感觉
      if (lavaTex) {
        const glow = new THREE.Mesh(tileGeo, new THREE.MeshBasicMaterial({
          map: lavaTex, transparent: true, opacity: 0.85,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(0, 0.005, 0);
        m.add(glow);
      }

      const line = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.rail), transparent: true, opacity: 0.35,
      }));
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.01, 0);
      m.add(line);
      m.userData.line = line;

      this.tiles.push(m);
    }

    // 车道分隔线
    const laneGeo = new THREE.PlaneGeometry(0.08, TRACK_LEN * 2);
    for (const x of [-1.2, 1.2]) {
      const m = new THREE.Mesh(laneGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.laneLine), transparent: true, opacity: 0.5,
      }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.02, -TRACK_LEN / 2);
      root.add(m);
    }
    // 两侧护栏
    const railGeo = new THREE.BoxGeometry(0.12, 0.35, TRACK_LEN * 2);
    for (const x of [-4.6, 4.6]) {
      const m = new THREE.Mesh(railGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.rail) }));
      m.position.set(x, 0.18, -TRACK_LEN / 2);
      root.add(m);
    }
  }

  /* ---- 玩家：圆润 + 发光描边的静谧高级体 ---- */
  _buildPlayer(theme, root) {
    const g = new THREE.Group();
    const P = theme.player;

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.34, 0.55, 8, 16),
      this._mat(theme, P.body, { roughness: 0.35, metalness: 0.3, emissive: new THREE.Color(P.visor), emissiveIntensity: 0.15 })
    );
    body.position.y = 1.15;
    g.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 18), this._mat(theme, P.head, { roughness: 0.25, metalness: 0.2 }));
    head.position.y = 1.85;
    g.add(head);

    // 发光面罩：压扁的胶囊弧面（替代方块）
    const visor = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.16, 0.18, 6, 12),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(P.visor), emissive: new THREE.Color(P.visor),
        emissiveIntensity: 0.9, roughness: 0.15, metalness: 0.4,
      })
    );
    visor.rotation.z = Math.PI / 2; visor.position.set(0, 1.88, -0.26);
    g.add(visor);

    // 四肢：圆润胶囊（替代方块）
    const limbMat = this._mat(theme, P.limb, { roughness: 0.4, metalness: 0.25 });
    const mk = (r, len) => new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), limbMat);
    this.pArmL = mk(0.1, 0.5); this.pArmL.position.set(-0.46, 1.2, 0);
    this.pArmR = mk(0.1, 0.5); this.pArmR.position.set(0.46, 1.2, 0);
    this.pLegL = mk(0.13, 0.6); this.pLegL.position.set(-0.18, 0.45, 0);
    this.pLegR = mk(0.13, 0.6); this.pLegR.position.set(0.18, 0.45, 0);
    g.add(this.pArmL, this.pArmR, this.pLegL, this.pLegR);

    // 脚下柔光环（Torus 加性发光，替代 Ring）
    this.aura = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.06, 12, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.obstacle.hurdle.color), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    this.aura.rotation.x = -Math.PI / 2;
    this.aura.position.y = 0.06;
    g.add(this.aura);

    /* ---- 鲸鱼娘立牌（DeepSeek 鲸鱼娘二创形象，背影立绘，CC BY-NC-SA 4.0 署名见 README）----
       相机在玩家身后跟着跑，背影立绘刚好正对镜头。三张姿态图（跑/蹲/跳）状态切换时换图 ——
       2D 立牌绝不能用 y 轴压扁来表现蹲下（整张图变纸片，用户实测差评）。
       胶囊小人整体保留：贴图加载成功前显示它（首帧不空），加载失败就一直用它 ——
       角色永远不能缺位；压扁/倾身的老动画也只留给胶囊兜底用。 */
    this._playerParts = [body, head, visor, this.pArmL, this.pArmR, this.pLegL, this.pLegR];
    this._playerPoses = {};   // name -> {tex, aspect}，异步填充
    this._playerPoseName = '';
    // window.__PLAYER_IMGS / __PLAYER_IMG 是无头截图的注入钩子（data URI 绕开 Virtual Time 下
    // 网络 fetch 等不到回调的问题）；生产代码走相对路径，不受影响。
    const PLAYER_DIR = new URL('../assets/models/player/', import.meta.url);
    const POSE_IMGS = (typeof window !== 'undefined' && window.__PLAYER_IMGS) || {
      run: (typeof window !== 'undefined' && window.__PLAYER_IMG) || (PLAYER_DIR.href + 'whale-girl.png'),
      duck: PLAYER_DIR.href + 'whale-girl-duck.png',
      jump: PLAYER_DIR.href + 'whale-girl-jump.png',
    };
    const PH = 2.5;                                      // 立牌显示高度（米）
    const PW = PH * (963 / 1485);                        // 跑姿 PNG 实际宽高比
    const pMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.02, side: THREE.DoubleSide, fog: false, toneMapped: false });
    const standee = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), pMat);
    standee.position.y = PH / 2 - 0.02;                  // 脚底贴地
    standee.visible = false;
    g.add(standee);
    this._playerStandee = standee;
    const texLoader = new THREE.TextureLoader();
    for (const [pose, src] of Object.entries(POSE_IMGS)) {
      texLoader.load(
        src,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          this._playerPoses[pose] = { tex, aspect: tex.image.width / tex.image.height };
          if (pose !== 'run') return;                    // 跑姿到位才亮牌、收胶囊
          pMat.map = tex;
          pMat.needsUpdate = true;
          standee.visible = true;
          for (const p of this._playerParts) p.visible = false;
        },
        undefined,
        () => console.warn(`[scene] 鲸鱼娘${pose}姿立牌加载失败${pose === 'run' ? '，保留胶囊小人兜底' : ''}`)
      );
    }

    /* ---- 真 3D 鲸鱼娘（图生3D 三姿态 GLB，跨主题只加载一次）---- */
    this._player3DOn = false;
    this._mountPlayer3D();   // 模板已就位则同步挂载；否则触发异步加载（失败自动落回立牌/胶囊）

    root.add(g);
    this.player = g;
  }

  /* ---- 真 3D 鲸鱼娘：跑/蹲/跳三个姿态各一个 GLB，按状态换模型 ----
     图生3D 产物（tools/3d-gen-file.py 提交、glb-shrink.mjs 瘦身到 ~2.4MB）。
     模板加载一次，挂载时 clone（几何体/材质共享）；切主题时玩家组会被
     disposeTree 整棵释放，靠 __keep 标记保护共享资源。加载失败自动降级：
     立牌还在（再不行胶囊兜底），角色永不缺席。 */
  async _loadPlayer3D() {
    if (this._player3DTpl) return this._player3DTpl;
    if (this._player3DLoading) return this._player3DLoading;
    this._player3DLoading = (async () => {
      let Ctor = (typeof window !== 'undefined' && window.__GLTFLoader) || null;
      if (!Ctor) {
        try {
          Ctor = (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader;
        } catch (e) {
          console.warn('[scene] GLTFLoader 不可用，3D 鲸鱼娘降级为立牌：', e && e.message);
          return null;
        }
      }
      const loader = new Ctor();
      const PLAYER_DIR = new URL('../assets/models/player/', import.meta.url).href;
      const srcs = (typeof window !== 'undefined' && window.__PLAYER_GLB) || {
        run: PLAYER_DIR + 'whale3d-run.glb',
        duck: PLAYER_DIR + 'whale3d-duck.glb',
        jump: PLAYER_DIR + 'whale3d-jump.glb',
      };
      const one = (src) => new Promise((res) => {
        if (/^data:/.test(src)) {
          // data URI：atob → parse，零网络等待（无头 Virtual Time 下 fetch 回调不可靠）
          const bin = atob(src.slice(src.indexOf(',') + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          loader.parse(bytes.buffer, '', (g) => res(g), (e) => res(null));
        } else {
          loader.load(src, (g) => res(g), undefined, () => { console.warn('[scene] 3D 鲸鱼娘加载失败：' + src.slice(0, 60)); res(null); });
        }
      });
      const scenes = {};
      for (const [k, s] of Object.entries(srcs)) {
        const g = await one(s);
        if (g) scenes[k] = g.scene;
      }
      if (!scenes.run) return null;
      // 统一缩放：跑姿归一到 2.5m 高；蹲/跳用同一因子 —— 蹲模型的"矮"必须保留
      const box = new THREE.Box3().setFromObject(scenes.run);
      const s = 2.5 / Math.max(0.01, box.max.y - box.min.y);
      const out = {};
      for (const [k, obj] of Object.entries(scenes)) {
        obj.scale.setScalar(s);
        obj.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(obj);
        obj.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);   // 脚底贴地 + 水平居中
        const outer = new THREE.Group();
        outer.add(obj);
        outer.userData.__keep = true;   // disposeTree 对带 __keep 的子树整体跳过
        if (obj.geometry) obj.geometry.userData.__shared = true;
        obj.traverse((o) => { if (o.geometry) o.geometry.userData.__shared = true; });
        out[k] = outer;
      }
      this._player3DTpl = out;
      if (this.player) this._mountPlayer3D();   // 主题构建是同步的，加载完补挂到当前玩家组
      return out;
    })();
    return this._player3DLoading;
  }

  _mountPlayer3D() {
    const tpl = this._player3DTpl;
    if (!tpl || !this.player || this._player3DObjs) return;
    const wrap = new THREE.Group();
    this._player3DObjs = {};
    for (const [k, obj] of Object.entries(tpl)) {
      const c = obj.clone();
      c.visible = k === 'run';
      wrap.add(c);
      this._player3DObjs[k] = c;
    }
    this.player.add(wrap);
    // 3D 到位：收掉立牌与胶囊兜底
    this._player3DOn = true;
    if (this._playerStandee) this._playerStandee.visible = false;
    if (this._playerParts) for (const p of this._playerParts) p.visible = false;
  }

  /* ---- 两侧立牌（修罗魔像 / 樱花树）：同一套加载·挂载·滚动管线 ---- */
  /**
   * 加载并缓存一套立牌贴图（cfg: STATUE_CFG / TREE_CFG）。直接用 THREE.TextureLoader
   * 加载透明 PNG —— 纯核心 API，连 GLTFLoader/addons 都不需要，零"现场环境依赖"。
   * 素材由 AI 生成高清立绘后经 tools/key-out-standee.py 抠图，透明通道已带好。
   * 加载失败只降级不抛错 —— 外部素材永远不能成为"页面白屏"的原因。
   */
  /**
   * 通用 GLB 模板加载（立牌系统的 3D 升级路径，与玩家 3D 同一套机制）：
   * - GLTFLoader 走 window.__GLTFLoader 静态钩子（无头 Virtual Time 下 await import 悬挂）
   *   或动态 import，都不可用就返回 null → 调用方回退立牌平面。
   * - data URI 用 atob→parse 零网络等待（展台出图注入用）。
   * - 模板归一到 cfg.height 高、脚底贴地、水平居中；__keep + __shared 防 disposeTree
   *   误释放（跨主题复用，clone 挂载共享几何体）。
   */
  async _loadModelTpl(models, height, slot) {
    if (this[slot]) return this[slot];
    this[slot] = (async () => {
      let Ctor = (typeof window !== 'undefined' && window.__GLTFLoader) || null;
      if (!Ctor) {
        try {
          Ctor = (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader;
        } catch (e) {
          console.warn('[scene] GLTFLoader 不可用，路侧模型降级为立牌：', e && e.message);
          return null;
        }
      }
      const loader = new Ctor();
      const one = (src) => new Promise((res) => {
        if (/^data:/.test(src)) {
          const bin = atob(src.slice(src.indexOf(',') + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          loader.parse(bytes.buffer, '', (g) => res(g), () => res(null));
        } else {
          loader.load(src, (g) => res(g), undefined,
            () => { console.warn('[scene] 路侧模型加载失败：' + src.slice(0, 80)); res(null); });
        }
      });
      const tpl = new Map();
      for (const name of models.files) {
        // 展台注入时 files 里直接放完整 data URI；生产代码走 dir + name + '.glb'
        const src = /^(data|https?|blob):/.test(name) ? name : models.dir + name + '.glb';
        const g = await one(src);
        if (!g) continue;
        const obj = g.scene;
        // 归一：目标高度 → 缩放；脚底贴地 + 水平居中（Box3 已含节点旋转，Z-up 件也能正）
        const box = new THREE.Box3().setFromObject(obj);
        const s = height / Math.max(0.01, box.max.y - box.min.y);
        obj.scale.setScalar(s);
        obj.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(obj);
        obj.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
        obj.traverse((o) => {
          if (o.geometry) o.geometry.userData.__shared = true;
          if (o.isMesh) {
            o.frustumCulled = false;   // 与立牌同策略：剔除交给肉眼验证，杜绝"在画面内却消失"
            o.castShadow = false; o.receiveShadow = false;
          }
        });
        const outer = new THREE.Group();
        outer.add(obj);
        outer.userData.__keep = true;   // disposeTree 对带 __keep 的子树整体跳过
        tpl.set(name, outer);
      }
      return tpl.size ? tpl : null;
    })();
    return this[slot];
  }

  async _loadStandeeTpl(cfg, slot) {
    if (this[slot]) return this[slot];
    this[slot] = (async () => {
      const loader = new THREE.TextureLoader();
      const one = (spec) => new Promise((res) => {
        const url = /^(data|https?|blob):/.test(spec) ? spec : `${cfg.dir}${spec}.png`;
        loader.load(
          url,
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 8;   // 斜视角清晰度：立牌都是竖长条贴图，不加各向异性会糊成马赛克
            res(tex);
          },
          undefined,
          () => { console.warn(`[scene] 立牌加载失败：${url.slice(0, 80)}`); res(null); }
        );
      });
      const tpl = new Map();
      for (const name of cfg.files) {
        const tex = await one(name);
        if (!tex) continue;
        tpl.set(name, tex);
      }
      return tpl.size ? tpl : null;
    })();
    return this[slot];
  }

  /**
   * 把一套立牌挂到场景里。挂在 scene 下而不是 themeRoot 下是有意的：
   * themeRoot 切主题会被 disposeTree 整棵释放，而立牌资源要跨主题复用
   * （换来换去都只加载一次），所以自己管生命周期，靠 visible 控制出镜。
   * opts: { tplSlot, rootSlot, listSlot, theme } —— hell/sakura 各挂一份。
   */
  async _mountStandeeSet(cfg, opts) {
    /* 3D 优先：cfg.models 存在就先试真模型（有体积、掠过见侧面，逼真度优先），
       GLTFLoader 不可用 / 模型 404 时回退立牌平面 —— 两侧装饰永远不能空。 */
    let mtpl = null;
    if (cfg.models && opts.modelSlot) mtpl = await this._loadModelTpl(cfg.models, cfg.height, opts.modelSlot);
    const tpl = mtpl ? null : await this._loadStandeeTpl(cfg, opts.tplSlot);
    if ((!mtpl && !tpl) || !this.scene || this[opts.rootSlot]) return;   // 加载期间可能已换场景
    const root = new THREE.Group();
    root.visible = this.themeName === opts.theme;
    this.scene.add(root);
    this[opts.rootSlot] = root;

    const names = [...(mtpl || tpl).keys()];
    let n = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < cfg.perSide; i++) {
        const key = names[n % names.length];
        n++;
        const wrap = new THREE.Group();
        if (mtpl) {
          /* 真 3D：clone 共享几何体/材质（模板 __keep + __shared 防误释放）。
             y 偏移与立牌一致 —— 底座沉进地里 0.35m，避免"浮在地面上"的悬浮感。 */
          wrap.add(mtpl.get(key).clone());
          const jitter = (Math.random() - 0.5) * 0.8;
          wrap.position.set(side * (cfg.x + Math.abs(jitter)), -0.35, -cfg.z0 - i * cfg.gap + jitter * 3);
          wrap.rotation.y = side < 0 ? (cfg.tilt || 0) : -(cfg.tilt || 0);
        } else {
          /* 用 PlaneGeometry+MeshBasicMaterial 而不是 Sprite：Sprite 的专属 shader
             在无头 SwiftShader 下整条 draw call 静默失效（红块实验实锤：摘掉贴图
             也不上屏、frustumCulled 关了也没用）。普通网格与路面/障碍同一条渲染
             路径，稳。相机基本沿 -z 直线跑，立牌面向 +z 即可。 */
          const tex = tpl.get(key);
          const mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            alphaTest: 0.02,     // 掐掉完全透明像素，避免透明排序毛边
            side: THREE.DoubleSide,
            fog: false,          // 场景雾会把远处立牌糊成一坨
            toneMapped: false,   // 立牌自带成品质感，不做 tonemap 压暗
            depthWrite: true,
          });
          const aspect = tex.image ? tex.image.width / tex.image.height : 2 / 3;
          const h = cfg.height, w = h * aspect;
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
          mesh.frustumCulled = false;   // 保险：几何体小，剔除交给肉眼验证
          wrap.add(mesh);
          const jitter = (Math.random() - 0.5) * 0.8;
          wrap.position.set(side * (cfg.x + Math.abs(jitter)), h / 2 - 0.35, -cfg.z0 - i * cfg.gap + jitter * 3);
          wrap.rotation.y = side < 0 ? (cfg.tilt || 0) : -(cfg.tilt || 0);   // 微倾显威仪（树不倾）
        }
        root.add(wrap);
        this[opts.listSlot].push(wrap);
      }
    }
  }

  _mountStatues() {
    return this._mountStandeeSet(STATUE_CFG, { tplSlot: '_statueTpl', modelSlot: '_statueModelTpl', rootSlot: 'statueRoot', listSlot: 'statues', theme: 'hell' });
  }

  _mountTrees() {
    return this._mountStandeeSet(TREE_CFG, { tplSlot: '_treeTpl', rootSlot: 'treeRoot', listSlot: 'trees', theme: 'sakura' });
  }

  /** 随跑道一起滚动到玩家身后就绕回去（与景物同一套循环逻辑）；各套立牌独立 span */
  _updateStatues(move) {
    const roll = (root, list, cfg) => {
      if (!root) return;
      const span = cfg.perSide * cfg.gap;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        s.position.z += move;
        if (s.position.z > 14) s.position.z -= span;
      }
    };
    roll(this.statueRoot, this.statues, STATUE_CFG);
    roll(this.treeRoot, this.trees, TREE_CFG);
  }

  /* ---- 两侧景物 ---- */
  _buildScenery(theme, root) {
    // 总开关：关掉时一件都不建（四张地图统一），见文件头 SCENERY_ON 的说明。
    if (!SCENERY_ON) return;
    // 物件做得更细了，数量相应收一点（16 个精致件 ≈ 原来 20 个简陋件的观感密度，
    // 但 draw call 更少 —— 这也是"改善观感"不能拖垮帧率的折中）
    const COUNT = this.quality < 1 ? 10 : 16;
    for (let i = 0; i < COUNT; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const m = this._mkSceneryPiece(theme);
      m.position.set(side * (5.6 + Math.random() * 2.5), m.userData.baseY, -Math.random() * TRACK_LEN * 1.6);
      root.add(m);
      this.scenery.push(m);
    }
  }

  _mkSceneryPiece(theme) {
    const t = theme.scenery;
    if (t === 'sakura') {
      // ── 和风街屋 + 樱树 ──
      // 旧版是"一个挤出方盒 + 圆形车削屋顶 + 两团球花"，远看就是纸板道具。
      // 现在按真实建筑语言重建：石基 → 四角木柱 → 障子窗/格子门 → 缘侧回廊
      // → 双层出檐屋顶，再配一棵"多枝干 + 团块花冠"的樱树。
      const g = new THREE.Group();
      const wallMat = this._mat(theme, '#f2e7d6', { roughness: 0.78, metalness: 0.03 });
      const woodMat = this._mat(theme, '#6d4a33', { roughness: 0.72, metalness: 0.05 });
      const darkMat = this._mat(theme, '#3a2a20', { roughness: 0.7, metalness: 0.1 });
      const roofMat = this._mat(theme, '#4a5464', { roughness: 0.55, metalness: 0.22 });
      const stoneMat = this._mat(theme, '#cfc6b8', { roughness: 0.9, metalness: 0.02 });
      // 樱花主题走卡通材质（_mat 的 toon 分支会丢弃 emissive），
      // 需要发光的花冠/灯笼就用显式标准材质，否则樱花树会是死板的塑料色。
      const glowStd = (color, emissive, intensity, rough = 0.5) => new THREE.MeshStandardMaterial({
        color: new THREE.Color(color), emissive: new THREE.Color(emissive),
        emissiveIntensity: intensity, roughness: rough, metalness: 0.05,
      });
      if (!World._shojiTex) World._shojiTex = makeShojiTexture();

      const W = 3.0, D = 2.4, H1 = 2.1, H2 = 1.15;
      // 1) 石基 + 一层墙体
      const base = new THREE.Mesh(boxGeo(W + 0.5, 0.3, D + 0.5), stoneMat);
      base.position.y = 0.15;
      const body1 = new THREE.Mesh(boxGeo(W, H1, D), wallMat);
      body1.position.y = 0.3 + H1 / 2;
      // 2) 四角木柱
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(boxGeo(0.13, H1 + 0.1, 0.13), woodMat);
        post.position.set(sx * (W / 2 - 0.02), 0.3 + (H1 + 0.1) / 2, sz * (D / 2 - 0.02));
        g.add(post);
      }
      // 3) 障子窗 + 格子门
      const shoji = new THREE.Mesh(planeGeo(1.15, 1.05), glowStd('#ffffff', '#ffe9c4', 0.35, 0.85));
      shoji.material.map = World._shojiTex;
      shoji.position.set(0.78, 1.45, D / 2 + 0.03);
      const door = new THREE.Mesh(boxGeo(1.2, 1.7, 0.07), darkMat);
      door.position.set(-0.72, 1.15, D / 2 + 0.02);
      for (let k = -2; k <= 2; k++) {
        const slat = new THREE.Mesh(boxGeo(0.045, 1.5, 0.03), woodMat);
        slat.position.set(-0.72 + k * 0.22, 1.15, D / 2 + 0.07);
        g.add(slat);
      }
      g.add(base, body1, shoji, door);
      // 4) 缘侧（外廊）+ 栏杆
      const deck = new THREE.Mesh(boxGeo(W + 0.7, 0.12, 0.62), woodMat);
      deck.position.set(0, 0.36, D / 2 + 0.34);
      const rail = new THREE.Mesh(boxGeo(W + 0.7, 0.075, 0.075), woodMat);
      rail.position.set(0, 0.72, D / 2 + 0.62);
      g.add(deck, rail);
      for (const k of [-1, 0, 1]) {
        const rp = new THREE.Mesh(boxGeo(0.06, 0.34, 0.06), woodMat);
        rp.position.set(k * (W / 2 + 0.1), 0.55, D / 2 + 0.62);
        g.add(rp);
      }
      // 5) 二层 + 双层出檐屋顶（四棱锥转 45° 得到"面朝轴向"的歇山屋顶）
      const body2 = new THREE.Mesh(boxGeo(W * 0.82, H2, D * 0.82), wallMat);
      body2.position.y = 0.3 + H1 + H2 / 2;
      g.add(body2);
      const addRoof = (hx, hz, hy, y) => {
        const grp = new THREE.Group();
        const slab = new THREE.Mesh(boxGeo(hx * 2 + 0.36, 0.14, hz * 2 + 0.36), roofMat);
        const cone = new THREE.Mesh(coneGeo(1, hy, 4), roofMat);
        cone.rotation.y = Math.PI / 4;
        cone.scale.set((hx + 0.18) * Math.SQRT2, 1, (hz + 0.18) * Math.SQRT2);
        cone.position.y = hy / 2;
        grp.add(slab, cone);
        grp.position.y = y;
        g.add(grp);
      };
      addRoof(W / 2, D / 2, 0.78, 0.3 + H1 + 0.07);
      addRoof(W * 0.41, D * 0.41, 0.62, 0.3 + H1 + H2 + 0.07);
      // 6) 檐下灯笼（暖光缓慢呼吸）
      const pulseMats = [];
      for (const sx of [-1, 1]) {
        const lm = new THREE.MeshStandardMaterial({
          color: new THREE.Color('#ffd9a0'), emissive: new THREE.Color('#ff9e3d'),
          emissiveIntensity: 1.1, roughness: 0.6, metalness: 0.05,
        });
        const lan = new THREE.Mesh(sphereGeo(0.15, 12, 10), lm);
        lan.scale.set(1, 1.25, 1);
        lan.position.set(sx * (W / 2 + 0.12), 0.3 + H1 - 0.24, D / 2 + 0.24);
        g.add(lan);
        pulseMats.push({ mat: lm, base: 0.85, amp: 0.5, rate: 1.1, ph: Math.random() * 6.28 });
      }
      // 7) 樱树：主干 + 两根分叉 + 团块花冠
      const trunkMat = this._mat(theme, '#6b4a3c', { roughness: 0.85, metalness: 0.03 });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.26, 2.4, 9), trunkMat);
      trunk.position.set(2.25, 1.2, -0.25); trunk.rotation.z = 0.09;
      const br1 = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 1.5, 7), trunkMat);
      br1.position.set(2.75, 2.55, -0.1); br1.rotation.z = -0.75;
      const br2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.11, 1.3, 7), trunkMat);
      br2.position.set(1.85, 2.6, -0.35); br2.rotation.z = 0.8; br2.rotation.x = 0.3;
      g.add(trunk, br1, br2);
      const blossomMat = glowStd('#ffc0dc', '#ff8fc0', 0.32, 0.55);
      const centers = [[2.35, 3.5, -0.25], [3.05, 2.95, 0.15], [1.75, 3.1, -0.5]];
      const CLOUD = 3, PER = 11;   // 3 个团心 × 每团 11 块 ≈ 33 个花团
      // 花团走 InstancedMesh：33 个网格 → 1 次 draw call。
      // 为什么必须这么做：景物 COUNT 是 16，一件 33 个花团就是 16×33 = 528 次 draw call，
      // 只为了堆树冠细节 —— 这正是"好看但掉帧"的典型写法，答辩现场掉帧比物件粗糙更致命。
      // 实例化的代价只是每朵花要用"统一半径 1 的球 + 各自缩放"（几何体必须共享）。
      const blossoms = new THREE.InstancedMesh(icoGeo(1, 1), blossomMat, CLOUD * PER);
      const dummy = new THREE.Object3D();
      let bi = 0;
      for (let ci = 0; ci < CLOUD; ci++) {
        for (let k = 0; k < PER; k++) {
          const c = centers[ci];
          const r = 0.7 + Math.random() * 0.5;
          const th = Math.random() * 6.28, ph = Math.acos(2 * Math.random() - 1);
          dummy.position.set(
            c[0] + Math.sin(ph) * Math.cos(th) * r,
            c[1] + Math.cos(ph) * r * 0.8,
            c[2] + Math.sin(ph) * Math.sin(th) * r,
          );
          dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
          dummy.scale.setScalar(0.3 + Math.random() * 0.16);
          dummy.updateMatrix();
          blossoms.setMatrixAt(bi++, dummy.matrix);
        }
      }
      blossoms.instanceMatrix.needsUpdate = true;
      // 包围球要按"实例散布范围"重算，否则会被视锥剔除误杀（花团摊在树冠上，比单个球的包围盒大得多）
      blossoms.computeBoundingSphere();
      g.add(blossoms);
      // 花冠外那层柔光：贴图必须复用，别每件景物都新建一张 canvas 贴图（16 张白上传一次显存）
      if (!World._petalTex) World._petalTex = makePetalTexture();
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: World._petalTex, color: new THREE.Color('#ffd0e6'), transparent: true, opacity: 0.42,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      halo.scale.set(6.5, 6.5, 1); halo.position.set(2.4, 3.2, -0.2);
      g.add(halo);
      g.userData.pulseMats = pulseMats;
      g.userData.baseY = 0;
      return g;
    }
    if (t === 'rock') {
      // ── 火山岩柱 + 熔岩池 ──
      // 旧版是"干净圆柱 + 几片贴上去的发光方片"，一眼贴图盒。
      // 现在按真实火山地貌重建：不规则岩体（顶点抖动）+ 岩层断带
      // + 岩体内透的熔岩裂纹（emissiveMap）+ 不规则熔岩池 + 悬浮熔岩碎块。
      if (!World._rockTex) World._rockTex = makeRockTexture();
      if (!World._veinTex) World._veinTex = makeLavaVeinTexture();
      if (!World._lavaFlowTex) World._lavaFlowTex = makeLavaFlowTexture();
      const g = new THREE.Group();
      const ph = 3.6 + Math.random() * 4.2;
      const rockMat = this._mat(theme, '#1b1316', {
        roughness: 0.62, metalness: 0.38, envMapIntensity: 0.7,
        map: World._rockTex,
        emissive: new THREE.Color('#ff3c08'), emissiveIntensity: 0.85,
        emissiveMap: World._veinTex,
      });
      const rockMat2 = this._mat(theme, '#120b0e', { roughness: 0.7, metalness: 0.3, map: World._rockTex });
      // 1) 基座岩丘
      const mound = new THREE.Mesh(jitterGeo(new THREE.CylinderGeometry(1.5, 2.15, 0.72, 9), 0.22), rockMat2);
      mound.position.y = 0.36;
      // 2) 主岩柱（越往上越细）
      const spire = new THREE.Mesh(jitterGeo(new THREE.CylinderGeometry(0.3, 1.02, ph, 7), 0.2), rockMat);
      spire.position.set((Math.random() - 0.5) * 0.5, 0.7 + ph / 2, (Math.random() - 0.5) * 0.4);
      spire.rotation.y = Math.random() * 3;
      // 3) 岩层断带：两道略粗的环状层，做出"沉积岩"的读感
      const bandA = new THREE.Mesh(jitterGeo(new THREE.CylinderGeometry(0.66, 0.82, 0.3, 7), 0.14), rockMat2);
      bandA.position.set(spire.position.x, 0.7 + ph * 0.42, spire.position.z); bandA.rotation.y = spire.rotation.y + 0.5;
      const bandB = new THREE.Mesh(jitterGeo(new THREE.CylinderGeometry(0.46, 0.6, 0.26, 7), 0.14), rockMat2);
      bandB.position.set(spire.position.x, 0.7 + ph * 0.72, spire.position.z); bandB.rotation.y = spire.rotation.y - 0.6;
      // 4) 顶部熔岩口
      const crater = new THREE.Mesh(circleGeo(0.34, 14), new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ff8a2a'), transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      crater.rotation.x = -Math.PI / 2;
      crater.position.set(spire.position.x, 0.7 + ph + 0.01, spire.position.z);
      g.add(mound, spire, bandA, bandB, crater);
      // 5) 不规则熔岩池（随机多边形，不是完美的圆）+ 焦岩池边
      const poolR = 1.15 + Math.random() * 0.6;
      const shp = new THREE.Shape();
      const N = 13;
      for (let k = 0; k < N; k++) {
        const a = (k / N) * 6.28;
        const r = poolR * (0.72 + Math.random() * 0.5);
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        if (k === 0) shp.moveTo(px, py); else shp.lineTo(px, py);
      }
      shp.closePath();
      const pool = new THREE.Mesh(new THREE.ShapeGeometry(shp), new THREE.MeshBasicMaterial({
        map: World._lavaFlowTex, color: new THREE.Color('#ff7a1e'),
        transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(spire.position.x + (Math.random() - 0.5) * 1.8, 0.03, spire.position.z + 1.0);
      const rim = new THREE.Mesh(jitterGeo(new THREE.TorusGeometry(poolR * 1.06, 0.14, 6, 18), 0.3), rockMat2);
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(pool.position.x, 0.05, pool.position.z);
      g.add(pool, rim);
      // 6) 悬浮熔岩碎块：黑岩外壳 + 内透熔岩
      const crystals = [];
      const nRock = 2 + Math.floor(Math.random() * 2);
      for (let k = 0; k < nRock; k++) {
        const r = 0.3 + Math.random() * 0.38;
        const m = new THREE.Mesh(icoGeo(r, 1), this._mat(theme, '#2a1216', {
          roughness: 0.3, metalness: 0.55,
          emissive: new THREE.Color('#ff5a1f'), emissiveIntensity: 0.7,
        }));
        m.position.set(
          spire.position.x + (Math.random() - 0.5) * 2.0,
          1.3 + Math.random() * (ph * 0.7),
          spire.position.z + (Math.random() - 0.5) * 1.6,
        );
        m.userData.spin = 0.2 + Math.random() * 0.4;
        m.userData.bobBase = m.position.y;
        m.userData.bobPh = Math.random() * 6.28;
        g.add(m); crystals.push(m);
      }
      // 7) 顶部热浪光晕（贴图复用，别每件景物新建）
      if (!World._glowTex) World._glowTex = makeGlowTexture();
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: World._glowTex, color: new THREE.Color('#ff7a20'), transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.scale.set(3.4, 3.4, 1);
      halo.position.set(spire.position.x, 0.7 + ph + 0.15, spire.position.z);
      g.add(halo);
      g.userData.crystals = crystals;
      g.userData.pool = pool;
      // 熔岩裂纹的"呼吸"：整体发光强度缓慢起落
      g.userData.pulseMats = [
        { mat: rockMat, base: 0.5, amp: 0.55, rate: 1.3, ph: Math.random() * 6.28 },
      ];
      g.userData.baseY = 0;
      return g;
    }
    if (t === 'crystal') {
      // 星海：悬浮发光星晶 + 细发光星轨环（静谧酷感）
      const g = new THREE.Group();
      const rk = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.55, 1),
        this._mat(theme, '#2a2f5e', { roughness: 0.2, metalness: 0.5, emissive: new THREE.Color('#7b6bff'), emissiveIntensity: 0.7 })
      );
      rk.position.set(0.8, 3.0 + Math.random() * 1.5, 0.3);
      rk.userData.baseY = rk.position.y;
      g.add(rk);
      const rings = [];
      const ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color('#8a7bff'), transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      for (let k = 0; k < 2; k++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4 + k * 0.5, 0.025, 8, 48), ringMat);
        ring.position.copy(rk.position);
        ring.rotation.x = Math.random() * 3.14; ring.rotation.y = Math.random() * 3.14;
        ring.userData.rs = (Math.random() - 0.5) * 0.5;
        g.add(ring); rings.push(ring);
      }
      g.userData.bobMesh = rk;
      g.userData.rings = rings;
      g.userData.bobPhase = Math.random() * 6.28;
      return g;
    }
    // 赛博：玻璃幕墙塔（带倒角挤出 + 金属玻璃感）+ 楼顶能量环 + 紫红霓虹牌
    const g = new THREE.Group();
    const bh = 10 + Math.random() * 7;
    const w = 1.7, d = 1.7;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, -bh / 2); shape.lineTo(w / 2, -bh / 2);
    shape.lineTo(w / 2, bh / 2); shape.lineTo(-w / 2, bh / 2); shape.closePath();
    const towerGeo = new THREE.ExtrudeGeometry(shape, {
      depth: d, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3, steps: 1,
    });
    towerGeo.translate(0, 0, -d / 2);
    if (!World._circuitTex) World._circuitTex = makeCircuitTexture('rgba(45,226,255,0.95)');
    const tower = new THREE.Mesh(towerGeo, new THREE.MeshStandardMaterial({
      map: World._circuitTex, color: new THREE.Color('#9fdcff'),
      roughness: 0.1, metalness: 0.9, emissive: new THREE.Color('#0a3a5a'),
      emissiveIntensity: 0.45, envMapIntensity: 1.4,
    }));
    tower.position.y = bh / 2;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.06, 10, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#2de2ff'), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    ring.position.y = bh + 0.2; ring.rotation.x = Math.PI / 2;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 2.6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2d78'), transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    sign.position.set(1.05, bh * 0.55, 0);
    g.add(tower, ring, sign);
    g.userData.baseY = 0;
    g.userData.blinkMesh = sign;
    return g;
  }

  /* ---- 障碍物 ----
     三型共用一套"工业路障"语言：深色金属骨架 + 主题色发光警示，
     形状差异一眼可辨（低栏要跳 / 高杆要蹲 / 实墙要变道），
     同时保持与判定区间一致的轮廓高度 —— 看到的形状就是判定的区间。 */
  _mkObstacleMesh(theme, type) {
    // 小恶魔走独立的建模分支（它没有 theme.obstacle 配置项）
    if (type === 'demon') return this._mkDemonMesh(theme);
    const g = new THREE.Group();
    const oc = theme.obstacle[type];
    const mat = this._mat(theme, oc.color, {
      roughness: 0.34, metalness: 0.42,
      emissive: new THREE.Color(oc.emissive), emissiveIntensity: 0.5,
    });
    const frameMat = this._mat(theme, '#242c42', { roughness: 0.5, metalness: 0.55, envMapIntensity: 0.8 });
    const trimMat = this._mat(theme, oc.emissive, {
      roughness: 0.3, metalness: 0.5,
      emissive: new THREE.Color(oc.color), emissiveIntensity: 0.55,
    });
    // 加性发光条：门槛/警示线专用，暗主题里也能一眼看见（不吃光照）
    const glowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(oc.color), transparent: true, opacity: 0.92,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });

    if (type === 'hurdle') {
      // 低栏：双层横杆 + 斜撑 + 配重底脚 + 顶部发光警示条
      const barTop = new THREE.Mesh(boxGeo(2.0, 0.17, 0.17), mat);
      barTop.position.y = 0.80;
      const barSub = new THREE.Mesh(boxGeo(1.84, 0.08, 0.08), trimMat);
      barSub.position.y = 0.58;
      const glow = new THREE.Mesh(boxGeo(1.9, 0.06, 0.06), glowMat);
      glow.position.set(0, 0.92, 0);
      g.add(barTop, barSub, glow);
      // 杆面斜纹：三块小斜板，读作"警示"
      for (let i = -1; i <= 1; i++) {
        const stripe = new THREE.Mesh(boxGeo(0.24, 0.42, 0.05), glowMat);
        stripe.position.set(i * 0.46, 0.80, 0.1);
        stripe.rotation.z = 0.62;
        g.add(stripe);
      }
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(boxGeo(0.13, 0.86, 0.13), frameMat);
        leg.position.set(s * 0.88, 0.43, 0);
        const foot = new THREE.Mesh(boxGeo(0.34, 0.09, 0.44), frameMat);
        foot.position.set(s * 0.88, 0.045, 0);
        const brace = new THREE.Mesh(boxGeo(0.06, 0.6, 0.06), frameMat);
        brace.position.set(s * 0.62, 0.44, 0);
        brace.rotation.z = s * 0.5;
        const cap = new THREE.Mesh(coneGeo(0.105, 0.2, 8), trimMat);
        cap.position.set(s * 0.88, 0.96, 0);
        g.add(leg, foot, brace, cap);
      }
    } else if (type === 'overhead') {
      // 高杆：顶梁 + 吊链 + 梁上警示牌 + 下缘发光条
      const beam = new THREE.Mesh(boxGeo(2.1, 0.44, 0.34), mat);
      beam.position.y = 2.08;
      const lip = new THREE.Mesh(boxGeo(2.14, 0.08, 0.38), trimMat);
      lip.position.y = 1.84;
      const glow = new THREE.Mesh(boxGeo(2.0, 0.06, 0.06), glowMat);
      glow.position.set(0, 1.78, 0.19);
      // 梁面菱形警示牌（纯几何，不依赖贴图）
      const diamond = new THREE.Mesh(boxGeo(0.46, 0.46, 0.06), trimMat);
      diamond.position.set(0, 2.08, 0.19); diamond.rotation.z = Math.PI / 4;
      const diamondLit = new THREE.Mesh(boxGeo(0.24, 0.24, 0.04), glowMat);
      diamondLit.position.set(0, 2.08, 0.23); diamondLit.rotation.z = Math.PI / 4;
      g.add(beam, lip, glow, diamond, diamondLit);
      // 吊链：每侧 4 节链环，交错 90° 转出"链条"的读感
      for (const s of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const link = new THREE.Mesh(torusGeo(0.072, 0.023, 6, 14), frameMat);
          link.position.set(s * 0.9, 2.44 + k * 0.17, 0);
          if (k % 2) { link.rotation.y = Math.PI / 2; }
          else { link.rotation.x = Math.PI / 2; }
          g.add(link);
        }
      }
    } else {
      // 实墙：主墙 + 内嵌面板 + 竖向肋条 + 上下发光安全带 + 底座与压顶
      const wall = new THREE.Mesh(boxGeo(1.98, 1.84, 0.5), mat);
      wall.position.y = 0.95;
      const panel = new THREE.Mesh(boxGeo(1.48, 1.4, 0.08), trimMat);
      panel.position.set(0, 0.95, 0.26);
      const band1 = new THREE.Mesh(boxGeo(1.98, 0.07, 0.06), glowMat);
      band1.position.set(0, 1.72, 0.24);
      const band2 = new THREE.Mesh(boxGeo(1.98, 0.07, 0.06), glowMat);
      band2.position.set(0, 0.24, 0.24);
      const base = new THREE.Mesh(boxGeo(2.12, 0.16, 0.66), frameMat);
      base.position.y = 0.08;
      const cap = new THREE.Mesh(boxGeo(2.06, 0.12, 0.58), trimMat);
      cap.position.y = 1.92;
      g.add(wall, panel, band1, band2, base, cap);
      for (const s of [-1, 1]) {
        const rib = new THREE.Mesh(boxGeo(0.1, 1.4, 0.1), frameMat);
        rib.position.set(s * 0.5, 0.95, 0.3);
        const edge = new THREE.Mesh(boxGeo(0.1, 1.84, 0.1), trimMat);
        edge.position.set(s * 0.99, 0.95, 0.21);
        g.add(rib, edge);
      }
    }
    g.visible = false;
    g.userData.__pool = this.pools;   // 标记所属池，供 release 校验
    this.themeRoot.add(g);
    return g;
  }

  _buildObstaclePool(theme, root) {
    for (const t of Object.keys(this.pools)) {
      for (let i = 0; i < 8; i++) this.pools[t].push(this._mkObstacleMesh(theme, t));
    }
  }

  /* ---- 小恶魔：挥拳打倒的怪 ----
     设计取向：矮胖圆身 + 一对小角 + 尖耳 + 发光大眼 + 尖牙 + 会扑扇的小翅膀 + 尾巴，
     危险但可爱 —— 既有"怪"的辨识度，又不破坏各主题的整体氛围。

     刻意把体高压扁：主体顶端 ≈1.06、角尖 ≈1.2，与规则层判定的站立高度（1.15）对齐。
     之前的老模型头顶到 1.67，比判定高出一大截 —— 玩家"跳过去"时会从它脑袋里穿过去。

     头顶挂一条始终朝向相机的血条（背板 + 填充双面板）：
     受伤时按 hp/maxHp 左对齐收缩、血量越少越红，让"还要几拳"一眼可见。
     待机动画（浮动 + 扇翅膀）与血条朝向在 update() 里做，规则层只管推进 z。 */
  _mkDemonMesh(theme) {
    const g = new THREE.Group();
    // 恶魔配色刻意不随主题材质开关走 —— 它是"角色"，必须在所有主题里一眼可辨。
    // 尤其樱花主题走 MeshToonMaterial，而 _mat 的 toon 分支不透传 emissive，
    // 实测恶魔会黑成一团只剩两只眼睛（截图复核发现的）。这里显式带上自发光。
    const mkMat = (color, emissive, intensity) => (theme.anime
      ? new THREE.MeshToonMaterial({
          color: new THREE.Color(color), emissive: new THREE.Color(emissive), emissiveIntensity: intensity,
        })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color(color), roughness: 0.42, metalness: 0.14,
          emissive: new THREE.Color(emissive), emissiveIntensity: intensity,
        }));
    const bodyMat = mkMat('#a81c30', '#7a0d1e', 1.0);
    const darkMat = mkMat('#5a1224', '#30060f', 0.8);
    const bellyMat = mkMat('#ffb08a', '#8a4028', 0.55);
    const hornMat = this._mat(theme, '#ffe3bd', { roughness: 0.35 });

    // 圆滚滚的身体（同时就是脑袋）—— 主体顶端 1.06
    const body = new THREE.Mesh(sphereGeo(0.54, 22, 16), bodyMat);
    body.scale.set(1, 0.98, 0.94); body.position.y = 0.56;
    // 浅色肚皮
    const belly = new THREE.Mesh(sphereGeo(0.34, 16, 12), bellyMat);
    belly.scale.set(1, 1.1, 0.5); belly.position.set(0, 0.46, 0.4);
    // ⚠ 身体和肚皮必须 add 进组 —— 之前漏了这一行，恶魔只剩飘在空中的
    // 眼睛/翅膀/脚，本体根本不存在（恶魔特写截图里一眼看出来的）。
    g.add(body, belly);

    // 一对小角 + 侧耳
    const hL = new THREE.Mesh(coneGeo(0.082, 0.26, 8), hornMat);
    hL.position.set(-0.19, 1.07, -0.02); hL.rotation.z = 0.42;
    const hR = new THREE.Mesh(coneGeo(0.082, 0.26, 8), hornMat);
    hR.position.set(0.19, 1.07, -0.02); hR.rotation.z = -0.42;
    g.add(hL, hR);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(coneGeo(0.075, 0.22, 7), darkMat);
      ear.position.set(s * 0.5, 0.72, -0.05);
      ear.rotation.z = s * 1.15;
      g.add(ear);
    }

    // 发光眼睛 + 深色瞳点：暗主题里也能一眼认出"这是只怪"
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd166'), fog: false });
    const eyeGeo = sphereGeo(0.063, 10, 8);
    const eL = new THREE.Mesh(eyeGeo, eyeMat); eL.position.set(-0.15, 0.68, 0.47);
    const eR = new THREE.Mesh(eyeGeo, eyeMat); eR.position.set(0.15, 0.68, 0.47);
    const pupMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#2a0510'), fog: false });
    const pL = new THREE.Mesh(sphereGeo(0.026, 8, 6), pupMat); pL.position.set(-0.15, 0.68, 0.51);
    const pR = new THREE.Mesh(sphereGeo(0.026, 8, 6), pupMat); pR.position.set(0.15, 0.68, 0.51);
    g.add(eL, eR, pL, pR);

    // 咧开的嘴 + 两颗小尖牙
    const mouth = new THREE.Mesh(sphereGeo(0.14, 12, 9), darkMat);
    mouth.scale.set(1.5, 0.68, 0.42); mouth.position.set(0, 0.42, 0.45);
    g.add(mouth);
    const toothMat = this._mat(theme, '#fff6e8', { roughness: 0.3 });
    for (const s of [-1, 1]) {
      const t = new THREE.Mesh(coneGeo(0.032, 0.1, 6), toothMat);
      t.position.set(s * 0.075, 0.41, 0.5); t.rotation.x = Math.PI;
      g.add(t);
    }

    // 小翅膀：挂在根部枢轴组上，update 里转 rotation.z 做扑扇
    const wings = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.3, 0.78, -0.26);
      const wing = new THREE.Mesh(sphereGeo(0.3, 12, 9), darkMat);
      wing.scale.set(1.5, 0.85, 0.1);
      wing.position.x = s * 0.4;
      pivot.add(wing);
      g.add(pivot);
      wings.push(pivot);
    }

    // 尾巴 + 尾尖
    const tail = new THREE.Mesh(cylGeo(0.032, 0.016, 0.46, 7), bodyMat);
    tail.position.set(0.2, 0.3, -0.44); tail.rotation.x = 1.15; tail.rotation.z = -0.4;
    const tip = new THREE.Mesh(coneGeo(0.062, 0.14, 7), darkMat);
    tip.position.set(0.35, 0.2, -0.62); tip.rotation.x = 1.15;
    g.add(tail, tip);

    // 两只小短脚：贴地，强化"站在跑道上"的读感
    for (const s of [-1, 1]) {
      const foot = new THREE.Mesh(sphereGeo(0.15, 10, 8), darkMat);
      foot.scale.set(1, 0.55, 1.3); foot.position.set(s * 0.24, 0.08, 0.06);
      g.add(foot);
    }

    // 脚下柔影：贴地的存在感
    const shadow = new THREE.Mesh(
      circleGeo(0.62, 22),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#000000'), transparent: true, opacity: 0.3, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
    g.add(shadow);

    // "可以打"的地面指示环：恶魔进入挥拳范围时亮起并脉动。
    // 实机反馈里"识别不出来"有一半是玩家不知道该什么时候出手 —— 这个环就是时间提示。
    const targetRing = new THREE.Mesh(
      torusGeo(0.78, 0.055, 10, 36),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ffd85e'), transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      })
    );
    targetRing.rotation.x = -Math.PI / 2;
    targetRing.position.y = 0.05;
    targetRing.visible = false;
    g.add(targetRing);

    // —— 血条：永远朝向相机的双面板（背板 + 填充）——
    // 尺寸按截图复核调过：太小（1.06×0.15）在 10 单位外只剩 6px 高，根本读不出还剩几拳。
    const HP_W = 1.5, HP_H = 0.26;
    const hpGroup = new THREE.Group();
    hpGroup.position.set(0, 1.62, 0);
    hpGroup.renderOrder = 3;
    const hpBg = new THREE.Mesh(planeGeo(HP_W + 0.08, HP_H + 0.08), new THREE.MeshBasicMaterial({
      color: new THREE.Color('#100609'), transparent: true, opacity: 0.8, depthWrite: false, fog: false,
    }));
    const hpFill = new THREE.Mesh(planeGeo(HP_W, HP_H), new THREE.MeshBasicMaterial({
      color: new THREE.Color('#ff4d5e'), transparent: true, opacity: 1, depthWrite: false, fog: false,
    }));
    hpFill.position.z = 0.016;
    hpGroup.add(hpBg, hpFill);
    g.add(hpGroup);

    g.userData.bobPhase = Math.random() * 6.28;
    g.userData.wings = wings;
    g.userData.targetRing = targetRing;
    g.userData.hpBar = { group: hpGroup, fill: hpFill, w: HP_W };
    g.visible = false;
    g.userData.__pool = this.pools;   // 标记所属池，供 release 校验
    this.themeRoot.add(g);
    return g;
  }

  /** 击杀小恶魔的特效：冲击波环 + 一团闪光（挂在 scene 上，自管理生命周期） */
  demonKill(x, z) {
    if (!World._glowTex) World._glowTex = makeGlowTexture();
    const ring = new THREE.Mesh(
      torusGeo(0.5, 0.06, 10, 36),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ff8a4d'), transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      })
    );
    ring.position.set(x, 0.9, z);
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: World._glowTex, color: new THREE.Color('#ffd166'),
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    flash.position.copy(ring.position);
    flash.scale.set(2.0, 2.0, 1);
    this.scene.add(ring, flash);
    this.fx.push(
      { mesh: ring, t: 0, life: 0.42, ring: true, s0: 1, grow: 3.4 },
      { mesh: flash, t: 0, life: 0.28, s0: 2.0, grow: 3.0 }
    );
  }

  /**
   * 打中恶魔但没打倒：一小团射向镜头的火花。
   * 刻意做得比击杀弱一档，让"打残"和"打死"在画面上一眼能分辨 ——
   * 血条厚了以后，玩家全靠这个反馈判断"还差几拳"。
   */
  demonHit(x, z, lethal) {
    if (!World._glowTex) World._glowTex = makeGlowTexture();
    const s = lethal ? 2.0 : 1.25;   // 收掉的那一拳也给个"半大"的爆点做衔接
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: World._glowTex, color: new THREE.Color(lethal ? '#ffd166' : '#ffb03a'),
      transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    flash.position.set(x, 0.75, z);
    flash.scale.set(s, s, 1);
    this.scene.add(flash);
    this.fx.push({ mesh: flash, t: 0, life: lethal ? 0.24 : 0.18, s0: s, grow: lethal ? 1.4 : 0.9 });
  }

  /* ---- 拳弹（挥拳时从玩家手里打出的光弹）---- */

  /**
   * 打出一发拳弹。
   *
   * 规则层的命中是"出拳当帧即时结算"的（这是跟手的前提），但画面上只有拳头前伸时，
   * 读起来像"隔空打牛"。补一颗真飞出去的光弹，"我打中了"这件事才在画面里成立；
   * 而且它的落点是怪**被击退之后**的位置 —— 视觉上自成一句"子弹把它推走"，
   * 和击退是同一套叙事（这也是用户想要的手感：打拳 → 弹出去 → 怪被崩飞）。
   *
   * 用 Sprite 而不是 Mesh 是有意的：这条弹道恰好顺着摄像机视线往画面深处去，
   * 而 Sprite 天生正对相机 —— 观感正好对上，还省一次网格绘制。
   */
  _spawnShot(ev) {
    if (!World._glowTex) World._glowTex = makeGlowTexture();
    this.shotCount++;
    let s = this._shotPool.pop();
    if (!s) {
      const g = new THREE.Group();
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: World._glowTex, color: new THREE.Color('#ffc243'), transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: World._glowTex, color: new THREE.Color('#fffdf0'), transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      g.add(halo, core);
      g.userData.halo = halo;
      g.userData.core = core;
      this.scene.add(g);
      s = g;
    }
    s.visible = true;

    // 起点取玩家右手（模型里右臂在 local x = +0.46），落点由规则层给
    const sx = laneToX(ev.fromF) + 0.42, sy = 1.32, sz = -0.35;
    const tx = Number.isFinite(ev.x) ? ev.x : laneToX(ev.fromF);

    const u = s.userData;
    u.px = sx; u.py = sy; u.pz = sz;
    u.tx = tx; u.tz = ev.z;
    u.dist = Math.max(2, Math.hypot(tx - sx, ev.z - sz));
    u.speed = 150;                 // m/s —— 快到你来不及怀疑，但看清得到"发射→命中"
    u.t = 0;
    u.hit = !!ev.hit;
    // 命中弹记住目标怪的 id：怪在弹丸飞行的零点几秒里还在逼近，
    // 固定落点（出拳那一刻的位置）会让弹丸从怪身上穿过去继续飞 ——
    // 看起来就是"子弹根本不停"。每帧瞄向怪的实时位置（见 _updateShots），
    // 弹丸才会稳稳停在怪身上。挥空弹没有目标，沿固定弹道飞到窗口尽头消散。
    u.demonId = Number.isFinite(ev.demonId) ? ev.demonId : null;
    // 挥空的弹丸更小更冷色：一眼分得清"这发打中了"和"这发飞空了"
    const k = u.hit ? 1 : 0.68;
    u.baseHalo = 1.05 * k;         // 光晕：比"拳头特效"小一号 —— 是颗弹丸，不是爆炸
    u.baseCore = 0.36 * k;
    u.halo.material.color.set(u.hit ? (ev.lethal ? '#ffd166' : '#ffc243') : '#9fd0ff');
    u.core.material.color.set(u.hit ? '#fffdf0' : '#dff0ff');
    u.halo.scale.set(u.baseHalo, u.baseHalo, 1);
    u.core.scale.set(u.baseCore, u.baseCore, 1);
    s.position.set(sx, sy, sz);
    this.shots.push(s);
  }

  /**
   * 推进拳弹。命中弹每帧瞄向目标怪的**当前位置**（追踪弹）：
   * 出拳是当帧结算，但怪在弹丸飞行的零点几秒里还在迎面逼近，
   * 固定落点会让弹丸从怪身上穿过去飞到身后 —— 用户实测"子弹不会停下来"就是它。
   * 追踪之后弹丸必然追上怪，追上即停在怪身上消散（零点几秒内，肉眼仍是"打中了"）。
   * 目标中途消失（被打死回收 / 主题重建）就退回固定落点飞完 —— 退路要保底。
   * 挥空弹没有目标，飞到窗口尽头自然消散。命中点的火花仍由规则层 demonHit 负责。
   */
  _updateShots(dt, demons) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const u = s.userData;
      u.t += dt;

      // —— 追踪：有活目标就刷新瞄准点 ——
      let tx = u.tx, tz = u.tz;
      if (u.demonId != null && demons && demons.length) {
        const d = demons.find((x) => x.id === u.demonId);
        if (d) {
          tx = d.mesh.position.x; tz = d.z;
          u.tx = tx; u.tz = tz;          // 记下来：目标若中途消失，沿最后瞄的点飞完
        } else {
          u.demonId = null;              // 目标没了（被打死回收）→ 停止追踪
        }
      }

      const dx = tx - s.position.x, dz = tz - s.position.z;
      const dist = Math.max(1e-4, Math.hypot(dx, dz));
      const step = u.speed * dt;
      if (dist <= Math.max(step, 0.9)) {
        // 到达（命中弹贴到怪身上，挥空弹到窗口尽头）：就地消散，不再穿过去
        s.position.set(tx, s.position.y, tz);
        s.visible = false;
        this.shots.splice(i, 1);
        this._shotPool.push(s);
        continue;
      }
      s.position.x += (dx / dist) * step;
      s.position.z += (dz / dist) * step;
      // 出膛瞬间胀一下（枪口闪光），随后收细
      const puff = 1 + 0.9 * Math.max(0, 1 - u.t / 0.09);
      u.halo.scale.set(u.baseHalo * puff, u.baseHalo * puff, 1);
      u.core.scale.set(u.baseCore * puff, u.baseCore * puff, 1);
      // 兜底：追踪弹万一跟着一只永远打不死的怪打转（理论上不会），2 秒强制消散
      if (u.t > 2) {
        s.visible = false;
        this.shots.splice(i, 1);
        this._shotPool.push(s);
      }
    }
  }

  acquire(type) {
    const pool = this.pools[type];
    for (const m of pool) if (!m.visible) { m.visible = true; return m; }
    const m = this._mkObstacleMesh(THEMES[this.themeName], type);
    pool.push(m);
    m.visible = true;
    return m;
  }

  release(mesh) {
    if (!mesh) return;
    // 只回收"属于当前对象池"的网格。
    // 切主题时旧池整体销毁、game 可能还攥着旧引用；
    // 若放行野引用，它会被塞进新池，之后 acquire 拿来渲染一个已 dispose 的网格 → 画面异常。
    if (!mesh.userData.__pool || mesh.userData.__pool !== this.pools) {
      mesh.visible = false;
      return;
    }
    mesh.visible = false;
    mesh.position.set(0, 0, 0);
    // 复位"上一次使用留下的状态"：恶魔被打中的震缩/倾斜、血条被压掉的长度。
    // 不复位的话，从池里再取出来的恶魔会带着上一只的残血条出场。
    mesh.scale.setScalar(1);
    mesh.rotation.set(0, 0, 0);
    const hb = mesh.userData.hpBar;
    if (hb) { hb.fill.scale.x = 1; hb.fill.position.x = 0; hb.fill.material.color.set('#ff4d5e'); }
    const tr = mesh.userData.targetRing;
    if (tr) tr.visible = false;
  }

  /* ---- 粒子 ---- */
  _buildParticles(theme, root) {
    const cfg = theme.particle;
    const n = this.quality < 1 ? Math.round(cfg.count * 0.45) : cfg.count;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 26;
      pos[i * 3 + 1] = Math.random() * 9;
      pos[i * 3 + 2] = -Math.random() * 130;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (cfg.type === 'petal') return this._buildPetalParticles(cfg, pos, seed, n, root);
    // 星海：彩色星点（参考图5 的白/蓝/橙/红混杂）
    let colAttr = null;
    if (cfg.colors) {
      colAttr = new Float32Array(n * 3);
      const pool = cfg.colors.map(c => new THREE.Color(c));
      for (let i = 0; i < n; i++) {
        const c = pool[i % pool.length];
        colAttr[i * 3] = c.r; colAttr[i * 3 + 1] = c.g; colAttr[i * 3 + 2] = c.b;
      }
    }
    // 发光粒子（火星/星点）用加性混合 + 光斑贴图，灰烬用普通混合 + 灰点贴图
    const isEmber = cfg.type === 'ember' || cfg.type === 'spark';
    const isAsh = cfg.type === 'ash';
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(cfg.color),
      size: cfg.size,
      map: isAsh ? makeAshTexture() : (isEmber ? makeGlowTexture() : null),
      transparent: true,
      opacity: isAsh ? 0.75 : 0.85,
      depthWrite: false,
      fog: true,
      vertexColors: !!colAttr,
      blending: (isEmber || isAsh) ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    if (colAttr) geo.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    root.add(pts);
    this.particles = { pts, pos, seed, n, cfg, geo, mat };
    // 地狱：额外加一层飘落的灰烬（与上升火星反向，做出"oppressive atmosphere"）
    if (theme.ash) this._buildAshLayer(theme, root);
  }

  /** 灰烬层：缓慢飘落、随跑道迎面而来的暗色颗粒 */
  _buildAshLayer(theme, root) {
    const cfg = theme.ash;
    const n = this.quality < 1 ? Math.round(cfg.count * 0.45) : cfg.count;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = Math.random() * 12;
      pos[i * 3 + 2] = -Math.random() * 140;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color('#b9aca6'),
      size: cfg.size,
      map: makeAshTexture(),
      transparent: true, opacity: 0.6, depthWrite: false, fog: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    root.add(pts);
    this.ashLayer = { pts, pos, seed, n, cfg, geo, mat };
  }

  _updateAshLayer(dt, move) {
    const A = this.ashLayer;
    if (!A) return;
    const { pos, seed, n, cfg } = A;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      pos[i3 + 2] += move;
      pos[i3 + 1] -= cfg.fall * dt;
      pos[i3] += Math.sin(pos[i3 + 2] * 0.06 + seed[i] * 6.28) * dt * 0.5;
      if (pos[i3 + 2] > 14 || pos[i3 + 1] < -1) {
        pos[i3 + 2] = -Math.random() * 140;
        pos[i3] = (Math.random() - 0.5) * 30;
        pos[i3 + 1] = 9 + Math.random() * 4;
      }
    }
    A.geo.attributes.position.needsUpdate = true;
  }

  _updateParticles(dt, move) {
    const P = this.particles;
    if (!P) return;
    const { pos, seed, n, cfg } = P;
    const fall = cfg.fall;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      // 随跑道一起向 +z 移动，营造迎面而来的感觉
      pos[i3 + 2] += move;
      pos[i3 + 1] -= fall * dt;
      // 横向飘摆
      if (cfg.type === 'petal' || cfg.type === 'ember') {
        pos[i3] += Math.sin(pos[i3 + 2] * 0.08 + seed[i] * 6.28) * dt * 0.6;
      }
      if (pos[i3 + 2] > 14) {
        pos[i3 + 2] -= 140;
        pos[i3] = (Math.random() - 0.5) * 26;
        pos[i3 + 1] = fall > 0 ? 8 + Math.random() * 2 : Math.random() * 2;
      } else if (pos[i3 + 1] < -1 || pos[i3 + 1] > 11) {
        pos[i3 + 1] = fall > 0 ? 8 + Math.random() * 2 : Math.random() * 2;
      }
    }
    P.geo.attributes.position.needsUpdate = true;
    if (P.uTime) P.uTime.value += dt;
  }

  /* ---- 主题专属动态装饰（低于通用粒子的附加层） ---- */
  _updateDecor(dt, move) {
    if (!this.decor) return;
    this.decor.update(dt, move);
  }

  _buildDecor(theme, root) {
    this.decor = null;
    const t = theme.scenery;
    if (t === 'rock') this._buildFlameJets(root);
    else if (t === 'pillar') this._buildNeonDecor(root);
    else if (t === 'crystal') this._buildGalaxyDecor(root);
    else if (t === 'sakura') this._buildSakuraDecor(root);
  }

  /** 樱花：旋转飘飞的花瓣（替换通用方块粒子） */
  _buildPetalParticles(cfg, pos, seed, n, root) {
    const tex = makePetalTexture();
    const aSeed = new Float32Array(n);
    const aSize = new Float32Array(n);
    for (let i = 0; i < n; i++) { aSeed[i] = Math.random(); aSize[i] = cfg.size * (0.55 + Math.random() * 1.0); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    const uTime = { value: 0 };
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime, uTex: { value: tex } },
      vertexShader: PETAL_VERT, fragmentShader: PETAL_FRAG,
      transparent: true, depthWrite: false, fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    root.add(pts);
    this.particles = { pts, pos, seed, n, cfg, geo, mat, uTime };
  }

  /** 地狱：空中间歇喷发的火焰喷射柱 + 闪烁点光源；静谧深渊感用漂浮熔岩碎石替代吵闹的骷髅/铁链 */
  _buildFlameJets(root) {
    const g = new THREE.Group();
    root.add(g);
    const tex = makeGlowTexture();
    const M = 34;
    const defs = [
      { x: -5.2, y: 0.0, z: -28 }, { x: 5.2, y: 0.0, z: -52 },
      { x: -3.6, y: 3.0, z: -74 }, { x: 3.6, y: 3.2, z: -98 },
      { x: -5.0, y: 0.0, z: -88 }, { x: 5.0, y: 0.0, z: -14 },
    ].map(d => ({ ...d, phase: Math.random(), period: 1.0 + Math.random() * 1.6 }));
    const total = defs.length * M;
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const life = new Float32Array(total);
    const vel = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) { life[i] = 0; pos[i * 3 + 1] = -999; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.95, map: tex, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; g.add(pts);

    const lights = [new THREE.PointLight(0xff5a1f, 0, 22), new THREE.PointLight(0xff5a1f, 0, 22)];
    lights[0].position.set(-4, 1.5, -40);
    lights[1].position.set(4, 1.5, -60);
    g.add(lights[0], lights[1]);

    // 漂浮的发光熔岩碎石：缓慢自转 + 上下浮动，营造静谧深渊酷感（替代原骷髅/铁链/电弧）
    const floatRocks = [];
    for (let i = 0; i < 5; i++) {
      const r = 0.3 + Math.random() * 0.5;
      const rock = new THREE.Mesh(
        new THREE.IcosahedronGeometry(r, 1),
        this._mat(THEMES.hell, '#2a1216', { roughness: 0.3, metalness: 0.5, emissive: new THREE.Color('#ff5a1f'), emissiveIntensity: 0.5 })
      );
      rock.position.set((Math.random() - 0.5) * 16, 2 + Math.random() * 8, -20 - Math.random() * 150);
      rock.userData.ph = Math.random() * 6.28;
      rock.userData.by = rock.position.y;
      rock.userData.sp = 0.2 + Math.random() * 0.3;
      g.add(rock); floatRocks.push(rock);
    }

    const st = { v: 0 };
    this.decor = {
      group: g,
      update: (dt, move) => {
        st.v += dt; const t = st.v;
        for (let j = 0; j < defs.length; j++) {
          const d = defs[j];
          d.z += move; if (d.z > 14) d.z -= 192;
          const active = ((t + d.phase * d.period) % d.period) < d.period * 0.5;
          for (let k = 0; k < M; k++) {
            const idx = j * M + k, i3 = idx * 3;
            if (life[idx] <= 0) {
              if (active) {
                life[idx] = 1;
                pos[i3] = d.x + (Math.random() - 0.5) * 0.35;
                pos[i3 + 1] = d.y;
                pos[i3 + 2] = d.z + (Math.random() - 0.5) * 0.5;
                vel[i3] = (Math.random() - 0.5) * 0.8;
                vel[i3 + 1] = 2.4 + Math.random() * 2.0;
                vel[i3 + 2] = (Math.random() - 0.5) * 0.8;
              } else { pos[i3 + 1] = -999; col[i3] = col[i3 + 1] = col[i3 + 2] = 0; continue; }
            }
            life[idx] -= dt * 0.85;
            if (life[idx] <= 0) { pos[i3 + 1] = -999; continue; }
            pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
            vel[i3 + 1] *= 0.98;
            const l = life[idx];
            col[i3] = 1.0; col[i3 + 1] = Math.min(1, l * 1.15); col[i3 + 2] = Math.max(0, (l - 0.82) * 5.0);
          }
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        const flick = 4 + Math.sin(t * 11) * 2 + Math.random() * 2;
        lights[0].intensity = flick; lights[1].intensity = flick * 0.9;
        for (const r of floatRocks) {
          r.position.z += move * 0.6;
          if (r.position.z > 14) r.position.z -= 180;
          r.position.y = r.userData.by + Math.sin(t * 0.6 + r.userData.ph) * 0.5;
          r.rotation.y += dt * r.userData.sp;
          r.rotation.x += dt * r.userData.sp * 0.6;
        }
      },
    };
  }

  /** 赛博霓虹：空中横向流光车轨 + 闪烁全息广告牌 */
  _buildNeonDecor(root) {
    const g = new THREE.Group();
    root.add(g);
    const tex = makeTrailTexture();
    const trails = [];
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(7 + Math.random() * 4, 0.16),
        new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(i % 2 ? '#2de2ff' : '#7b5cff'), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })
      );
      m.position.set((Math.random() - 0.5) * 20, 6 + Math.random() * 9, -18 - Math.random() * 95);
      m.rotation.y = (Math.random() - 0.5) * 0.5; m.frustumCulled = false;
      g.add(m);
      trails.push({ m, sp: (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 7) });
    }
    const btex = makeBillboardTexture();
    const boards = [];
    for (const sx of [-5.4, 5.4]) {
      const b = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 3.4),
        new THREE.MeshBasicMaterial({ map: btex, color: new THREE.Color('#2de2ff'), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })
      );
      b.position.set(sx, 5.5 + Math.random() * 3, -28 - Math.random() * 60);
      b.frustumCulled = false; g.add(b);
      boards.push({ b, ph: Math.random() * 6 });
    }
    /* ── 参考图4 补充：地面橙色车流光轨（沿跑道方向飞驰） ── */
    const roadTex = makeTrailTexture();
    const cars = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.55, 6 + Math.random() * 5),
        new THREE.MeshBasicMaterial({
          map: roadTex, color: new THREE.Color(i % 3 === 2 ? '#ff5a2a' : '#ffb14a'),
          transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
          depthWrite: false, fog: false, side: THREE.DoubleSide,
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = Math.PI / 2; // 长边沿 z 方向
      m.position.set((i % 2 ? 1 : -1) * (5.4 + Math.random() * 4.5), 0.06, -10 - Math.random() * 110);
      m.frustumCulled = false; g.add(m);
      cars.push({ m, sp: 26 + Math.random() * 22 });
    }
    this.decor = {
      group: g,
      update: (dt, move) => {
        for (const t of trails) {
          t.m.position.x += t.sp * dt;
          if (t.m.position.x > 22) t.m.position.x = -22;
          if (t.m.position.x < -22) t.m.position.x = 22;
        }
        for (const bd of boards) { bd.ph += dt; bd.b.material.opacity = 0.45 + 0.4 * Math.abs(Math.sin(bd.ph * 2.3)); }
        // 车流光轨：迎面飞驰 + 随跑道滚动循环
        for (const c of cars) {
          c.m.position.z += c.sp * dt + move;
          if (c.m.position.z > 14) {
            c.m.position.z -= 125;
            c.m.position.x = (Math.random() < 0.5 ? -1 : 1) * (5.4 + Math.random() * 4.5);
          }
        }
      },
    };
  }

  /** 星海：流星划过 + 缓慢旋转的星云 */
  _buildGalaxyDecor(root) {
    const g = new THREE.Group();
    root.add(g);
    const neb = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 90),
      new THREE.MeshBasicMaterial({ map: makeNebulaTexture(), transparent: true, opacity: 0.45, depthWrite: false, fog: false, side: THREE.DoubleSide })
    );
    neb.position.set(0, 28, -120); neb.frustumCulled = false; g.add(neb);
    /* 参考图5：地平线橙色辉光带 */
    const hz = new THREE.Mesh(
      new THREE.PlaneGeometry(190, 34),
      new THREE.MeshBasicMaterial({ map: makeHorizonTexture(), transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide })
    );
    hz.position.set(0, 6, -158); hz.frustumCulled = false; g.add(hz);
    const mtex = makeTrailTexture();
    const meteors = [];
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(7, 0.14),
        new THREE.MeshBasicMaterial({ map: mtex, color: new THREE.Color('#ffffff'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })
      );
      m.visible = false; m.frustumCulled = false; g.add(m);
      meteors.push({ m, t: Math.random() * 4, dur: 0, dx: 0, dy: 0 });
    }
    this.decor = {
      group: g,
      update: (dt) => {
        neb.rotation.z += dt * 0.015;
        neb.material.opacity = 0.38 + 0.1 * Math.sin(performance.now() * 0.0003);
        for (const me of meteors) {
          me.t -= dt;
          if (me.m.visible) {
            me.dur -= dt;
            me.m.position.x += me.dx * dt; me.m.position.y += me.dy * dt;
            me.m.material.opacity = Math.max(0, me.dur / 0.7);
            if (me.dur <= 0) me.m.visible = false;
          } else if (me.t <= 0) {
            me.m.position.set((Math.random() - 0.5) * 50, 30 + Math.random() * 6, -90 - Math.random() * 25);
            const sp = 20 + Math.random() * 14;
            me.dx = (Math.random() - 0.5) * sp * 0.7; me.dy = -sp * 0.5;
            me.m.rotation.z = Math.atan2(me.dy, me.dx);
            me.m.visible = true; me.dur = 0.7; me.m.material.opacity = 1;
            me.t = 2.5 + Math.random() * 4;
          }
        }
      },
    };
  }

  /** 樱花：两侧鸟居剪影（呼应图片里的鸟居与日式街景） */
  _buildSakuraDecor(root) {
    const g = new THREE.Group();
    root.add(g);
    const torii = [];
    // 鸟居立在 x=±5.4，也是"路两边的道具"，跟随 SCENERY_ON 一起下掉（白云是天空氛围，保留）
    if (SCENERY_ON) {
      for (let i = 0; i < 4; i++) {
        const t = makeTorii(this, THEMES.sakura);
        t.position.set(i % 2 ? 5.4 : -5.4, 0, -22 - i * 28);
        g.add(t); torii.push(t);
      }
    }
    /* 参考图1/2：蓝天上的大块白云（缓慢横移） */
    const ctex = makeCloudTexture();
    const clouds = [];
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ctex, transparent: true, opacity: 0.9, depthWrite: false, fog: false }));
      const sc = 22 + Math.random() * 16;
      sp.scale.set(sc, sc * 0.5, 1);
      sp.position.set((Math.random() - 0.5) * 80, 22 + Math.random() * 10, -70 - Math.random() * 80);
      sp.userData.sp = 0.4 + Math.random() * 0.5;
      g.add(sp); clouds.push(sp);
    }
    this.decor = {
      group: g,
      update: (dt, move) => {
        for (const t of torii) {
          t.position.z += move;
          if (t.position.z > 14) t.position.z -= 130;
        }
        for (const c of clouds) {
          c.position.x += c.userData.sp * dt;
          if (c.position.x > 55) c.position.x = -55;
        }
      },
    };
  }

  hitFlash() { this.shakeT = 0.35; }

  /**
   * @param {number} dt 帧间隔秒
   * @param {object} st { laneF, jumpY, duck, speed }
   *        laneF 是玩家连续横向位置，直接决定画面里小人的 x —— 不再本地插值，
   *        否则又会出现"画的和判的不是同一个位置"。
   */
  update(dt, st) {
    const laneF = typeof st.laneF === 'number' ? st.laneF : st.lane;

    // 摄像机
    const targetX = laneToX(laneF) * 0.35;
    // 跟随系数 6 → 9：原来时间常数 ~167ms，摄像机会明显"追不上"人，
    // 画面上表现为变道拖泥带水，和识别延迟叠加在一起就更钝了。
    this.camera.position.x += (targetX - this.camera.position.x) * Math.min(1, dt * 9);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      this.camera.position.y = 3.4 + Math.sin(this.shakeT * 60) * 0.12;
    } else {
      this.camera.position.y += (3.4 - this.camera.position.y) * Math.min(1, dt * 9);
    }
    this.camera.lookAt(this.camera.position.x * 0.4, 1.5, -12);

    const move = st.speed * dt;
    const segLen = TRACK_LEN / TILE_COUNT;

    // 跑道滚动
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      t.position.z += move;
      if (t.position.z > 12) t.position.z -= TRACK_LEN;
    }
    // 景物滚动
    const now = performance.now() * 0.001;
    this._updateStatues(move);
    for (let i = 0; i < this.scenery.length; i++) {
      const s = this.scenery[i];
      s.position.z += move;
      if (s.position.z > 12) {
        s.position.z -= TRACK_LEN * 1.6;
        s.position.x = Math.sign(s.position.x) * (5.6 + Math.random() * 2.5);
      }
      // 星海：悬浮碎石缓动；霓虹：竖牌闪烁；地狱/星海：水晶与星轨环自转浮动
      if (s.userData.bobMesh) {
        s.userData.bobMesh.position.y = s.userData.bobMesh.userData.baseY + Math.sin(now * 1.3 + s.userData.bobPhase) * 0.35;
        s.userData.bobMesh.rotation.y += 0.4 * dt;
      }
      if (s.userData.crystals) {
        for (const cr of s.userData.crystals) {
          cr.rotation.y += cr.userData.spin * dt;
          cr.rotation.x += cr.userData.spin * 0.6 * dt;
          cr.position.y = cr.userData.bobBase + Math.sin(now * 0.8 + cr.userData.bobPh) * 0.3;
        }
      }
      if (s.userData.rings) {
        for (const r of s.userData.rings) r.rotation.z += r.userData.rs * dt;
      }
      if (s.userData.blinkMesh) {
        s.userData.blinkMesh.material.opacity = 0.45 + 0.4 * Math.abs(Math.sin(now * 2.1 + i));
      }
      // 地狱：柱身符文与岩浆池的"熔岩呼吸"脉动
      if (s.userData.runes) {
        const k = 0.6 + 0.4 * Math.abs(Math.sin(now * 1.4 + i * 0.7));
        for (const r of s.userData.runes) r.material.opacity = k;
      }
      if (s.userData.pool) {
        s.userData.pool.material.opacity = 0.72 + 0.22 * Math.abs(Math.sin(now * 0.9 + i));
      }
      // 通用发光脉动：樱花灯笼 / 地狱熔岩纹共用一套（每项自带节奏与相位）
      if (s.userData.pulseMats) {
        for (const pm of s.userData.pulseMats) {
          pm.mat.emissiveIntensity = pm.base + pm.amp * Math.abs(Math.sin(now * pm.rate + pm.ph));
        }
      }
    }
    this._updateParticles(dt, move);
    this._updateAshLayer(dt, move);
    this._updateDecor(dt, move);
    this._updateShots(dt, st.demons);

    // 拳弹：规则层每次出拳都会报一个自增 id，同一个事件每帧都会跟着 st 传进来，
    // 所以按 id 去重 —— 只有 id 变了才是"新的一发"，否则连打时会一帧发一串。
    if (st.shot && st.shot.id !== this._shotSeen) {
      this._shotSeen = st.shot.id;
      this._spawnShot(st.shot);
    }

    // 玩家：横向位置完全由 laneF 决定，和碰撞判定读的是同一个数
    this.player.position.x = laneToX(laneF);
    this.player.position.y = st.jumpY;

    // 立牌在场时禁用整组压扁 —— 2D 平面被 y 轴压扁就是"纸片"（用户实测差评），
    // 蹲下改由换蹲姿立绘表达；压扁动画只属于胶囊兜底。
    const paperProof = this._playerStandee && this._playerStandee.visible;
    if (st.duck && !paperProof && !this._player3DOn) {
      this.player.scale.set(1.15, 0.55, 1.15);
      this.player.rotation.x = 0.25;
    } else {
      this.player.scale.set(1, 1, 1);
      this.player.rotation.x = 0;
    }

    this.runPhase += dt * (6 + st.speed * 0.55);
    const sw = Math.sin(this.runPhase);
    if (st.jumpY > 0.05) {
      this.pArmL.rotation.x = -1.4; this.pArmR.rotation.x = -1.4;
      this.pLegL.rotation.x = 0.6; this.pLegR.rotation.x = -0.3;
    } else if (st.duck) {
      this.pArmL.rotation.x = -0.8; this.pArmR.rotation.x = -0.8;
      this.pLegL.rotation.x = -0.5; this.pLegR.rotation.x = -0.5;
    } else {
      this.pArmL.rotation.x = sw * 1.1;
      this.pArmR.rotation.x = -sw * 1.1;
      this.pLegL.rotation.x = -sw * 0.9;
      this.pLegR.rotation.x = sw * 0.9;
    }

    // 状态光环
    const mat = this.aura.material;
    const oc = THEMES[this.themeName].obstacle;
    if (st.jumpY > 0.05) { mat.color.set(oc.hurdle.color); mat.opacity = 0.75; }
    else if (st.duck) { mat.color.set(oc.overhead.color); mat.opacity = 0.75; }
    else { mat.opacity += (0 - mat.opacity) * Math.min(1, dt * 8); }

    // 挥拳：双臂一起向前捅出去再收回（0.26s 一个来回）。
    // 覆盖在常规跑动摆臂之上 —— 出拳瞬间拳头必须"看得见地"打出去。
    if (typeof st.punchT === 'number' && st.punchT >= 0) {
      const k = Math.sin(Math.min(1, st.punchT / 0.26) * Math.PI);
      this.pArmL.rotation.x = -1.45 * k;
      this.pArmR.rotation.x = -1.45 * k;
    }

    // 鲸鱼娘立牌：按状态换姿态图（跑/蹲/跳），2D 角色演"活"全靠换图 + 小动作。
    // 换图时按新图宽高比微调 scale.x（跑姿几何为基准），高度恒定。
    if (paperProof) {
      const sp = this._playerStandee;
      const poses = this._playerPoses;
      const name = st.duck ? 'duck' : (st.jumpY > 0.05 ? 'jump' : 'run');
      const pose = poses[name] || poses.run;
      if (pose && this._playerPoseName !== name) {
        this._playerPoseName = name;
        sp.material.map = pose.tex;
        sp.material.needsUpdate = true;
      }
      // 蹲下必须真的"降下去"：立牌等比缩到 DUCK_S 并保持脚底贴地 ——
      // 只换蹲姿图不动高度的话，头还是和横杆障碍齐高（用户实测差评）。
      // 等比缩放（x、y 同步）不会像纯 y 压扁那样把图变纸片；dt 平滑过渡不跳变。
      const DUCK_S = 0.58;
      const target = st.duck ? DUCK_S : 1;
      if (this._playerCrouchS === undefined) this._playerCrouchS = 1;
      this._playerCrouchS += (target - this._playerCrouchS) * Math.min(1, dt * 16);
      const s = this._playerCrouchS;
      sp.scale.set((pose.aspect / (poses.run ? poses.run.aspect : pose.aspect)) * s, s, 1);
      const pH = sp.geometry.parameters.height;
      sp.position.y = (pH * s) / 2 - 0.02;
      sp.rotation.z = st.jumpY > 0.05 || st.duck ? 0 : sw * 0.055;
      sp.rotation.x = (typeof st.punchT === 'number' && st.punchT >= 0)
        ? -0.14 * Math.sin(Math.min(1, st.punchT / 0.26) * Math.PI)
        : 0;
    }

    // 真 3D 鲸鱼娘：按状态换模型（跑/蹲/跳），跑动 bob + 倾摆，出拳前倾。
    // 蹲下=换蹲模型 + 等比缩到 0.72（蹲模型因尾鳍竖起天然身高仍接近跑姿，
    // 不缩的话还是会"和横杆齐高"，用户实测差评过）。
    if (this._player3DOn && this._player3DObjs) {
      const objs = this._player3DObjs;
      const key = st.duck ? 'duck' : (st.jumpY > 0.05 ? 'jump' : 'run');
      for (const k in objs) objs[k].visible = k === key;
      const m = objs[key] || objs.run;
      const DUCK_S3 = 0.72;
      const target = st.duck ? DUCK_S3 : 1;
      if (this._playerCrouchS === undefined) this._playerCrouchS = 1;
      this._playerCrouchS += (target - this._playerCrouchS) * Math.min(1, dt * 16);
      const cs = this._playerCrouchS;
      m.scale.setScalar(cs);
      m.position.y = (key === 'run' && !st.duck) ? Math.abs(sw) * 0.05 : 0;
      m.rotation.z = (key === 'run' && !st.duck) ? sw * 0.05 : 0;
      m.rotation.x = (typeof st.punchT === 'number' && st.punchT >= 0)
        ? -0.16 * Math.sin(Math.min(1, st.punchT / 0.26) * Math.PI)
        : 0;
    }

    // 小恶魔待机动画：上下浮动 + 扑扇翅膀 + 受伤震缩 + 血条（z 的推进由规则层负责，
    // 这里只管"活着的感觉"和"还要几拳"）
    if (st.demons && st.demons.length) {
      const camQ = this.camera.quaternion;
      for (const d of st.demons) {
        const m = d.mesh;
        if (!m || !m.userData || m.userData.bobPhase === undefined) continue;
        const bob = Math.sin(now * 2.1 + m.userData.bobPhase) * 0.12;
        m.position.y = bob;
        const ws = m.userData.wings;
        if (ws) {
          for (let wi = 0; wi < ws.length; wi++) {
            ws[wi].rotation.z = (wi ? -1 : 1) * (0.5 + Math.sin(now * 13 + m.userData.bobPhase) * 0.45);
          }
        }
        // 挨拳的瞬间缩一下再弹回 —— 打击感全靠这 0.22 秒
        const hit = d.hitT > 0 ? d.hitT / 0.22 : 0;
        // 击退后仰（knockT）：怪被推远的同时往后倒一下。
        // 只让位置变化是不够的 —— z 是在一帧里退掉好几米的，眼睛只会读成"闪了一下"；
        // 补上仰角，才读得出"我把它打飞了"（这是打击手感的一半）。
        const knock = d.knockT > 0 ? d.knockT / 0.25 : 0;
        m.scale.setScalar(1 - 0.16 * hit);
        m.rotation.z = Math.sin(hit * 26) * 0.18 * hit;
        m.rotation.x = -0.5 * knock;

        // "可以打"指示环：进了挥拳范围就亮起来脉动，出手时机一眼可见
        const tr = m.userData.targetRing;
        if (tr) {
          const on = !!d.hittable;
          tr.visible = on;
          if (on) {
            tr.material.opacity = 0.5 + 0.45 * Math.abs(Math.sin(now * 7));
            const sc = 1 + 0.14 * Math.sin(now * 8);
            tr.scale.set(sc, sc, 1);
          }
        }

        const hb = m.userData.hpBar;
        if (hb) {
          const hp = typeof d.hp === 'number' ? d.hp : 1;
          const max = d.maxHp || 1;
          const r = Math.max(0, Math.min(1, hp / max));
          // 左对齐收缩：血少了就从右边咬掉一截，而不是整条居中变短
          hb.fill.scale.x = Math.max(0.001, r);
          hb.fill.position.x = -(hb.w * (1 - r)) / 2;
          // 满血偏青绿 → 残血偏红，扫一眼就知道还差几拳
          hb.fill.material.color.setHSL(0.02 + 0.30 * r, 0.82, 0.5 + 0.06 * hit);
          // 公告板：血条永远正对相机（恶魔本体不转，所以直接抄相机朝向即可）
          hb.group.quaternion.copy(camQ);
          hb.group.scale.setScalar(1 + 0.22 * hit);
        }
      }
    }

    // 打击特效推进：环扩散淡出 / 闪光缩小淡出，走完即回收
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      const k = f.t / f.life;
      if (k >= 1) {
        this.scene.remove(f.mesh);
        disposeTree(f.mesh);
        this.fx.splice(i, 1);
        continue;
      }
      f.mesh.material.opacity = 0.95 * (1 - k);
      f.mesh.scale.setScalar((f.s0 || 1) + k * (f.grow || 2));
    }

    // 天幕跟随相机横向平移（球心永远罩着玩家，看不到边界）
    if (this.sky) this.sky.position.set(this.camera.position.x, 0, 0);
    // 天幕轮换的交叉淡入
    if (this.backdrop) this.backdrop.update(dt);

    this.renderer.render(this.scene, this.camera);
  }

  /** 按帧率动态调整画质，优先保证不卡顿 */
  setQuality(q) {
    if (this.quality === q) return;
    this.quality = q;
    const pr = q < 1 ? 1 : Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    // 景物/粒子数量随画质重建
    const name = this.themeName;
    const root = this.themeRoot;
    if (root) {
      for (const s of this.scenery) { root.remove(s); disposeTree(s); }
      this.scenery = [];
      if (this.particles) { root.remove(this.particles.pts); disposeTree(this.particles.pts); this.particles = null; }
      if (this.ashLayer) { root.remove(this.ashLayer.pts); disposeTree(this.ashLayer.pts); this.ashLayer = null; }
      if (this.decor && this.decor.group) { root.remove(this.decor.group); disposeTree(this.decor.group); this.decor = null; }
      this._buildScenery(THEMES[name], root);
      this._buildParticles(THEMES[name], root);
      this._buildDecor(THEMES[name], root);
    }
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

/** 鸟居：圆润立柱(Lathe) + 微拱横梁，告别方块感 */
function makeTorii(world, theme) {
  const g = new THREE.Group();
  const mat = world._mat(theme, '#c0392b', { roughness: 0.5, metalness: 0.2 });
  const pillarProfile = [
    new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.2, 0.0),
    new THREE.Vector2(0.22, 0.3), new THREE.Vector2(0.18, 4.2), new THREE.Vector2(0.16, 4.4),
  ];
  const pillarGeo = new THREE.LatheGeometry(pillarProfile, 12);
  const pL = new THREE.Mesh(pillarGeo, mat); pL.position.set(-1.3, 0, 0);
  const pR = new THREE.Mesh(pillarGeo, mat); pR.position.set(1.3, 0, 0);
  const top = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 3.4, 6, 12), mat);
  top.rotation.z = Math.PI / 2; top.position.set(0, 4.35, 0);
  const top2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 2.9, 6, 12), mat);
  top2.rotation.z = Math.PI / 2; top2.position.set(0, 3.85, 0);
  g.add(pL, pR, top, top2);
  g.traverse(o => { o.frustumCulled = false; });
  return g;
}

/** 释放一棵子树的几何体与材质，防止切主题时显存泄漏 */
/**
 * 雕像一律是博物馆扫描件：朝向、单位都不统一（这份是 Z 轴朝上的），
 * 所以不能按固定数值摆，要先按包围盒"扶正"：
 *   ① 把跨度最大的那根轴转成竖直（Y）；② 按目标高度缩放；③ X/Z 居中、底面贴地。
 * 返回戴上件后的实际宽度，供调用方确认不会侵占跑道。
 */
function normalizeStatue(obj, targetH) {
  obj.updateMatrixWorld(true);
  const b0 = new THREE.Box3().setFromObject(obj);
  const s0 = b0.getSize(new THREE.Vector3());
  const axis = [['x', s0.x], ['y', s0.y], ['z', s0.z]].sort((a, c) => c[1] - a[1])[0][0];
  if (axis === 'z') obj.rotation.x = -Math.PI / 2;
  else if (axis === 'x') obj.rotation.z = Math.PI / 2;

  obj.updateMatrixWorld(true);
  const b1 = new THREE.Box3().setFromObject(obj);
  const s1 = b1.getSize(new THREE.Vector3());
  const k = s1.y > 1e-6 ? targetH / s1.y : 1;
  obj.scale.setScalar(k);

  obj.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(obj);
  const c = b2.getCenter(new THREE.Vector3());
  obj.position.set(-c.x, -b2.min.y, -c.z);
  return b2.getSize(new THREE.Vector3()).x;
}

/** 炼狱化：石材原色偏灰黄，压暗成焦岩色并给一层内红外照亮脸 */
function tintStatue(obj, tint, glow, glowColor) {
  obj.traverse((o) => {
    const m = o.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mat of list) {
      if (mat.color) mat.color.multiply(new THREE.Color(tint));
      if (mat.isMeshStandardMaterial) {
        mat.emissive = new THREE.Color(glowColor);
        mat.emissiveIntensity = glow;
        mat.roughness = Math.min(1, (mat.roughness ?? 0.8) + 0.12);
      }
      // 共享几何体：clone 出来的每一尊都复用这一份，别让 disposeTree 误杀
      if (o.geometry) o.geometry.userData.__shared = true;
    }
  });
}

function disposeTree(obj) {
  obj.traverse((o) => {
    // 带 __keep 标记的子树整体跳过。
    // 天幕（SkyBackdrop）用它把"共享几何体 + 全局缓存贴图"保护起来：
    // 那些资源由 SkyBackdrop 自己管，disposeTree 一旦碰了就会波及后续主题。
    if (o.userData && o.userData.__keep) return;
    // 共享几何体（几何体缓存）不能销毁 —— 它还被其它主题/其它网格引用着。
    // Sprite 用的也是 three 内部共享的几何体，dispose 会波及全场景所有精灵。
    if (o.geometry && !o.isSprite && !(o.geometry.userData && o.geometry.userData.__shared)) o.geometry.dispose();
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m.dispose();
  });
}
