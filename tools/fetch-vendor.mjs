// 抓取离线依赖到本地 vendor/ 目录
// 用法: node tools/fetch-vendor.mjs
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = resolve(ROOT, 'vendor');

const FILES = [
  // Three.js
  ['https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js', 'three.module.js'],
  // MediaPipe Tasks Vision (Pose Landmarker)
  ['https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs', 'vision_bundle.mjs'],
  ['https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js', 'vision_wasm_internal.js'],
  ['https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm', 'vision_wasm_internal.wasm'],
  ['https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.js'],
  ['https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.wasm', 'vision_wasm_nosimd_internal.wasm'],
  // 姿态模型 (lite 版，体积小速度快；full 版更准但更大)
  ['https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', 'pose_landmarker_lite.task'],
];

async function grab(url, dest) {
  const out = resolve(VENDOR, dest);
  try {
    const s = await stat(out);
    if (s.size > 1024) {
      console.log(`[skip] ${dest} (${(s.size / 1048576).toFixed(2)} MB)`);
      return true;
    }
  } catch {}
  console.log(`[get ] ${dest} <- ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  console.log(`[ok  ] ${dest} (${(buf.length / 1048576).toFixed(2)} MB)`);
  return true;
}

await mkdir(VENDOR, { recursive: true });
let fail = 0;
for (const [url, dest] of FILES) {
  try { await grab(url, dest); }
  catch (e) { fail++; console.error(`[FAIL] ${dest}: ${e.message}`); }
}
console.log(fail === 0 ? '\nAll vendor files ready.' : `\n${fail} file(s) failed.`);
process.exit(fail === 0 ? 0 : 1);
