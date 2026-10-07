/**
 * check.mjs —— 语法检查
 * 把 js/ 下的 ES module 复制成 .mjs 后交给 node --check 解析。
 * 用法： node tools/check.mjs
 */
import { copyFile, mkdir, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.check-tmp');
const NODE = process.execPath;

await mkdir(TMP, { recursive: true });
const files = (await readdir(join(ROOT, 'js'))).filter((f) => f.endsWith('.js'));

let bad = 0;
for (const f of files) {
  const dst = join(TMP, f.replace(/\.js$/, '.mjs'));
  await copyFile(join(ROOT, 'js', f), dst);
  try {
    await run(NODE, ['--check', dst]);
    console.log(`[ok  ] js/${f}`);
  } catch (e) {
    bad++;
    console.log(`[FAIL] js/${f}\n${(e.stderr || e.message).split('\n').slice(0, 10).join('\n')}`);
  }
}
// server.js 是 CommonJS
try { await run(NODE, ['--check', join(ROOT, 'server.js')]); console.log('[ok  ] server.js'); }
catch (e) { bad++; console.log(`[FAIL] server.js\n${(e.stderr || '').slice(0, 600)}`); }

await rm(TMP, { recursive: true, force: true });
console.log(bad === 0 ? '\nALL SYNTAX OK' : `\n${bad} FILE(S) FAILED`);
process.exit(bad ? 1 : 0);
