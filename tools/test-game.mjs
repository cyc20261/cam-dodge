/**
 * test-game.mjs —— 游戏规则层回归测试（纯 Node，无需浏览器）
 *
 * 用法： node tools/test-game.mjs
 *
 * 原理：game.js 只从 scene.js 里取一个车道坐标常量，
 * 这里把那行 import 替换成本地常量后直接 import，就能脱离浏览器跑规则验证。
 *
 * 覆盖：
 *   1. 三类障碍 × 正确/错误操作 的判定是否准确
 *   2. 小恶魔：血条（多拳才倒）/ 撞击不秒杀 / 车道互斥（不会被墙挡在身后）
 *   3. 两个难度模式的参数确实不同、切模式能正确重开
 *   4. "完美 AI" 长跑：普通模式必须能跑满 10 分钟且一次都没被撞（关卡公平性）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(tmpdir(), 'cam-dodge-test');
await mkdir(TMP, { recursive: true });

const src = await readFile(join(ROOT, 'js', 'game.js'), 'utf8')
  .then((s) => s.replace(/import\s*\{\s*LANE_X\s*\}\s*from\s*'\.\/scene\.js';/, 'const LANE_X = [-2.4, 0, 2.4];'));
const modPath = join(TMP, `game-${Date.now()}.mjs`);
await writeFile(modPath, src, 'utf8');

const { Game, MODES } = await import(pathToFileURL(modPath).href);

// ui.js 里的血量换算（红心 → 金心）也一起测。
// 它虽然是 UI 层的东西，但换算是纯函数，而"每 9 点血一颗金心"本身就是一条规则，
// 后面 HUD 的显示全靠它 —— 同样用"把 import 换掉再加载"的老办法（见文件开头说明）。
// 换掉的两个 import 只被类方法用到（构造函数不执行，所以顶层是干净的）。
const uiSrc = (await readFile(join(ROOT, 'js', 'ui.js'), 'utf8'))
  .replace(/import\s*\{[^}]*\}\s*from\s*'\.\/scene\.js';/, 'const THEMES = {}, THEME_KEYS = [];')
  .replace(/import\s*\{[^}]*\}\s*from\s*'\.\/game\.js';/, 'const MODES = {}, MODE_KEYS = [];');
const uiPath = join(TMP, `ui-${Date.now()}.mjs`);
await writeFile(uiPath, uiSrc, 'utf8');

const { heartMarkup, GOLD_HEART } = await import(pathToFileURL(uiPath).href);

const L = MODES.normal.lives;   // 普通模式命数（不写死，改了参数也不用改测试）

const stubWorld = () => ({
  acquire: () => ({ position: { x: 0, y: 0, z: 0, set() {} }, visible: true, userData: {} }),
  release: () => {},
  update: () => {},
  hitFlash: () => {},
  demonKill: () => {},
  demonHit: () => {},
});

const newGame = (mode = 'normal') => {
  const g = new Game(stubWorld(), {});
  g.setMode(mode, true);
  g.reset(); g.start();
  return g;
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
};
const step = (g, seconds, onFrame) => {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) { if (onFrame) onFrame(g, i); g.update(dt); }
};

console.log('\n--- 单障碍判定 ---');
{
  let g = newGame(); g.obstacles = []; g._addObstacle('hurdle', 1, -30);
  step(g, 4);
  check('低栏·不跳 → 撞', g.lives === L - 1, `lives=${g.lives}/${L}`);

  g = newGame(); g.obstacles = []; g._addObstacle('hurdle', 1, -30);
  step(g, 4, (gg) => { const o = gg.obstacles[0]; if (o && !o.scored && -o.z < gg.speed * 0.30) gg.jump(); });
  check('低栏·起跳 → 过', g.lives === L && g.cleared === 1, `lives=${g.lives} cleared=${g.cleared}`);
}
{
  let g = newGame(); g.obstacles = []; g._addObstacle('overhead', 1, -30);
  step(g, 4);
  check('高杆·不蹲 → 撞', g.lives === L - 1, `lives=${g.lives}/${L}`);

  g = newGame(); g.obstacles = []; g._addObstacle('overhead', 1, -30);
  step(g, 4, (gg) => { const o = gg.obstacles[0]; gg.setDuck(!!(o && !o.scored && -o.z < gg.speed * 0.25)); });
  check('高杆·下蹲 → 过', g.lives === L && g.cleared === 1, `lives=${g.lives} cleared=${g.cleared}`);

  g = newGame(); g.obstacles = []; g._addObstacle('overhead', 1, -30);
  step(g, 4, (gg) => { const o = gg.obstacles[0]; if (o && !o.scored && -o.z < gg.speed * 0.30) gg.jump(); });
  check('高杆·起跳 → 仍撞（判定符合直觉）', g.lives === L - 1, `lives=${g.lives}`);
}
{
  let g = newGame(); g.obstacles = []; g._addObstacle('block', 1, -30);
  step(g, 4);
  check('实墙·不变道 → 撞', g.lives === L - 1, `lives=${g.lives}`);

  g = newGame(); g.obstacles = []; g._addObstacle('block', 1, -30);
  step(g, 4, (gg) => gg.setLane(0));
  check('实墙·变道 → 过', g.lives === L && g.cleared === 1, `lives=${g.lives} cleared=${g.cleared}`);

  g = newGame(); g.obstacles = []; g._addObstacle('block', 1, -30);
  step(g, 4, (gg) => { const o = gg.obstacles[0]; if (o && !o.scored && -o.z < gg.speed * 0.30) gg.jump(); });
  check('实墙·起跳 → 仍撞（跳不过墙）', g.lives === L - 1, `lives=${g.lives}`);
}

console.log('\n--- 小恶魔：血条 / 多拳 / 碰撞 / 跳跃 ---');
{
  // 不处理 → 迎面撞上，但只掉 1 血（"玩家不要轻易被怪打死"）
  let g = newGame(); g.demons = []; g._addDemon(1, -30);
  check('恶魔出生即满血', g.demons[0].hp === MODES.normal.demonHp && g.demons[0].maxHp === MODES.normal.demonHp,
    `hp=${g.demons[0].hp}/${g.demons[0].maxHp}`);
  step(g, 4);
  check('恶魔·不理它 → 只掉 1 血', g.lives === L - 1, `lives=${g.lives}/${L}`);
  check('恶魔·撞到不会直接结束', g.state === 'running', `state=${g.state}`);
  check('恶魔撞击的无敌时间明显长于撞墙', MODES.normal.demonInvincible > MODES.normal.invincible,
    `${MODES.normal.demonInvincible}s vs ${MODES.normal.invincible}s`);

  // 进窗连打 → 血条逐格掉，最后一拳才倒
  g = newGame(); g.demons = []; g._addDemon(1, -30);
  const hpLog = [];
  step(g, 4, (gg) => {
    const d = gg.demons[0];
    if (!d) return;
    if (Math.abs(gg.laneF - d.lane) > 0.6 || d.z < -22 || d.z > 2) return;
    const before = d.hp;
    gg.punch();
    const after = gg.demons[0];
    if (after && after.hp !== before) hpLog.push(after.hp);
    else if (!after) hpLog.push(0);
  });
  check('血条是逐格掉的（不是一拳秒）', hpLog.join('>') === '2>1>0', `hp 轨迹=${hpLog.join('>')}`);
  check('恶魔·进窗连打几拳 → 击倒', g.kills === 1 && g.demons.length === 0 && g.lives === L,
    `kills=${g.kills} lives=${g.lives}`);
  check('击倒计入连击并加分', g.score > 0, `score=${g.score}`);

  // 太远就出拳 → 挥空（恶魔还在窗外），之后没补刀 → 被撞。
  // 用 punchWindow 反推"窗外"的位置，窗口参数改了这个用例也不会失效。
  const far = -(MODES.normal.punchWindow + 5);
  g = newGame(); g.demons = []; g._addDemon(1, far);
  const whiff = g.punch();
  check('恶魔·窗外出拳 → 挥空不误伤', whiff === false && g.demons[0].hp === MODES.normal.demonHp,
    `z=${far} hit=${whiff} kills=${g.kills}`);

  // 一拳只打掉一只一格血：两只叠在窗口里，且优先打最近的那只
  g = newGame(); g.demons = []; g._addDemon(1, -3); g._addDemon(1, -3.5);
  g.punch();
  const totalHp = g.demons.reduce((s, d) => s + d.hp, 0);
  check('一拳只打掉一处血（不溅射）', totalHp === MODES.normal.demonHp * 2 - 1 && g.demons.length === 2,
    `totalHp=${totalHp} left=${g.demons.length}`);
  check('优先打最近的那只恶魔', g.demons[0].hp === MODES.normal.demonHp - 1 && g.demons[1].hp === MODES.normal.demonHp,
    `近=${g.demons[0].hp} 远=${g.demons[1].hp}`);

  // 连续两只恶魔撞上来 → 长无敌吃掉第二只，绝不连掉两血
  g = newGame(); g.demons = [];
  g._addDemon(1, -4); g._addDemon(1, -7);
  step(g, 3);
  check('连撞两只恶魔也只掉 1 血', g.lives === L - 1, `lives=${g.lives}`);

  // 隔壁道的恶魔经过 → 无伤
  g = newGame(); g.demons = []; g._addDemon(0, -30);
  step(g, 4);
  check('恶魔·隔壁道经过 → 无伤', g.lives === L, `lives=${g.lives}`);

  // 跳得够高 → 从恶魔头上跃过
  g = newGame(); g.demons = []; g._addDemon(1, -30);
  step(g, 4, (gg) => { const d = gg.demons[0]; if (d && !d.scored && -d.z < gg.speed * 0.32) gg.jump(); });
  check('恶魔·跳得够高 → 跃过不撞', g.lives === L, `lives=${g.lives}`);

  // —— 挥拳命中的宽容度（实机"打不到怪"的主要成因就在这几条）——
  // ① 站在两条道之间：拳头有长度，够得着邻道的怪
  g = newGame(); g.obstacles = []; g.demons = [];
  g.laneF = 1.5; g.laneTarget = 1.5;
  g._addDemon(2, -0.5);
  check('站在两道之间也能打中邻道的恶魔', g.punch() === true && g.demons[0].hp === MODES.normal.demonHp - 1,
    `hp=${g.demons[0].hp}`);

  // ② 打击窗口最远端也要够得着（窗口太紧 → 玩家觉得"明明够近却打空"）
  g = newGame(); g.obstacles = []; g.demons = [];
  g._addDemon(1, -(MODES.normal.punchWindow - 1));
  check('在打击窗口最远端也能命中', g.punch() === true, `z=${-(MODES.normal.punchWindow - 1)}`);

  // ③ 恶魔刚越过身后一点点仍可追击
  g = newGame(); g.obstacles = []; g.demons = [];
  g._addDemon(1, MODES.normal.punchReach - 0.2);
  check('恶魔刚越到身后仍可追击命中', g.punch() === true, `z=${(MODES.normal.punchReach - 0.2).toFixed(1)}`);

  // ④ "可打"标记：渲染层的目标环 / HUD 的"挥拳！"提示都读它
  g = newGame('normal'); g.obstacles = []; g.demons = [];
  g._addDemon(1, -5);
  g.update(1 / 60);
  const marked = g.demons[0].hittable === true;
  check('进入挥拳范围的恶魔被标记"可打"（高亮/提示的依据）', marked === true, `hittable=${marked}`);
  g.demons[0].z = -100; g.update(1 / 60);
  check('太远的恶魔不标记"可打"', g.demons[0].hittable === false, `hittable=${g.demons[0].hittable}`);
  check('demonInRange 汇总与逐只标记一致', g.demonInRange === g.demons.some((d) => d.hittable));
}

console.log('\n--- 恶魔不会被墙挡在身后（车道互斥）---');
{
  // 同时开一局跑 180 秒，逐帧检查"同一条道上的恶魔与障碍"的 z 间距。
  // 两者的推进速度完全一致，所以出生时的间距就是全程的间距 ——
  // 只要出生时被互斥规则隔开了，它们就永远不会贴到一起（也就不存在"怪物卡在墙里"）。
  const g = newGame('hard');
  const dt = 1 / 60;
  let minSep = Infinity, worst = '', pairSeen = 0;
  for (let i = 0; i < Math.round(180 / dt); i++) {
    g.update(dt);
    for (const d of g.demons) {
      for (const o of g.obstacles) {
        if (o.lane !== d.lane) continue;
        const sep = Math.abs(o.z - d.z);
        pairSeen++;
        if (sep < minSep) {
          minSep = sep;
          worst = `${o.type} z=${o.z.toFixed(1)} vs 恶魔 z=${d.z.toFixed(1)} (道 ${o.lane})`;
        }
      }
    }
    // 撞了就复活，让这一局能一直跑下去（这里测的是生成器，不是操作）
    if (g.state !== 'running') { g.lives = 3; g.state = 'running'; }
  }
  console.log(`  同车道共观测 ${pairSeen} 次配对，最小间距 ${minSep.toFixed(1)} 单位`);
  check('确实出现过同车道的怪与墙（用例有效）', pairSeen > 0, '一次都没配对到，这条测试没意义');
  check('同车道的恶魔与障碍始终保持安全间距', minSep > 20, `min=${minSep.toFixed(1)} ← ${worst}`);
}

console.log('\n--- 难度模式 ---');
{
  const n = newGame('normal'), h = newGame('hard');
  check('普通 5 条命 / 困难 3 条命', n.lives === 5 && h.lives === 3, `${n.lives} / ${h.lives}`);
  check('普通模式速度上限更低', n.modeConf.speedMax < h.modeConf.speedMax, `${n.modeConf.speedMax} vs ${h.modeConf.speedMax}`);
  check('普通模式提速更平缓', n.modeConf.speedRamp < h.modeConf.speedRamp, `${n.modeConf.speedRamp} vs ${h.modeConf.speedRamp}`);
  check('普通模式障碍间距更宽', n.modeConf.gapMin > h.modeConf.gapMin, `${n.modeConf.gapMin} vs ${h.modeConf.gapMin}`);
  check('普通模式恶魔更脆（打的拳数更少）', n.modeConf.demonHp < h.modeConf.demonHp, `${n.modeConf.demonHp} vs ${h.modeConf.demonHp}`);
  check('普通模式撞后无敌更久', n.modeConf.invincible > h.modeConf.invincible, `${n.modeConf.invincible} vs ${h.modeConf.invincible}`);

  const g = newGame('hard'); g.demons = []; g._addDemon(1, -30);
  check('困难模式恶魔 4 拳才倒', g.demons[0].maxHp === 4, `maxHp=${g.demons[0].maxHp}`);

  const g2 = newGame('normal');
  step(g2, 6);
  check('切换难度会按新模式重开（距离归零、场上清空）',
    g2.setMode('hard') === true && g2.mode === 'hard' && g2.lives === 3 && g2.distance === 0 && g2.obstacles.length === 0,
    `mode=${g2.mode} lives=${g2.lives} dist=${g2.distance} obs=${g2.obstacles.length}`);
  check('重复设置同一难度是空操作', g2.setMode('hard') === false);
  check('未知难度被忽略', g2.setMode('nightmare') === false && g2.mode === 'hard');
}

console.log('\n--- 等级系统：按跑动距离升级 + 回血（等级与血量都不设上限）----------');
{
  const C = MODES.normal;
  const g = newGame('normal');
  check('开局 Lv.1', g.level === 1, `level=${g.level}`);
  check('开局血量上限 = 模式命数', g.livesMax === C.lives, `livesMax=${g.livesMax}`);

  // 绕开障碍，直接推距离到"刚好跨过第一级门槛"，只看等级结算
  g.obstacles = []; g.demons = [];
  g.lives = 1;                        // 先扣成残血，验证升级顺带回血
  g.distance = C.levelUpDist + 1;
  g.update(1 / 60);
  check('跨过门槛后等级 +1', g.level === 2, `level=${g.level} dist=${Math.floor(g.distance)}`);
  check('升级后血量上限 +1', g.livesMax === C.lives + 1, `livesMax=${g.livesMax}`);
  check('升级后残血被补回一血', g.lives === 2, `lives=${g.lives}/${g.livesMax}`);
  check('升级次数被记录', g.levelsGained === 1, `levelsGained=${g.levelsGained}`);

  // 一帧跨很多级：逐级补算不能丢级，而且**没有封顶**。
  // （旧实现封顶 30 级 / 9 点血，跑得再久也不再变强；现在跑到多远就长多强）
  const targetLv = 181;
  g.distance = C.levelUpDist * (targetLv - 1) + 1;
  g.update(1 / 60);
  check('一帧跨近 180 级也逐级补算（不丢级）', g.levelsGained === targetLv - 1,
    `levelsGained=${g.levelsGained}/${targetLv - 1}`);
  check('等级不设上限', g.level === targetLv, `level=${g.level}/${targetLv}`);
  check('血量上限不封顶', g.livesMax === C.lives + (targetLv - 1), `livesMax=${g.livesMax}`);
  check('血量上限能越过 9（HUD 才会开始出现金色心）', g.livesMax > GOLD_HEART, `livesMax=${g.livesMax}`);
  check('回血不会超过上限', g.lives <= g.livesMax, `${g.lives}/${g.livesMax}`);

  // 换难度后等级 / 血量全部重置
  const g2 = newGame('hard');
  check('换难度后等级与血量上限重置',
    g2.level === 1 && g2.livesMax === MODES.hard.lives && g2.levelsGained === 0,
    `level=${g2.level} livesMax=${g2.livesMax}`);
}

console.log('\n--- 血量显示：每 9 点血折 1 颗金色心 ----------');
{
  // heartMarkup 产的是 HTML，这里只数它的 class 组合（不跑 DOM）
  const parts = (html) => [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
  const goldOn = (html) => parts(html).filter((c) => c.includes('gold') && c.includes('on')).length;
  const redOn = (html) => parts(html).filter((c) => c.includes('on') && !c.includes('gold')).length;
  const redOff = (html) => parts(html).filter((c) => c.includes('off') && !c.includes('gold')).length;

  const h5 = heartMarkup(5, 5);
  check('开局 5 血 = 5 颗红心（还够不上金心）',
    parts(h5).length === 5 && goldOn(h5) === 0 && redOn(h5) === 5, h5);
  const h9 = heartMarkup(9, 9);
  check('正好 9 血 = 1 颗金心（9 颗红心熔成一颗）',
    parts(h9).length === 1 && goldOn(h9) === 1, h9);
  const h13 = heartMarkup(13, 13);
  check('13 血 = 1 金心 + 4 红心',
    goldOn(h13) === 1 && redOn(h13) === 4 && parts(h13).length === 5, h13);
  const h10 = heartMarkup(10, 13);   // 上限 13 = 1 金 + 4 红；当前 10 = 1 金满 + 1 红
  check('10/13 血：金心亮着，红心亮 1 颗、空 3 颗',
    goldOn(h10) === 1 && redOn(h10) === 1 && redOff(h10) === 3 && parts(h10).length === 5, h10);
  const h0 = heartMarkup(0, 9);
  check('血掉光时金心变成空位（不是消失）',
    parts(h0).length === 1 && goldOn(h0) === 0, h0);
  // 金心多到一屏放不下时退回"N/M"计数（见 heartMarkup 的说明）
  const h63 = heartMarkup(63, 63);
  check('金心超过 6 颗改用计数（不再逐颗画）',
    h63.includes('xcount') && !h63.includes('gold'), h63);
}

console.log('\n--- 击退：命中把恶魔推远（"还没打死就撞上"的正面解法）----------');
{
  const C = MODES.normal;

  // ① 命中就把怪沿来路推远
  const g = newGame('normal');
  g.obstacles = []; g.demons = [];
  g._addDemon(1, -8);
  const z0 = g.demons[0].z, hp0 = g.demons[0].hp;
  g.punch();
  const d = g.demons[0];
  check('一拳打掉一格血', d.hp === hp0 - 1, `hp=${d.hp}`);
  check('命中后恶魔被沿来路推远', d.z < z0 - 1, `z ${z0.toFixed(1)} → ${d.z.toFixed(1)}`);
  check('击退同步到渲染用的 mesh 位置', d.mesh.position.z === d.z, `mesh.z=${d.mesh.position.z}`);
  check('击退后下一拳仍够得着（不会推出窗口）', g._inPunchRange(d) === true, `z=${d.z.toFixed(1)}`);

  // ② 怪已贴着窗口远端时，击退不能把它推出可打范围
  //   —— 那会让玩家以为"后面几拳全空了"，比被打死更让人困惑
  const g2 = newGame('normal');
  g2.obstacles = []; g2.demons = [];
  g2._addDemon(1, -(C.punchWindow - 1));
  g2.punch();
  const d2 = g2.demons[0];
  check('贴窗口远端时击退不会把怪推出窗口',
    d2.hp < C.demonHp && g2._inPunchRange(d2) === true, `z=${d2.z.toFixed(1)} hp=${d2.hp}`);

  // ③ 越残血推得越远（最后一拳最需要喘口气）
  const g3 = newGame('normal');
  g3.obstacles = []; g3.demons = [];
  g3._addDemon(1, -12);
  g3.punch();
  const zA = g3.demons[0].z;
  g3.demons[0].z = -12; g3.demons[0].mesh.position.z = -12;   // 摆回同一位置再打
  g3.punchCd = 0;                                             // 清掉冷却，立刻再出拳
  g3.punch();
  const zB = g3.demons[0].z;
  check('越残血被推得越远', (-12 - zB) > (-12 - zA) + 0.5,
    `第一拳推到 ${zA.toFixed(1)}，第二拳推到 ${zB.toFixed(1)}`);

  // ④ 击退只会让怪远离，不会回头触发"擦身而过"的撞击结算
  const g4 = newGame('normal');
  g4.obstacles = []; g4.demons = [];
  g4._addDemon(1, -10);
  g4.punch();
  check('击退方向正确（远离玩家），不会重复触发撞击',
    g4.demons[0].z < -10 && g4.demons[0].scored === false, `z=${g4.demons[0].z.toFixed(1)}`);

  // ⑤ 量化"打不完 → 打得完"：从窗口远端开始连着出拳，能不能在贴脸前收掉。
  //    判据是"怪被打死时，玩家实际只推进了多远" —— 击退会把这段距离明显压下来。
  const step = 1 / 60;
  const g5 = newGame('normal');
  g5.obstacles = []; g5.demons = [];
  g5._addDemon(1, -(C.punchWindow - 10));
  let punches = 0;
  const d0 = g5.distance;
  for (let i = 0; i < 600 && g5.demons.length; i++) {   // 最多模拟 10 秒
    if (g5.punch()) punches++;
    g5.update(step);
  }
  const advanced = g5.distance - d0;
  check('从窗口远端开始连打出拳 → 能打死，且不必贴脸',
    g5.demons.length === 0 && punches >= C.demonHp,
    `用了 ${punches} 拳，玩家只推进了 ${advanced.toFixed(1)} 米`);
  check('击退把"要推进的距离"压到远小于窗口长度',
    advanced < C.punchWindow * 0.6,
    `实际推进 ${advanced.toFixed(1)} 米（窗口 ${C.punchWindow} 米）`);
}

console.log('\n--- 拳弹事件：出拳要"看得见"（渲染层据此从玩家手里打出光弹）----------');
{
  const C = MODES.normal;

  // ① 命中：事件要带 id / 落点 / hit 标记，且落点必须是"击退之后"的位置 ——
  //    这是"子弹把怪推走"这条叙事的硬契约，落点错了就变成"子弹追着怪跑"。
  const g = newGame('normal');
  g.obstacles = []; g.demons = [];
  g._addDemon(1, -10);
  const id0 = g.shotId;
  g.punch();
  const d = g.demons[0], s1 = g.lastShot;
  check('出拳会产生一个发射事件（id 自增）', !!s1 && s1.id === id0 + 1, `shotId ${id0} → ${g.shotId}`);
  check('落点 = 恶魔被击退之后的位置（不是打之前的位置）',
    !!s1 && s1.hit === true && Math.abs(s1.z - d.z) < 1e-9 && Math.abs(s1.x - d.mesh.position.x) < 1e-9,
    s1 ? `shot.z=${s1.z.toFixed(1)} demon.z=${d.z.toFixed(1)}` : '-');
  check('落点确实比出拳前更远（把击退量带上了）', !!s1 && s1.z < -10, s1 ? `z=${s1.z.toFixed(1)}` : '-');
  check('非致命的一拳 lethal=false', !!s1 && s1.lethal === false);
  check('事件带上出发车道（渲染层据此定位玩家右手）', !!s1 && Math.abs(s1.fromF - g.laneF) < 1e-9);
  check('事件指认目标怪（渲染层的弹丸靠它追踪活目标、停在怪身上）',
    !!s1 && Number.isFinite(s1.demonId) && s1.demonId === d.id,
    s1 ? `shot.demonId=${s1.demonId} demon.id=${d.id}` : '-');

  // ①b 追踪契约：发射事件里的 demonId 必须能在场上 demons 里找到同 id 的怪 ——
  //    渲染层 _updateShots 每帧靠它瞄准怪的实时位置。id 断链弹丸就只能飞固定落点，
  //    会从还在逼近的怪身上穿过去（实测"子弹不停下来"的根因）。
  const g1b = newGame('normal');
  g1b.obstacles = []; g1b.demons = [];
  g1b._addDemon(1, -10); g1b._addDemon(2, -14);
  g1b.punch();
  const ids = g1b.demons.map((x) => x.id);
  check('每只怪都有稳定且互不相同的 id', ids.length === 2 && ids[0] !== ids[1] && Number.isFinite(ids[0]),
    `ids=${ids.join(',')}`);
  check('事件里的 demonId 能在场上找到目标怪',
    !!g1b.lastShot && g1b.demons.some((x) => x.id === g1b.lastShot.demonId),
    `demonId=${g1b.lastShot && g1b.lastShot.demonId} 场上=[${ids.join(',')}]`);

  // ② 击杀那拳带 lethal 标记 —— 渲染层换更亮的弹色，"收掉没有"隔着屏幕也看得出
  const g2 = newGame('normal');
  g2.obstacles = []; g2.demons = [];
  g2._addDemon(1, -10);
  let last = null;
  for (let i = 0; i < C.demonHp; i++) { g2.punchCd = 0; g2.punch(); last = g2.lastShot; }
  check('打死它的那一拳 lethal=true', !!last && last.lethal === true && g2.demons.length === 0,
    last ? `lethal=${last.lethal} 剩 ${g2.demons.length} 只` : '-');

  // ③ 挥空也要发弹（落点取窗口最远端）——
  //    "这一拳出去了只是没够到"，比什么都不发生清楚得多（否则像识别失灵）
  const g3 = newGame('normal');
  g3.obstacles = []; g3.demons = [];
  g3._addDemon(1, -(C.punchWindow + 20));
  const idBefore = g3.shotId;
  const hit = g3.punch();
  check('窗外出拳不命中，但照样产生发射事件', hit === false && g3.shotId === idBefore + 1,
    `hit=${hit} shotId=${g3.shotId}`);
  check('挥空的落点落在打击窗口最远端', !!g3.lastShot && g3.lastShot.hit === false
    && Math.abs(g3.lastShot.z + C.punchWindow) < 1e-9, `z=${g3.lastShot && g3.lastShot.z}`);
  check('挥空弹不指认目标（飞固定弹道到窗口尽头消散）',
    !!g3.lastShot && !Number.isFinite(g3.lastShot.demonId),
    `demonId=${g3.lastShot && g3.lastShot.demonId}`);

  // ④ 冷却期内的重复出拳不许重复发弹（连点会一帧窜出一串光弹）
  const g4 = newGame('normal');
  g4.obstacles = []; g4.demons = [];
  g4._addDemon(1, -10);
  g4.punch();
  const idA = g4.shotId;
  g4.punch();
  check('冷却期内的重复出拳不产生第二个发射事件', g4.shotId === idA, `shotId=${g4.shotId}`);
}

/* ---------- 完美 AI：用来验证关卡生成器的公平性 ---------- */

// 确定性伪随机（mulberry32）。
// 为什么必须有：game.js 用 Math.random 生成障碍类型/车道/间距，
// 而 Math.random 未播种 —— 每次运行的地图布局都不一样，"零受击"这类
// 长跑断言就会偶发飘红（实测同 AI 跑两次结果都不同）。
// 固定种子后长跑可复现：断言真正有意义，也不会在 CI 里随机失败。
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在固定种子下跑一段逻辑：保证长跑用例可复现（见 mulberry32 的说明）。
 *  用 try/finally 保证异常时也把 Math.random 还原，不给后续用例埋雷。 */
function withSeededRandom(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = real; }
}

function perfectRun(mode, seconds, seed = 20260929) {
  return withSeededRandom(seed, () => runPerfect(mode, seconds));
}

function runPerfect(mode, seconds) {
  const g = newGame(mode);
  const C = g.modeConf;
  let hits = 0;
  const origHit = g._takeHit.bind(g);
  g._takeHit = (o) => { hits++; origHit(o); };

  const dt = 1 / 60;
  const TYPES = ['block', 'hurdle', 'overhead'];
  let stalled = 0;

  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const v = g.speed;
    const nearest = (l, types) => {
      let m = Infinity;
      for (const o of g.obstacles) {
        if (o.scored || o.lane !== l || o.z > 3) continue;
        if (!types.includes(o.type)) continue;
        m = Math.min(m, -o.z);
      }
      return m;
    };
    // 进入某条道所需的最小提前量：低栏要起跳，实墙要能再变道，高杆可瞬时下蹲
    const need = (t) => (t === 'hurdle' ? v * 0.32 : t === 'block' ? v * 0.15 : 0);

    // 1) 本道实墙逼近才换道。选道分两层（这套分层是实测调出来的）：
    //    第一层 = 障碍来得及处理 且 本道没有"马上要撞上来"的恶魔；
    //    只有第一层全灭时才退而求其次（宁可留着恶魔，也别选择必然撞墙的道）。
    //    为什么恶魔要和障碍同级：之前只按"障碍越远越好"打分，AI 会在最后一刻
    //    切进"障碍更远但 0.1s 内就有恶魔"的车道 → 必被撞。真人不会这么走。
    if (nearest(g.lane, ['block']) < v * 1.5) {
      const obsOk = (l) => TYPES.every((t) => nearest(l, [t]) >= need(t));
      const demonOk = (l) => !g.demons.some((d) => !d.scored && d.lane === l && d.z < 0 && -d.z / v < 0.7);
      const hard = [0, 1, 2].filter((l) => obsOk(l) && demonOk(l));
      const soft = [0, 1, 2].filter(demonOk);
      const pool = hard.length ? hard : (soft.length ? soft : [g.lane]);
      let best = pool[0], bestScore = -Infinity;
      for (const l of pool) {
        // 障碍越远越好；同分时略微倾向"待在原道"（少变道 = 少失误）
        const score = Math.min(nearest(l, TYPES), 300) + (l === g.lane ? 40 : 0);
        if (score > bestScore) { bestScore = score; best = l; }
      }
      g.setLane(best);
    }

    // 2) 按当前道最近的障碍决定跳 / 蹲
    let imm = null;
    for (const o of g.obstacles) {
      if (o.scored || o.lane !== g.lane || o.z > 0) continue;
      if (!imm || -o.z < -imm.z) imm = o;
    }
    if (imm && imm.type === 'hurdle' && -imm.z / v < 0.30) g.jump();
    g.setDuck(!!g.obstacles.find(
      (o) => !o.scored && o.lane === g.lane && o.type === 'overhead' && o.z < 0 && -o.z < v * 0.28
    ));

    // 3) 本车道有恶魔进打击窗口 → 出拳（窗口与冷却都由规则层限频，这里逐帧喊就行）
    const dmn = g.demons.find((d) =>
      Math.abs(g.laneF - d.lane) <= 0.45 && d.z > -C.punchWindow && d.z < C.punchReach);
    if (dmn) g.punch();

    // 3b) 恶魔已经逼到眼前、血条来不及打光（例如刚被迫切进这条道）→ 直接跳过去。
    //     这是游戏本来就给玩家的"第二解法"（跳越高度 > 恶魔站立高度 1.05）。
    //     起跳时机必须落在"脚底高于恶魔"的整段上升期里：起跳后约 0.16~0.55s
    //     脚底都在 1.05 之上 —— 所以剩余距离对应的时间窗取 (0.16s, 0.55s)。
    //     之前只写"< 0.30s"起跳太晚，实测跳起来才 0.7 高，反而被判撞。
    const dnClose = g.demons.find((d) => {
      if (d.scored || d.z >= 0) return false;
      // 玩家可能正在变道，所以"目标车道"上的怪也算数（否则切过去才发现躲不掉）
      const inLane = Math.abs(g.laneF - d.lane) <= 0.45 || Math.abs(g.laneTarget - d.lane) <= 0.45;
      if (!inLane) return false;
      const t = -d.z / v;
      return t > 0.16 && t < 0.55;
    });
    if (dnClose) g.jump();

    g.update(dt);
    if (g.state !== 'running') { stalled = i; break; }
  }
  return { g, hits, stalled, summary: g.summary };
}

console.log('\n--- 完美 AI 长跑 120s（普通）：关卡生成器公平性 ---');
{
  const { g, hits, summary: s, stalled } = perfectRun('normal', 120, 20260929);
  console.log(`  距离 ${s.distance}m · 躲过 ${s.cleared} 个 · 击倒 ${s.demons} 只 · 分数 ${s.score} · 受击 ${hits} 次`);
  check('完美操作下不应被撞（不存在必死局）', hits === 0, `hits=${hits}`);
  check('中途没有因掉血而中断', stalled === 0, `中断于第 ${stalled} 帧`);
  check('分数随奔跑正常累积', s.score > 1000, `score=${s.score}`);
  check('难度等级随时间提升', s.diffLevel >= 2, `diffLevel=${s.diffLevel}`);
}

console.log('\n--- 完美 AI 长跑 600s（普通）：保证能运动 10 分钟 ----------');
{
  const { g, hits, summary: s, stalled } = perfectRun('normal', 600, 987654321);
  console.log(`  10 分钟：距离 ${s.distance}m · 躲过 ${s.cleared} 个 · 击倒 ${s.demons} 只 · 分数 ${s.score} · 受击 ${hits} 次`);
  check('普通模式能连续跑满 10 分钟（中途不结束）', stalled === 0, `中断于第 ${stalled} 帧`);
  check('普通模式 10 分钟内零受击（难度确实收敛）', hits === 0, `hits=${hits}`);
  check('10 分钟跑出足够距离（>12000m）', s.distance > 12000, `距离=${s.distance}m`);
  check('10 分钟里恶魔有被反复击倒（血条玩法在真跑）', s.demons > 20, `击倒=${s.demons}`);
  check('满血通关（命数一颗没掉）', g.lives >= MODES.normal.lives, `lives=${g.lives}/${g.livesMax}`);
  check('等级系统在真跑里生效（升级把血量上限抬高了）',
    g.livesMax > MODES.normal.lives && s.levelsGained > 0,
    `livesMax=${g.livesMax} 升级${s.levelsGained}次 Lv.${s.level}`);
  check('难度到顶后不再增长（这是能一直玩下去的关键）',
    MODES.normal.maxLevel * MODES.normal.levelDist < s.distance, `封顶距离=${MODES.normal.maxLevel * MODES.normal.levelDist}m`);
}

console.log('\n--- 公平性抽检：换 3 张随机地图，完美 AI 依旧零受击 ----------');
{
  // 单张地图零受击可能只是运气好；换几张不同布局再验一次。
  // 种子固定 → 结果可复现，不会随机飘红。
  const seeds = [131071, 262142, 393213];
  const runs = seeds.map((s) => perfectRun('normal', 240, s));
  const bad = runs.filter((r) => r.hits > 0).length;
  console.log(`  三张地图：${runs.map((r) => `${r.hits}次受击/${r.summary.distance}m`).join('  ')}`);
  check('3 张不同布局的 240s 长跑全部零受击（不靠单张地图的运气）', bad === 0, `有受击的布局数=${bad}`);
}

console.log('\n--- 硬难度对照：困难模式 60s（要明显更难）----------');
{
  const { summary: h } = perfectRun('hard', 60, 4242);
  const { summary: n } = perfectRun('normal', 60, 4242);
  console.log(`  困难 60s：距离 ${h.distance}m · 障碍 ${h.cleared} 个 ｜ 普通 60s：距离 ${n.distance}m · 障碍 ${n.cleared} 个`);
  check('困难模式同期速度更快', h.distance > n.distance, `${h.distance} vs ${n.distance}`);
}

console.log('\n--- 视觉一致性：判定用的位置必须等于画面上的位置 ---');
{
  // 玩家在中间道，障碍在左道；在障碍"即将跨过玩家"的那一帧才下令变道。
  // 此刻画面上的人几乎还没挪动，只要离障碍所在道还超过 laneTol，就绝不该判撞 ——
  // 这正是"看着根本没碰到，却提示撞到"的成因。
  //
  // 注意这个用例不能依赖"变道插值多慢"：laneLerp 是可调参数（14→28 提过速），
  // 绑死帧数会让用例随调参误报。这里只跑"越线的那一帧"，并显式断言
  // "此刻确实还没挪进那条道"，判据仍然是不变量本身。
  const TOL = 0.45;   // = 规则层的 laneTol
  const g = newGame(); g.obstacles = []; g._addObstacle('block', 0, -0.05);
  step(g, 1 / 60, (gg) => gg.setLane(0));
  check('变道尚未到位时不算撞', g.lives === L, `lives=${g.lives} laneF=${g.laneF.toFixed(3)}`);
  check('（用例前提）此刻确实还没挪进障碍道', Math.abs(g.laneF - 0) > TOL,
    `laneF=${g.laneF.toFixed(3)} tol=${TOL}`);

  // 反向对照：真的站过去了，判定必须照常生效（不能修过头变成打不死）
  const g2 = newGame(); g2.obstacles = []; g2._addObstacle('block', 0, -30);
  step(g2, 3, (gg) => gg.setLane(0));
  check('已经站进障碍道则正常判撞', g2.lives === L - 1, `lives=${g2.lives} laneF=${g2.laneF.toFixed(3)}`);

  // 模拟真人的提前量：提前约 0.4 秒变道，到位后应判撞
  const g3 = newGame(); g3.obstacles = []; g3._addObstacle('block', 0, -8);
  step(g3, 1.2, (gg) => { const o = gg.obstacles[0]; if (o && -o.z < 6) gg.setLane(0); });
  check('提前量足够时变道完成、判定生效', g3.lives === L - 1, `lives=${g3.lives} laneF=${g3.laneF.toFixed(3)}`);

  // 待在原道不动，隔壁道的障碍永远不该伤到
  const g4 = newGame(); g4.obstacles = [];
  g4._addObstacle('block', 0, -30); g4._addObstacle('block', 2, -30);
  step(g4, 4);
  check('隔壁车道的障碍不会误伤', g4.lives === L && g4.cleared === 2, `lives=${g4.lives} cleared=${g4.cleared}`);
}

console.log('\n--- 重开局 / 换地图：障碍网格不许残留在场景里 ---');
{
  const live = new Set();
  let acquired = 0, released = 0;
  const world = {
    acquire: () => { acquired++; const m = { position: { x: 0, y: 0, z: 0, set() {} }, userData: {} }; live.add(m); return m; },
    release: (m) => { if (m && live.delete(m)) released++; },
    update: () => {}, hitFlash: () => {}, demonKill: () => {}, demonHit: () => {},
  };

  const g = new Game(world, {});
  g.reset(); g.start();
  // 恶魔进窗就打（顺便验证恶魔网格也参与回收配平）
  step(g, 30, (gg) => {
    const d = gg.demons.find((x) => Math.abs(gg.laneF - x.lane) <= 0.6 && x.z > -22 && x.z < 2);
    if (d) gg.punch();
  });
  const beforeReset = live.size;
  g.reset();

  console.log(`  跑 30s 后在场 ${beforeReset} 个，重开后回收 ${released}/${acquired}`);
  check('确实生成过障碍（用例有效）', beforeReset > 0, '一个都没生成，这条测试没意义');
  check('重开局后场上无残留', live.size === 0, `残留 ${live.size} 个`);
  check('生成与回收数量配平', released === acquired, `${released} vs ${acquired}`);

  // 注意：reset() 会让状态停在 'ready'，必须先 start() 步进才会推进 ——
  // 少了这一句，下面两条"无残留"断言会变成对着空场跑，永远是绿的（假绿）。
  g.start();
  step(g, 20);
  const liveBefore = live.size;
  g.clearObstacles();
  console.log(`  清障碍前在场 ${liveBefore} 个 → 清后 ${live.size} 个`);
  check('清障碍前场上确实有东西（上一条断言不是假绿）', liveBefore > 0, '空场跑，断言无效');
  check('切换地图后场上无残留', live.size === 0, `残留 ${live.size} 个`);

  // clearDemons：只收怪、留下障碍（测试注入后收场，以及"清怪不打断跑图"都靠它）
  // 怪是"跑够一段距离才刷一只"，不是常驻的 —— 所以必须盯着步进过程中的某一刻调，
  // 等步进结束再调，大概率那一刻场上正好没怪（这条用例第一次跑就是那样假绿的）。
  const st = { demonBefore: 0, obsBefore: 0, demonAfter: -1, obsAfter: -1, live: -1, next: -1 };
  step(g, 30, () => {
    if (st.demonBefore > 0 || g.demons.length === 0) return;   // 抓到第一只就收手
    st.demonBefore = g.demons.length;
    st.obsBefore = g.obstacles.length;
    g.clearDemons();
    st.demonAfter = g.demons.length;
    st.obsAfter = g.obstacles.length;
    st.live = live.size;
    st.next = g.nextDemon;
  });
  console.log(`  清怪前：障碍 ${st.obsBefore} 个 / 恶魔 ${st.demonBefore} 只 `
    + `→ 清怪后：障碍 ${st.obsAfter} 个 / 恶魔 ${st.demonAfter} 只`);
  check('clearDemons 只清恶魔（用例有效：当时确实有怪）', st.demonBefore > 0, '30s 里一只怪都没刷出来');
  check('clearDemons 后场上无恶魔', st.demonAfter === 0, `还剩 ${st.demonAfter} 只`);
  check('clearDemons 不动障碍（跑图不被打断）', st.obsAfter === st.obsBefore,
    `${st.obsBefore} → ${st.obsAfter}`);
  check('clearDemons 把怪的网格全归还了（无泄漏）', st.live === st.obsBefore,
    `在场网格 ${st.live} = 障碍数 ${st.obsBefore}`);
  check('clearDemons 会推迟下一只怪（不在眼前凭空刷）', st.next >= g.modeConf.demonFirstGap * 0.5,
    `nextDemon=${st.next === -1 ? 'n/a' : st.next.toFixed(1)}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
