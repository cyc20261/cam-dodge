/**
 * diag-run.mjs —— 一条命令跑完「起服务 → 无头浏览器加载诊断页 → 读回结果 → 关服务」
 *
 * 为什么必须打包成一条命令：
 * 本机后台进程会在两次工具调用之间被回收，分两步做（先起服务、再开浏览器）
 * 服务早就没了。把整条链路塞进同一个 Node 进程里，服务是它的子进程，
 * 生命周期就跟着这个进程走，不再被回收。
 *
 * 用法： node tools/diag-run.mjs <页面路径> [等待秒数]
 * 例：   node tools/diag-run.mjs diag-bg-rotate.html 25
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.argv[2] || 'diag-bg-rotate.html';
const WAIT = Number(process.argv[3] || 25);
const PORT = Number(process.env.PORT || 8177);
const PROBE = join(ROOT, 'tools', '.probe.json');
const NODE = process.execPath;

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = BROWSERS.find(existsSync);
if (!chrome) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

rmSync(PROBE, { force: true });

/* ---- 1) 起服务（子进程，指定 PROBE_FILE 让诊断页能落盘状态） ---- */
const srv = spawn(NODE, [join(ROOT, 'server.js'), String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, PROBE_FILE: PROBE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

/* 等端口真的起来，别用固定 sleep 赌运气 */
let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (r.ok) { up = true; break; }
  } catch { /* 还没起来 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(2); }
console.log(`服务已在 ${PORT} 端口就绪，加载 ${PAGE} …`);

/* ---- 2) 开无头浏览器 ---- */
const profile = join(tmpdir(), 'cam-dodge-diag-' + Date.now());
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  // 假摄像头 + 自动放行权限：涉及识别回路的诊断页不用手动授权
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  // 无头页会被当后台标签页降频，rAF / 定时器被冻结 → 诊断逻辑跑不动
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--user-data-dir=' + profile,
  `http://127.0.0.1:${PORT}/${PAGE}`,
], { stdio: ['ignore', 'ignore', 'ignore'] });

/* ---- 3) 轮询探针文件 ---- */
let payload = null;
const deadline = Date.now() + WAIT * 1000;
while (Date.now() < deadline) {
  await sleep(400);
  try {
    const txt = readFileSync(PROBE, 'utf8');
    if (txt && txt.trim()) { payload = JSON.parse(txt); break; }
  } catch { /* 还没写 */ }
}

/* ---- 4) 收摊 ---- */
try { srv.kill(); } catch {}
try { browser.kill(); } catch {}
if (process.platform === 'win32') {
  try { spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
try { rmSync(profile, { recursive: true, force: true }); } catch {}

/* ---- 5) 报告 ---- */
if (!payload) {
  console.log('\n没读到探针数据 —— 页面可能没跑到上报那一步（加载报错 / 逻辑抛异常）');
  process.exit(1);
}
console.log('\n=== result ===');
console.log('ok =', payload.ok);
console.log(payload.msg);
process.exit(payload.ok ? 0 : 1);
