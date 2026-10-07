/**
 * ui.js —— HUD、界面切换、骨骼可视化、主题选择
 *
 * 骨骼叠加绘制是答辩时最有说服力的画面：
 * 评委能直接看到"识别到了什么、判定成了什么动作"。
 *
 * 性能：骨骼绘制在 canvas 2D 上，机器跑不动时可隔帧重绘（setSkeletonStride）。
 */

import { THEMES, THEME_KEYS } from './scene.js';
import { MODES, MODE_KEYS } from './game.js';

const $ = (id) => document.getElementById(id);

/* ---------- 血量显示：红心 → 金心 ---------- */

/** 每 9 点血折 1 颗"金色的心"，余数还是红心。
 *
 *  为什么需要这个刻度：等级不设上限（见 game.js 的 level），血量会一直涨 ——
 *  跑十分钟就是三四十点。一颗一颗画红心既排不下，也读不出"自己到底长进了多少"。
 *  金心是**长期成长的刻度**，红心是零头（也就是眼下那点缓冲）。
 *  金心多到画不下时改用 "N/M" 计数：到那个量级，看数字比一颗颗数快。 */
export const GOLD_HEART = 9;
const GOLD_ICON_MAX = 6;

// 心形一律用**内联 SVG** 画，不用字符 ♥。
// ⚠ 用字符会翻车：Windows 上 U+2665 被 Segoe UI Emoji 的**彩色字形**接管
// （连追加 VS15 文本变体选择符都救不回来，无头截图实测无效），
// 而 emoji 字形无视 color / 渐变 / text-fill-color —— 结果"金心"永远显示成
// emoji 的红色，和红心只差一圈光晕，用户看到的"金心色感差"根源就是它。
// SVG path 是几何绘制，颜色 / 渐变 100% 由我们控制，跨环境稳定。
const HEART_PATH = 'M16 29C10.5 24.6 1 16.8 1 9.6 1 5 4.8 1.2 9.4 1.2c2.6 0 5 1.3 6.6 3.3C17.6 2.5 20 1.2 22.6 1.2 27.2 1.2 31 5 31 9.6c0 7.2-9.5 15-15 19.4z';
const heartSvg = (fill) =>
  `<svg viewBox="0 0 32 30" aria-hidden="true"><path fill="${fill}" d="${HEART_PATH}"/></svg>`;

/**
 * 把 (当前血量, 血量上限) 拼成心的 HTML。
 * 金心在前（大额、金色），红心在后（零头）；缺的血用 off 类压暗成空位。
 * @param {number} lives 当前血量
 * @param {number} total 血量上限
 * @returns {string} 供 #lives 的 innerHTML 使用
 */
export function heartMarkup(lives, total) {
  const goldMax = Math.floor(total / GOLD_HEART);
  const redMax = total % GOLD_HEART;
  const gold = Math.floor(lives / GOLD_HEART);
  const red = lives % GOLD_HEART;

  // 金色的渐变只需在文档里存在一份（多个 SVG 引用同一个 id 是合法的，都指到第一个）。
  // HUD 每帧重建 innerHTML，所以 defs 每次都得跟着输出 —— 宽高为 0 不占布局。
  const defs = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
    + '<linearGradient id="heartGold" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#fffbe8"/><stop offset="0.3" stop-color="#ffe98f"/>'
    + '<stop offset="0.55" stop-color="#ffcf3f"/><stop offset="0.8" stop-color="#d99b16"/>'
    + '<stop offset="1" stop-color="#ffeead"/></linearGradient>'
    + '<linearGradient id="heartGoldOff" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#77663c"/><stop offset="0.55" stop-color="#4a3c21"/>'
    + '<stop offset="1" stop-color="#77663c"/></linearGradient>'
    + '</defs></svg>';

  let out = defs;
  if (goldMax > GOLD_ICON_MAX) {
    // 血量 54 点以上（要跑十几分钟）：金心排不下，直接给"当前/上限"的数字
    out += `<span class="xcount">${gold}<i>/${goldMax}</i></span>`;
  } else {
    for (let i = 0; i < goldMax; i++) {
      out += `<span class="gold ${i < gold ? 'on' : 'off'}">${heartSvg(i < gold ? 'url(#heartGold)' : 'url(#heartGoldOff)')}</span>`;
    }
  }
  for (let i = 0; i < redMax; i++) {
    // 红心用 currentColor：亮/灭完全由 span 的 color 控制（CSS 一处说了算）
    out += `<span class="${i < red ? 'on' : 'off'}">${heartSvg('currentColor')}</span>`;
  }
  return out;
}

// MediaPipe 官方骨架连线
const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [27, 31], [28, 30], [28, 32],
  [15, 17], [15, 19], [16, 18], [16, 20],
];

export class UI {
  constructor() {
    this.el = {
      stage: $('stage'),
      hud: $('hud'),
      score: $('score'),
      speed: $('speed'),
      combo: $('combo'),
      lives: $('lives'),
      level: $('level'),
      punchHint: $('punch-hint'),
      dist: $('dist'),
      fps: $('fps'),
      aiMs: $('ai-ms'),
      gesture: $('gesture'),
      mode: $('mode'),
      video: $('video'),
      overlay: $('overlay'),
      debug: $('debug'),
      toast: $('toast'),
      themePicker: $('theme-picker'),
      modePicker: $('mode-picker'),
      diff: $('diff'),
      screens: {
        start: $('screen-start'),
        calib: $('screen-calib'),
        over: $('screen-over'),
      },
      calibText: $('calib-text'),
      calibBar: $('calib-bar'),
      camDiag: $('cam-diag'),
      overStats: $('over-stats'),
      pause: $('pause-layer'),
    };
    this.ctx = this.el.overlay.getContext('2d');
    this._fpsAcc = 0; this._fpsN = 0;
    this._toastT = 0;
    this._stride = 1;      // 骨骼重绘间隔
    this._strideI = 0;
    this._themeBtns = {};
    this._modeBtns = {};
  }

  /* ---------- 界面 ---------- */

  showScreen(name) {
    for (const k of Object.keys(this.el.screens)) {
      this.el.screens[k].classList.toggle('show', k === name);
    }
  }

  hideAllScreens() {
    for (const k of Object.keys(this.el.screens)) this.el.screens[k].classList.remove('show');
  }

  /** 暂停遮罩：半透明黑幕 + 居中大字。刻意不挡 HUD，方便暂停时对照数值截图 */
  setPaused(on) {
    const el = this.el.pause;
    if (!el) return;
    el.classList.toggle('show', !!on);
  }

  toast(msg, ms = 2600) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.el.toast.classList.remove('show'), ms);
  }

  setCalibProgress(p, text) {
    this.el.calibBar.style.width = `${Math.round(p * 100)}%`;
    if (text) this.el.calibText.innerHTML = text;
  }

  /** 标定屏上的摄像头诊断：识别不出人体时告诉玩家差在哪一项 */
  setCamDiag(rows, advice) {
    const box = this.el.camDiag;
    if (!box) return;
    const html = rows
      .map(([k, v]) => `<div class="dg"><i>${k}</i><b>${v}</b></div>`)
      .join('');
    box.innerHTML = html + (advice ? `<div class="dg-advice">${advice}</div>` : '');
    box.classList.add('show');
  }

  /* ---------- 主题选择 ---------- */

  /** 在开始屏生成主题按钮 */
  buildThemePicker(onPick) {
    const box = this.el.themePicker;
    if (!box) return;
    box.innerHTML = '';
    for (const key of THEME_KEYS) {
      const t = THEMES[key];
      const b = document.createElement('button');
      b.className = 'theme-btn';
      b.dataset.theme = key;
      const dots = t.swatch.map((c) => `<i style="background:${c}"></i>`).join('');
      b.innerHTML = `<span class="swatches">${dots}</span><span class="tname">${t.name}</span>`;
      b.addEventListener('click', () => onPick(key));
      box.appendChild(b);
      this._themeBtns[key] = b;
    }
  }

  setTheme(name) {
    for (const k of Object.keys(this._themeBtns)) {
      this._themeBtns[k].classList.toggle('active', k === name);
    }
  }

  /* ---------- 难度选择 ---------- */

  /** 在开始屏生成难度按钮（普通 / 困难） */
  buildModePicker(onPick) {
    const box = this.el.modePicker;
    if (!box) return;
    box.innerHTML = '';
    for (const key of MODE_KEYS) {
      const m = MODES[key];
      const b = document.createElement('button');
      b.className = 'mode-btn';
      b.dataset.mode = key;
      b.innerHTML = `<b>${m.label}</b><span>${m.tag}</span><em>${m.desc}</em>`;
      b.addEventListener('click', () => onPick(key));
      box.appendChild(b);
      this._modeBtns[key] = b;
    }
  }

  setMode(name) {
    for (const k of Object.keys(this._modeBtns)) {
      this._modeBtns[k].classList.toggle('active', k === name);
    }
    if (this.el.diff && MODES[name]) this.el.diff.textContent = MODES[name].label;
  }

  /* ---------- HUD ---------- */

  updateHUD(game, extra = {}) {
    this.el.score.textContent = Math.floor(game.score).toLocaleString('en-US');
    this.el.speed.textContent = (game.speed * 3.6).toFixed(0);
    this.el.dist.textContent = Math.floor(game.distance);
    this.el.combo.textContent = game.combo > 1 ? `x${game.combo}` : '—';
    this.el.combo.classList.toggle('hot', game.combo >= 5);

    // 等级：按跑动距离成长（升级会回血，见 game.js 的 _checkLevelUp）
    if (this.el.level && game.level !== undefined) this.el.level.textContent = game.level;

    // 血量：红心 1 点 / 颗，攒满 9 点熔成 1 颗金心（换算见 heartMarkup）。
    // 上限跟着等级走且不封顶，所以这里不写死颗数。
    const total = (game.livesMax || (game.modeConf && game.modeConf.lives) || 3);
    this.el.lives.innerHTML = heartMarkup(game.lives, total);
    // 心只画到"整颗"的粒度，鼠标悬停给确切数值（答辩时被问到也能立刻答）
    this.el.lives.title = `${game.lives} / ${total} 点血量`;

    // 挥拳提示分两档（两档解决的是不同的问题，见 game.js 的两个 getter）：
    //   "来了！" —— 怪还有约 0.45 秒进窗口。现在就得动身，抵消识别延迟；
    //   "挥拳！" —— 已经在窗口里了，立刻打。
    // 只有一档（进窗口才提示）时，玩家看到提示再动，动作被识别时怪已经贴脸了。
    if (this.el.punchHint) {
      const hot = !!extra.demonInRange;
      const soon = !hot && !!extra.demonApproaching;
      this.el.punchHint.classList.toggle('show', hot);
      this.el.punchHint.classList.toggle('soon', soon);
      if (hot) this.el.punchHint.textContent = '挥拳！';
      else if (soon) this.el.punchHint.textContent = '来了！';
    }

    if (this.el.diff) this.el.diff.textContent = extra.diffLabel || this.el.diff.textContent || '普通';
    this.el.mode.textContent = extra.modeLabel || '—';
    this.el.mode.className = 'pill ' + (extra.modeClass || '');
    this.el.gesture.textContent = extra.gestureLabel || '待机';
  }

  tickFps(dt) {
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc >= 0.5) {
      const fps = Math.round(this._fpsN / this._fpsAcc);
      this._fpsAcc = 0; this._fpsN = 0;
      this.el.fps.textContent = fps;
      this.el.fps.className = fps >= 45 ? 'good' : fps >= 28 ? 'warn' : 'bad';
      return fps;
    }
    return null;
  }

  /** 显示单次姿态识别耗时（延迟指标） */
  setAi(ms) {
    if (!this.el.aiMs) return;
    this.el.aiMs.textContent = ms > 0 ? Math.round(ms) : '—';
    this.el.aiMs.className = ms < 15 ? 'good' : ms < 30 ? 'warn' : 'bad';
  }

  showOver(summary) {
    this.el.overStats.innerHTML = `
      <div class="stat"><b>${summary.score.toLocaleString('en-US')}</b><span>总分</span></div>
      <div class="stat"><b>${summary.distance}</b><span>米</span></div>
      <div class="stat"><b>${summary.cleared}</b><span>躲过障碍</span></div>
      <div class="stat"><b>${summary.demons ?? 0}</b><span>击败恶魔</span></div>
      <div class="stat"><b>x${summary.bestCombo}</b><span>最高连击</span></div>
      <div class="stat"><b>Lv.${summary.level ?? 1}</b><span>最终等级</span></div>
      <div class="stat"><b>${summary.modeLabel || '普通'}</b><span>难度</span></div>`;
    this.showScreen('over');
  }

  /* ---------- 骨骼叠加 ---------- */

  /** 在摄像头画面上叠加骨骼（镜像显示，符合照镜子直觉） */
  drawSkeleton(landmarks, opts = {}) {
    // 机器性能不足时隔帧重绘
    if ((this._strideI = (this._strideI + 1) % this._stride) !== 0) return;

    const cv = this.el.overlay;
    const v = this.el.video;
    const w = v.videoWidth || 640, h = v.videoHeight || 480;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!landmarks) return;

    const px = (lm) => [(1 - lm.x) * w, lm.y * h]; // 镜像
    const vis = (i) => !landmarks[i] || landmarks[i].visibility === undefined || landmarks[i].visibility > 0.35;

    ctx.lineWidth = Math.max(2, w / 200);
    ctx.strokeStyle = opts.color || '#2de2ff';
    ctx.beginPath();
    for (let i = 0; i < CONNECTIONS.length; i++) {
      const a = CONNECTIONS[i][0], b = CONNECTIONS[i][1];
      if (!vis(a) || !vis(b)) continue;
      const p1 = px(landmarks[a]), p2 = px(landmarks[b]);
      ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
    }
    ctx.stroke();

    ctx.fillStyle = opts.dot || '#ffd166';
    const r = Math.max(2, w / 150);
    for (let i = 0; i < landmarks.length; i++) {
      if (!vis(i)) continue;
      const p = px(landmarks[i]);
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  setSkeletonStride(n) { this._stride = Math.max(1, n | 0); }

  /* ---------- 调试 ---------- */

  toggleDebug(force) {
    const el = this.el.debug;
    const on = force === undefined ? !el.classList.contains('show') : force;
    el.classList.toggle('show', !!on);
  }

  isDebugOpen() { return this.el.debug.classList.contains('show'); }

  setDebug(obj) {
    const rows = Object.entries(obj).map(([k, v]) => `<div><i>${k}</i><b>${v}</b></div>`).join('');
    this.el.debug.innerHTML = rows;
  }
}
