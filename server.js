/**
 * server.js —— 零依赖静态服务器
 *
 * 为什么必须起服务：MediaPipe 需要 fetch 加载 .wasm / .task 模型，
 * 直接用 file:// 打开会被浏览器的同源策略拦掉。本地 http 服务是"安全上下文"，
 * getUserMedia 摄像头权限也才能正常申请。
 *
 * 用法： node server.js [端口] [绑定地址]
 *   默认只绑本机回环 127.0.0.1 —— 本地演示用，不必暴露到局域网。
 *   需要局域网内手机扫码玩时，才显式传 0.0.0.0：node server.js 8080 0.0.0.0
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8080;
const HOST = process.argv[3] || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  // 外部 3D <｜hy_place▁holder▁no▁813｜>（roadside 修罗魔相，GLB 二进制容器）
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

// 调试用的状态收集端点：只有显式设了 PROBE_FILE 才启用，平时完全不暴露。
// 用途：无头端到端测试要读页面内部状态，而 console 抓取（Chrome 117+ 不再
// 输出到 stderr）和 CDP WebSocket（本机握手不稳）都不可靠 ——
// 让页面把状态 POST 过来落盘，是唯一稳且实时的通道。
// 启动方式：PROBE_FILE=./tools/.probe.json node server.js 8080
const PROBE_FILE = process.env.PROBE_FILE || '';

// 反向通道：按键注入指令文件。PROBE_FILE 是页面 → 脚本（读状态），
// KEY_CMD_FILE 是脚本 → 页面（发指令）。同样只在显式开启时存在。
// 为什么用文件而不是 CDP evaluate：见 tools/key-e2e.mjs 顶部说明。
const KEY_CMD_FILE = process.env.KEY_CMD_FILE || '';

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname === '/') pathname = '/index.html';

  if (req.method === 'POST' && pathname === '/__probe') {
    if (!PROBE_FILE) { res.writeHead(404); res.end('probe disabled'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try { fs.writeFileSync(PROBE_FILE, body); } catch { /* 写不进去也不影响游戏 */ }
      res.writeHead(204); res.end();
    });
    return;
  }

  // 按键指令：GET 取一条并清空（消费型）。没开启就 404，页面侧静默忽略。
  if (req.method === 'GET' && pathname === '/__keycmd') {
    if (!KEY_CMD_FILE) { res.writeHead(404); res.end('disabled'); return; }
    let body = '';
    try { body = fs.readFileSync(KEY_CMD_FILE, 'utf8'); } catch { /* 没有指令 */ }
    if (body) { try { fs.writeFileSync(KEY_CMD_FILE, ''); } catch {} }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body || '');
    return;
  }

  const filePath = path.join(ROOT, pathname);
  // 防目录穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  奔跑吧，鲸鱼娘 已启动');
  console.log(`  本机打开   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') console.log('  (已绑定 0.0.0.0：同局域网设备可用本机 IP 访问)');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
