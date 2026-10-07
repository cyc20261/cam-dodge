/**
 * verify-glb.mjs —— 校验 GLB 结构是否合法。
 *
 * 为什么要单独做这一步：GLB 是我们**自己拼出来的**（tools/decode-statues.mjs 把 DRACO 版
 * 就地转成了免解压版），拼错一个字节在浏览器里只会表现为"雕像集体消失"，
 * 连报错都没有。这里按 glTF 2.0 规范逐条体检，坏在哪一眼看得出。
 *
 * 用法： node tools/verify-glb.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['asura', 'guardian', 'dvarapala'].map((n) => join(ROOT, 'assets/models/hell', `${n}.glb`));

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const CTYPE = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

let bad = 0;
const fail = (f, msg) => { console.log(`  ✗ ${msg}`); bad++; };

for (const file of FILES) {
  const name = file.split(/[\\/]/).pop();
  console.log(`\n${name}`);
  if (!existsSync(file)) { fail(name, '文件不存在'); continue; }
  const buf = readFileSync(file);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (view.getUint32(0, true) !== 0x46546c67) { fail(name, 'magic 不是 glTF'); continue; }
  if (view.getUint32(4, true) !== 2) fail(name, '版本不是 2');
  if (view.getUint32(8, true) !== buf.byteLength) fail(name, `header 长度 ${view.getUint32(8, true)} ≠ 实际 ${buf.byteLength}`);

  let off = 12, json = null, bin = null;
  while (off < buf.byteLength) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    if (off + 8 + len > buf.byteLength) { fail(name, `chunk 越界 @${off}`); break; }
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.slice(off + 8, off + 8 + len);
    off += 8 + len;
  }
  if (!json) { fail(name, '没有 JSON chunk'); continue; }
  if (!bin) { fail(name, '没有 BIN chunk'); continue; }

  if ((json.extensionsRequired || []).includes('KHR_draco_mesh_compression')) fail(name, '仍然依赖 DRACO');

  const total = json.buffers?.[0]?.byteLength;
  if (total !== bin.byteLength) fail(name, `buffers[0].byteLength=${total} ≠ BIN 实际 ${bin.byteLength}`);

  // bufferView 越界 + 对齐
  (json.bufferViews || []).forEach((v, i) => {
    const o = v.byteOffset || 0;
    if (o + v.byteLength > bin.byteLength) fail(name, `bufferView[${i}] 越界 ${o}+${v.byteLength}`);
    if (o % 4 !== 0) fail(name, `bufferView[${i}] 未按 4 字节对齐（offset=${o}）`);
  });

  // accessor 尺寸自洽
  (json.accessors || []).forEach((a, i) => {
    const size = COMP[a.type] * CTYPE[a.componentType];
    if (!size) return fail(name, `accessor[${i}] 类型不支持`);
    const v = json.bufferViews[a.bufferView];
    const need = a.count * size;
    const room = v.byteLength - (a.byteOffset || 0);
    if (room < need) fail(name, `accessor[${i}] 需要 ${need}B，view 只剩 ${room}B`);
    if (a.min) {
      for (const k of [0, 1, 2]) if (!Number.isFinite(a.min[k]) || !Number.isFinite(a.max?.[k])) fail(name, `accessor[${i}] min/max 有 NaN/Inf`);
    }
  });

  // mesh 引用的 accessor 必须存在
  for (const m of json.meshes || []) {
    for (const p of m.primitives) {
      if (p.indices === undefined) fail(name, 'primitive 缺 indices');
      if (!p.attributes || p.attributes.POSITION === undefined) fail(name, 'primitive 缺 POSITION');
      for (const k of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
        const ai = p.attributes?.[k];
        if (ai === undefined) continue;
        if (!json.accessors[ai]) fail(name, `attributes.${k} 指向不存在的 accessor ${ai}`);
      }
    }
  }

  // 贴图：JPEG 魔数 FFD8
  for (const img of json.images || []) {
    const v = json.bufferViews[img.bufferView];
    const head = bin.readUInt16BE((v.byteOffset || 0));
    if (head !== 0xffd8) fail(name, `贴图 ${img.mimeType || '?'} 不是 JPEG（magic=0x${head.toString(16)}）`);
  }

  if (!bad) {
    const m = json.meshes[0].primitives[0];
    console.log(`  ✓ 面数=${json.accessors[m.indices].count / 3} 顶点=${json.accessors[m.attributes.POSITION].count}`
      + ` 贴图=${(json.images || []).length} 体积=${(buf.byteLength / 1048576).toFixed(2)}MB`);
  }
}

console.log(bad ? `\n✗ ${bad} 处不合格` : '\n✓ 全部合法');
process.exit(bad ? 1 : 0);
