/**
 * 交叉引用完整性检查：main.js 里调用的每个方法，是否真的存在于对应模块？
 * 浏览器只有在运行时才会暴露这类问题，这里提前静态捕获。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const MODULE_OF = {
  ui: 'js/ui.js',
  world: 'js/scene.js',
  game: 'js/game.js',
  tracker: 'js/pose.js',
  gesture: 'js/pose.js',
};

// 每个类各自的源码范围（避免把 game 的方法算到 tracker 头上）
const CLASS_RANGE = {
  'js/ui.js': { UI: read('js/ui.js') },
  'js/scene.js': { World: read('js/scene.js') },
  'js/game.js': { Game: read('js/game.js') },
  'js/pose.js': { PoseTracker: read('js/pose.js'), GestureRecognizer: read('js/pose.js') },
};

const OWNER_CLASS = {
  ui: 'UI', world: 'World', game: 'Game',
  tracker: 'PoseTracker', gesture: 'GestureRecognizer',
};

const main = read('js/main.js');
let fail = 0;

// 1) 方法调用检查
console.log('--- 方法引用 ---');
const seen = new Map();
for (const m of main.matchAll(/\b(ui|world|game|tracker|gesture)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
  const [, obj, method] = m;
  const key = `${obj}.${method}`;
  if (seen.has(key)) continue;
  seen.set(key, true);

  const file = MODULE_OF[obj];
  const cls = OWNER_CLASS[obj];
  const src = CLASS_RANGE[file][cls];
  const declared =
    new RegExp(`(^|\\s)${method}\\s*\\(`, 'm').test(src) &&
    new RegExp(`(^\\s{2}${method}\\s*\\(|\\n\\s+${method}\\s*\\(|async\\s+${method}\\s*\\(|get\\s+${method}\\s*\\(|\\*\\s*${method}\\s*\\()`).test(src);
  // 更宽松但可靠的判断：类体内任何位置出现 "  method(" 或 "async method(" 或 "get method"
  const ok = new RegExp(`(async\\s+)?${method}\\s*\\([^)]*\\)\\s*\\{`).test(src)
    || new RegExp(`get\\s+${method}\\s*\\(`).test(src)
    || new RegExp(`\\*\\s*${method}\\s*\\(`).test(src);
  const want = ok || declared;
  console.log(`  ${want ? '[ok  ]' : '[MISS]'} ${key}()  → ${file} ${cls}`);
  if (!want) fail++;
}

// 2) 属性引用检查（非函数调用形式）
console.log('\n--- 属性引用 ---');
// 注意末尾的 \b：少了它会踩正则回溯的坑 ——
// 对 `game.update(dt)`，贪婪的 [\w$]* 先吃掉 "update"，负向先行断言看到 "(" 失败，
// 于是回退一格截成 "updat"（下一个字符是 "e"，不是 "("，断言成立）→ 假 MISS。
// 加上 \b 后，"updat" 后面紧跟单词字符 "e" 不构成词边界，回退被禁止，
// 必须吃满整个标识符再判断，于是函数调用会被正确排除。
// 再加一条负向后顾排除模块路径里的字面量（import 语句里的 './game.js' 会被误当成 game.js）。
// 最后排除可选链调用 game.foo?.()：后面的字符是 "?" 而不是 "("，不加这条会被当成属性引用。
const props = [...main.matchAll(/(?<!['"/])\b(tracker|gesture|world|game)\.([A-Za-z_$][\w$]*)\b(?!\s*\(|\s*\?\.)/g)];
const propSeen = new Set();
for (const m of props) {
  const [, obj, prop] = m;
  const key = `${obj}.${prop}`;
  if (propSeen.has(key)) continue;
  propSeen.add(key);
  const src = CLASS_RANGE[MODULE_OF[obj]][OWNER_CLASS[obj]];
  const ok = new RegExp(`this\\.${prop}\\b`).test(src)
    || new RegExp(`get\\s+${prop}\\b`).test(src)
    || new RegExp(`(const|let|var)\\s+${prop}\\b`).test(src);
  console.log(`  ${ok ? '[ok  ]' : '[MISS]'} ${key}  → ${MODULE_OF[obj]}`);
  if (!ok) fail++;
}

// 3) main.js 里 getElementById 的 id 必须在 HTML 中存在
console.log('\n--- DOM id（main.js 直接取用）---');
const htmlFiles = ['index.html', 'index-cdn.html'];
const ids = new Set([...main.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
for (const f of htmlFiles) {
  const html = read(f);
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const id of ids) {
    const ok = htmlIds.has(id);
    if (!ok) { console.log(`  [MISS] ${f} 缺少 id="${id}"`); fail++; }
  }
  console.log(`  ${f}: ${ids.size} 个 id 全部存在`);
}

console.log(`\n结果：${fail === 0 ? '全部通过' : fail + ' 项缺失'}`);
process.exit(fail ? 1 : 0);
