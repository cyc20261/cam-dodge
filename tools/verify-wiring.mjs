/**
 * verify-wiring.mjs —— 静态一致性检查（不启动浏览器）
 *
 * 1. JS 里 getElementById('x') 用到的 id，两份 HTML 里是否都存在
 * 2. 模块之间 import 的具名导出，是否真的被导出
 * 3. 主题配置字段是否齐全（缺字段会导致运行时 undefined）
 *
 * 用法： node tools/verify-wiring.mjs
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log(`  [ok  ] ${m}`);
const no = (m) => { bad++; console.log(`  [FAIL] ${m}`); };

/* ---- 1. DOM id 一致性 ---- */
console.log('\n--- DOM id 引用检查 ---');
const jsFiles = ['js/main.js', 'js/ui.js'];
const usedIds = new Set();
for (const f of jsFiles) {
  const src = await read(f);
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) usedIds.add(m[1]);
  for (const m of src.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) usedIds.add(m[1]);
}
for (const html of ['index.html', 'index-cdn.html']) {
  const src = await read(html);
  const have = new Set([...src.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...usedIds].filter((id) => !have.has(id));
  if (missing.length) no(`${html} 缺少元素: ${missing.join(', ')}`);
  else ok(`${html}: ${usedIds.size} 个 id 全部存在`);
}

/* ---- 2. 具名导出一致性 ---- */
console.log('\n--- 模块导出检查 ---');
const mods = {};
for (const f of ['js/scene.js', 'js/game.js', 'js/ui.js', 'js/pose.js']) {
  const src = await read(f);
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:const|class|function|let)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    m[1].split(',').forEach((s) => names.add(s.trim().split(/\s+as\s+/).pop()));
  }
  mods[f] = names;
}
const importers = { 'js/main.js': 'js/main.js', 'js/ui.js': 'js/ui.js', 'js/game.js': 'js/game.js' };
for (const [f] of Object.entries(importers)) {
  const src = await read(f);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const target = 'js/' + m[2].replace('./', '');
    const have = mods[target];
    if (!have) { no(`${f} -> ${target}：找不到模块导出表`); continue; }
    const missing = names.filter((n) => !have.has(n));
    if (missing.length) no(`${f} 从 ${target} 引入了不存在的导出: ${missing.join(', ')}`);
    else ok(`${f} -> ${target}: ${names.join(', ')}`);
  }
}

/* ---- 3. 主题配置完整性 ---- */
console.log('\n--- 主题配置检查 ---');
const scene = await read('js/scene.js');
const themeNames = [...scene.matchAll(/^\s{2}(\w+):\s*\{$/gm)].map((m) => m[1]);
const REQUIRED = ['name', 'swatch', 'anime', 'sky', 'fog', 'ground', 'laneLine', 'rail', 'player', 'obstacle', 'scenery', 'particle', 'lights'];
const blockRe = /\{\s*name:\s*'[^']*'[\s\S]*?\n\s{2}\},/g;
const blocks = [...scene.matchAll(blockRe)];
if (blocks.length < 4) no(`主题数量不足，只找到 ${blocks.length} 个（期望 4）`);
else ok(`主题数量: ${blocks.length}`);
for (const b of blocks) {
  const txt = b[0];
  const nameM = txt.match(/name:\s*'([^']+)'/);
  const miss = REQUIRED.filter((k) => !new RegExp(`\\b${k}:`).test(txt));
  if (miss.length) no(`主题「${nameM ? nameM[1] : '?'}」缺字段: ${miss.join(', ')}`);
  else ok(`主题「${nameM ? nameM[1] : '?'}」字段齐全`);
}
// 障碍物三种类型必须齐全
for (const b of blocks) {
  const t = b[0];
  const missT = ['hurdle', 'overhead', 'block'].filter((k) => !t.includes(`${k}:`));
  if (missT.length) no(`主题缺障碍类型: ${missT.join(', ')}`);
}

console.log(bad === 0 ? '\nWIRING ALL OK' : `\n${bad} 项不一致`);
process.exit(bad ? 1 : 0);
