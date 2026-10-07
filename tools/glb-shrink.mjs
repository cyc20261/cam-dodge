#!/usr/bin/env node
/**
 * glb-shrink.mjs —— 把 GLB 里超大纹理缩到指定尺寸后重新打包。
 * 图生3D 产物是单贴图 4K PNG（18MB+），游戏里角色只有 2.5m 高，1024 足够；
 * 只替换贴图 bufferView、其余顶点数据原样搬运，accessor/offset 全部重排。
 * 用法： node glb-shrink.mjs <in.glb> <out.glb> [maxTex=1024]
 * 流程： 解包 GLB → 抽贴图 → PIL 缩图（外部调 python）→ 重建 BIN（去旧图、
 *        追加新图 bufferView，其余 bufferView 原样拷贝）→ 重写 JSON/长度。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , IN, OUT, MAX = '1024'] = process.argv;
const buf = readFileSync(IN);
const jsonLen = buf.readUInt32LE(12);
const binLen = buf.readUInt32LE(20);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const bin = buf.slice(binStart, binStart + binLen);

const img = json.images[0];
const bvIdx = img.bufferView;
const bv = json.bufferViews[bvIdx];
const oldTex = bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);

// PIL 缩图（转 PNG 优化）
const tmp = mkdtempSync(join(tmpdir(), 'glbshr-'));
const srcPng = join(tmp, 'src.png');
const dstPng = join(tmp, 'dst.png');
writeFileSync(srcPng, oldTex);
const PY = 'C:/Users/lenovo/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
execFileSync(PY, ['-c', `
from PIL import Image
import sys
im = Image.open(sys.argv[1])
if im.mode in ('RGBA','P'): im = im.convert('RGBA')
w,h = im.size
s = min(1.0, ${MAX}/max(w,h))
if s < 1: im = im.resize((round(w*s), round(h*s)), Image.LANCZOS)
im.save(sys.argv[2], optimize=True)
`, srcPng, dstPng]);
const newTex = readFileSync(dstPng);
console.log(`texture ${(oldTex.length / 1e6).toFixed(1)}MB -> ${(newTex.length / 1e6).toFixed(1)}MB`);

// 重建 BIN：除贴图外的 bufferView 依原序拷贝（4 字节对齐），贴图放最后
const views = json.bufferViews;
const newViews = [];
const chunks = [];
let off = 0;
for (let i = 0; i < views.length; i++) {
  if (i === bvIdx) continue;
  const v = views[i];
  const data = bin.slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  const pad = (4 - (off % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
  newViews.push({ ...v, byteOffset: off });
  chunks.push(data); off += data.byteLength;
}
const pad2 = (4 - (off % 4)) % 4;
if (pad2) { chunks.push(Buffer.alloc(pad2)); off += pad2; }
newViews.push({ buffer: 0, byteOffset: off, byteLength: newTex.length });
chunks.push(newTex); off += newTex.byteLength;
const newBin = Buffer.concat(chunks);
json.bufferViews = newViews;
// bufferView 索引整体重排：> bvIdx 的减一
const shift = (i) => (i > bvIdx ? i - 1 : i);
for (const att of Object.values(json.meshes[0].primitives[0].attributes)) json.accessors[att].bufferView = shift(json.accessors[att].bufferView);
if (json.meshes[0].primitives[0].indices != null) {
  const ix = json.meshes[0].primitives[0].indices;
  json.accessors[ix].bufferView = shift(json.accessors[ix].bufferView);
}
img.bufferView = newViews.length - 1;

// 写 GLB（JSON chunk 4 字节对齐，空格填充；BIN chunk 0 填充）
let jsonBuf = Buffer.from(JSON.stringify(json));
if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
let binBuf = newBin;
if (binBuf.length % 4) binBuf = Buffer.concat([binBuf, Buffer.alloc(4 - (binBuf.length % 4))]);
const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
const out = Buffer.alloc(total);
out.write('glTF', 0, 'ascii');
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonBuf.length, 12);
out.write('JSON', 16, 'ascii');
jsonBuf.copy(out, 20);
out.writeUInt32LE(binBuf.length, 20 + jsonBuf.length);
out.write('BIN\0', 24 + jsonBuf.length, 'ascii');
binBuf.copy(out, 28 + jsonBuf.length);
writeFileSync(OUT, out);
console.log(`${IN} (${(buf.length / 1e6).toFixed(1)}MB) -> ${OUT} (${(total / 1e6).toFixed(1)}MB)`);
