/**
 * 语法自检：把 js/ 下的 ES 模块逐个喂给 vm.SourceTextModule，
 * 只做解析（不执行、不解析 import 目标），能在几毫秒内抓出括号/模板串之类的低级错误。
 * 用它替代"改完直接开浏览器看有没有白屏"。
 *
 * 用法：node tools/syntax-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* vm.SourceTextModule 在 Node 里需要 --experimental-vm-modules 才暴露。
   直接用 node tools/syntax-check.mjs 会因为缺这个 flag 而全量误报，
   所以这里检测到缺 flag 就自动带 flag 重启一次（对外仍是"一条命令"）。 */
if (typeof vm.SourceTextModule !== 'function' && !process.env.__SYNTAX_RELAUNCH) {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, __SYNTAX_RELAUNCH: '1' },
  });
  process.exit(r.status === null ? 1 : r.status);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['js', 'tools'];
const files = [];

for (const d of dirs) {
  const full = path.join(root, d);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) {
    if (f.endsWith('.js') || f.endsWith('.mjs')) files.push(path.join(full, f));
  }
}
files.push(path.join(root, 'server.js'));

let bad = 0;
for (const f of files) {
  const rel = path.relative(root, f);
  const src = fs.readFileSync(f, 'utf8');
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(src, { identifier: rel });
    console.log(`  ok   ${rel}`);
  } catch (e) {
    bad++;
    console.log(`  FAIL ${rel}\n       ${e.message}`);
  }
}
console.log(bad ? `\n${bad} 个文件语法有误` : `\n全部 ${files.length} 个模块语法通过`);
process.exit(bad ? 1 : 0);
