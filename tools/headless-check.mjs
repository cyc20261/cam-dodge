/**
 * headless-check.mjs —— 无头浏览器端到端冒烟测试
 *
 * 用法：
 *   node tools/headless-check.mjs [秒数]            默认：查页面能否启动（dump-dom，稳定）
 *   node tools/headless-check.mjs [秒数] live       深链路：相机 + 模型 + 标定（环境相关）
 *
 * 前提（live 模式）：
 *   PROBE_FILE=<绝对路径> node server.js 8080
 *   即服务端要开启状态收集端点，否则页面 POST 过去会 404。
 *   然后本脚本会自动读那个文件。
 *
 * 模式选择说明：
 *   dom  模式走 --dump-dom，不依赖任何长连接或定时器投递，本机实测 100% 稳定，
 *        作为默认。它能覆盖：模块加载、DOM 构建、导出/引用错误、页面内异常、
 *        以及 autocam 流程是否真的走起来了。
 *   live 模式能在真实时间里跑完"开相机 → 载模型 → 检测 → 标定"，覆盖更全，
 *        但它依赖页面定时器持续投递 —— 无头 Chrome 对"无人观看"的页面会降频，
 *        本机表现时好时坏（同一份代码能连续成功，也能连续失败）。
 *        所以它是可选加深项，不作为默认门禁。
 *
 * 干什么：用 Chrome 的假摄像头（--use-fake-device）真实跑一遍
 *   "点摄像头模式 → 开相机 → 加载模型 → 标定 → （自动升级 full）→ 降级兜底"
 *   的全流程。假摄像头里没有人，所以预期结局是"标定超时后降级键盘模式"
 *   —— 这条链路能跑通，就说明状态机、模型加载、模型热切换都没坏。
 *
 * ── 为什么不用 console / CDP（这三条路都试过）──────────────
 * v1 `--enable-logging=stderr` + 从 stderr 筛 "CONSOLE" 行：
 *    Chrome 117+ 起不通。`--v=1` 能产 84KB 日志，CONSOLE 行数却是 0。
 * v2 CDP + Node 内置 WebSocket：功能可行，但本机实测握手只有约 1/4 成功，
 *    失败时静默卡住（连 'open' 都不触发）。固定/随机端口、独立 profile、
 *    Origin 白名单、短超时重试都试过，没根治。
 * v3 `--dump-dom --virtual-time-budget`：通道很稳，但虚拟时间驱动不了
 *    视频管线 —— 页面永远卡在 initCam（getUserMedia 的 onloadeddata 依赖
 *    真实帧），所以只能用来查"页面是否启动"。
 * v4（现在，实时模式）页面把状态 POST 给本地服务器落盘，脚本轮询读文件。
 *    实时、零握手竞态、能覆盖相机+模型全过程。DOM 方式保留为 dom 子模式。
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEC = Number(process.argv[2] || 16);
const MODE = process.argv[3] === 'live' ? 'live' : 'dom';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const APP_URL = `${BASE}/?autocam=1`;
const PROBE_FILE = process.env.PROBE_FILE || join(ROOT, 'tools', '.probe.json');

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = BROWSERS.find(existsSync);
if (!chrome) { console.error('找不到 Chrome / Edge，无法做端到端检查'); process.exit(2); }

const COMMON = [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  // 这三个开关是必须的：无头 Chrome 会把"无人观看"的页面当后台标签页，
  // rAF / requestVideoFrameCallback 会被冻结 —— 表现是检测循环只跑一帧
  // （calls 卡在 1，detectFps=0），看着像识别坏了，其实是浏览器在省电。
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];
const PROFILE = join(tmpdir(), 'cam-dodge-' + MODE + '-' + process.pid);

/**
 * 判定 + 报告，两种模式共用。
 * @param {'boot'|'full'} expect boot=只要求页面跑起来且无错误；full=还要求相机与检测循环真的在跑
 */
function report(state, extraDiag, expect = 'boot') {
  console.log('—— 页面状态 ——');
  if (!state) {
    console.log('  取不到页面状态');
    if (extraDiag) console.log('  ' + extraDiag);
    console.log('  → 页面很可能在初始化阶段就崩了（?autocam=1 才会上报状态）');
  } else {
    for (const [k, v] of Object.entries(state)) {
      if (k === 'errs') continue;
      console.log(`  ${k} = ${v}`);
    }
    if (state.errs && state.errs.length) {
      console.log('  页面内错误：');
      state.errs.forEach((e) => console.log('    ' + e));
    }
  }

  const errs = (state && state.errs) || [];
  const booted = !!state;                                   // 页面跑到了 autocam 上报
  const camOk = !!state && state.calls > 0;                 // 检测循环真的在跑
  const ok = booted && errs.length === 0 && (expect === 'boot' || camOk);

  console.log('\n结论：');
  console.log('  页面启动：' + (booted ? '通过' : '未通过'));
  console.log('  相机与检测循环：' + (camOk ? `通过（已检测 ${state.calls} 次，${state.detectFps}fps）` : '未通过/未覆盖'));
  console.log('  已进入的阶段：' + (booted ? (state.phase || '-') : '-'));
  console.log('  页面内脚本错误：' + (errs.length ? `${errs.length} 条` : '无'));
  console.log('  判定口径：' + (expect === 'boot' ? '页面可启动且无脚本错误' : '页面可启动 + 相机检测循环在跑 + 无脚本错误'));
  return ok;
}

if (MODE === 'dom') {
  console.log(`用 ${chrome}`);
  console.log(`[dom 模式] 虚拟时间 ${SEC}s —— 只验证页面能否启动\n`);
  const ch = spawn(chrome, [
    ...COMMON, '--user-data-dir=' + PROFILE,
    `--virtual-time-budget=${SEC * 1000}`, '--dump-dom', APP_URL,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let dom = '';
  ch.stdout.on('data', (d) => { dom += d; });
  ch.on('close', () => {
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
    const m = /<pre id="probe-out"[^>]*>([\s\S]*?)<\/pre>/i.exec(dom);
    let state = null;
    if (m) {
      const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
      try { state = JSON.parse(txt); } catch { /* 留空 */ }
    }
    const ok = report(state, `DOM 长度=${dom.length} · btn-pose=${/id="btn-pose"/.test(dom)} · theme-picker=${/id="theme-picker"/.test(dom)}`);
    process.exit(ok ? 0 : 1);
  });
} else {
  console.log(`用 ${chrome}`);
  console.log(`实时 ${SEC}s/次，最多 3 次 —— ${APP_URL}`);
  console.log(`状态文件 ${PROBE_FILE}（需服务端以 PROBE_FILE 启动）\n`);

  // 累积证据：一个进程内的状态是会变的 ——
  // 假摄像头里没有人，所以正常结局就是"标定超时 → 降级键盘模式"，
  // 而 tracker.stop() 会把 calls 归零。只看最后一次快照就会把成功判成失败。
  const acc = { sawCalib: false, maxCalls: 0, maxFps: 0, sawDetect: false, errs: [], last: null, samples: 0 };

  async function attempt(seconds) {
    const profile = PROFILE + '-' + Math.random().toString(36).slice(2, 7);
    try { rmSync(PROBE_FILE, { force: true }); } catch {}
    const ch = spawn(chrome, [...COMMON, '--user-data-dir=' + profile, APP_URL], { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastRaw = '';
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      try {
        const txt = readFileSync(PROBE_FILE, 'utf8');
        if (txt && txt !== lastRaw) {
          lastRaw = txt;
          const o = JSON.parse(txt);
          if (o && typeof o === 'object') {
            acc.samples++;
            acc.last = o;
            if (o.phase === 'calib') acc.sawCalib = true;
            if (typeof o.calls === 'number') acc.maxCalls = Math.max(acc.maxCalls, o.calls);
            if (typeof o.detectFps === 'number') acc.maxFps = Math.max(acc.maxFps, o.detectFps);
            if (o.detectMs > 0) acc.sawDetect = true;
            if (Array.isArray(o.errs) && o.errs.length) acc.errs = o.errs;
          }
        }
      } catch { /* 还没写或写了一半，下一轮再读 */ }
      await sleep(400);
    }
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
      else ch.kill('SIGKILL');
    } catch {}
    try { ch.kill(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    return acc.sawCalib && acc.maxCalls > 0;
  }

  (async () => {
    const per = Math.max(6, Math.round(SEC / 2));   // 单次够跑完"开相机+载模型"即可
    for (let i = 1; i <= 3; i++) {
      const good = await attempt(per);
      if (good) { console.log(`第 ${i} 次尝试：采集到有效链路\n`); break; }
      console.log(`第 ${i} 次尝试：没取到状态（无头 Chrome 偶尔不加载页面），重试…`);
    }

    let diag = '';
    if (!acc.samples) {
      let served = false;
      try { served = (await fetch(BASE + '/')).ok; } catch {}
      diag = `服务端可达=${served}；若服务端没设 PROBE_FILE，POST /__probe 会 404，就永远读不到状态。`
        + ` 可先用 dom 子模式确认页面本身能否启动：node tools/headless-check.mjs 4 dom`;
    }

    console.log(`—— 页面状态（累计观测 ${acc.samples} 个快照，下面是最新一个）——`);
    if (!acc.last) {
      console.log('  一个快照都没拿到');
      if (diag) console.log('  ' + diag);
    } else {
      for (const [k, v] of Object.entries(acc.last)) {
        if (k === 'errs') continue;
        console.log(`  ${k} = ${v}`);
      }
      if (acc.errs.length) {
        console.log('  页面内错误：');
        acc.errs.forEach((e) => console.log('    ' + e));
      }
    }

    const booted = acc.samples > 0;
    const camOk = acc.sawDetect && acc.maxCalls > 0;
    const ok = booted && acc.sawCalib && camOk && acc.errs.length === 0;

    console.log('\n结论：');
    console.log('  页面启动：' + (booted ? '通过' : '未通过'));
    console.log('  相机与检测循环：' + (camOk ? `通过（峰值 ${acc.maxFps}fps，累计检测 ${acc.maxCalls} 次）` : '未通过'));
    console.log('  进入过标定阶段：' + (acc.sawCalib ? '是' : '否'));
    console.log(`  预期结局（假摄像头无人 → 降级键盘）：${acc.last && acc.last.input === 'keyboard' ? '已发生，符合预期' : '未发生（时间可能不够）'}`);
    console.log('  页面内脚本错误：' + (acc.errs.length ? `${acc.errs.length} 条` : '无'));
    process.exit(ok ? 0 : 1);
  })();
}
