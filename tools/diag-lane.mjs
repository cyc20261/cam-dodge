import { GestureRecognizer } from '../js/pose.js';

const BASE = {
  0: [0.50, 0.22],
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
  const { bodyDy = 0, bodyDx = 0 } = o;
  for (const k of Object.keys(BASE)) { const [x, y] = BASE[k]; put(+k, x + bodyDx, y + bodyDy); }
  return lms;
}

const nAmp = +(process.argv[2] || 0.014);
const dAmp = +(process.argv[3] || 0.028);
let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };

const g = new GestureRecognizer();
const step = 1000 / 30;
let t = 0;
const build = (i) => {
  const p = pose({});
  const sy = Math.sin((i / 30) * 0.9) * dAmp;
  const sx = Math.sin((i / 30) * 0.6 + 1.2) * dAmp * 1.2;
  for (const q of p) { if (!q.visibility) continue; q.y += rnd() * 2 * nAmp + sy; q.x += rnd() * 2 * nAmp + sx; }
  return p;
};
for (let i = 0; i < 46; i++) { g.feedCalibration(build(i)); t += step; }
g.finishCalibration();
console.log('标定基准 scale=', g.baseline.scale.toFixed(4), 'hipX=', g.baseline.hipX.toFixed(4));

const ring = [];
let n = 0;
let maxAbs = 0;
for (let i = 0; i < 100 * 30; i++) {
  t += step;
  const s = g.update(build(i + 46), t);
  const d = g.debug;
  if (Math.abs(d.dxRaw) > maxAbs) maxAbs = Math.abs(d.dxRaw);
  ring.push({ i, dx: d.dxRaw, v: d.laneVel, lane: s.lane });
  if (ring.length > 10) ring.shift();
  const prev = ring[ring.length - 2];
  if (prev && s.lane !== prev.lane) {
    n++;
    if (n <= 3) {
      console.log(`\n=== 变道 #${n} @${i} → ${s.lane}`);
      for (const r of ring) console.log(`  ${String(r.i).padStart(5)} dxRaw=${String(r.dx).padStart(7)} laneVel=${String(r.v).padStart(6)} lane=${r.lane}`);
    }
  }
}
console.log(`\n变道共 ${n} 次，|dxRaw| 峰值 ${maxAbs.toFixed(3)}`);
