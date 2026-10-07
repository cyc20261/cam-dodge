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

const nAmp = +(process.argv[3] || 0.008);
const dAmp = +(process.argv[4] || 0.015);
const seedStart = 20240928;
let seed = seedStart;
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

const ring = [];
let jumps = 0;
for (let i = 0; i < 100 * 30; i++) {
  t += step;
  const s = g.update(build(i + 46), t);
  ring.push({ i, d: { ...g.debug }, jump: s.jump });
  if (ring.length > 14) ring.shift();
  if (s.jump) {
    jumps++;
    if (jumps <= 3) {
      console.log(`\n=== 误跳 #${jumps} @frame ${i} ===`);
      for (const r of ring) {
        const d = r.d;
        console.log(`  ${String(r.i).padStart(5)} dy=${String(d.dy).padStart(7)} up=${String(d.up).padStart(6)} velUp=${String(d.velUp).padStart(6)} `
          + `range=${String(d.range).padStart(6)} alpha=${d.alpha} still=${d.still ? 'Y' : 'n'} rebased=${d.rebased ? 'Y' : 'n'} `
          + `attack=${String(d.attack).padStart(4)} rise=${d.rise ? 'Y' : 'n'}${r.jump ? ' <<< JUMP' : ''}`);
      }
    }
  }
}
console.log(`\n总误跳 ${jumps} 次（noise=${nAmp} drift=${dAmp}）`);
