/**
 * test-pose.mjs —— 手势识别回归测试（纯 Node，无需浏览器 / 摄像头）
 *
 * 用法： node tools/test-pose.mjs
 *
 * 起因：玩家明明没做动作，游戏里的小人却自己跳动 / 变道（幽灵动作）。
 * 根因是判定阈值落在了 MediaPipe 的抖动 + 人体自然漂移区间里，
 * 于是这组测试的核心命题是：
 *
 *   ① 带着噪声和漂移静止站 100 秒 → 一次操作都不许产生
 *   ② 真的做动作时 → 仍然要在很短的延迟里触发（修了误触不能牺牲跟手）
 *
 * 用合成关键点而不是真实视频，是为了让噪声幅度可控、结果可复现。
 */

import { GestureRecognizer } from '../js/pose.js';

/* ================= 合成 MediaPipe 关键点 ================= */

// 33 点里用得上的那些，取一个正对摄像头站立的标准站姿（归一化图像坐标）
const BASE = {
  0:  [0.50, 0.22],                    // 鼻
  11: [0.40, 0.32], 12: [0.60, 0.32],  // 肩
  15: [0.36, 0.62], 16: [0.64, 0.62],  // 腕（自然下垂）
  23: [0.43, 0.55], 24: [0.57, 0.55],  // 髋
  25: [0.42, 0.72], 26: [0.58, 0.72],  // 膝
  27: [0.42, 0.88], 28: [0.58, 0.88],  // 踝
};

/**
 * @param {object} o
 *   bodyDy   整体上抬（负）/ 下沉（正）
 *   bodyDx   整体左右平移
 *   crouch   0..1 蹲姿程度（髋下沉 + 膝前顶，会让屈膝角真正变小）
 *   armsUp   0..1 抬手程度
 *   lowerVis 下半身关键点的可见度（模拟只拍到上半身的场景）
 */
function pose(o = {}) {
  const lms = new Array(33);
  for (let i = 0; i < 33; i++) lms[i] = { x: 0.5, y: 0.5, visibility: 0 };
  const put = (i, x, y) => { lms[i] = { x, y, visibility: 1 }; };
  const { bodyDy = 0, bodyDx = 0, crouch = 0, armsUp = 0, punchR = 0, hookR = 0, lowerVis = 1 } = o;

  for (const k of Object.keys(BASE)) {
    const [x, y] = BASE[k];
    put(+k, x + bodyDx, y + bodyDy);
  }

  // 只拍到上半身时，MediaPipe 仍在输出髋/膝/踝，但那是"猜"的，可见度很低
  if (lowerVis < 1) {
    for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) lms[i].visibility = lowerVis;
  }

  if (crouch > 0) {
    for (const i of [0, 11, 12, 23, 24]) lms[i].y += 0.09 * crouch;
    // 膝盖向前顶 —— 正面视角投影到左右方向上。少了这一步，
    // 髋膝踝三点还是共线，屈膝角度判不出来。
    lms[25].x += 0.07 * crouch;
    lms[26].x -= 0.07 * crouch;
  }
  if (armsUp > 0) {
    for (const i of [15, 16]) lms[i].y += (0.20 - BASE[i][1]) * armsUp;
  }
  if (punchR > 0) {
    // 右拳向摄像头方向打出去：腕部 z 变负（MediaPipe 里 z 越负越近），
    // 同时手腕抬到胸口高度、往身体中线收一点（真实出拳的姿态投影）。
    lms[16].z = -0.28 * punchR;
    lms[16].y = 0.62 + (0.50 - 0.62) * punchR;
    lms[16].x = 0.64 + (0.55 - 0.64) * punchR;
  }
  if (hookR > 0) {
    // 侧勾拳：手腕在画面里快速横扫（x/y 大幅变化），z 几乎不动。
    // 对应"手上这台摄像头 z 轴不可靠"的现实场景 ——
    // 新版的"手腕画面甩速"兜底通道专门捞这种情况。
    lms[16].x = 0.64 + 0.30 * hookR;
    lms[16].y = 0.62 - 0.18 * hookR;
  }
  return lms;
}

/* ================= 仿真驱动 ================= */

/**
 * @param {number} frames 帧数（按 30fps 计）
 * @param {(i:number, t:number) => object|null} script
 *        返回姿态参数对象；返回 null 代表"这一帧没识别到人体"
 * @param {object} opts { noise, drift, seed }
 */
function simulate(frames, script, opts = {}) {
  const g = new GestureRecognizer();
  const step = 1000 / 30;
  const nAmp = opts.noise ?? 0.008;   // 白噪声：MediaPipe 逐帧抖动
  const dAmp = opts.drift ?? 0.015;   // 低频漂移：呼吸 / 重心转移
  let seed = opts.seed ?? 20240928;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };

  let t = 0;
  const zNoise = opts.zNoise ?? 0.008;  // z 轴噪声（MediaPipe 的 z 比 x/y 抖）
  // z 噪声用独立的随机源：不与 x/y 共用 rnd() 序列。
  // 否则多调用一次 rnd 就会挪动整条随机流，让旧用例"恰好过/恰好不过"的
  // 边界结果随序列漂移 —— 测试会莫名红掉，与产品代码无关。
  let zSeed = (opts.seed ?? 20240928) ^ 0x9e3779b9;
  const zRnd = () => {
    zSeed = (zSeed * 1103515245 + 12345) % 2147483648;
    return zSeed / 2147483648 - 0.5;
  };
  const build = (i, o) => {
    if (!o) return null;
    const p = pose(o);
    const sy = Math.sin((i / 30) * 0.9) * dAmp;
    const sx = Math.sin((i / 30) * 0.6 + 1.2) * dAmp * 1.2;
    for (const q of p) {
      if (!q.visibility) continue;
      q.y += rnd() * 2 * nAmp + sy;
      q.x += rnd() * 2 * nAmp + sx;
      q.z = (q.z || 0) + zRnd() * 2 * zNoise;
    }
    return p;
  };

  // 标定阶段：站直不动
  for (let i = 0; i < 46; i++) {
    const p = builtAt(i);
    if (p) g.feedCalibration(p);
    t += step;
  }
  function builtAt(i) { return build(i, { bodyDy: 0, bodyDx: 0 }); }

  if (!g.finishCalibration()) throw new Error('标定失败：采样不足');

  const ev = { jumps: [], duckEdges: [], laneChanges: [], punches: [] };
  let lane = g.state.lane;
  let duck = false;

  for (let i = 0; i < frames; i++) {
    t += step;
    const raw = script(i, t);
    const s = g.update(raw === null ? null : build(i + 46, raw), t);
    if (s.jump) ev.jumps.push(i);
    if (s.punch) ev.punches.push(i);
    if (s.punch) (ev.dbg ||= []).push({ i, ...g.debug });
    if (s.duck !== duck) ev.duckEdges.push({ frame: i, on: s.duck });
    duck = s.duck;
    if (s.lane !== lane) { ev.laneChanges.push({ frame: i, from: lane, to: s.lane }); lane = s.lane; }
    if (g.debug.lost) ev.lost++;
  }
  return { g, ev };
}

/* ================= 断言 ================= */

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  ${extra}`); }
};

console.log('\n--- ① 静止不动：不许产生任何操作 ---');
{
  const SEC = 100;
  const F = SEC * 30;
  const { ev } = simulate(F, () => ({}), { noise: 0.008, drift: 0.015 });
  const ducks = ev.duckEdges.filter((e) => e.on).length;
  console.log(`  模拟 ${SEC}s（含白噪声 + 低频漂移）：跳 ${ev.jumps.length} 次 · 蹲 ${ducks} 次 · 变道 ${ev.laneChanges.length} 次`);
  check('静止 100s 零误跳', ev.jumps.length === 0, `jumps=${ev.jumps.length}`);
  check('静止 100s 零误蹲', ducks === 0, `duck=${ducks}`);
  check('静止 100s 零误变道', ev.laneChanges.length === 0, `lane=${JSON.stringify(ev.laneChanges)}`);
}
{
  // 更恶劣：抖得更凶 + 漂移更大幅（比如站得远、光线差、背后有人影）
  const { ev } = simulate(100 * 30, () => ({}), { noise: 0.014, drift: 0.028, seed: 777 });
  const ducks = ev.duckEdges.filter((e) => e.on).length;
  console.log(`  强干扰场景：跳 ${ev.jumps.length} · 蹲 ${ducks} · 变道 ${ev.laneChanges.length}`);
  check('强干扰下仍零误触发',
    ev.jumps.length === 0 && ducks === 0 && ev.laneChanges.length === 0,
    JSON.stringify({ j: ev.jumps.length, d: ducks, l: ev.laneChanges.length }));
}

console.log('\n--- ② 真做动作：必须响应，且要快 ---');
{
  // 200 帧处开始上抬，持续 0.5s
  const START = 200;
  const { ev } = simulate(400, (i) => {
    if (i < START) return {};
    const k = Math.min(1, (i - START) / 15);   // 15 帧内完成起跳
    return { bodyDy: -0.10 * k };
  }, {});
  const delay = ev.jumps.length ? ev.jumps[0] - START : Infinity;
  console.log(`  起跳后第 ${delay} 帧触发（约 ${(delay / 30 * 1000).toFixed(0)}ms）`);
  check('起跳能被识别', ev.jumps.length > 0, '没有任何一次起跳被识别到');
  check('起跳响应延迟 < 400ms', delay <= 12, `delay=${delay}帧`);
}
{
  // 间隔 1.2s 跳五次，每次都不该被冷却吃掉
  const { ev } = simulate(30 * 10, (i) => {
    const cycle = i % 36;                     // 1.2s 一个周期
    if (cycle < 15) return { bodyDy: -0.10 * (cycle / 15) };
    return {};
  }, {});
  check('连续 8 次跳跃全部识别（冷却期不吞动作）', ev.jumps.length >= 8, `识别到 ${ev.jumps.length} 次`);
}
{
  const START = 200;
  const HOLD = 60;                                  // 蹲 2 秒
  const { ev } = simulate(START + HOLD + 120, (i) => {
    if (i < START) return {};
    if (i < START + HOLD) return { crouch: 1 };
    return {};
  }, {});
  const down = ev.duckEdges.find((e) => e.on);
  const up = ev.duckEdges.find((e) => !e.on && down && e.frame > down.frame);
  const delay = down ? down.frame - START : Infinity;
  console.log(`  下蹲后第 ${delay} 帧生效，松手后第 ${up ? up.frame - (START + HOLD) : '--'} 帧解除`);
  check('下蹲能被识别', !!down);
  check('下蹲响应延迟 < 400ms', delay <= 12, `delay=${delay}帧`);
  check('站着不动期间不会自己蹲下', !ev.duckEdges.some((e) => e.on && e.frame < START),
    '在下达蹲指令前就蹲了');
  check('松手后蹲姿会解除（不会卡住）', !!up, '松开后一直卡在蹲姿');
  check('解除延迟 < 400ms', up && up.frame - (START + HOLD) <= 12,
    `delay=${up ? up.frame - (START + HOLD) : '∞'}帧`);
}
{
  const START = 150;
  const { ev } = simulate(400, (i) => {
    if (i < START) return {};
    return { bodyDx: 0.14 };                  // 向一侧走一步
  }, {});
  const c = ev.laneChanges[0];
  console.log(`  侧移后第 ${c ? c.frame - START : '--'} 帧变道 → ${c ? c.to : '未触发'}`);
  check('侧移一步能触发变道', !!c, '完全没有响应');
  check('变道响应延迟 < 530ms', c && c.frame - START <= 16, `delay=${c ? c.frame - START : '∞'}帧`);
}
{
  // 只是稍微侧一点点身子（够不上"走一步"）不该变道
  const { ev } = simulate(30 * 20, (i) => (i < 100 ? {} : { bodyDx: 0.035 }), {});
  check('轻微侧身不应变道', ev.laneChanges.length === 0, `触发了 ${ev.laneChanges.length} 次`);
}

console.log('\n--- ②.5 挥拳：快速出拳打小恶魔 ---');
{
  // 200 帧处开始出拳，5 帧内打到位，然后保持伸直 1.5s
  const START = 200;
  const { ev } = simulate(START + 60 + 90, (i) => {
    if (i < START) return {};
    const k = Math.min(1, (i - START) / 5);
    return { punchR: k };
  }, {});
  const delay = ev.punches.length ? ev.punches[0] - START : Infinity;
  console.log(`  出拳后第 ${delay} 帧触发（约 ${(delay / 30 * 1000).toFixed(0)}ms），共触发 ${ev.punches.length} 次`);
  check('快速出拳能被识别', ev.punches.length > 0, '没有任何一拳被识别到');
  check('出拳响应延迟 < 330ms', delay <= 10, `delay=${delay}帧`);
  check('保持伸拳不会连续触发（latch 生效）', ev.punches.length === 1,
    `触发了 ${ev.punches.length} 次：${JSON.stringify(ev.punches)}`);
}
{
  // 收回再打出 → 允许下一拳（一伸一收算一拳）
  const { ev } = simulate(30 * 8, (i) => {
    const cycle = i % 60;                     // 2s 一个周期
    if (cycle < 5) return { punchR: cycle / 5 };        // 5 帧打出
    if (cycle < 45) return { punchR: 1 };               // 保持 1.3s
    return { punchR: Math.max(0, 1 - (cycle - 45) / 10) }; // 10 帧收回
  }, {});
  console.log(`  8 秒内反复出拳：识别到 ${ev.punches.length} 次`);
  check('收回后可以再次出拳（冷却不吞动作）', ev.punches.length >= 3,
    `识别到 ${ev.punches.length} 次`);
}
{
  // ★ 连打节奏 —— 这是"还没打死就被撞上"的另一半解法（另一半是 game.js 的击退）。
  //   实战里的节奏就是"伸-收-伸-收"，一拳接一拳地追打。
  //   旧参数（COOLDOWN 320 / REARM 380）最快也只能打出 3 拳/秒，
  //   而怪贴脸时的打击窗口只有一秒多 —— 数学上就是打不完。
  //   这里按 300ms 一个来回连打，要求一拳都不被冷却吞掉。
  const START = 200, CYCLE = 9, EXPAND = 5;
  const { ev } = simulate(START + 30 * 4, (i) => {
    if (i < START) return {};
    const c = (i - START) % CYCLE;
    return { punchR: c < EXPAND ? 1 : 0 };   // 5 帧伸出 + 4 帧收回
  }, {});
  console.log(`  300ms 一个来回连打 4 秒（约 13 个来回）：识别到 ${ev.punches.length} 次拳`);
  check('300ms 一个来回的连打，一拳都不会被冷却吞掉',
    ev.punches.length >= 10, `只识别到 ${ev.punches.length} 次（期望 ≈13）`);
}
{
  // 慢慢前倾 / 缓慢伸手：速度通道必须挡住（够不到 PUNCH_VEL）
  const { ev } = simulate(30 * 15, (i) => {
    if (i < 120) return {};
    return { punchR: Math.min(0.9, (i - 120) / 120) };  // 4 秒才慢慢伸到 0.9
  }, {});
  check('缓慢前倾/伸手不触发出拳', ev.punches.length === 0,
    `误触发了 ${ev.punches.length} 次 ${JSON.stringify(ev.dbg)}`);
}
{
  // 静止（含 z 噪声）整段不挥拳
  const { ev } = simulate(100 * 30, () => ({}), { noise: 0.008, drift: 0.015 });
  check('静止 100s 零误挥拳', ev.punches.length === 0, `punches=${ev.punches.length}`);
}
{
  // ★ 侧勾拳：z 通道几乎不动，全靠"手腕画面甩速"这条兜底通道接住。
  //   这正是实机上"明明挥了拳却识别不出来"的典型场景之一。
  const START = 200;
  const { ev } = simulate(START + 60 + 90, (i) => {
    if (i < START) return {};
    return { hookR: Math.min(1, (i - START) / 5) };
  }, {});
  const d = ev.punches.length ? ev.punches[0] - START : Infinity;
  check('侧勾拳（z 基本不变、手腕在画面里横扫）也能识别',
    ev.punches.length >= 1, `识别到 ${ev.punches.length} 次，delay=${d}帧`);
  check('侧勾拳响应延迟 < 330ms', d <= 10, `delay=${d}帧`);
}
{
  // ★ 小幅出拳（前伸量只到 ~0.3 个肩宽）：旧的 0.42 阈值根本打不出来，
  //   新阈值必须认。这是"打不到怪"最直接的成因，专门锁住它。
  const START = 200;
  const { ev } = simulate(START + 60 + 90, (i) => {
    if (i < START) return {};
    return { punchR: 0.25 * Math.min(1, (i - START) / 5) };
  }, {});
  check('小幅出拳（伸得不算远）也能识别 —— 实机打不到怪的主要成因',
    ev.punches.length >= 1, `识别到 ${ev.punches.length} 次`);
}
{
  // 手腕在画面里缓慢晃动（远低于兜底速度线）→ 不许误触发
  const { ev } = simulate(30 * 15, (i) => {
    if (i < 120) return {};
    return { hookR: Math.min(1, (i - 120) / 100) };   // 3.3s 才慢慢晃到位
  }, {});
  check('手腕缓慢晃动不触发出拳', ev.punches.length === 0, `误触发 ${ev.punches.length} 次`);
}

console.log('\n--- ③ 对照：修复前的"固定基线"行为会怎样 ---');
{
  // v5 之前的实现把 dy 直接相对"标定那一刻的固定基准"算，且阈值落在自然漂移带里，
  // 于是站着不动也会持续误触发（幽灵动作）。现在 dy 相对"会缓慢追随漂移的慢基线"，
  // 漂移被吸收掉，阈值只响应真实动作。
  // 这个对照让 OLD 配置禁用慢基线（退化成固定基线，逼近旧实现），
  // 再用足以越过旧阈值的漂移幅度喂进去，量化"同样站着不动"会误触发多少次。
  const OLD = {
    DEAD: 0,           // 旧版没有死区
    RISE: 0.085, DROP: 0.09,
    LANE_TH: 0.20, LANE_BACK: 0.10, LANE_DWELL: 0,
    LANE_STRONG: 999,  // 旧版没有"大幅移动立刻响应"这一档
    DRIFT_FOLLOW: 0,   // 旧版基线固定在标定那一刻，不吸收漂移
    REBASE_RATE: 0,
    QUIET: 0,
    MAX_ATTACK: 1e9,   // 旧版无攻击时间门控
    CONFIRM: 1,        // 旧版单帧即触发
    RISE_VEL: 1e9, RISE_VEL_FAST: 1e9, PRED: 0,  // 关掉速度预判红利
    EMA: 0.35,
  };
  const run = (cfgOverride, seed, driftAmp) => {
    const mod = new GestureRecognizer(cfgOverride);
    const step = 1000 / 30;
    let s2 = seed;
    const rnd = () => { s2 = (s2 * 1103515245 + 12345) % 2147483648; return s2 / 2147483648 - 0.5; };
    let t = 0;
    const mkFrame = (i) => {
      const p = pose({});
      const sy = Math.sin((i / 30) * 0.9) * driftAmp;
      const sx = Math.sin((i / 30) * 0.6 + 1.2) * driftAmp * 1.2;
      for (const q of p) {
        if (!q.visibility) continue;
        q.y += rnd() * 2 * 0.008 + sy;
        q.x += rnd() * 2 * 0.008 + sx;
      }
      return p;
    };
    for (let i = 0; i < 46; i++) { mod.feedCalibration(mkFrame(i)); t += step; }
    mod.finishCalibration();
    const c = { jump: 0, duck: 0, lane: 0 };
    let prev = mod.state.lane, duck = false;
    for (let i = 0; i < 100 * 30; i++) {
      t += step;
      const st = mod.update(mkFrame(i + 46), t);
      if (st.jump) c.jump++;
      if (st.duck && !duck) c.duck++;
      duck = st.duck;
      if (st.lane !== prev) { c.lane++; prev = st.lane; }
    }
    return c;
  };

  const DRIFT = 0.04;  // 让漂移峰值足以越过旧阈值 0.085，复现幽灵动作
  const old = run(OLD, 20240928, DRIFT);
  const now = run({}, 20240928, DRIFT);
  console.log(`  固定基线(旧) ${DRIFT} 漂移：误跳 ${old.jump} · 误蹲 ${old.duck} · 误变道 ${old.lane}`);
  console.log(`  慢基线(新) ${DRIFT} 漂移：误跳 ${now.jump} · 误蹲 ${now.duck} · 误变道 ${now.lane}`);
  check('固定基线确实复现了幽灵动作', old.jump + old.duck + old.lane > 0, '没复现，说明对照无效');
  check('慢基线消除了幽灵动作', now.jump + now.duck + now.lane === 0);
}

console.log('\n--- ④ 识别丢失的处理 ---');
{
  // 先蹲下，再让画面里"没人"
  let duckAfterLost = 0;
  const g = new GestureRecognizer();
  let t = 0;
  for (let i = 0; i < 46; i++) { g.feedCalibration(pose({})); t += 1000 / 30; }
  g.finishCalibration();
  for (let i = 0; i < 60; i++) { t += 1000 / 30; g.update(pose({ crouch: 1 }), t); }
  const beforeLost = g.state.duck;
  for (let i = 0; i < 30; i++) {
    t += 1000 / 30;
    const s = g.update(new Array(33).fill(null), t);
    if (s.duck) duckAfterLost++;
  }
  check('蹲下状态能被识别到', beforeLost === true);
  check('人体消失后立刻松开蹲姿', duckAfterLost === 0, `仍有 ${duckAfterLost} 帧卡在蹲下`);
}

console.log('\n--- ⑤ 半身入镜：笔记本摄像头凑近用 ---');
{
  // 场景：只拍到上半身，髋/膝/踝是模型猜出来的（可见度 0.15）。
  // 上一版把髋部可见度也设了硬门槛 → 这种场景每一帧都被拒收，
  // 标定永远采不满，5 秒后被静默踢进键盘模式 —— 就是"摄像头模式消失"。
  const LV = 0.15;
  const g = new GestureRecognizer();
  let t = 0;
  for (let i = 0; i < 60; i++) { g.feedCalibration(pose({ lowerVis: LV })); t += 1000 / 30; }
  const calibOk = g.finishCalibration();
  check('半身场景标定能采满', calibOk, '采样不足（复现了消失 bug）');
  if (calibOk) {
    let duckAt = -1;
    for (let i = 0; i < 40; i++) {
      t += 1000 / 30;
      const k = Math.min(1, (i + 1) / 10);
      const s = g.update(pose({ lowerVis: LV, crouch: k }), t);
      if (s.duck && duckAt < 0) duckAt = i;
    }
    check('自动切换为半身模式', g.mode === 'half', `mode=${g.mode}`);
    check('半身下蹲能识别', duckAt >= 0 && duckAt <= 12, `duckAt=${duckAt}`);

    let released = false;
    for (let i = 0; i < 40; i++) {
      t += 1000 / 30;
      if (!g.update(pose({ lowerVis: LV }), t).duck) { released = true; break; }
    }
    check('半身蹲姿能解除', released);

    // 防止这次修改把全身场景削弱
    const g2 = new GestureRecognizer();
    let t2 = 0;
    for (let i = 0; i < 60; i++) { g2.feedCalibration(pose({})); t2 += 1000 / 30; }
    g2.finishCalibration();
    g2.update(pose({}), t2 += 33);
    check('全身场景仍是 full 模式', g2.mode === 'full', `mode=${g2.mode}`);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
