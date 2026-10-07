/**
 * decode-statues.mjs —— 把 DRACO 压缩的馆藏扫描件，转成"免解压"的普通 GLB。
 *
 * 为什么要这一步：Scan the World 发布的这批 .glb 全部带 KHR_draco_mesh_compression，
 * 浏览器加载必须先起 Web Worker 跑 WASM 解码器。答辩现场我们控制不了运行环境
 * （有的机器/浏览器策略会拦 Worker），而雕像只是背景装饰 —— 不值得为它冒"整组消失"的风险。
 * 转完之后：页面不再需要 DRACOLoader，加载更快，本地节点/无头截图也都能验证。
 *
 * 用法： NODE_PATH=<workspace>/node_modules node tools/decode-statues.mjs
 * 产物： assets/models/hell/*.glb 被原地替换成解压版（贴图原样保留，不重新编码）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'assets/models/hell');
const FILES = ['asura', 'guardian', 'dvarapala'];

const require = createRequire(import.meta.url);
/* 优先用仓库里自带的 Node 版解码器（tools/.draco/，离线可用）；
   没有的话退回 npm 包。下载地址：
   https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf_nodejs.js
   https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf.wasm */
let createDecoderModule = null;
for (const p of [join(ROOT, 'tools/.draco/draco_decoder_gltf_nodejs.js'), 'draco3dgltf']) {
  try {
    const m = require(p);
    createDecoderModule = m.createDecoderModule || m;
    break;
  } catch {}
}
if (!createDecoderModule) {
  console.error('缺 Draco 解码器。把这两个文件放进 tools/.draco/ 再跑：\n'
    + '  https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf_nodejs.js\n'
    + '  https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf.wasm');
  process.exit(2);
}

/* ---------- GLB 读写小工具 ---------- */
function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12;
  let json = null, bin = null;
  while (off < buf.length) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.slice(start, start + len);
    off = start + len;
  }
  return { json, bin };
}

const align4 = (n) => (n + 3) & ~3;

function packGLB(json, blocks) {
  // blocks: [{ data: Uint8Array }] —— 按 4 字节对齐依次拼进 BIN
  const binViews = [];
  let binLen = 0;
  for (const b of blocks) {
    const padsize = align4(b.data.byteLength);
    const pad = new Uint8Array(padsize);
    pad.set(b.data, 0);
    b.view = { byteOffset: binLen, byteLength: b.data.byteLength };
    binViews.push(pad);
    binLen += padsize;
  }
  const bin = new Uint8Array(binLen);
  let p = 0;
  for (const v of binViews) { bin.set(v, p); p += v.byteLength; }

  json.buffers = [{ byteLength: binLen }];
  const jsonStr = JSON.stringify(json);
  const jsonPad = align4(Buffer.byteLength(jsonStr));
  const jsonBuf = Buffer.alloc(jsonPad, 0x20);
  jsonBuf.write(jsonStr, 0, 'utf8');

  const total = 12 + 8 + jsonPad + (binLen ? 8 + binLen : 0);
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4;
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonPad, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonBuf.copy(out, o); o += jsonPad;
  if (binLen) {
    out.writeUInt32LE(binLen, o); o += 4;
    out.writeUInt32LE(0x004e4942, o); o += 4;
    Buffer.from(bin).copy(out, o);
  }
  return out;
}

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3 };
const CT = { 5121: 'UNSIGNED_BYTE', 5123: 'UNSIGNED_SHORT', 5125: 'UNSIGNED_INT', 5126: 'FLOAT' };

/* ---------- 主流程 ---------- */
const decoderModule = await createDecoderModule();

/**
 * 贴图为什么被丢掉：原始扫描件的贴图是 **Basis Universal（KHR_texture_basisu）** 压缩的，
 * 浏览器侧要再挂一个 KTX2Loader + basis 转码 Worker 才能解出来。
 * 加上原本的 DRACO，等于为了两尊背景雕像在运行时引入两套 Worker + WASM ——
 * 现场环境一旦限制 Worker，雕像就整组消失，连报错都没有。不值得。
 * 所以这里一并去掉贴图：保留博物馆级的**几何形体**（这才是"真模型"的价值），
 * 颜色与发光交给 scene.js 的 tintStatue 去做，正好融进地狱的火光里。
 */
function stripTexturesAndImages(json, bin, layout) {
  const out = JSON.parse(JSON.stringify(json));
  const inIdx = json.meshes[0].primitives[0].indices;
  const attrs = json.meshes[0].primitives[0].attributes;

  // 只留 索引 / 位置 / 法线。UV 在没有贴图时纯属浪费（每顶点 8 字节）。
  const keep = [
    { key: 'indices', ai: inIdx, type: 'SCALAR', componentType: 5125 },
    { key: 'POSITION', ai: attrs.POSITION, type: 'VEC3', componentType: 5126 },
    { key: 'NORMAL', ai: attrs.NORMAL, type: 'VEC3', componentType: 5126 },
  ].filter((d) => d.ai !== undefined && d.ai !== null);

  const blocks = keep.map((d) => {
    const bv = json.bufferViews[json.accessors[d.ai].bufferView];
    return { data: new Uint8Array(bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)) };
  });

  delete out.images; delete out.textures; delete out.samplers;

  /* 材质整块换成自建的干净材质 —— 不能只"删几个贴图字段"：
     原材质里 loose 的 metallicRoughnessTexture / KHR_texture_transform 只要漏一个，
     GLTFLoader 就会去 json.textures[1] 取到 undefined 然后整组抛错（雕像集体消失，
     且浏览器只报一句读不出上下文的 TypeError —— 这个坑踩过）。 */
  out.materials = [{
    name: 'statue_stone',
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: [0.72, 0.66, 0.6, 1],   // 石灰色；scene.js 的 tintStatue 会再乘一层焦岩色
      metallicFactor: 0,
      roughnessFactor: 0.92,
    },
  }];
  // 根级扩展声明也要清掉，否则 GLTFLoader 会去调对应插件
  delete out.extensionsUsed;
  delete out.extensionsRequired;
  if (out.extensions) delete out.extensions;
  delete out.meshes[0].primitives[0].extensions;

  // 几何顺序：indices → POSITION → NORMAL
  let cursor = 0;
  out.bufferViews = blocks.map((b) => {
    const o = cursor; cursor += align4(b.data.byteLength);
    return { buffer: 0, byteOffset: o, byteLength: b.data.byteLength };
  });
  out.buffers = [{ byteLength: cursor }];

  out.accessors = keep.map((d, i) => {
    const a = {
      bufferView: i, componentType: d.componentType, count: json.accessors[d.ai].count, type: d.type,
    };
    if (d.type === 'VEC3' && json.accessors[d.ai].min) { a.min = json.accessors[d.ai].min; a.max = json.accessors[d.ai].max; }
    return a;
  });

  const prim = out.meshes[0].primitives[0];
  prim.material = 0;
  const attrIdx = {};
  keep.forEach((d, i) => { if (d.key !== 'indices') attrIdx[d.key] = i; });
  prim.attributes = attrIdx;
  prim.indices = 0;

  void layout;
  return { json: out, blocks };
}

async function cleanOne(name) {
  const src = join(DIR, `${name}.glb`);
  if (!existsSync(src)) { console.log(`skip ${name}（文件不存在）`); return; }
  const { json, bin } = parseGLB(readFileSync(src));
  const { json: j2, blocks } = stripTexturesAndImages(json, bin, null);
  const glb = packGLB(j2, blocks);
  writeFileSync(src, glb);
  const acc = j2.accessors[0];
  console.log(`ok   ${name}: ${(glb.byteLength / 1048576).toFixed(2)}MB · ${acc.count / 3} 面 · ${j2.accessors[1].count} 点 · 无贴图`);
}

async function decodeOne(name) {
  const src = join(DIR, `${name}.glb`);
  if (!existsSync(src)) { console.log(`skip ${name}（文件不存在）`); return; }
  const { json, bin } = parseGLB(readFileSync(src));

  if (!(json.extensionsRequired || []).includes('KHR_draco_mesh_compression')) {
    console.log(`ok   ${name} 本来就没压缩，跳过`);
    return;
  }

  const mesh = json.meshes[0];
  const prim = mesh.primitives[0];
  const ext = prim.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const dracoBytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);

  const decoder = new decoderModule.Decoder();
  const dbuf = new decoderModule.DecoderBuffer();
  dbuf.Init(new Int8Array(dracoBytes.buffer, dracoBytes.byteOffset, dracoBytes.byteLength), dracoBytes.byteLength);
  const geom = new decoderModule.Mesh();
  const status = decoder.DecodeBufferToMesh(dbuf, geom);
  if (!status.ok()) throw new Error(`${name}: 解码失败 ${status.error_msg()}`);

  const nPts = geom.num_points();
  const nFaces = geom.num_faces();

  // 新版解码器的 DracoFloat32Array 不给整个数组（只有 size + GetValue），逐个取
  const getFloat = (uniqueId) => {
    const att = decoder.GetAttributeByUniqueId(geom, uniqueId);
    const arr = new decoderModule.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(geom, att, arr);
    const n = arr.size();
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = arr.GetValue(i);
    return { n: att.num_components(), data };
  };
  const pos = getFloat(0);
  const nrm = getFloat(1);
  const uv = getFloat(2);

  const idx = new Uint32Array(nFaces * 3);
  // GetFaceFromMesh 的正确姿势是**三参调用**：返回布尔表示成功，索引写进第三个出参
  // （DracoInt32Array，只有 GetValue/size）。把它当返回值用只会拿到 true，
  // f[0] 恒为 undefined → 整个索引缓冲区被写成 0，所有三角形退化 ——
  // 模型"加载成功、包围盒正确、就是整个不上屏"（排查了一晚上的坑）。
  const face = new decoderModule.DracoInt32Array();
  for (let i = 0; i < nFaces; i++) {
    if (!decoder.GetFaceFromMesh(geom, i, face)) throw new Error(`${name}: 第 ${i} 面提取失败`);
    idx[i * 3] = face.GetValue(0); idx[i * 3 + 1] = face.GetValue(1); idx[i * 3 + 2] = face.GetValue(2);
  }
  if (face.__destroy__) face.__destroy__();

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nPts; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos.data[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }

  // 贴图字节整体搬过来原样保留（不重新编码 → 画质零损失）
  const imgBlocks = (json.images || []).map((img) => {
    const v = json.bufferViews[img.bufferView];
    return { data: new Uint8Array(bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength)) };
  });
  const geoBlocks = [
    { data: new Uint8Array(idx.buffer.slice(0)) },
    { data: new Uint8Array(pos.data.buffer.slice(0)) },
    { data: new Uint8Array(nrm.data.buffer.slice(0)) },
    { data: new Uint8Array(uv.data.buffer.slice(0)) },
  ];

  const out = JSON.parse(JSON.stringify(json));
  delete out.extensionsRequired;
  if (out.extensionsUsed) {
    out.extensionsUsed = out.extensionsUsed.filter((e) => e !== 'KHR_draco_mesh_compression');
    if (!out.extensionsUsed.length) delete out.extensionsUsed;
  }
  delete out.meshes[0].primitives[0].extensions;

  const blocks = [...imgBlocks, ...geoBlocks];
  const all = packGLB(out, blocks);   // 第一次：只为拿到对齐后的 offsets

  // 第二次：填上新 bufferView / accessor（offset 要先算一遍才知道，所以复用 packGLB 的结果）
  const viewOf = (b) => b.view;
  const json2 = JSON.parse(JSON.stringify(json));
  delete json2.extensionsRequired;
  if (json2.extensionsUsed) {
    json2.extensionsUsed = json2.extensionsUsed.filter((e) => e !== 'KHR_draco_mesh_compression');
    if (!json2.extensionsUsed.length) delete json2.extensionsUsed;
  }
  delete json2.meshes[0].primitives[0].extensions;

  // 用真实对齐偏移量重建（与 packGLB 内部同一套规则，保证一致）
  let cursor = 0;
  const layout = [];
  for (const b of blocks) {
    layout.push({ byteOffset: cursor, byteLength: b.data.byteLength });
    cursor += align4(b.data.byteLength);
  }
  json2.bufferViews = blocks.map((b, i) => ({ buffer: 0, byteOffset: layout[i].byteOffset, byteLength: layout[i].byteLength }));
  json2.buffers = [{ byteLength: cursor }];

  // image → 前 N 个 bufferView；几何 → 随后 4 个
  let gi = (json.images || []).length;
  (json.images || []).forEach((img, i) => { json2.images[i].bufferView = i; });
  const I_IDX = gi, I_POS = gi + 1, I_NRM = gi + 2, I_UV = gi + 3;

  json2.accessors = [
    { bufferView: I_IDX, componentType: 5125, count: nFaces * 3, type: 'SCALAR' },
    { bufferView: I_POS, componentType: 5126, count: nPts, type: 'VEC3', min, max },
    { bufferView: I_NRM, componentType: 5126, count: nPts, type: 'VEC3' },
    { bufferView: I_UV, componentType: 5126, count: nPts, type: 'VEC2' },
  ];
  json2.meshes[0].primitives[0].attributes = { POSITION: 1, NORMAL: 2, TEXCOORD_0: 3 };
  json2.meshes[0].primitives[0].indices = 0;

  const glb = packGLB(json2, blocks);
  const dst = join(DIR, `${name}.glb`);
  writeFileSync(dst, glb);
  console.log(`ok   ${name}: ${(glb.byteLength / 1048576).toFixed(2)}MB · ${nFaces} 面 · ${nPts} 点 · 贴图 ${imgBlocks.length} 张`);
  void all; void viewOf; void COMP; void CT;
}

// 幂等：已经清干净（既无 DRACO 也无 basisu 贴图）的文件跳过，否则按当前状态处理
for (const f of FILES) {
  const p = join(DIR, `${f}.glb`);
  if (!existsSync(p)) { console.log(`skip ${f}（文件不存在）`); continue; }
  const { json } = parseGLB(readFileSync(p));
  const needDraco = (json.extensionsRequired || []).includes('KHR_draco_mesh_compression');
  const needBasis = (json.extensionsUsed || []).includes('KHR_texture_basisu') || (json.images || []).length;
  await (needDraco ? decodeOne(f) : cleanOne(f));
  void needBasis;
}
console.log('\n完成。运行时不再需要 DRACOLoader / KTX2Loader（无 Worker 依赖）。');
