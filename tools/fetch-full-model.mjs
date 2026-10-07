/**
 * 下载 MediaPipe 高精度姿态模型（full）
 *
 * 为什么需要它：lite 模型在"只露上半身 / 逆光 / 人多"的场景下经常漏检，
 * 表现为"站着不动却怎么也进不了游戏"。full 模型对这些情况明显更稳，
 * 代价是单次推理更贵 —— 所以策略是：lite 起步，检测不到人再自动升级。
 */
import fs from 'fs';
import path from 'path';

const VENDOR = path.resolve(import.meta.dirname, '..', 'vendor');
const SRC = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const DEST = path.join(VENDOR, 'pose_landmarker_full.task');

if (fs.existsSync(DEST)) {
  console.log('已存在，跳过下载:', DEST, (fs.statSync(DEST).size / 1048576).toFixed(1) + 'MB');
  process.exit(0);
}

console.log('下载 →', SRC);
const r = await fetch(SRC);
if (!r.ok) { console.error('下载失败 HTTP', r.status); process.exit(1); }
const buf = Buffer.from(await r.arrayBuffer());
fs.writeFileSync(DEST, buf);
console.log('完成:', DEST, (buf.length / 1048576).toFixed(1) + 'MB');
