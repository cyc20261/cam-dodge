/**
 * latency.mjs —— 动作响应延迟 & 幽灵动作 量化探针
 *
 * 用法： node tools/latency.mjs
 *
 * 为什么单独做这个：test-pose.mjs 里的动作是"瞬间跳变"（bodyDx 一步到位），
 * 测出来永远是 0 帧，掩盖了真实人体"斜坡发力"时才暴露的延迟
 * （EMA 滞后 + 连续帧确认 + 窗口位移累加）。
 * 这里改成"用 N 帧斜坡完成一个动作"，才是玩家真实的手感。
 *
 * 输出：每种动作在 快速/中速/慢速 三种发力下的首帧触发延迟（帧 / ms）。
 */

import { GestureRecognizer } from '../js/pose.js';

const BASE = {
  0:  [0.50, 0.22],
  11: [0.40, 0.32], 12: [0.60, 0.32],
  15: [0.36, 0.62], 16: [0.64, 0.62],
  23: [0.43, 0.55], 24: [0.57, 0.55],
  25: [0.42, 0.72], 26: [0.58, 0.72],
  27: [0.42, 0.88], 28: [0.58, 0.88],
};

function pose(o = {}) {
  const lms = new Array(33);
  for (let i = 0; i < 33; i++) lms[i] = { x: 0.5, y: 0.5, visibility: 0 };
  const put = (i, x, y) => { lms[i] = { x, y, visibility: 1 }; };
  const { bodyDy = 0, bodyDx = 0, crouch = 0, armsUp = 0, lowerVis = 1 } = o;
  for (const k of Object.keys(BASE)) { const [x, y] = BASE[k]; put(+k, x + bodyDx, y + bodyDy); }
  if (lowerVis < 1) for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) lms[i].visibility = lowerVis;
  if (crouch > 0) {
    for (const i of [0, 11, 12, 23, 24]) lms[i].y += 0.09 * crouch;
    lms[25].x += 0.07 * crouch; lms[26].x -= 0.07 * crouch;
  }
  if (armsUp > 0) for (const i of [15, 16]) lms[i].y += (0.20 - BASE[i][1]) * armsUp;
  return lms;
}

const STEP = 1000 / 30;

/** 通用仿真：标定后跑 frames 帧，script(i) 返回姿态参数 */
function sim(cfg, frames, script, opts = {}) {
  const g = new GestureRecognizer(cfg);
  const nAmp = opts.noise ?? 0.008;
  const dAmp = opts.drift ?? 0.015;
  let seed = opts.seed ?? 20240928;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  let t = 0;
  const build = (i, o) => {
    if (!o) return null;
    const p = pose(o);
    const sy = Math.sin((i / 30) * 0.9) * dAmp;
    const sx = Math.sin((i / 30) * 0.6 + 1.2) * dAmp * 1.2;
    for (const q of p) { if (!q.visibility) continue; q.y += rnd() * 2 * nAmp + sy; q.x += rnd() * 2 * nAmp + sx; }
    return p;
  };
  for (let i = 0; i < 46; i++) { g.feedCalibration(build(i, {})); t += STEP; }
  if (!g.finishCalibration()) throw new Error('标定失败');

  const out = { jumps: [], duckEdges: [], laneChanges: [] };
  let lane = g.state.lane, duck = false;
  for (let i = 0; i < frames; i++) {
    t += STEP;
    const o = script(i);
    const s = g.update(o === null ? null : build(i + 46, o), t);
    if (s.jump) out.jumps.push(i);
    if (s.duck !== duck) out.duckEdges.push({ frame: i, on: s.duck });
    duck = s.duck;
    if (s.lane !== lane) { out.laneChanges.push({ frame: i, from: lane, to: s.lane }); lane = s.lane; }
  }
  return out;
}

const ms = (f) => (f === Infinity ? '∞' : `${Math.round(f * STEP)}ms`);

/* ---------- 幽灵动作免疫 ---------- */
function ghost(cfg) {
  const a = sim(cfg, 100 * 30, () => ({}), { noise: 0.008, drift: 0.015 });
  const b = sim(cfg, 100 * 30, () => ({}), { noise: 0.014, drift: 0.028, seed: 777 });
  const n = (e) => e.jumps.length + e.duckEdges.filter((x) => x.on).length + e.laneChanges.length;
  return { normal: n(a), strong: n(b) };
}

const START = 200;
/** 在 rampF 帧内线性完成动作，之后保持 */
const ramp = (rampF, peak, key) => (i) => {
  if (i < START) return {};
  const k = Math.min(1, (i - START) / rampF);
  return { [key]: peak * k };
};

function latencies(cfg, rampF) {
  const j = sim(cfg, 500, ramp(rampF, -0.10, 'bodyDy'), {});
  const l = sim(cfg, 500, ramp(rampF, 0.14, 'bodyDx'), {});
  const d = sim(cfg, 500, ramp(rampF, 1, 'crouch'), {});
  const jd = j.jumps.length ? j.jumps[0] - START : Infinity;
  const ld = l.laneChanges.length ? l.laneChanges[0].frame - START : Infinity;
  const de = d.duckEdges.find((e) => e.on);
  const dd = de ? de.frame - START : Infinity;
  return { jump: jd, lane: ld, duck: dd };
}

/* ---------- 报告 ----------
   候选配置从 argv[2] 传入（JSON 数组），方便一次扫多组参数：
     node tools/latency.mjs '[{"name":"A","cfg":{"EMA":0.75}}]'
   不传则只测当前默认配置。 */
const argvCfg = process.argv[2];
const CANDS = argvCfg ? JSON.parse(argvCfg) : [{ name: '当前', cfg: {} }];

console.log('\n=== 幽灵动作免疫（静止 100s 误触发次数，越低越好）===');
for (const { name, cfg } of CANDS) {
  const g = ghost(cfg);
  console.log(`  ${name.padEnd(10)} 常规噪声 ${String(g.normal).padStart(2)} 次 · 强干扰 ${String(g.strong).padStart(2)} 次`);
}

console.log('\n=== 动作响应延迟（从开始发力到首次触发）===');
console.log('  配置 / 动作      3帧发力  6帧发力  10帧发力 15帧发力');
const pad = (s, w) => String(s).padEnd(w);
for (const { name, cfg } of CANDS) {
  for (const act of ['jump', 'lane', 'duck']) {
    const row = [3, 6, 10, 15].map((rf) => ms(latencies(cfg, rf)[act]));
    console.log(`  ${pad(name + '·' + { jump: '起跳', lane: '变道', duck: '下蹲' }[act], 16)}${row.map((s) => pad(s, 9)).join('')}`);
  }
}
