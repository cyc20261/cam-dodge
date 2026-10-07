/**
 * preview-statues.mjs —— 地狱两侧「修罗魔相」出图复核
 *
 * 两个机位，一张都不能少：
 *   front  实机第三人称视角 → 唯一能证明"没挡住跑道"的证据
 *   row    侧后方 → 看排布疏密、朝向、体量
 *
 * 用法： node tools/preview-statues.mjs
 * 产物： preview/20-地狱·修罗魔相-实机视角.png
 *        preview/21-地狱·修罗魔相-两侧排布.png
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8237);
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
  { seq: '20', set: 'statue', view: 'front', name: '地狱·修罗魔相-实机视角' },
  { seq: '21', set: 'statue', view: 'row', name: '地狱·修罗魔相-两侧排布' },
  { seq: '30', set: 'tree', view: 'front', name: '樱花·樱树立牌-实机视角' },
  { seq: '31', set: 'tree', view: 'row', name: '樱花·樱树立牌-两侧排布' },
  { seq: '40', set: 'player', view: 'player', name: '角色·鲸鱼娘-实机背影' },
  { seq: '41', set: 'player', view: 'duck', name: '角色·鲸鱼娘-蹲姿' },
  { seq: '42', set: 'player', view: 'jump', name: '角色·鲸鱼娘-跳姿' },
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

const SETS = {
  // statue 机位：PNG data URI（回退立牌）+ GLB data URI（真 3D，__STATUE_GLB）双注入
  statue: { dir: 'assets/models/hell/asura-standee', files: ['asura-1', 'asura-2', 'asura-3'], varName: '__STATUE_FILES', stage: '.statue-inline.html', glbs: { asura3d: 'asura3d' } },
  tree: { dir: 'assets/models/sakura/standee-src', files: ['sakura-tree-1', 'sakura-tree-2'], varName: '__TREE_FILES', stage: '.tree-inline.html' },
  // player 机位：注入三姿态 GLB data URI（scene.js 读 window.__PLAYER_GLB 对象）
  player: { dir: 'assets/models/player', stage: '.player-inline.html', glbs: { run: 'whale3d-run', duck: 'whale3d-duck', jump: 'whale3d-jump' } },
};

/**
 * 生成内联页：把立牌 PNG 用 data URI 塞进去（TextureLoader 分支支持 data:）。
 * 无头 Chrome 的 Virtual Time 与"异步 fetch + 解析"八字不合（真实网络请求常常等不到回调，
 * 立牌加载就永远 pending），改成 data URI 后没有网络等待，截图才有东西可看。
 * ——注意：这只是**出图**用的旁路，加载函数走的是 scene.js 里真实的 _mountStandeeSet 全流程。
 */
function makeInlineStage(setKey) {
  const set = SETS[setKey];
  const src = readFileSync(join(ROOT, 'tools/preview-statues.html'), 'utf8');
  const duri = (n) => {
    const b = readFileSync(join(ROOT, set.dir, `${n}.png`));
    return `data:image/png;base64,${b.toString('base64')}`;
  };
  const parts = [];
  if (set.glbs) {
    // GLB data URI 对象：player → window.__PLAYER_GLB / statue → window.__STATUE_GLB
    const vname = set.varName === '__STATUE_FILES' ? '__STATUE_GLB' : '__PLAYER_GLB';
    const entries = Object.entries(set.glbs).map(([k, n]) => {
      const b = readFileSync(join(ROOT, set.dir, `${n}.glb`));
      return `"${k}":"data:model/gltf-binary;base64,${b.toString('base64')}"`;
    });
    parts.push(`<script>window.${vname}={${entries.join(',')}};</script>`);
  }
  if (set.files && set.varName) {
    const files = set.files.map((n) => `"${duri(n)}"`);
    parts.push(`<script>window.${set.varName}=[${files.join(',')}];</script>`);
  }
  const inject = parts.join('\n') + '\n</head>';
  const out = src.replace('</head>', inject);
  const p = join(ROOT, 'tools', set.stage);
  writeFileSync(p, out);
  return `/tools/${set.stage}`;
}
for (const key of Object.keys(SETS)) SETS[key].path = makeInlineStage(key);

let miss = 0;
for (const s of SHOOTS) {
  const tmp = join(SHOT_DIR, `.shot-statue-${s.seq}.png`);
  const out = join(OUT_DIR, `${s.seq}-${s.name}.png`);
  rmSync(tmp, { force: true });
  const profile = join(tmpdir(), `cam-dodge-statue-${s.seq}-` + Date.now());
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1280,760',
    // 雕像要异步 fetch 3 个 GLB（本地几 MB），给足预算
    `--virtual-time-budget=${20000}`,
    `--screenshot=${tmp}`,
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${PORT}${SETS[s.set].path}?set=${s.set}&view=${s.view}`,
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
