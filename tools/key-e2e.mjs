/**
 * key-e2e.mjs —— 真实按键链路的端到端验证
 *   M 换图 / B 换背景 / 空格暂停 / F 挥拳（恶魔血条）/ 难度切换
 *
 * 为什么要专门测按键：
 * 前面几处改动（多背景轮换、暂停键、挥拳、难度模式）全都挂在 window 的
 * keydown 处理与页面指令通道上。静态检查只能证明"函数存在"，
 * 证明不了"按下去真的生效、且不再出现换图后障碍物渲染异常"。
 *
 * 做法：无头浏览器加载 ?autocam=1 页面 → 等它进入 running →
 * 用 page 注入的 window.__key() 依次按键 → 每次按键后读状态比对。
 * 状态通过 POST /__probe 落盘，所以每一步都能被这个脚本观测到。
 *
 * 用法： node tools/key-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8199);
const NODE = process.execPath;
const PROBE = join(ROOT, 'tools', '.probe-key.json');
/* 这个文件是脚本与页面之间的"指令队列"：脚本写进去，页面读它执行。
   为什么不走 CDP evaluate：本机 DevTools WebSocket 握手不稳（详见
   headless-check.mjs 的说明）。文件队列虽然土，但零竞态。 */
const CMD = join(ROOT, 'tools', '.keycmd.txt');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = BROWSERS.find(existsSync);
if (!chrome) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
rmSync(PROBE, { force: true });
rmSync(CMD, { force: true });

const srv = spawn(NODE, [join(ROOT, 'server.js'), String(PORT)], {
  cwd: ROOT, env: { ...process.env, PROBE_FILE: PROBE, KEY_CMD_FILE: CMD }, stdio: ['ignore', 'ignore', 'ignore'],
});
let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) { up = true; break; } } catch {}
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(2); }

const profile = join(tmpdir(), 'cam-dodge-key-' + Date.now());
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--user-data-dir=' + profile,
  `http://127.0.0.1:${PORT}/?autocam=1&keydrive=1`,
], { stdio: ['ignore', 'ignore', 'ignore'] });

/** 读当前状态快照 */
function snap() {
  try {
    const o = JSON.parse(readFileSync(PROBE, 'utf8'));
    return o && o.phase ? o : null;
  } catch { return null; }
}

/** 等状态满足条件（页面状态是持续覆盖写的，需要等它变） */
async function waitFor(pred, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = snap();
    if (s && pred(s)) return s;
    await sleep(350);
  }
  return null;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
};

/** 让页面按一次键：写指令文件，等状态真的变化 */
async function press(key, expectChange, ms = 6000) {
  const before = snap();
  writeFileSync(CMD, JSON.stringify({ key, id: Date.now() }));
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(250);
    const s = snap();
    if (s && (!expectChange || expectChange(s, before))) return s;
  }
  return snap();
}

let exitCode = 1;
try {
  console.log('等待页面进入可交互阶段（键盘兜底模式）…');
  const run = await waitFor((s) => s.phase === 'running' && s.input === 'keyboard', 30000);
  if (!run) {
    console.log('  没等到 running 阶段，最终状态：' + JSON.stringify(snap()));
    throw new Error('页面未进入 running');
  }
  console.log(`  已进入 running · 主题=${run.theme} 背景=${run.bg + 1}/${run.bgTotal}\n`);

  console.log('--- 1. M 键换地图（含换图后障碍物应继续正常滚动）---');
  const t0 = snap();
  const t1 = await press('m', (s, b) => b && s.theme !== b.theme);
  check('按 M 切到了另一个主题', !!t1 && t1.theme !== t0.theme, `${t0.theme} → ${t1 && t1.theme}`);

  // 换图后多跑几秒，确认障碍物还能正常生成/滚动（原来这里会渲染异常）
  await sleep(4000);
  const t1b = snap();
  check('换图 4s 后仍在 running 且无脚本错误', !!t1b && t1b.phase === 'running' && t1b.errs.length === 0,
    t1b ? `phase=${t1b.phase} 障碍=${t1b.obstacles} 距离=${t1b.dist} errs=${t1b.errs.length}` : 'no state');
  check('换图后障碍物在生成（数量 > 0 或距离在涨）', !!t1b && (t1b.obstacles > 0 || t1b.dist > t0.dist),
    t1b ? `障碍=${t1b.obstacles} 距离=${t1b.dist}` : '-');
  check('换图后背景索引已重置到该主题第 1 张', !!t1b && t1b.bg === 0, t1b ? `bg=${t1b.bg + 1}/${t1b.bgTotal}` : '-');

  console.log('\n--- 2. 连续按 M 轮完全部主题（每次都要还能跑）---');
  let themeLog = [t1b && t1b.theme];
  for (let i = 0; i < 4; i++) {
    const b = snap();
    const s = await press('m', (x, y) => y && x.theme !== y.theme);
    themeLog.push(s && s.theme);
    await sleep(900);
  }
  const t2 = snap();
  check('连续换 4 次主题未崩', !!t2 && t2.phase === 'running' && t2.errs.length === 0,
    `主题轨迹=${themeLog.join('→')} errs=${t2 ? t2.errs.length : '?'}`);

  console.log('\n--- 3. B 键换背景 ---');
  const b0 = snap();
  const b1 = await press('b', (s, b) => b && s.bg !== b.bg);
  check('按 B 切到了同主题内另一张背景', !!b1 && b1.bg !== b0.bg,
    b1 ? `${b0.bg + 1}/${b0.bgTotal}(${b0.bgLabel}) → ${b1.bg + 1}/${b1.bgTotal}(${b1.bgLabel})` : '-');
  check('换背景没有切换主题', !!b1 && b1.theme === b0.theme, b1 ? `theme 仍是 ${b1.theme}` : '-');

  // 把当前主题的背景轮满一圈，确认回绕正确、且期间游戏继续
  let ring = [snap()];
  for (let i = 0; i < b0.bgTotal; i++) {
    const s = await press('b', (x, y) => y && x.bg !== y.bg, 4000);
    if (s) ring.push(s);
  }
  const idxs = ring.map((s) => s && s.bg);
  const uniq = new Set(idxs).size;
  check('轮一圈覆盖了图组里全部背景', uniq === b0.bgTotal, `经过的索引=${idxs.join(',')} 去重=${uniq}/${b0.bgTotal}`);
  await sleep(1200);
  const t3 = snap();
  check('连续换背景期间游戏未中断', !!t3 && t3.dist > t2.dist && t3.errs.length === 0,
    t3 ? `距离 ${t2.dist} → ${t3.dist} errs=${t3.errs.length}` : '-');
  check('连续换背景后仍无脚本错误', !!t3 && t3.errs.length === 0, t3 ? `errs=${t3.errs.length}` : '-');

  console.log('\n--- 4. 空格暂停 / 继续 ---');
  const p0 = snap();
  const p1 = await press(' ', (s, b) => b && s.paused && !b.paused);
  check('按空格进入暂停', !!p1 && p1.paused === true, p1 ? `paused=${p1.paused}` : '-');
  check('暂停时遮罩层已显示', !!p1 && p1.pauseShown === true, p1 ? `pauseShown=${p1.pauseShown}` : '-');

  // 暂停 4 秒：距离必须冻住
  await sleep(4000);
  const p2 = snap();
  check('暂停期间距离冻结（规则层不再推进）', !!p2 && p2.dist === p1.dist,
    p2 ? `暂停时 ${p1.dist} → 4s 后 ${p2.dist}` : '-');
  check('暂停期间仍无脚本错误', !!p2 && p2.errs.length === 0, p2 ? `errs=${p2.errs.length}` : '-');

  // 暂停时按方向键/跳跃不应被采纳（只认空格）
  const p2b = snap();
  await press('w', null, 900);
  await press('d', null, 900);
  const p2c = snap();
  check('暂停时方向/跳跃键被忽略（距离仍冻结）', !!p2c && p2c.dist === p2b.dist,
    p2c ? `${p2b.dist} → ${p2c.dist}` : '-');

  const p3 = await press(' ', (s, b) => b && b.paused && !s.paused);
  check('再按空格恢复运行', !!p3 && p3.paused === false, p3 ? `paused=${p3.paused}` : '-');
  check('恢复后遮罩层已隐藏', !!p3 && p3.pauseShown === false, p3 ? `pauseShown=${p3.pauseShown}` : '-');

  await sleep(2500);
  const p4 = snap();
  check('恢复后距离继续增长', !!p4 && p4.dist > p3.dist, p4 ? `${p3.dist} → ${p4.dist}` : '-');

  console.log('\n--- 4.5 F 键挥拳打小恶魔（血条厚：要连打几拳）---');
  // 血条要打 3 拳，而恶魔在打击窗口里只待 1 秒出头 ——
  // 所以不能"等探针报告它进窗再按"（探针 500ms 才落一次盘，等到了它也快过身了）。
  // 做法改成：注入 → 立刻按 F 连打 → 场上没怪就再补一只，直到真的打出一只击杀。
  // 这既验证了"血条逐格掉"，也验证了"最后一拳才清空血条"。
  //
  // 顺带说明 {cmd:'poke'} 的用法：页面收到任何指令后都会立刻推一次快照，
  // 所以一个无副作用的 poke 就是"手动催更"状态，用来做高频采样。
  const kf0 = snap();
  const kf1Base = kf0.kills;
  const hpSeen = new Set();
  let killSeen = null, punches = 0, spawns = 0, maxHpSeen = 0, modeSeen = kf0.mode;
  // 注意指令通道是"单槽文件"：写完必须留够时间给页面轮询消费（150ms 一次），
  // 否则会被紧接着的按键指令覆写掉 —— 这一版第一次跑就是这么把 spawn 弄丢的。
  const spawnOne = async () => {
    const s = snap();
    const lane = s && [0, 1, 2].includes(s.laneF) ? s.laneF : 1;
    writeFileSync(CMD, JSON.stringify({ cmd: 'spawn', lane, z: -22, id: Date.now() }));
    spawns++;
    await sleep(240);
  };
  await spawnOne();
  const tEnd = Date.now() + 14000;
  while (Date.now() < tEnd) {
    writeFileSync(CMD, JSON.stringify({ key: 'f', id: Date.now() }));
    punches++;
    await sleep(170);
    const s = snap();
    if (!s) continue;
    modeSeen = s.mode;
    if (s.demonMaxHp > maxHpSeen) maxHpSeen = s.demonMaxHp;
    if (s.demonHp > 0) hpSeen.add(s.demonHp);
    if (s.kills > kf1Base) { killSeen = s; break; }
    // 命掉到 2 就收手：这段用例不该把整局打死，后面的用例还要接着跑
    if (s.lives <= 2) break;
    if (s.demons === 0 && spawns < 5) await spawnOne();
  }
  const hpTrack = [...hpSeen].sort((a, b) => b - a).join(' > ') || '无';
  console.log(`   注入 ${spawns} 只 · 连按 ${punches} 拳 · 观察到的血条档位：${hpTrack}`);
  check('普通模式恶魔血条 = 3 拳', maxHpSeen === 3 && modeSeen === 'normal',
    `maxHp=${maxHpSeen} mode=${modeSeen}`);
  check('不是一拳秒：观察到了中间血量', hpSeen.has(2) || hpSeen.has(1), `档位=${hpTrack}`);
  check('血条清空才倒下（按 F 连打 → 击倒恶魔）', !!killSeen && killSeen.kills > kf1Base,
    `kills ${kf1Base} → ${killSeen && killSeen.kills}`);
  await sleep(600);
  const kf2 = snap();
  check('挥拳交互后无脚本错误', !!kf2 && kf2.errs.length === 0, kf2 ? `errs=${kf2.errs.length}` : '-');

  console.log('\n--- 4.6 难度模式：普通 / 困难 ---');
  const m0 = snap();
  check('当前是普通模式（5 条命）', m0.mode === 'normal' && m0.livesMax === 5,
    `mode=${m0.mode} livesMax=${m0.livesMax}`);
  writeFileSync(CMD, JSON.stringify({ cmd: 'mode', name: 'hard', id: Date.now() }));
  const m1 = await waitFor((s) => s.mode === 'hard', 8000);
  check('切到困难：3 条命 + 按新难度重开（距离归零）', !!m1 && m1.livesMax === 3 && m1.lives === 3 && m1.dist < 200,
    m1 ? `mode=${m1.mode} lives=${m1.lives}/${m1.livesMax} dist=${m1.dist}` : '-');

  // 困难模式：注入一只怪，用 poke 高频催快照（不按 F，避免把它打死）读到它的血条上限
  {
    const laneH = [0, 1, 2].includes(m1 ? m1.laneF : 1) ? m1.laneF : 1;
    writeFileSync(CMD, JSON.stringify({ cmd: 'spawn', lane: laneH, z: -22, id: Date.now() }));
    await sleep(240);   // 等页面把这条指令消费掉（单槽文件，不能立刻覆写）
    let seen = 0;
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      writeFileSync(CMD, JSON.stringify({ cmd: 'poke', id: Date.now() }));
      await sleep(120);
      const s = snap();
      if (s && s.demonMaxHp > seen) seen = s.demonMaxHp;
      if (seen === 4) break;
    }
    check('困难模式恶魔血更厚（4 拳）', seen === 4, `maxHp=${seen}`);
  }

  // 切回普通，并重开一局：让后面的用例从干净状态（满命、距离 0）继续
  writeFileSync(CMD, JSON.stringify({ cmd: 'mode', name: 'normal', id: Date.now() }));
  const m2 = await waitFor((s) => s.mode === 'normal', 8000);
  check('切回普通模式成功', !!m2 && m2.mode === 'normal' && m2.livesMax === 5,
    m2 ? `mode=${m2.mode} livesMax=${m2.livesMax}` : '-');
  writeFileSync(CMD, JSON.stringify({ cmd: 'restart', id: Date.now() }));
  const m3 = await waitFor((s) => s.lives === 5 && s.gstate === 'running', 6000);
  check('重开后满命继续跑（后续用例状态干净）', !!m3 && m3.lives === 5,
    m3 ? `lives=${m3.lives}/${m3.livesMax}` : '-');

  console.log('\n--- 4.7 等级系统：按距离升级 → 血量上限跟着涨 ---');
  // 升级门槛本来是 400m，真跑要十几秒才够得着。这里只是把门槛临时压到 60m，
  // 触发的仍是同一条 _checkLevelUp 逻辑（改的是门槛数值，不是逻辑本身）。
  // 结尾必须还原，否则后面的用例会在"一路狂升级"的状态里跑，断言全失真。
  writeFileSync(CMD, JSON.stringify({ cmd: 'restart', id: Date.now() }));
  const lv0 = await waitFor((s) => s.gstate === 'running' && s.dist < 60, 6000) || snap();
  check('重开后从 Lv.1 起跑（等级会随重开归零）',
    !!lv0 && lv0.level === 1 && lv0.levelsGained === 0,
    lv0 ? `level=${lv0.level} gained=${lv0.levelsGained} 距离=${lv0.dist}m 命=${lv0.lives}/${lv0.livesMax}` : '-');
  const lvBaseMax = (lv0 && lv0.livesMax) || 5;

  writeFileSync(CMD, JSON.stringify({ cmd: 'leveldist', value: 60, id: Date.now() }));
  await sleep(300);
  const lv1 = await waitFor((s) => s.level >= 3, 30000);
  check('跑着跑着等级按距离自己往上涨', !!lv1 && lv1.level >= 3,
    lv1 ? `距离 ${lv1.dist}m → Lv.${lv1.level}` : '30s 内没等到升级');
  // 血量上限**不封顶**（旧实现封顶 9，跑到后期再也不长了 —— 见 game.js 的 level）
  check('升了几级就补几级血上限（升级 = 更耐打，且不封顶）',
    !!lv1 && lv1.livesMax === lvBaseMax + (lv1.level - 1) && lv1.levelsGained === lv1.level - 1,
    lv1 ? `Lv.${lv1.level} → 命上限 ${lvBaseMax} → ${lv1.livesMax}（累计升 ${lv1.levelsGained} 级）` : '-');
  check('升级会把血一起补上（不白给上限）',
    !!lv1 && lv1.lives === lv1.livesMax, lv1 ? `命 ${lv1.lives}/${lv1.livesMax}` : '-');
  check('等级只跟距离走，和难度档位是两码事（diffLevel 另算）',
    !!lv1 && typeof lv1.diffLevel === 'number' && lv1.diffLevel >= 0,
    lv1 ? `diffLevel=${lv1.diffLevel}（难度档位，会封顶）` : '-');
  check('升级过程中无脚本错误', !!lv1 && lv1.errs.length === 0, lv1 ? `errs=${lv1.errs.length}` : '-');

  // 血量上限越过 9 点 → HUD 该开始出现金色心（每 9 点血折一颗，见 ui.js 的 heartMarkup）。
  // 门槛再压到 10m，跑一小会儿就够 9 点血了。
  writeFileSync(CMD, JSON.stringify({ cmd: 'leveldist', value: 10, id: Date.now() }));
  await sleep(300);
  const lv9 = await waitFor((s) => s.livesMax >= 9, 30000);
  check('血量上限能越过 9 点（旧实现封顶 9，永远长不上去）',
    !!lv9 && lv9.livesMax >= 9, lv9 ? `命上限 ${lv9.livesMax}（Lv.${lv9.level}）` : '30s 内没攒到 9 点血');
  check('血量过 9 后 HUD 开始出现金色心（探针与 UI 用的是同一套换算）',
    !!lv9 && lv9.goldHearts >= 1 && lv9.goldHearts === Math.floor(lv9.livesMax / 9),
    lv9 ? `livesMax=${lv9.livesMax} → 金心 ${lv9.goldHearts} 颗` : '-');

  writeFileSync(CMD, JSON.stringify({ cmd: 'leveldist', value: 400, id: Date.now() }));  // 还原门槛
  await sleep(300);

  console.log('\n--- 4.8 挥拳反馈链：怪进窗口 → 提示亮 → 过去后自动灭 ---');
  // 键盘兜底模式下按 F 是直接调 game.punch()，所以这里验的是"打击窗口 / 可打标记 /
  // HUD 提示"这条反馈链。MediaPipe 的手势通道（直拳/刺拳/侧勾拳三通道）由
  // test-pose.mjs 用合成关键点覆盖 —— 无头浏览器喂不进真手，那条测不了。
  writeFileSync(CMD, JSON.stringify({ cmd: 'restart', id: Date.now() }));
  await waitFor((s) => s.gstate === 'running' && s.lives === 5, 6000);
  writeFileSync(CMD, JSON.stringify({ cmd: 'clear', id: Date.now() }));
  await sleep(300);
  writeFileSync(CMD, JSON.stringify({ cmd: 'poke', id: Date.now() }));
  await sleep(200);
  const ph0 = snap();
  check('场上没怪时"挥拳！"提示不亮', !!ph0 && ph0.demons === 0
    && ph0.demonInRange === false && ph0.punchHintShown === false,
    ph0 ? `demons=${ph0.demons} inRange=${ph0.demonInRange} hint=${ph0.punchHintShown}` : '-');

  const laneNow = ph0 && [0, 1, 2].includes(ph0.laneF) ? Math.round(ph0.laneF) : 1;
  // 生成点必须在打击窗口**之外**：只有这样怪才会先经过"来了！"预警区，
  // 再进窗口变成"挥拳！"。直接生成在窗口内的话，它一出生就是可打状态，
  // 预警那一档根本不会被触发（这条用例一开始就是这么假绿的）。
  writeFileSync(CMD, JSON.stringify({ cmd: 'spawn', lane: laneNow, z: -46, id: Date.now() }));
  await sleep(240);
  let sawRange = null, sawHint = null, sawRing = null, sawEmpty = null, sawSoon = null;
  const winEnd = Date.now() + 9000;
  while (Date.now() < winEnd) {
    writeFileSync(CMD, JSON.stringify({ cmd: 'poke', id: Date.now() }));
    await sleep(110);
    const s = snap();
    if (!s) continue;
    if (s.demonInRange) sawRange = s;
    if (s.punchHintShown) sawHint = s;
    if (s.demonHittable) sawRing = s;
    if (s.demonApproaching) sawSoon = s;
    if (sawHint && s.demons === 0) { sawEmpty = s; break; }
  }
  check('恶魔进入打击窗口 → 规则层报 demonInRange', !!sawRange,
    sawRange ? `距离 ${sawRange.dist}m 时 inRange=true` : '没进过窗口');
  check('模型侧地面指示环跟着亮（和判定同一个真相源）', !!sawRing,
    sawRing ? 'hittable=true（地环亮起）' : '一直没亮');
  check('HUD 真的弹出"挥拳！"提示（DOM class 是加上了的）', !!sawHint,
    sawHint ? 'punch-hint.show 已加上' : '提示始终没亮');
  // "来了！"预警档：怪还在窗口外就先亮 —— 这是对"识别延迟"的对冲（见 game.js 的 demonApproaching）。
  // 只有"进窗口才提示"一档时，玩家看到提示再动身，动作被识别出来时怪已经贴脸了。
  check('怪还没进窗口就先亮"来了！"预警（实机要早半个身位）',
    !!sawSoon && sawSoon.demonInRange === false,
    sawSoon ? `跑到 ${sawSoon.dist}m 时预警亮起（此刻 inRange=false，怪还在窗口外）` : '预警从没亮过');
  await sleep(500);
  const ph1 = snap();
  check('提示会自己熄灭（不是一直挂着）', !!ph1 && ph1.punchHintShown === false,
    ph1 ? `提示已灭 · 场上 ${ph1.demons} 只` : '-');
  check('挥拳反馈链全程无脚本错误', !!ph1 && ph1.errs.length === 0,
    ph1 ? `errs=${ph1.errs.length}` : '-');

  console.log('\n--- 4.85 连打击杀：命中击退 = 在撞上之前收掉怪 ---');
  // "还没打死就撞上"的端到端验收：注入一只怪，用键盘 F 连打（模拟玩家猛捶），
  // 要求"打得死 + 过程中一滴血不掉 + 累计击退量 > 0"。
  // 最后一条是关键 —— 它证明"命中确实把怪推远了"，而那正是把窗口"延长"出来的东西；
  // 光靠放宽阈值做不到这一点（那只是让判定更容易过，并不能给玩家更多时间）。
  // 按 F 走的是键盘兜底通道，和体感通道共用同一个 game.punch() 判定。
  writeFileSync(CMD, JSON.stringify({ cmd: 'restart', id: Date.now() }));
  await waitFor((s) => s.gstate === 'running' && s.lives === 5, 6000);
  writeFileSync(CMD, JSON.stringify({ cmd: 'clear', id: Date.now() }));
  await sleep(300);
  writeFileSync(CMD, JSON.stringify({ cmd: 'spawn', lane: laneNow, z: -24, id: Date.now() }));
  await sleep(320);
  const dk0 = snap();
  check('注入的怪出现在打击窗口里（用例前提）',
    !!dk0 && dk0.demonMaxHp > 0 && dk0.demonHp === dk0.demonMaxHp,
    dk0 ? `怪 hp=${dk0.demonHp}/${dk0.demonMaxHp} z=${dk0.demonZ}` : '-');
  check('击退量确实来自模式表（接线正确）', !!dk0 && dk0.knockback > 0,
    dk0 ? `knockback=${dk0.knockback} 米/拳` : '-');

  const kills0 = (dk0 && dk0.kills) || 0;
  let killed = false, knockSeen = 0, lostLife = false, last = dk0;
  let shotSeen = (dk0 && dk0.shotId) || 0, flySeen = 0, firedSeen = (dk0 && dk0.shotsFired) || 0;
  for (let i = 0; i < 28; i++) {
    // 指令通道是单槽文件：写完之后必须留足时间给页面 150ms 的轮询消费，
    // 否则会被下一轮覆写（见文件里的说明）。
    writeFileSync(CMD, JSON.stringify({ key: 'f', id: Date.now() }));
    await sleep(250);
    const s = snap();
    if (!s) continue;
    last = s;
    knockSeen = Math.max(knockSeen, s.knockTotal);
    shotSeen = Math.max(shotSeen, s.shotId || 0);
    flySeen = Math.max(flySeen, s.shotsFlying || 0);
    firedSeen = Math.max(firedSeen, s.shotsFired || 0);
    if (s.lives < s.livesMax) lostLife = true;
    if (s.kills > kills0) { killed = true; break; }
    if (s.demons === 0) break;
  }
  check('对着贴脸的怪连打出拳 → 在被撞到之前把它收掉', killed,
    last ? `kills=${last.kills} · 场上还剩 ${last.demons} 只 · 怪 z=${last.demonZ}` : '-');
  check('收怪过程中一滴血都没掉', !lostLife, last ? `命 ${last.lives}/${last.livesMax}` : '-');
  check('命中确实把怪推远过（累计击退量 > 0）', knockSeen > 0,
    `累计击退 ${knockSeen.toFixed(1)} 米 —— 这就是"打不完"变成"打得完"的那段缓冲`);

  // 拳弹链路：规则层每次出拳报一个自增 id，渲染层据此从玩家手里打出一发光弹。
  // 两个口径分开看 —— shotId 证明"事件发了"，shotsFired 证明"画面真的把它打出去了"。
  // 渲染层用的是累计值（只增不减），因为弹丸 150 m/s、飞完全程才 0.2 秒出头，
  // 按几百毫秒采样极容易整段错过。
  check('每次出拳都在画面里打出一发光弹（渲染层真的接上了）',
    !!dk0 && firedSeen > (dk0.shotsFired || 0),
    `渲染层累计打出 ${firedSeen} 发（注入前 ${dk0 ? dk0.shotsFired : '?'}）`);
  // 渲染层的 shotCount 是"页面加载以来"的累计值，不会跟着 game.reset() 归零 ——
  // 所以只能比**这一段的增量**（且留 ±1 的采样时序容差：最后一发可能还没被探针看到）。
  const punchesThrown = shotSeen - (dk0.shotId || 0);
  const bulletsFired = firedSeen - (dk0.shotsFired || 0);
  check('这一段打出的光弹数与出拳数对得上（不漏发不重发）',
    punchesThrown > 0 && bulletsFired >= punchesThrown - 1 && bulletsFired <= punchesThrown + 1,
    `出拳 ${punchesThrown} 次 · 画面打出 ${bulletsFired} 发（±1 为采样时序容差）`);
  check('光弹确实在场景里飞过（探针抓到过在飞的弹）', flySeen > 0,
    `观察到最多 ${flySeen} 发同时在飞`);

  check('连打链路无脚本错误', !!last && last.errs.length === 0, last ? `errs=${last.errs.length}` : '-');

  console.log('\n--- 4.9 樱花 / 地狱：精修后的景物要能真渲染 ---');
  // 这两套景物的零件多了不少（障子窗 / 樱树花团 / 顶点抖动的火山岩 / 熔岩池）。
  // 零件一多，最容易踩的是"共享几何体被当草稿纸改坏"，所以逐个定点跑一遍。
  for (const [key, label] of [['sakura', '樱花·二次元浪漫'], ['hell', '地狱·熔岩']]) {
    writeFileSync(CMD, JSON.stringify({ cmd: 'theme', name: key, id: Date.now() }));
    const th = await waitFor((s) => s.theme === key, 8000);
    check(`切到「${label}」成功`, !!th, th ? `theme=${th.theme} 背景=${th.bg + 1}/${th.bgTotal}` : '没切过去');
    await sleep(3200);   // 让景物建完 + 跑几帧（建景物的报错都是在这一刻冒出来的）
    const ts = snap();
    check(`「${label}」景物渲染 3s 无脚本错误`, !!ts && ts.errs.length === 0,
      ts ? `障碍=${ts.obstacles} 距离=${ts.dist} errs=${ts.errs.length}`
         + (ts.badUniform ? ` ⚠ badUniform=${ts.badUniform}` : '') : '-');
    check(`「${label}」下障碍物仍在继续生成`, !!ts && ts.phase === 'running' && (ts.obstacles > 0 || ts.dist > (th ? th.dist : 0)),
      ts ? `障碍=${ts.obstacles} 距离=${th ? th.dist : '?'} → ${ts.dist}` : '-');
    // 景物精修最容易的副作用是"零件暴涨 → 帧率掉"。这里把渲染开销记下来当基线守着。
    console.log(`   ↳ 渲染开销：draw calls=${ts && ts.drawCalls} · 三角面=${ts && ts.triangles}`
      + ` · 场景网格=${ts && ts.meshes}`);
    check(`「${label}」draw call 在预算内（< 1400）`, !!ts && ts.drawCalls > 0 && ts.drawCalls < 1400,
      ts ? `drawCalls=${ts.drawCalls}` : '-');
  }
  // 收场：换回樱花这档让人一眼看到好景（答辩演示的默认位），并重开一局回到干净状态
  writeFileSync(CMD, JSON.stringify({ cmd: 'theme', name: 'sakura', id: Date.now() }));
  await sleep(400);
  writeFileSync(CMD, JSON.stringify({ cmd: 'clear', id: Date.now() }));
  await sleep(200);
  writeFileSync(CMD, JSON.stringify({ cmd: 'restart', id: Date.now() }));
  await waitFor((s) => s.gstate === 'running' && s.lives === 5, 6000);

  console.log('\n--- 5. 暂停中换背景（演示时挑图用）---');
  await press(' ', (s, b) => b && !b.paused && s.paused, 4000);
  const q0 = snap();
  console.log(`  （暂停前背景 ${q0.bg + 1}/${q0.bgTotal} = ${q0.bgLabel}）`);
  for (let t = 0; t < 3; t++) {
    const r = await press('b', null, 1500);
    console.log(`   尝试 ${t + 1}: 按键后 bg=${r.bg + 1}/${r.bgTotal} (${r.bgLabel}) paused=${r.paused}`);
  }
  const q1 = snap();
  check('暂停状态下按 B 能换背景', q1.bg !== q0.bg, `${q0.bg + 1}(${q0.bgLabel}) → ${q1.bg + 1}(${q1.bgLabel})`);
  check('换背景不会解除暂停', !!q1 && q1.paused === true, `paused=${q1.paused}`);
  await press(' ', null, 4000);

  console.log('\n--- 6. 全程无脚本错误 ---');
  const fin = snap();
  const allErrs = (fin && fin.errs) || [];
  check('整轮交互零脚本错误', allErrs.length === 0, allErrs.length ? allErrs.join(' | ') : '无');
  if (fin && fin.errFull && fin.errFull.length) {
    console.log('\n  带堆栈的错误详情：');
    for (const e of fin.errFull) {
      console.log(`   · [${e.at}ms] ${e.msg}`);
      console.log(`     ${e.stack}`);
      if (e.probe) console.log(`     probe=${e.probe}`);
    }
  }
  if (fin && fin.badUniform) console.log(`\n  炸掉的 uniform 详情：${fin.badUniform}`);
  check('结束时游戏仍在正常运行', !!fin && fin.phase === 'running', fin ? `phase=${fin.phase} 距离=${fin.dist}` : '-');

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass} 通过 / ${results.length - pass} 失败`);
  exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  console.log('\n异常中断：' + (e && e.message));
  exitCode = 1;
} finally {
  try { srv.kill(); } catch {}
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else { try { browser.kill(); } catch {} }
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  rmSync(CMD, { force: true });
  process.exit(exitCode);
}
