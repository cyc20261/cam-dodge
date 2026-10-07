/**
 * preview-ui.mjs —— 整站视觉改版后的"肉眼复核"出图工具
 *
 * 为什么要有它：这次改的是**纯 CSS + DOM 结构**，断言只能证明"元素还在"，
 * 证明不了新界面好不好看、字还读不读得清。观感问题必须出图用眼睛看 ——
 * 这也是这个项目一贯的做法（preview-shots.mjs 就是为同样的理由存在的）。
 *
 * 五个状态各一张：
 *   start  首页 / 开始屏（投屏第一眼）
 *   calib  姿态标定屏（含摄像头诊断行）
 *   over   结算屏（数据卡）
 *   pause  暂停层
 *   hud    HUD 在浅景(樱花)/暗景(地狱)下的可读性
 *   live   真实游戏运行中（真的跑起来 cmd 的 3D 背景，验证 HUD 压在实机上不清）
 *
 * 展台页 tools/preview-ui.html 直接 fetch 线上 index.html 的 DOM、调用线上 js/ui.js
 * —— 不复制粘贴结构，所以不会出现"截图好看、实机难看"的两张皮。
 *
 * 用法： node tools/preview-ui.mjs
 *        LIVE=0 node tools/preview-ui.mjs      跳过实机那张（慢）
 * 产物： preview/1x-<界面>.png
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8234);
const NODE = process.execPath;
const SHOT_TIMEOUT = Number(process.env.SHOT_TIMEOUT || 90000);

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = BROWSERS.find(existsSync);
if (!chrome) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const SHOOTS = [
  { seq: '10', name: '首页-开始屏', url: `/tools/preview-ui.html?state=start&bg=sakura` },
  { seq: '11', name: '标定屏-摄像头诊断', url: `/tools/preview-ui.html?state=calib&bg=sakura` },
  { seq: '12', name: '结算屏-战绩', url: `/tools/preview-ui.html?state=over&bg=hell` },
  { seq: '13', name: '暂停层', url: `/tools/preview-ui.html?state=pause&bg=hell` },
  { seq: '14', name: 'HUD-浅景樱花', url: `/tools/preview-ui.html?state=hud&bg=sakura` },
  { seq: '15', name: 'HUD-暗景地狱', url: `/tools/preview-ui.html?state=hud&bg=hell` },
  ...(process.env.LIVE === '0' ? [] : [{ seq: '16', name: 'HUD-实机运行中', live: true }]),
];

const srv = spawn(NODE, [join(ROOT, 'server.js'), String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
});
let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) { up = true; break; } } catch {}
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(2); }

const SHOT_DIR = join(ROOT, 'tools');
const OUT_DIR = join(ROOT, 'preview');
mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

let miss = 0;
for (const s of SHOOTS) {
  const tmp = join(SHOT_DIR, `.shot-ui-${s.seq}.png`);
  const out = join(OUT_DIR, `${s.seq}-${s.name}.png`);
  rmSync(tmp, { force: true });
  const profile = join(tmpdir(), `cam-dodge-ui-${s.seq}-` + Date.now());
  // 实机那张要给更长的时间预算：要先等摄像头 + 模型加载完跑起来，才截得到真 HUD
  const budget = s.live ? 16000 : 9000;
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    // 机位尺寸可用 SHOT_SIZE=宽,高 覆盖 —— 矮屏布局（预览面板 / 720p 投影）靠它复核
    `--window-size=${process.env.SHOT_SIZE || '1280,760'}`,
    `--virtual-time-budget=${budget}`,
    `--screenshot=${tmp}`,
    `--user-data-dir=${profile}`,
    s.live ? `http://127.0.0.1:${PORT}/?autocam=1` : `http://127.0.0.1:${PORT}${s.url}`,
  ];
  await new Promise((done) => {
    const b = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { spawn('taskkill', ['/PID', String(b.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      if (why === 'timeout') console.log(`     ⚠ ${s.seq} 超过 ${SHOT_TIMEOUT / 1000}s 未退出，已强杀`);
      done();
    };
    const timer = setTimeout(() => finish('timeout'), SHOT_TIMEOUT);
    b.on('exit', () => finish('exit'));
  });
  if (existsSync(tmp)) {
    copyFileSync(tmp, out);
    console.log(`ok   ${s.seq} → preview/${s.seq}-${s.name}.png`);
  } else {
    miss++;
    console.log(`MISS ${s.seq} ${s.name}`);
  }
  try {
    spawn('cmd.exe', ['/c', 'rmdir', '/s', '/q', profile], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

try { srv.kill(); } catch {}
console.log(`\n共 ${SHOOTS.length} 张，失败 ${miss} 张 → ${OUT_DIR}`);
process.exit(miss ? 1 : 0);
