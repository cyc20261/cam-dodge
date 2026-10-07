/**
 * main.js —— 入口与流程编排
 *
 * ── 防卡顿 / 低延迟架构（v2）──────────────────────
 * 渲染循环：恒定 rAF，只做"画"，永远不识别 → 画面流畅
 * 识别循环：由 requestVideoFrameCallback 驱动，相机一出新帧就识别，
 *           识别完立刻把动作喂给游戏，不等渲染帧 → 操作跟手
 * 两条循环彻底解耦，互不阻塞。
 *
 * 另有自适应降质器：持续监测 FPS 与单次识别耗时，
 * 掉帧时依次降低像素比 → 精简粒子/景物 → 降低识别频率 → 降低相机分辨率，
 * 恢复后再逐级升回来。目标：任何机器上都不卡顿。
 *
 * 状态机： idle → initCam → calib → running → over
 * 输入三通道：体感（主）/ 键盘（兜底）/ 触屏（移动端）
 */

import { World, THEMES, THEME_KEYS } from './scene.js';
import { Game, MODES, MODE_KEYS } from './game.js';
import { UI, GOLD_HEART } from './ui.js';
import { PoseTracker, GestureRecognizer } from './pose.js';

const CFG = window.CAMRUN_CONFIG || {};

const ui = new UI();
const world = new World(ui.el.stage).init(loadTheme());
const game = new Game(world, {
  onClear: (combo) => { if (combo % 5 === 0) ui.toast(`连击 x${combo}！`, 1200); },
  onDemonHit: (pts, hp) => ui.toast(`命中！还剩 ${hp} 拳 +${pts}`, 800),
  onDemonKill: (pts) => ui.toast(`击倒小恶魔 +${pts}`, 900),
  // 升级：血量上限**不封顶**（见 js/game.js 的 level），HUD 每 9 点折一颗金心。
  // 恰好凑满一整颗金心时单独报一句 —— 那是玩家最该被夸一下的时刻。
  onLevelUp: (lv, livesMax) => {
    const gold = Math.floor(livesMax / GOLD_HEART);
    const newGold = gold > Math.floor((livesMax - 1) / GOLD_HEART);
    ui.toast(newGold
      ? `等级提升 Lv.${lv}！血量上限 ${livesMax} —— 凝出第 ${gold} 颗金心！`
      : `等级提升 Lv.${lv}！血量上限 +1（共 ${livesMax} 点）`, 1400);
  },
  onHit: (type, lives) => {
    const tip = {
      hurdle: '低栏要跳过去',
      overhead: '高杆要蹲下',
      block: '实墙要变道',
      demon: '被小恶魔撞到了（迎面挥拳能把它打退，跳高也能跃过）',
    }[type] || '';
    ui.toast(`撞到了！${tip}（剩余 ${lives}）`, 1600);
  },
  onOver: (s) => ui.showOver(s),
});

const tracker = new PoseTracker({
  wasmBase: CFG.wasmBase,
  modelUrl: CFG.modelUrl,
  modelUrlFull: CFG.modelUrlFull,
});
const gesture = new GestureRecognizer();

// 难度必须在建 Game 之后立刻定下来（reset 里要按模式取命数/速度/间距）
game.setMode(loadMode(), true);

let phase = 'idle';         // idle | initCam | calib | running | over
let paused = false;         // 暂停（空格）：只冻结规则推进与世界观运动，画面仍持续绘制
let inputMode = 'keyboard'; // keyboard | pose
let latestLandmarks = null;
let lastGesture = { lane: 0, jump: false, duck: false };
let poseSeen = false;

/* ================= 主题 ================= */

function loadTheme() {
  try {
    const v = localStorage.getItem('camDodge.theme');
    if (v && THEMES[v]) return v;
  } catch {}
  return 'sakura';
}
function saveTheme(n) { try { localStorage.setItem('camDodge.theme', n); } catch {} }

/* ================= 难度 ================= */

function loadMode() {
  try {
    const v = localStorage.getItem('camDodge.mode');
    if (v && MODES[v]) return v;
  } catch {}
  return 'normal';   // 默认普通：能跑满 10 分钟的那档
}
function saveMode(n) { try { localStorage.setItem('camDodge.mode', n); } catch {} }

/** 开始屏点难度：立刻按新模式重开一局并记住选择 */
function pickMode(name) {
  if (!MODES[name]) return;
  game.setMode(name, true);
  // 局内切难度：必须立刻 start()，否则 game 会停在 'ready' 态不动（画面还在滚，规则全冻）
  if (phase === 'running') game.start();
  ui.setMode(name);
  saveMode(name);
  ui.toast(`难度：${MODES[name].label} · ${MODES[name].desc}`, 2200);
}

function setTheme(name, silent) {
  // 顺序很关键：必须先把手上的障碍物归还给"当前的对象池"，
  // 再重建主题树（重建会销毁旧池并新建池）。
  // 反过来的话，旧 mesh 会被 release 进新池 → 新池混入已 dispose 的网格，
  // 之后 acquire 拿到它就渲染出问题（这就是按 M 换图出现异常的原因）。
  game.clearObstacles();
  world.applyTheme(name);
  saveTheme(name);
  ui.setTheme(name);
  if (!silent) {
    const bg = world.bgInfo;
    ui.toast(`已切换到「${THEMES[name].name}」` + (bg.total > 1 ? ` · ${bg.label}` : ''), 1800);
  }
}

/** B 键：在当前地图的多张天幕之间轮换（云海 / 星海 / 樱景 / 地狱天幕…） */
function cycleBg() {
  const r = world.cycleBg(1);
  if (!r) { ui.toast('当前地图只有一张天幕', 1400); return; }
  ui.toast(`背景 ${r.index + 1}/${r.total} · ${r.label}`, 1600);
}

/* ================= 暂停 ================= */

/**
 * 暂停只做一件事：让规则层停更。
 * 为什么不去场景层里做手脚 —— 那会让场景彻底静止，看起来像"卡死"。
 * 这里让规则推进停掉（障碍物、速度、计分全冻结），但保留场景推进，
 * 用 speed=0 继续跑天幕过渡/粒子呼吸/景物浮动 —— 画面是活的，只是世界不再逼近你。
 */
function setPaused(v) {
  if (phase !== 'running') return;
  const want = !!v;
  if (paused === want) return;
  paused = want;
  ui.setPaused(paused);
  if (paused) {
    game.setDuck(false);           // 别让玩家按着 ↓ 暂停后卡在蹲姿
    ui.toast('已暂停 · 空格继续（B 可换背景）', 1800);
  } else {
    last = performance.now();      // 重置帧间隔基准，否则恢复瞬间会跳一大步
    ui.toast('继续！', 900);
  }
}

/** 恢复（或开始）游戏时统一清掉暂停态 */
function clearPause() {
  paused = false;
  ui.setPaused(false);
}

/* ================= 自适应降质 ================= */

const perf = {
  level: 2,        // 2=高 1=中 0=低
  fps: 60,
  acc: 0, frames: 0,
  lastCheck: 0,
  camQuality: 'high',
};

function perfTick(dt, now) {
  perf.acc += dt; perf.frames++;
  if (perf.acc >= 0.5) {
    perf.fps = Math.round(perf.frames / perf.acc);
    perf.acc = 0; perf.frames = 0;
    ui.setAi(tracker.detectMs); // HUD 上的识别延迟
  }
  // 每 2.5 秒评估一次，避免在临界点反复横跳
  if (now - perf.lastCheck < 2500) return;
  perf.lastCheck = now;

  const detectHeavy = tracker.detectMs > 26; // 单次识别超过 26ms 就算重
  let target = perf.level;

  if (perf.fps < 42 || detectHeavy) target = Math.min(perf.level, 1);
  if (perf.fps < 30) target = 0;
  if (perf.fps > 55 && tracker.detectMs < 12) target = Math.min(2, perf.level + 1);

  if (target !== perf.level) {
    perf.level = target;
    applyPerfLevel();
    ui.toast(`性能自适应：${['低画质', '中画质', '高画质'][target]}（${perf.fps}fps）`, 1600);
  }
}

function applyPerfLevel() {
  const lv = perf.level;
  world.setQuality(lv >= 2 ? 1 : 0.5);          // 粒子/景物数量
  world.renderer.setPixelRatio(lv >= 2 ? Math.min(window.devicePixelRatio, 2) : lv === 1 ? 1.25 : 1);
  // 识别永远每帧都跑，绝不隔帧 —— 隔帧等于把动作延迟直接翻倍（33ms → 66ms+）。
  // 低端机器上宁可降画质（像素比/粒子/骨骼），也要保住体感的响应速度。
  tracker.setThrottle(1);
  ui.setSkeletonStride(lv >= 2 ? 1 : 2);        // 低画质时骨骼隔帧重绘
}

/* ================= 渲染主循环（只负责画） ================= */

let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (phase === 'running' && !paused) {
    // 体感模式下，输入已在识别回调里即时生效；这里只做规则推进与绘制
    game.update(dt);
    ui.updateHUD(game, hudExtra());
  } else if (phase === 'over') {
    game.update(dt);
    ui.updateHUD(game, hudExtra());
  } else {
    // idle / calib / 暂停中：只画世界观（暂停时 speed=0，画面是活的但不逼近）
    ui.updateHUD(game, hudExtra());
    world.update(dt, { laneF: game.laneF, lane: game.lane, jumpY: game.jumpY, duck: game.duck, speed: 0, demons: game.demons, punchT: -1 });
  }

  if (inputMode === 'pose') {
    ui.drawSkeleton(latestLandmarks, {
      color: phase === 'calib' ? '#06d6a0' : THEMES[world.themeName].laneLine,
    });
    if (latestLandmarks) poseSeen = true;
    if (phase === 'running' && !poseSeen) ui.toast('没识别到人体，请站到摄像头画面中央', 3000);
  }

  ui.tickFps(dt);
  perfTick(dt, now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ================= 识别回调（即时响应，不等渲染帧） ================= */

function onPoseResult(res) {
  // 已经降级到键盘模式时，体感不能再插手。
  // 否则摄像头虽然失败了识别回调却还在跑，会不断把 setLane/setDuck 覆盖回来，
  // 玩家会发现键盘按了没反应、或者游戏自己在动。
  if (inputMode !== 'pose') return;

  latestLandmarks = res ? res.landmarks : null;

  if (phase === 'calib') {
    if (!latestLandmarks) {
      // 没检测到人就明说，别让玩家对着静止的进度条猜
      ui.setCalibProgress(0.2, '没有检测到人体<br><small>请正对摄像头、保证光线充足，全身或上半身入镜都可以</small>');
      return;
    }
    const done = gesture.feedCalibration(latestLandmarks);
    // 前 8 帧热身 + 32 帧采样，取中位数作为基准
    ui.setCalibProgress(Math.min(0.95, 0.2 + (gesture.calib.n / 40) * 0.75),
      '请站直、正对摄像头<br><small>正在采集体态基准…</small>');
    if (done && gesture.finishCalibration()) beginRun();
    return;
  }

  if (phase !== 'running') return;
  // 暂停时识别回路照常跑（人体框还画着），但不喂给游戏 ——
  // 否则暂停期间挥手会让角色在恢复后瞬间"闪"到别的道。
  if (paused) return;

  // 关键：拿到结果立刻作用于游戏，不等下一次 rAF
  const g = gesture.update(latestLandmarks, performance.now());
  if (!g) return;
  lastGesture = g;
  game.setLane(g.lane + 1);
  if (g.jump) game.jump();
  if (g.punch) game.punch();
  game.setDuck(g.duck);
}

function hudExtra() {
  const diffLabel = game.modeConf.label;
  const demonInRange = game.demonInRange;
  const demonApproaching = game.demonApproaching;   // "来了！"预警档（见 js/game.js）
  if (inputMode !== 'pose') return { modeLabel: '键盘 / 触屏', modeClass: 'kb', diffLabel, demonInRange, demonApproaching };
  const m = gesture.debug.mode || 'full';
  return {
    modeLabel: m === 'full' ? '体感·全身' : '体感·半身',
    modeClass: m === 'full' ? 'ok' : 'warn',
    gestureLabel: gestureLabel(),
    diffLabel,
    demonInRange,
    demonApproaching,
  };
}

function gestureLabel() {
  const d = gesture.debug || {};
  if (d.lost) return '未识别到人体';
  const parts = [];
  if (lastGesture.duck) parts.push('下蹲');
  if (d.rise || d.handsUp || d.feetUp) parts.push('起跳');
  parts.push(['左道', '中道', '右道'][lastGesture.lane + 1]);
  return parts.join(' · ');
}

/* ================= 键盘 / 触屏 ================= */

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();

  if (phase === 'running') {
    // 空格：暂停 / 继续（不再是跳跃 —— 跳跃交给 W / ↑）
    if (k === ' ') { setPaused(!paused); return; }
    // 暂停期间：只放行"不改变游戏状态"的键（换背景/换地图/调试），
    // 变道/跳跃/下蹲一律吞掉，避免误操作。
    // 注意这里是 else-if 链而不是提前 return —— 提前 return 会把下面
    // 的 M / B / P 分支也一并挡掉（曾导致"暂停时按 B 换不了背景"）。
    if (paused) {
      if (k === 'b') cycleBg();
      else if (k === 'm') {
        const i = THEME_KEYS.indexOf(world.themeName);
        setTheme(THEME_KEYS[(i + 1) % THEME_KEYS.length]);
      } else if (k === 'p') ui.toggleDebug();
      return;
    }
    if (k === 'arrowleft' || k === 'a') game.moveLane(-1);
    else if (k === 'arrowright' || k === 'd') game.moveLane(1);
    else if (k === 'w' || k === 'arrowup') game.jump();
    else if (k === 's' || k === 'arrowdown') game.setDuck(true);
    else if (k === 'f' || k === 'j') game.punch();   // 挥拳打小恶魔
  }
  if (k === 'r' && phase === 'over') restart();
  if (k === 'escape' && phase !== 'idle') {
    // 中途退出：停掉体感回路，回到开始屏（可重新选择摄像头模式）
    inputMode = 'keyboard';
    tracker.stop();
    latestLandmarks = null;
    clearPause();
    document.getElementById('cam-panel').classList.remove('show');
    document.getElementById('cam-diag').classList.remove('show');
    phase = 'idle';
    game.reset();
    ui.showScreen('start');
  }
  if (k === 'p') ui.toggleDebug();
  if (k === 'm') {
    const i = THEME_KEYS.indexOf(world.themeName);
    setTheme(THEME_KEYS[(i + 1) % THEME_KEYS.length]);
  }
  if (k === 'b') cycleBg();     // 同地图内轮换天幕（暂停时也能换，方便对比挑选）
  if (k === 'enter' && phase === 'idle') document.getElementById('btn-pose').click();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 's' || k === 'arrowdown') game.setDuck(false);
});

for (const [id, fn] of [
  ['tb-left', () => game.moveLane(-1)],
  ['tb-right', () => game.moveLane(1)],
  ['tb-jump', () => game.jump()],
]) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('touchstart', (e) => { e.preventDefault(); fn(); }, { passive: false });
}
const tbDuck = document.getElementById('tb-duck');
if (tbDuck) {
  tbDuck.addEventListener('touchstart', (e) => { e.preventDefault(); game.setDuck(true); }, { passive: false });
  tbDuck.addEventListener('touchend', (e) => { e.preventDefault(); game.setDuck(false); }, { passive: false });
}

window.addEventListener('resize', () => world.resize());

/* ================= 流程 ================= */

ui.buildThemePicker((name) => setTheme(name));
ui.setTheme(world.themeName);
ui.buildModePicker((name) => pickMode(name));
ui.setMode(game.mode);

document.getElementById('btn-pose').addEventListener('click', () => startPoseMode());
document.getElementById('btn-keyboard').addEventListener('click', () => startKeyboardMode());

/** 上次现场识别效果更好时才记住：下次直接用高精度模型起步，省一次现场切换 */
function savedModelQuality() {
  try { return localStorage.getItem('camDodge.modelQuality') || 'lite'; } catch { return 'lite'; }
}

async function startPoseMode() {
  phase = 'initCam';
  ui.showScreen('calib');
  ui.setCalibProgress(0.05, '正在请求摄像头权限…<br><small>请在浏览器弹窗中点击「允许」</small>');
  document.getElementById('cam-panel').classList.add('show');

  try {
    await tracker.openCamera(ui.el.video, perf.camQuality);
  } catch (e) {
    console.error(e);
    ui.toast('摄像头不可用，已切换为键盘模式', 3200);
    return startKeyboardMode();
  }

  ui.setCalibProgress(0.2, '正在加载姿态识别模型…<br><small>首次加载约需数秒</small>');
  try {
    const delegate = await tracker.loadModel(savedModelQuality());
    console.log('[main] MediaPipe delegate =', delegate, 'model =', tracker.quality);
  } catch (e) {
    console.error(e);
    ui.toast('模型加载失败，已切换为键盘模式', 3200);
    return startKeyboardMode();
  }

  inputMode = 'pose';
  gesture.reset();
  phase = 'calib';
  calibStartAt = Date.now();
  ui.setCalibProgress(0.2, '请站直、正对摄像头<br><small>正在采集体态基准…</small>');
  tracker.start(onPoseResult);

  /* 标定看护：把诊断信息实时显示在标定屏上，并在需要时自动升级模型 */
  let upgraded = false;
  if (calibWatch) clearInterval(calibWatch);
  calibWatch = setInterval(async () => {
    if (phase !== 'calib') { clearInterval(calibWatch); calibWatch = null; return; }
    ui.setCamDiag(buildDiagRows(), buildDiagAdvice());
    // 连着 25 次检测都看不到人：先升级到高精度模型再试一轮，
    // 比直接把玩家踢进键盘模式体面得多
    if (!upgraded && tracker.calls >= 25 && tracker.hits === 0 && tracker.quality !== 'full') {
      upgraded = true;
      ui.setCalibProgress(0.35, '识别效果不佳，正在切换到高精度模型…<br><small>首次切换约需数秒</small>');
      try {
        await tracker.switchModel('full');
        try { localStorage.setItem('camDodge.modelQuality', 'full'); } catch {}
        ui.toast('已切换到高精度识别模型，请保持正对摄像头', 2600);
      } catch (e) { console.warn('[main] 升级模型失败', e); }
    }
  }, 400);

  // 标定超时保护：12 秒还采不够才降级。
  // 5 秒太短 —— 模型预热、玩家还没站好位就被误踢进键盘模式，
  // 且提示一闪而过，看起来就像"摄像头模式凭空消失"。
  setTimeout(() => {
    if (phase !== 'calib') return;
    if (gesture.finishCalibration()) beginRun();
    else {
      ui.toast('一直没识别到人体，已切到键盘模式。可按 ESC 重试摄像头', 4200);
      startKeyboardMode();
    }
  }, 12000);
}

/* ---------- 摄像头诊断：识别不出人体时，要明确告诉玩家差在哪 ---------- */

let calibWatch = null;
let calibStartAt = 0;

function buildDiagRows() {
  const v = tracker.video;
  const rate = tracker.calls > 0 ? Math.round((tracker.hits / tracker.calls) * 100) : 0;
  return [
    ['画面', v && v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '未取到画面'],
    ['模型', `${tracker.quality === 'full' ? '高精度' : '快速'} · ${tracker.delegate || '-'}`],
    ['检测', tracker.calls ? `${tracker.fps}fps · 命中 ${rate}%` : '未开始检测'],
    ['亮度', tracker.brightness ? `${tracker.brightness}${tracker.boosting ? '（已提亮）' : ''}` : '—'],
  ];
}

function buildDiagAdvice() {
  if (Date.now() - calibStartAt < 1500) return '';
  if (tracker.calls === 0) return '摄像头没输出画面：确认没被腾讯会议/微信/OBS 等软件占用';
  if (tracker.hits === 0) {
    if (tracker.brightness && tracker.brightness < 45) return '光线太暗：请开灯，或换个背对窗户的位置';
    if (tracker.quality === 'full') return '还没找到人体：把整个上半身放进画面，距摄像头 1.5–2.5 米，别贴太近';
    return '没检测到人体：请正对摄像头，让头和双肩完整出现在画面里';
  }
  return '已锁定人体，请站直别动…';
}

/* ---------- 响应速度看护：别被"高精度模型"悄悄拖慢 ----------
   高精度（full）模型识别更稳，但实测单次推理约为快速（lite）的 2 倍。
   识别耗时一旦超过 45ms，帧间隔就被推理时间主导，手感立刻变成"慢半拍"。
   更麻烦的是：之前为了救"识别不出人体"，一旦连续看不到人就会自动升级到 full
   并永久写进 localStorage —— 于是哪怕后来只是光线差了一下，
   之后每次开局都被锁在慢模型上，玩家只会觉得"这游戏怎么这么钝"。

   这里的策略：只有在"人确实识别得到、但推理明显偏慢"时才退回 lite。
   人识别不到时不能退 —— 那正是需要 full 的场合。 */
let speedGuardDone = false;
function speedGuard() {
  if (speedGuardDone || phase !== 'running') return;
  if (tracker.quality !== 'full') { speedGuardDone = true; return; }
  if (tracker.calls < 30 || tracker.hits === 0 || tracker.detectMs <= 0) return;
  speedGuardDone = true;
  if (tracker.detectMs > 45) {
    tracker.switchModel('lite')
      .then(() => {
        try { localStorage.setItem('camDodge.modelQuality', 'lite'); } catch {}
        ui.toast('识别耗时偏高，已切回快速模型以提升响应速度', 2600);
      })
      .catch(() => {});
  }
}
setInterval(speedGuard, 1000);

function startKeyboardMode() {
  inputMode = 'keyboard';
  tracker.stop();          // 停下识别回路，彻底交还控制权，也省掉这部分的算力开销
  latestLandmarks = null;
  document.getElementById('cam-panel').classList.remove('show'); // 别让黑屏的摄像头小窗留在界面上
  ui.hideAllScreens();
  ui.toast('键盘模式：←/→ 变道，W/↑ 跳，↓ 蹲，F 挥拳，空格 暂停，M 换地图，B 换背景', 3600);
  restart();
}

function beginRun() {
  phase = 'running';
  clearPause();
  game.reset();
  game.start();
  ui.hideAllScreens();
  ui.toast(`开始！【${game.modeConf.label}】左右变道，跳/蹲过障碍，挥拳打小恶魔（空格可暂停）`, 3000);
}

function restart() {
  game.reset();
  game.start();
  phase = 'running';
  clearPause();
  ui.hideAllScreens();
}

document.getElementById('btn-restart').addEventListener('click', restart);

// 标定卡住时的出口：只要画面里出现过人就允许用现有采样直接开跑，
// 别让玩家在标定屏上干等（现场演示时间宝贵）
const btnSkip = document.getElementById('btn-skip-calib');
if (btnSkip) {
  btnSkip.addEventListener('click', () => {
    if (gesture.finishCalibration(1)) {
      ui.toast('已跳过标定，直接用当前姿态开跑', 2400);
      beginRun();
    } else {
      ui.toast('画面里还没有人体，无法跳过标定', 2400);
    }
  });
}
document.getElementById('btn-back').addEventListener('click', () => {
  phase = 'idle';
  game.reset();
  ui.showScreen('start');
});

/* ================= 调试面板 ================= */
setInterval(() => {
  if (!ui.isDebugOpen()) return;
  const d = Object.assign({}, gesture.debug || {});
  d.phase = phase;
  d.input = inputMode;
  d.lane = lastGesture.lane;
  d.jumpY = game.jumpY.toFixed(2);
  d.speed = game.speed.toFixed(1);
  d.obstacles = game.obstacles.length;
  d.delegate = tracker.delegate || '-';
  d['模型'] = tracker.quality === 'full' ? '高精度' : '快速';
  d['识别ms'] = tracker.detectMs.toFixed(1);
  d['识别帧率'] = tracker.fps;
  d['检出率'] = tracker.calls ? `${Math.round((tracker.hits / tracker.calls) * 100)}%` : '—';
  d['亮度'] = tracker.brightness + (tracker.boosting ? '(提亮)' : '');
  d['驱动'] = tracker._useRvfc ? 'rvfc' : 'rAF';
  d['结果龄ms'] = Math.round(tracker.ageMs());
  d['节流'] = tracker.throttle;
  d['画质档'] = perf.level;
  d['渲染FPS'] = perf.fps;
  ui.setDebug(d);
}, 200);
document.getElementById('btn-debug').addEventListener('click', () => ui.toggleDebug());

document.getElementById('dep-info').textContent =
  CFG.mode === 'local' ? '本地离线依赖' : 'CDN 在线依赖';

// 自动化测试入口：?autocam=1 自动进入摄像头模式（配合浏览器假摄像头做端到端验证）
if (new URLSearchParams(location.search).has('autocam')) {
  // 注意：window.__err 由 index.html 的 <head> 内联脚本建立（那里能覆盖到
  // 模块加载阶段的异常，这里太晚了，别重复建）。

  // 主动可读的状态快照：测试脚本通过 CDP evaluate 直接取，
  // 不再依赖 console 日志的投递（无头浏览器里 console 抓取很不稳定）。
  window.__probe = () => {
    const MC = game.modeConf;
    // 本车道里"最靠近玩家的那只恶魔" —— e2e 靠它读血条，验证一拳一格血而不是一拳秒
    let near = null;
    for (const d of game.demons) {
      if (Math.abs(game.laneF - d.lane) > 0.75) continue;
      if (d.z > 2 || d.z < -MC.punchWindow - 2) continue;
      if (!near || d.z > near.z) near = d;
    }
    return {
      phase, input: inputMode, paused,
      quality: tracker.quality, delegate: tracker.delegate || '-',
      calls: tracker.calls, hits: tracker.hits, detectFps: tracker.fps,
      detectMs: +tracker.detectMs.toFixed(1), brightness: tracker.brightness,
      calibN: gesture.calib.n, rvfc: tracker._useRvfc, errs: window.__err.slice(),
      errFull: (window.__errFull || []).concat(),
      badUniform: window.__badUniform && window.__badUniform.__matProbe
        ? JSON.stringify(window.__badUniform.__matProbe) : '',
      theme: world.themeName, bg: world.bgInfo.index, bgTotal: world.bgInfo.total,
      bgLabel: world.bgInfo.label, laneF: +game.laneF.toFixed(2),
      dist: Math.floor(game.distance), obstacles: game.obstacles.length,
      demons: game.demons.length, kills: game.kills, gstate: game.state,
      mode: game.mode, lives: game.lives, livesMax: game.livesMax, hurt: game.hits,
      level: game.level, diffLevel: game.diffLevel, levelsGained: game.levelsGained,
      demonInRange: game.demonInRange,
      punchSrc: gesture.debug && gesture.debug.punchSrc || '',
      extL: gesture.debug && gesture.debug.extL, extR: gesture.debug && gesture.debug.extR,
      demonHp: near ? near.hp : 0, demonMaxHp: near ? near.maxHp : 0,
      demonZ: near ? +near.z.toFixed(1) : 0,
      // 本局累计击退距离 —— e2e 靠它证明"出拳命中确实把怪推远了"
      // （只看怪的位置不可靠：它同时在以十几米/秒逼近）
      knockTotal: +(game.knockTotal || 0).toFixed(1),
      // 打击窗口的数值与规则层模式表保持一致（那边没直接导出，所以这里从 modeConf 读）。
      // 探针报得比真窗口略宽：恶魔在窗口里只待零点几秒，
      // 按真实窗口报会被探针 500ms 的采样间隔整段跳过 —— 报"接近"让按键提前落下，
      // 真正的命中判定仍由规则层按真窗口结算。
      demonNear: game.demons.some((d) =>
        Math.abs(game.laneF - d.lane) <= 0.6 && d.z > -MC.punchWindow - 2 && d.z < 2),
      pauseShown: !!(ui.el.pause && ui.el.pause.classList.contains('show')),
      // "挥拳！"提示是否亮着 —— 它直接跟随规则层的 demonInRange，
      // e2e 靠它验证"怪进打击窗口 → 提示亮 → 打空后熄灭"这条反馈链。
      punchHintShown: !!(ui.el.punchHint && ui.el.punchHint.classList.contains('show')),
      // "来了！"预警档：比怪真进窗口早约 0.45 秒亮起，专门抵消识别延迟
      punchSoonShown: !!(ui.el.punchHint && ui.el.punchHint.classList.contains('soon')),
      demonApproaching: game.demonApproaching,
      // 击退量（e2e 用它证明"命中确实把怪推远了"）与金心颗数（HUD 换算的探针侧口径）
      knockback: MC.knockback,
      goldHearts: Math.floor(game.livesMax / GOLD_HEART),
      // 场上真有"可打"的怪（模型侧地面指示环也跟着它亮）
      demonHittable: game.demons.some((d) => d.hittable),
      // 拳弹链路：出拳次数（规则层）与"此刻在飞的光弹数"（渲染层）。
      // 两个数各说一半 —— 前者证明事件发了，后者证明画面真的把它打出去了。
      shotId: game.shotId,
      shotsFlying: world.shots ? world.shots.length : 0,
      shotsFired: world.shotCount || 0,
      // 渲染开销：景物精修后零件变多，这两个数用来守住"别把帧率做没了"。
      // drawCalls 每帧变，所以探针里取值只是"此刻一帧"的量级参考。
      drawCalls: world.renderer.info.render.calls,
      triangles: world.renderer.info.render.triangles,
      // 场景里的网格总数（含景物零件）——零件数失控时靠它一眼看出来
      meshes: (() => { let n = 0; world.scene.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
    };
  };

  // 测试专用按键注入：直接把 KeyboardEvent 派发给 window，
  // 走的是和真人按键完全相同的处理链路（不是绕过事件去调内部函数）。
  // 这样 M/B/空格 的绑定、preventDefault、暂停分支都能被真实覆盖。
  window.__key = (k) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
  };

  // 测试专用：直接在指定车道/位置生成一只小恶魔（等 e2e 不用碰随机生成的运气）
  window.__testSpawnDemon = (lane = 1, z = -40) => game._addDemon(lane, z);

  // 把带堆栈的异常也记下来：默认的 window.onerror 只给 message，
  // 排查第三方库（MediaPipe/TF）内部抛错时看不出是哪条链路触发的。
  window.__errFull = [];
  window.addEventListener('error', (e) => {
    window.__errFull.push({
      msg: String(e.message || (e.error && e.error.message) || ''),
      stack: String((e.error && e.error.stack) || '').split('\n').slice(0, 6).join(' ⏎ '),
      // 临时诊断：three.js 里那个炸掉的 uniform 到底属于哪个材质
      probe: window.__badUniform && window.__badUniform.__matProbe
        ? JSON.stringify(window.__badUniform.__matProbe) : '',
      matAt: window.__badUniform && window.__badUniform.__matCtor ? window.__badUniform.__matCtor : '',
      at: Math.round(performance.now()),
    });
  });

  // 排查用：把场景里所有"材质带 map、但该材质可能没有 mapTransform uniform"
  // 的 mesh 列出来。three.js 报 Matrix3.copy 时就是这类材质在渲染。
  window.__auditMaps = () => {
    const out = [];
    const seen = new Set();
    world.scene.traverse((o) => {
      const m = o.material;
      if (!m || Array.isArray(m)) return;
      if (!m.map) return;
      const key = m.uuid;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        type: o.type, mat: m.type,
        visible: o.visible && o.parent !== null,
        inScene: !!o.parent,
        uuid: m.uuid.slice(0, 8),
        disposed: !!m.__disposed,
      });
    });
    return out;
  };

  // ?keydrive=1：轮询服务端的按键指令队列（GET /__keycmd，消费型）。
  // 服务端没开 KEY_CMD_FILE 时这个端点 404，这里的 catch 静默吞掉，零副作用。
  // 为什么需要它：无头环境下脚本没法直接调页面函数（CDP 握手不稳），
  // 让页面自己来取指令是最省事且最接近"真人按键"的做法。
  if (new URLSearchParams(location.search).has('keydrive')) {
    setInterval(() => {
      fetch('/__keycmd', { cache: 'no-store' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((txt) => {
          if (!txt) return;
          let cmd = null;
          try { cmd = JSON.parse(txt); } catch { return; }
          if (cmd && cmd.key) window.__key(cmd.key);
          // 测试指令：注入一只小恶魔（key-e2e 验证挥拳链路用，不碰随机生成的运气）
          if (cmd && cmd.cmd === 'spawn' && window.__testSpawnDemon) {
            window.__testSpawnDemon(cmd.lane ?? 1, cmd.z ?? -40);
          }
          // 测试指令：切难度（验证两个模式真的走不同的参数表）
          if (cmd && cmd.cmd === 'mode' && MODES[cmd.name]) pickMode(cmd.name);
          // 测试指令：直接点名切地图（比连按 M 更可控，用来定点验证樱花/地狱景物不报错）
          if (cmd && cmd.cmd === 'theme' && THEMES[cmd.name]) setTheme(cmd.name, true);
          // 测试指令：临时改"每多少米升一级"。
          // 为什么要这个：升级门槛是 400m，真跑要等十几秒才够得着；
          // 把门槛改小只是让同一条 _checkLevelUp 逻辑更快被触发，逻辑本身没被绕过。
          // 用完必须由测试脚本改回去（脚本结尾会还原）。
          if (cmd && cmd.cmd === 'leveldist' && Number.isFinite(cmd.value)) {
            game.modeConf.levelUpDist = Math.max(10, cmd.value | 0);
          }
          // 测试指令：清场（把测试注入的怪收走，别污染后续用例）
          if (cmd && cmd.cmd === 'clear' && phase === 'running') game.clearDemons?.();
          // 测试指令：重开一局（把命/距离复位，让后续用例从干净状态继续）
          if (cmd && cmd.cmd === 'restart' && phase === 'running') { game.reset(); game.start(); }
          // 指令执行完立刻推一次快照，别等 500ms 的定时 POST ——
          // 否则测试脚本按完键读到的还是上一拍的状态，误判成"按键没生效"。
          try {
            fetch('/__probe', { method: 'POST', body: JSON.stringify(window.__probe()) }).catch(() => {});
          } catch { /* 忽略 */ }
        })
        .catch(() => {});
    }, 150);
  }

  // 把状态镜像进 DOM：无头端到端测试用 `--dump-dom` 直接读这段文本。
  // 为什么不走 console / WebSocket：本机无头环境下这两条都不稳 ——
  // 新版 Chrome 不再把页面 console 输出到 stderr，而 Node 内置 WebSocket
  // 与 DevTools 端点的握手实测只有约四分之一成功。DOM 是唯一稳的通道。
  let probeEl = null;
  setInterval(() => {
    if (!probeEl) {
      probeEl = document.createElement('pre');
      probeEl.id = 'probe-out';
      probeEl.style.display = 'none';
      document.body.appendChild(probeEl);
    }
    probeEl.textContent = JSON.stringify(window.__probe());
  }, 300);

  // 另一条通道：POST 给本地服务器落盘（需服务端设了 PROBE_FILE 才生效，否则 404）。
  // 这条是"实时"的，能覆盖到相机 + 模型 + 标定全过程；
  // DOM 那条配合 --dump-dom 只适合做页面启动检查（虚拟时间驱动不了视频管线）。
  setInterval(() => {
    try {
      fetch('/__probe', { method: 'POST', body: JSON.stringify(window.__probe()) }).catch(() => {});
    } catch { /* 忽略 */ }
  }, 500);

  setTimeout(() => { console.log('[probe] click btn-pose'); document.getElementById('btn-pose').click(); }, 600);
  setInterval(() => {
    console.log(`[probe] phase=${phase} input=${inputMode} quality=${tracker.quality} `
      + `calls=${tracker.calls} hits=${tracker.hits} detectFps=${tracker.fps} `
      + `bright=${tracker.brightness} boosting=${tracker.boosting} detectMs=${tracker.detectMs.toFixed(1)} `
      + `calibN=${gesture.calib.n} rvfc=${tracker._useRvfc}`);
  }, 1000);
}
