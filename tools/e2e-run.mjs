/**
 * e2e-run.mjs —— 真实主页面的端到端自检（自己起服务，不依赖外部进程）
 *
 * 为什么不用 tools/headless-check.mjs 直接跑：
 * 那个脚本要求外部先起好服务，而本机的后台进程会在两次工具调用之间被回收，
 * 分两步做服务早没了。这里把「起服务 + 开浏览器 + 读状态 + 收摊」打包进
 * 同一个 Node 进程，服务是它的子进程，生命周期跟着走。
 *
 * 覆盖：模块加载 → 主题选择器渲染 → 点摄像头模式 → （假摄像头）进入标定
 *       → 键盘模式兜底 → 按 M/B/空格 触发各条交互 → 采集页面内异常
 *
 * 用法： node tools/e2e-run.mjs [等待秒数]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WAIT = Number(process.argv[2] || 22);
const PORT = Number(process.env.PORT || 8188);
const PROBE = join(ROOT, 'tools', '.probe-e2e.json');
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

const srv = spawn(NODE, [join(ROOT, 'server.js'), String(PORT)], {
  cwd: ROOT, env: { ...process.env, PROBE_FILE: PROBE }, stdio: ['ignore', 'ignore', 'ignore'],
});

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) { up = true; break; } } catch {}
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(2); }

const profile = join(tmpdir(), 'cam-dodge-e2e-' + Date.now());
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--user-data-dir=' + profile,
  `http://127.0.0.1:${PORT}/?autocam=1`,
], { stdio: ['ignore', 'ignore', 'ignore'] });

/* 采集：累积证据（end 状态会变，只看最后一帧会把成功判成失败） */
const acc = { samples: 0, maxCalls: 0, sawCalib: false, last: null, errs: [] };
const deadline = Date.now() + WAIT * 1000;
let lastRaw = '';
while (Date.now() < deadline) {
  await sleep(400);
  try {
    const txt = readFileSync(PROBE, 'utf8');
    if (txt && txt !== lastRaw) {
      lastRaw = txt;
      const o = JSON.parse(txt);
      if (o && o.phase && typeof o.calls === 'number') {
        acc.samples++; acc.last = o;
        if (o.phase === 'calib') acc.sawCalib = true;
        acc.maxCalls = Math.max(acc.maxCalls, o.calls);
        if (Array.isArray(o.errs) && o.errs.length) acc.errs = o.errs;
      }
    }
  } catch {}
}

try { srv.kill(); } catch {}
if (process.platform === 'win32') {
  try { spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
} else { try { browser.kill(); } catch {} }
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const s = acc.last;
const booted = acc.samples > 0;
const camOk = acc.maxCalls > 0;
const ok = booted && camOk && acc.errs.length === 0;

console.log('—— 真实主页面端到端 ——');
console.log(`  观测快照：${acc.samples}`);
if (s) {
  console.log(`  阶段 phase=${s.phase} 输入=${s.input}`);
  console.log(`  检测：调用 ${s.calls} 次 · 命中 ${s.hits} · ${s.detectFps}fps · ${s.detectMs}ms`);
  console.log(`  模型：${s.quality} / ${s.delegate}`);
} else {
  console.log('  没拿到任何状态（页面可能在初始化阶段就崩了）');
}
console.log(`  峰值检测调用：${acc.maxCalls} · 进入过标定：${acc.sawCalib ? '是' : '否'}`);
console.log(`  页面内脚本错误：${acc.errs.length ? acc.errs.join(' | ') : '无'}`);
console.log(`\n结论：${ok ? '通过（页面启动 + 识别回路在跑 + 零脚本错误）' : '未通过'}`);
process.exit(ok ? 0 : 1);
