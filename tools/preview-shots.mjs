/**
 * preview-shots.mjs —— 把"障碍物 / 小恶魔 / 路边景物"逐个体检成 PNG（纯肉眼复核用）
 *
 * 为什么不用浏览器交互截图：模型好看与否只能靠眼睛看，
 * 而在无头环境里让游戏跑到"有怪、有墙"的时机很不确定。
 * 这里直接加载一个静态展台页（tools/preview-props.html），摆好模型、定死机位再截图。
 *
 * 四种机位：
 *   props    障碍 + 恶魔血条 + 地面指示环（四套主题各一张）
 *   scenery  路边景物特写（樱花 / 地狱各一张 —— 这两套是重做过的）
 *   demon    小恶魔特写（近水平视角，主展台的俯视机位会把恶魔压成扁片）
 *   hud      血量刻度对照（红心/金心/空位各状态，金心是纯 CSS 只能靠出图复核）
 *
 * 用法： node tools/preview-shots.mjs
 *        HUD=0 node tools/preview-shots.mjs        跳过 HUD 那张
 * 产物： preview/<序号>-<主题>-<视角>.png   ← 直接就是给人看的成品，不用再手动改名
 *       （中间件 tools/.shot-*.png 同时留着，方便跟历史截图对比）
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8233);
const NODE = process.execPath;

/* 主题键 → 中文名（成品文件名用中文，直接能对着截图讲） */
const LABEL = {
  sakura: '樱花·二次元浪漫',
  hell: '地狱·熔岩',
  neon: '赛博霓虹',
  galaxy: '星海·云端',
};

/* 序号按**固定顺序**给，不按"本次拍了几张"给 ——
   否则单独补拍一两个主题（THEMES=sakura,hell）会得到和上次不同的文件名，
   preview/ 里就会新旧混在一起，分不清哪张是哪张。 */
const CANON_PROPS = ['sakura', 'hell', 'neon', 'galaxy'];
const CANON_SCENERY = ['sakura', 'hell'];
const CANON_DEMON = ['sakura', 'hell'];

/* 用 !== undefined 判断，而不是 || —— 这样 THEMES=sakura SCENERY=（显式留空）
   就能表示"只拍道具、不拍景物"。用 || 的话空串会被当成"没设"，又会去拍默认的那套。 */
const pick = (env, canon) => (env !== undefined ? env.split(',').filter(Boolean) : canon.slice());
const propsThemes = pick(process.env.THEMES, CANON_PROPS);
const sceneryThemes = pick(process.env.SCENERY, CANON_SCENERY);
const demonThemes = pick(process.env.DEMON, CANON_DEMON);

const SHOOTS = [
  ...propsThemes.map((t) => ({
    key: `${t}-props`,
    theme: t,
    view: 'props',
    seq: String(CANON_PROPS.indexOf(t) + 1).padStart(2, '0'),
    name: `${LABEL[t] || t}-障碍与恶魔`,
  })),
  ...sceneryThemes.map((t) => ({
    key: `${t}-scenery`,
    theme: t,
    view: 'scenery',
    seq: String(CANON_PROPS.length + CANON_SCENERY.indexOf(t) + 1).padStart(2, '0'),
    name: `${LABEL[t] || t}-路边景物`,
  })),
  ...demonThemes.map((t) => ({
    key: `${t}-demon`,
    theme: t,
    view: 'demon',
    seq: String(CANON_PROPS.length + CANON_SCENERY.length + CANON_DEMON.indexOf(t) + 1).padStart(2, '0'),
    name: `${LABEL[t] || t}-恶魔特写`,
  })),
  // HUD 不跟主题走（心的观感与场景无关），固定一张；HUD=0 可跳过。
  // 它存在的理由：金心是纯 CSS 效果，只跑测试断言不出来"好不好看"，
  // 必须出图肉眼复核 —— 这正是这个脚本一贯的原则。
  ...(process.env.HUD === '0' ? [] : [{
    key: 'hud',
    theme: 'hud',
    view: 'hud',
    seq: String(CANON_PROPS.length + CANON_SCENERY.length + CANON_DEMON.length + 1).padStart(2, '0'),
    name: '血量刻度-金心对照',
  }]),
];

/* 单张截图的硬超时。为什么要它：无头 Chrome 偶发不退出（实测银河主题卡死过一次），
   脚本等着 'exit' 事件就会一直挂着 —— 加超时至少能让这一张算失败、继续拍下一张。 */
const SHOT_TIMEOUT = Number(process.env.SHOT_TIMEOUT || 150000);

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = BROWSERS.find(existsSync);
if (!chrome) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

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
  const tmp = join(SHOT_DIR, `.shot-${s.key}.png`);
  const out = join(OUT_DIR, `${s.seq}-${s.name}.png`);
  rmSync(tmp, { force: true });
  const profile = join(SHOT_DIR, `.shotprofile-${s.key}`);
  const url = s.view === 'hud'
    ? `http://127.0.0.1:${PORT}/tools/preview-hud.html`
    : `http://127.0.0.1:${PORT}/tools/preview-props.html`
      + `?theme=${s.theme}` + (s.view === 'props' ? '' : `&view=${s.view}`);
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1280,720',
    '--virtual-time-budget=9000',
    `--screenshot=${tmp}`,
    `--user-data-dir=${profile}`,
    url,
  ];
  await new Promise((done) => {
    const b = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 不管是自己退出还是被超时砍掉，都要连子进程一起收掉，
      // 否则残留的渲染进程会拖慢后面几张。
      try { spawn('taskkill', ['/PID', String(b.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      if (why === 'timeout') console.log(`     ⚠ ${s.key} 超过 ${SHOT_TIMEOUT / 1000}s 未退出，已强杀`);
      done();
    };
    const timer = setTimeout(() => finish('timeout'), SHOT_TIMEOUT);
    b.on('exit', () => finish('exit'));
  });
  if (existsSync(tmp)) {
    copyFileSync(tmp, out);
    console.log(`ok   ${s.view.padEnd(7)} ${s.theme.padEnd(7)} → preview/${s.seq}-${s.name}.png`);
  } else {
    miss++;
    console.log(`MISS ${s.view.padEnd(7)} ${s.theme.padEnd(7)} → ${tmp}`);
  }
  // profile 目录绝不能在本进程里同步删（rmSync recursive）：Chrome 关停瞬间文件仍被占用，
  // 实测会把整个循环卡死十几分钟（这就是"一张图卡住全脚本"的元凶）。
  // 丢给独立 cmd 进程异步删，删不完也不影响出图；残留的 .shotprofile-* 下次开机删也行。
  try {
    spawn('cmd.exe', ['/c', 'rmdir', '/s', '/q', profile], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

try { srv.kill(); } catch {}
console.log(`\n共 ${SHOOTS.length} 张，失败 ${miss} 张 → ${OUT_DIR}`);
process.exit(miss ? 1 : 0);
