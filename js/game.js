/**
 * game.js —— 游戏规则层（原仓库唯一需要替换的部分）
 *
 * 设计原则：与姿态识别完全解耦。
 * 外部只要调用 setLane / jump / setDuck / punch，就能驱动整局游戏，
 * 因此键盘、触屏、体感三种输入可以任意切换，演示翻车时也能兜底。
 */

import { LANE_X } from './scene.js';

/** 与难度无关的物理 / 几何参数 */
const CFG = {
  jumpV: 7.8,             // 起跳初速度（最高跳约 1.38，需高于低栏 0.9 且留出余量）
  gravity: 22,
  spawnAheadZ: -95,       // 障碍物生成位置（远处，随跑道推进迎面而来）
  despawnZ: 14,
  invincible: 1.3,        // 受击无敌时间兜底（实际按模式取值）

  // 变道插值速度。必须与渲染共用同一个横向位置（见 laneF），
  // 否则会出现"画面上人还在中道，逻辑上已经算到了左道"的假撞。
  //
  // 28 是为"反馈慢"提过速的值（14→28，走完一条道 ~160ms）—— 但实机体感反馈：
  // 角色横向窜得太快，跟玩家自己侧移的节奏对不上，看着像瞬移。
  // 12 的时间常数 ≈83ms，走完一条道约 250~300ms，正好是一次真人侧步的时长：
  // 画面节奏跟玩家的身体动作同步，判定照旧读 laneF，所见即所判。
  laneLerp: 12,

  // 碰撞的车道容差（单位＝车道间距）。
  // 障碍半宽 0.95 + 玩家半径 0.34 = 1.29，车道间距 2.4 → 视觉接触约 0.54。
  // 这里取 0.45，比视觉接触更宽容一点：宁可"擦身算过"，也不要"看着没碰到却判撞"。
  laneTol: 0.45,

  // 挥拳命中用的车道容差：刻意比撞墙更宽。
  // 拳头是有长度的，够得着邻道的边缘；玩家在两道之间时也该能打中——
  // 实机上"明明打到了却没反应"多半就是这里太严。
  punchLaneTol: 0.62,
  // "准备挥拳"的提前量（秒）：提示要比怪真进窗口早这么多亮起。
  // 体感链路（眼睛看到 → 身体做出动作 → 被识别出来）实机约 0.4~0.5 秒，
  // 等怪进窗口再提示，玩家一定来不及 —— 提示得早半个身位。
  punchLead: 0.45,

  // —— 小恶魔 ——
  demonHitScore: 70,      // 每打中一拳的分（吃连击加成）
  demonKillScore: 260,    // 击倒的额外奖励分（同样吃连击加成）
  demonJumpClear: 1.05,   // 脚底高于此值算"从恶魔头上跃过"（≈恶魔站立高度）
  // 恶魔与障碍的"互斥半径"：出生点前后这么多距离内，同一车道不许两者共存。
  // 为什么必须做：恶魔和实墙在同一条道上贴着走时，墙（1.9 高）会把小恶魔包进去，
  // 视觉上就是"怪物卡在墙后面"——玩家看不到它、也打不到它，非常出戏。
  demonLaneClear: 26,
};

/**
 * 难度模式。
 *
 * normal 的设计目标很明确：**让普通玩家能连续运动 10 分钟以上**。
 *   速度上限压到 25（≈90km/h 的体感）、提速斜率 0.09/s（要 133 秒才到顶）、
 *   障碍间距 34 → 24 单位（约 1.0–1.3 秒一波）、5 条命、撞一次给 2.2 秒无敌。
 *
 *   最容易忽略的一点是"节奏必须收敛"：距离等级每 800 米一档、封顶 6 档，
 *   也就是说约 200 秒后难度就不再增长了 —— 这才是"能一直玩下去"的根因。
 *   如果等级无限增长，无论开局多温柔，十分钟后都必然变成地狱。
 *   按 600 秒跑下来约 1.4 万米，全程节奏是"能喘气但一直在动"。
 * hard 则是给想被虐的人：上限 34、提速斜率 0.30/s、障碍保底 18 单位、3 条命。
 */
export const MODES = {
  normal: {
    key: 'normal',
    label: '普通',
    tag: '轻松开跑 · 10 分钟起步',
    desc: '5 条命 · 加速平缓 · 障碍稀疏 · 恶魔 3 拳 · 升级无限',
    lives: 5,
    speedStart: 13, speedMax: 25, speedRamp: 0.09,
    firstGap: 85, gapBase: 34, gapStep: 1.6, gapMin: 24, gapJitter: 7,
    levelDist: 800, maxLevel: 6,
    invincible: 2.2,          // 撞到障碍后的无敌时间
    demonInvincible: 3.0,     // 被恶魔撞到后的无敌时间（刻意更长 → 不会被连着送走）
    demonFirstGap: 70, demonGapMin: 95, demonGapMax: 155,
    demonHp: 3,               // 恶魔血条厚度：要打 3 拳
    // —— 打击手感（为什么是这三个数，见 punch() 的"打不完就被撞"说明）——
    // 窗口从 26 拉到 36：怪更早进"够得着"，玩家多出 (36-26)/20 ≈ 0.5 秒输出时间
    punchWindow: 36,          // 拳头够得着的最远距离（z >= -此值可命中）
    punchReach: 3.8,          // 恶魔已越过此 z（在身后）就打不到了（补偿识别延迟）
    punchCooldown: 0.16,      // 出拳冷却（秒）
    knockback: 5.5,           // 每命中一拳把恶魔沿来路推远多少米（越残血推得越远）
    // —— 等级系统（等级与血量都不设上限）——
    // 按跑动距离升级，升级时回血（并提高血量上限）。这是普通模式
    // "能一直运动下去"的另一半保障：跑得越久，越耐撞。
    // 无上限是刻意的：玩家跑多远就长多强，配合 HUD 的"每 9 点血折 1 颗金心"
    // 给出一条看得见的长期成长曲线（见 ui.js 的 updateHUD）。
    levelUpDist: 400,         // 每 400 米升一级
  },
  hard: {
    key: 'hard',
    label: '困难',
    tag: '高速高压 · 极限操作',
    desc: '3 条命 · 加速激进 · 障碍密集 · 恶魔 4 拳 · 升级无限',
    lives: 3,
    speedStart: 18, speedMax: 34, speedRamp: 0.30,
    firstGap: 55, gapBase: 33, gapStep: 1.9, gapMin: 18, gapJitter: 7,
    levelDist: 380, maxLevel: 8,
    invincible: 1.3,
    demonInvincible: 2.2,
    demonFirstGap: 48, demonGapMin: 60, demonGapMax: 105,
    demonHp: 4,
    // 困难模式速度上限 34：窗口若还按 30 算就只开 0.88 秒，要打 4 拳必然被撞 ——
    // 所以这里的窗口 / 击退都比普通模式再宽一档（见 punch() 的说明）。
    punchWindow: 44,
    punchReach: 4.0,
    punchCooldown: 0.15,
    knockback: 5,
    levelUpDist: 450,
  },
};
export const MODE_KEYS = Object.keys(MODES);

// 障碍物的"占据高度区间"，玩家与之交叠即判定撞上
// 低栏上限 0.9：跳跃最高约 1.38，可穿越的时间窗约 0.42s，
// 留足体感识别的延迟余量（调高会明显变难）
const OBSTACLE = {
  hurdle:   { yMin: 0.0,  yMax: 0.90, need: 'jump' },
  overhead: { yMin: 1.75, yMax: 2.45, need: 'duck' },
  block:    { yMin: 0.0,  yMax: 1.95, need: 'lane' },
};

export class Game {
  constructor(world, hooks = {}) {
    this.world = world;
    this.hooks = hooks;   // { onScore, onHit, onOver, onClear, onDemonHit, onDemonKill }
    this.mode = 'normal';
    this.reset();
  }

  /** 当前难度的参数表（渲染层 / 测试层都读它，避免到处硬编码） */
  get modeConf() { return MODES[this.mode] || MODES.normal; }

  /**
   * 换难度：立刻按新模式重开一局（场上残留一并回收）。
   * force=false 时对同一难度是空操作 —— 开始屏反复点同一个按钮不该重开。
   */
  setMode(name, force = false) {
    if (!MODES[name]) return false;
    if (name === this.mode && !force) return false;
    this.mode = name;
    this.reset();
    return true;
  }

  reset() {
    const C = this.modeConf;
    // 清场必须放在重建数组之前 —— 顺序反了就 release 不到任何东西，
    // 上一局的障碍网格会永久留在场景里（可见但不再移动），
    // 玩家会看到一堆"卡住的墙"，感觉画面和判定完全对不上。
    if (this.world) for (const o of this.obstacles || []) this.world.release(o.mesh);
    if (this.world) for (const d of this.demons || []) this.world.release(d.mesh);

    this.state = 'ready'; // ready | running | over
    this.laneTarget = 1;  // 玩家要去的车道索引 0..2
    this.laneF = 1;       // 玩家当前的连续横向位置 0..2 —— 渲染与碰撞的唯一真相
    this.jumpY = 0;
    this.vy = 0;
    this.airborne = false;
    this.duck = false;
    this.speed = C.speedStart;
    this.distance = 0;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.cleared = 0;
    this.lives = C.lives;
    this.livesMax = C.lives;      // 血量上限（升级会把它抬高，见 _checkLevelUp）
    this.levelsGained = 0;        // 本局升了几级
    this._lastLevel = 1;          // 上一次结算过的等级（用于检测升级）
    this.invT = 0;
    this.obstacles = [];
    this.demons = [];
    this.demonSeq = 0;              // 恶魔自增 id：拳弹靠它盯住"自己那发"的目标怪
    this.kills = 0;
    this.hits = 0;          // 受击次数（结算展示用）
    this.punches = 0;       // 有效命中拳数
    this.sinceSpawn = 0;
    this.nextGap = C.firstGap;   // 开局先跑一段热身再出障碍
    this.sinceDemon = 0;
    this.nextDemon = C.demonFirstGap;
    this.punchT = -1;              // 出拳动画计时（-1 = 没在出拳）
    this.punchCd = 0;
    this.knockTotal = 0;           // 本局累计击退距离（探针/e2e 用它证明"命中确实把怪推远了"）
    // 最近一次出拳的"发射事件"。渲染层靠 id 变化判断"这是新的一发"，
    // 然后从玩家手里打出一颗光弹（见 scene.js 的 fireShot）。
    // 判定仍然是出拳当帧即时结算，弹丸纯粹是画面表现 —— 让"打中了"看得见。
    this.lastShot = null;
    this.shotId = 0;
    this.elapsed = 0;
    this.passableLanes = [0, 1, 2]; // 开局玩家可能在任意车道
    this.lastWaveType = null;
  }

  start() {
    this.state = 'running';
  }

  /**
   * 清掉场内所有障碍（切换主题要重建网格时用）。
   * 必须留足下一波的间隔，否则清空后可能在玩家眼前凭空冒出一堵墙。
   */
  clearObstacles() {
    const C = this.modeConf;
    for (const o of this.obstacles) this.world.release(o.mesh);
    this.obstacles = [];
    for (const d of this.demons) this.world.release(d.mesh);
    this.demons = [];
    this.sinceSpawn = 0;
    this.nextGap = C.firstGap * 0.6;
    this.sinceDemon = 0;
    this.nextDemon = C.demonFirstGap * 0.8;
    this.passableLanes = [0, 1, 2];
    this.lastWaveType = null;
  }

  /**
   * 只清小恶魔、不动障碍（测试注入后收场用）。
   * 和 clearObstacles 一样要重置"下一只"的间隔，
   * 否则清空后可能立刻在玩家脸上刷新出一只。
   */
  clearDemons() {
    const C = this.modeConf;
    for (const d of this.demons) this.world.release(d.mesh);
    this.demons = [];
    this.sinceDemon = 0;
    this.nextDemon = C.demonFirstGap * 0.8;
    return this;
  }

  /** 玩家当前所属车道索引（整数）。仅供 UI / 测试读取，判定一律用 laneF */
  get lane() { return Math.round(this.laneF); }

  /* ---------- 输入接口 ---------- */

  setLane(idx) {
    this.laneTarget = Math.max(0, Math.min(2, idx | 0));
  }

  moveLane(dir) {
    this.setLane(this.laneTarget + dir);
  }

  jump() {
    if (!this.airborne && this.state === 'running') {
      this.vy = CFG.jumpV;
      this.airborne = true;
    }
  }

  setDuck(v) {
    this.duck = !!v;
  }

  /* ---------- 挥拳（打小恶魔）---------- */

  /**
   * 这只恶魔此刻在不在"够得着"的范围？
   * 判定三件事：同车道（宽容差）+ 前方不超窗 + 还没越到身后。
   * 规则层用它决定两件事：出手能否命中、以及渲染层该不该给"可打"高亮。
   *
   * 窗口刻意偏宽（普通模式前后合计约 40 米）：体感识别本身有 0.2~0.3 秒延迟，
   * 怪又是贴脸速度逼近，窗口收得太紧只会让玩家"动作明明做对了却判挥空"。
   * 近端特意宽到身后 punchReach 米，就是专门去补这段延迟的。
   */
  _inPunchRange(d) {
    const C = this.modeConf;
    if (Math.abs(this.laneF - d.lane) > CFG.punchLaneTol) return false;
    if (d.z < -C.punchWindow || d.z > C.punchReach) return false;
    return true;
  }

  /** 场上是否有"可以打"的恶魔（HUD 用它提示玩家"该挥拳了"） */
  get demonInRange() { return this.demons.some((d) => d.hittable); }

  /**
   * 有没有恶魔"马上"就要进打击窗口（提前量按当前速度折算，约 0.45 秒）。
   * 为什么要单独有这个：从玩家看见提示 → 身体做出动作 → 被识别出来，
   * 实机要 0.4~0.5 秒。等怪真进了窗口才提示，玩家永远慢半拍 ——
   * 所以 HUD 拿它提前亮"来了！"，进窗口后再切成"挥拳！"。
   * 已经进窗口的那只不重复计入（那归 demonInRange 管）。
   */
  get demonApproaching() {
    const C = this.modeConf;
    const lead = this.speed * CFG.punchLead;
    for (const d of this.demons) {
      if (d.hittable) continue;
      if (Math.abs(this.laneF - d.lane) > CFG.punchLaneTol) continue;
      if (d.z >= -(C.punchWindow + lead) && d.z <= C.punchReach) return true;
    }
    return false;
  }

  /**
   * 记一次"发弹"事件 —— 纯给渲染层用，判定绝不读它。
   *
   * 为什么要有：命中判定是**出拳当帧即时结算**的（这样才有打击感、才跟手），
   * 但画面上如果只有拳头前伸，读起来像"隔空打牛"。
   * 补一颗从玩家手里飞出去的光弹，"我打中了"这件事才在画面里成立。
   *
   * 落点取怪**击退结算之后**的位置：于是视觉上就成了"子弹把它推走"，
   * 和击退是同一套叙事，而不是"子弹追着怪跑"。
   * 挥空时落点取打击窗口最远端 —— 打向空处，飞出去自然消散，
   * 玩家一眼能看出"这一拳出去了但没够到"，比什么都不发生好。
   */
  _recordShot(d, lethal) {
    const C = this.modeConf;
    this.shotId++;
    this.lastShot = {
      id: this.shotId,
      fromF: this.laneF,                     // 起点车道（渲染层自己换算成 x）
      x: d ? d.mesh.position.x : NaN,         // 落点（NaN = 同车道正前方）
      z: d ? d.z : -C.punchWindow,
      hit: !!d,
      lethal: !!lethal,
      // 目标怪的稳定 id：渲染层的弹丸每帧瞄向它的当前位置 ——
      // 怪在弹丸飞行途中还在逼近，固定落点会让弹丸"穿模而过"根本不停；
      // 盯着活目标飞，弹丸才会真正停在怪身上。挥空时为 NaN（飞向窗口尽头消散）。
      demonId: d ? d.id : NaN,
    };
  }

  /**
   * 出一拳。命中判定当场结算：
   *   · 车道容差比撞墙略宽容（拳头有长度，够得着邻道边缘）
   *   · 恶魔在 punchWindow 内才够得着 —— 太远挥空，过头了也打不到
   *   · 一拳最多命中一只，且优先打"最近的那只"（z 越大越靠近玩家）
   *   · 恶魔有血条（普通 3 / 困难 4），所以一拳是"打掉一格"而不是直接秒
   *   · 命中后把怪**击退**（见函数内说明）—— 这是"打不完就被撞"的正面解法
   * @returns {boolean} 是否命中
   */
  punch() {
    if (this.state !== 'running' || this.punchCd > 0) return false;
    const C = this.modeConf;
    this.punchT = 0;
    this.punchCd = C.punchCooldown;

    let best = -1;
    for (let i = 0; i < this.demons.length; i++) {
      const d = this.demons[i];
      if (!this._inPunchRange(d)) continue;
      if (best < 0 || d.z > this.demons[best].z) best = i;
    }
    if (best < 0) {
      // 打空也要发一颗：弹道飞出去 → 玩家立刻看懂"这一拳出手了，只是没够到"，
      // 比什么都不发生（看起来像没识别到出拳）清楚得多。
      this._recordShot(null, false);
      return false;
    }

    const d = this.demons[best];
    this.punches++;
    d.hp--;
    d.hitT = 0.22;                       // 受伤反馈计时（场景层用它做震缩脉冲）
    const killed = d.hp <= 0;

    // —— 击退：让"打中"这件事本身买回输出时间 ——
    // 为什么必须有它：打击窗口是个距离窗（普通 36 米），怪以 20 m/s 迎面而来，
    // 停留时间只有 36/20 ≈ 1.8 秒；而打光一条 3 格的血要连着好几拳。
    // 一旦玩家的反应 + 识别延迟占掉大半（实机约 0.5 秒），
    // "还没打死就撞上"就成了数学上的必然 —— 光调阈值治不了本。
    //   · 每中一拳把怪沿来路推远 knockback 米，等于把逼近进度往回倒一段
    //   · 越残血推得越远 —— 最后一拳最需要喘口气，顺手抹平"就差一拳"的挫败
    //   · 但绝不推出打击窗口（留 2 米余量），否则下一拳够不着，
    //     玩家会以为后续出拳全空了（那比被打死更让人困惑）
    if (!killed) {
      const kb = C.knockback * (1 + (d.maxHp - d.hp) / d.maxHp);
      const limit = -(C.punchWindow - 2);
      const before = d.z;
      d.z = Math.max(d.z - kb, limit);
      this.knockTotal += before - d.z;
      d.mesh.position.z = d.z;
      d.knockT = 0.25;                   // 场景层用它做"被打飞"的后仰
      d.hittable = this._inPunchRange(d); // 位置变了，立刻刷新"还能不能打"
    }

    // 打击特效放在位置结算之后 —— 击退是瞬时的，火花必须挂在怪"现在"的位置上，
    // 否则会留在原地，跟被打飞的怪分家
    this.world.demonHit(d.mesh.position.x, d.mesh.position.z, killed);

    // 发弹事件也放在击退之后：落点就是怪被推到的位置（_killDemon 会回收网格，
    // 所以必须赶在那之前把落点记下来）
    this._recordShot(d, killed);

    if (killed) { this._killDemon(best); return true; }

    // 打中但没打倒：照样给分、照样续连击 —— 玩家不该因为"一拳没打死"而白挥
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const mult = Math.min(3, 1 + (this.combo - 1) * 0.1);
    const pts = Math.round(CFG.demonHitScore * mult);
    this.score += pts;
    if (this.hooks.onDemonHit) this.hooks.onDemonHit(pts, d.hp, d.maxHp);
    return true;
  }

  _killDemon(i) {
    const d = this.demons[i];
    this.kills++;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const mult = Math.min(3, 1 + (this.combo - 1) * 0.1);
    const pts = Math.round(CFG.demonKillScore * mult);
    this.score += pts;
    this.world.demonKill(d.mesh.position.x, d.mesh.position.z);
    this.world.release(d.mesh);
    this.demons.splice(i, 1);
    if (this.hooks.onDemonKill) this.hooks.onDemonKill(pts);
  }

  /* ---------- 主循环 ---------- */

  update(dt) {
    dt = Math.min(dt, 1 / 20); // 防止切后台后 dt 爆炸
    this._advanceLane(dt);

    if (this.state !== 'running') {
      // 未开始时也让画面轻微滚动，UI 不死板
      this.world.update(dt, {
        laneF: this.laneF, lane: this.lane, jumpY: this.jumpY, duck: false,
        speed: this.state === 'over' ? 0 : 4, running: false, distance: this.distance,
        demons: this.demons, punchT: -1,
      });
      return;
    }

    const C = this.modeConf;
    this.elapsed += dt;

    // 出拳计时：冷却倒数 + 动画窗口（0.3s 后归位）
    if (this.punchCd > 0) this.punchCd -= dt;
    if (this.punchT >= 0) {
      this.punchT += dt;
      if (this.punchT > 0.3) this.punchT = -1;
    }

    // 速度随时间线性提升
    this.speed = Math.min(C.speedMax, C.speedStart + this.elapsed * C.speedRamp);

    // 跳跃物理
    if (this.airborne) {
      this.vy -= CFG.gravity * dt;
      this.jumpY += this.vy * dt;
      if (this.jumpY <= 0) { this.jumpY = 0; this.vy = 0; this.airborne = false; }
    }

    if (this.invT > 0) this.invT -= dt;

    const dz = this.speed * dt;
    this.distance += dz;
    this.score += dz * 0.6;
    this._checkLevelUp();     // 按跑动距离升级 → 回血 / 抬高血量上限

    this._spawn(dz);
    this._moveObstacles(dz);
    this._moveDemons(dz, dt);

    // 恶魔有自己独立的出场节奏（与障碍波错开，
    // 避免"打拳的瞬间迎面还压来一堵墙"的夹击死局）
    this.sinceDemon += dz;
    if (this.sinceDemon >= this.nextDemon) {
      const dz0 = CFG.spawnAheadZ - 6;
      const lane = this._pickDemonLane(dz0);
      if (lane < 0) {
        // 三条道都被就近的障碍占着 → 这一拍先不出怪，再跑 20 单位后重试
        this.sinceDemon = this.nextDemon - 20;
      } else {
        this.sinceDemon = 0;
        this.nextDemon = C.demonGapMin + Math.random() * (C.demonGapMax - C.demonGapMin);
        this._addDemon(lane, dz0);
      }
    }

    this.world.update(dt, {
      laneF: this.laneF, lane: this.lane, jumpY: this.jumpY, duck: this.duck,
      speed: this.speed, running: true, distance: this.distance,
      demons: this.demons, punchT: this.punchT,
      shot: this.lastShot,          // 新的一发拳弹（渲染层按 id 去重，见 scene.js）
    });
  }

  /**
   * 推进玩家的横向位置。
   *
   * laneF 是连续值（0/1/2 之间是过渡状态），渲染和碰撞都读它。
   * 旧代码渲染层自己插值、判定层却用离散 lane，
   * 结果玩家刚按下变道、画面上人才挪出一点点，
   * 系统在逻辑上却已经当成"人在左道了"，于是撞上左道的墙 —— 看着根本没碰到。
   */
  _advanceLane(dt) {
    const k = Math.min(1, dt * CFG.laneLerp);
    this.laneF += (this.laneTarget - this.laneF) * k;
    if (Math.abs(this.laneTarget - this.laneF) < 0.002) this.laneF = this.laneTarget;
  }

  /* ---------- 障碍生成 ---------- */

  /** 难度等级 0..N，按模式的距离刻度提升（只影响速度/间距，不是玩家等级） */
  get diffLevel() { return Math.floor(this.distance / this.modeConf.levelDist); }

  /**
   * 玩家等级：从 1 起，按跑动距离提升（每 levelUpDist 米一级）。
   * **不设上限** —— 跑多远就长多强，这是玩家能一直跑下去的正反馈。
   * 与"难度等级"是两码事：难度等级决定游戏多难（有封顶），
   * 玩家等级是成长刻度（无封顶），升级会回血并抬高血量上限（见 _checkLevelUp）。
   */
  get level() {
    const C = this.modeConf;
    return 1 + Math.floor(this.distance / C.levelUpDist);
  }

  /** 升到下一级还差多少米（HUD 进度条 / 提示用） */
  get levelProgress() {
    const C = this.modeConf;
    const into = this.distance % C.levelUpDist;
    return Math.max(0, Math.min(1, into / C.levelUpDist));
  }

  /**
   * 升级结算：等级涨了就回血 + 抬高血量上限（两者都不封顶）。
   * 一帧可能跨过多个等级（高速下 dt 大），所以用 while 逐级补算。
   */
  _checkLevelUp() {
    const lv = this.level;
    while (this._lastLevel < lv) {
      this._lastLevel++;
      this.levelsGained++;
      // 抬高上限再回 1 血 —— 玩家能看到"心变多了 + 缺的那颗补上"
      this.livesMax++;
      this.lives = Math.min(this.livesMax, this.lives + 1);
      if (this.hooks.onLevelUp) this.hooks.onLevelUp(this._lastLevel, this.livesMax);
    }
  }

  /**
   * 这条道上、以 z 为中心的互斥半径内有没有恶魔占着？
   * 两个方向都要用：
   *   · 生成障碍前问一次 —— 恶魔刚出生（z≈-101）时不能在它身后 6 单位处放墙
   *   · 生成恶魔前问一次（换个问法：_pickDemonLane）—— 别让恶魔出生在墙后面
   */
  _demonInLane(lane, z = CFG.spawnAheadZ) {
    const span = CFG.demonLaneClear;
    for (const d of this.demons) {
      if (d.lane !== lane) continue;
      if (Math.abs(d.z - z) <= span) return true;
    }
    return false;
  }

  /**
   * 挑一条"出生点附近没有障碍"的道 —— 恶魔绝不能被墙挡在身后。
   * 三条道都被就近的障碍占着时返回 -1，由调用方推迟这次出场
   * （推迟而不是硬塞：宁可晚半秒出怪，也不要让怪卡在墙后面）。
   */
  _pickDemonLane(z) {
    const span = CFG.demonLaneClear;
    const bad = new Set();
    for (const o of this.obstacles) {
      if (Math.abs(o.z - z) <= span) bad.add(o.lane);
    }
    const free = [0, 1, 2].filter((l) => !bad.has(l));
    if (!free.length) return -1;
    return free[Math.floor(Math.random() * free.length)];
  }

  /**
   * 障碍生成。
   * 注意 sinceSpawn 只是"距离累加器"（用来决定多久出一波），
   * 而障碍物的 z 坐标必须固定在远处的 CFG.spawnAheadZ，
   * 否则会生成在玩家身后被立刻回收。
   */
  _spawn(dz) {
    const C = this.modeConf;
    this.sinceSpawn += dz;
    if (this.sinceSpawn < this.nextGap) return;
    this.sinceSpawn = 0;

    const lv = Math.min(this.diffLevel, C.maxLevel);
    // 间距随等级缩短，但保底 gapMin —— 这是"10 分钟玩得下去"的关键参数
    this.nextGap = Math.max(C.gapMin, C.gapBase - lv * C.gapStep) + Math.random() * C.gapJitter;

    // 同一 z 上只使用同一种类型：
    // 混排会出现"又要跳又要蹲"的死局，必须避免
    const roll = Math.random();
    let type;
    if (roll < 0.42) type = 'block';
    else if (roll < 0.72) type = 'hurdle';
    else type = 'overhead';

    // 防死局：跳过低栏后约有 0.7s 滞空，滞空期间无法执行"蹲"。
    // 若这一波是 hurdle 而下一波马上是高杆，玩家还在空中必然撞上。
    // 所以 hurdle 这一波之后，强制留出足够落地距离（按当前速度换算）。
    if (type === 'hurdle') {
      const landingGap = this.speed * 0.6 + 10;
      if (this.nextGap < landingGap) this.nextGap = landingGap;
    }
    this.lastWaveType = type;

    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    // 恶魔占着的道不放障碍（详见 CFG.demonLaneClear 的说明）
    const freeOfDemon = (l) => !this._demonInLane(l, CFG.spawnAheadZ);

    if (type === 'block') {
      // 实墙：留一条活路，且这条活路必须是玩家"一步就能走到"的。
      //
      // 这里只允许最多横跨 1 条道。真实原因不只是操作难度：
      // 变道是有插值的，横跨两条道要花约 0.3 秒，
      // 这中间玩家人还在半路，很可能被途径的那条道上的东西判中 ——
      // 也就是"画面上看还站在别处，却提示撞了"。一律一步到位就不会有这种错觉。
      const MAX_STEP = 1;
      // 玩家上一波可能在哪些道：
      //   - 上一波是 hurdle/overhead：三条道都可能（不需要变道）
      //   - 上一波是 block：只可能在当时的那条活路上
      let cands = [0, 1, 2].filter(
        (f) => this.passableLanes.every((p) => Math.abs(f - p) <= MAX_STEP)
      );
      if (!cands.length) cands = [this.passableLanes[0] ?? 1];
      const prefer = cands.filter(freeOfDemon);
      if (prefer.length) cands = prefer;
      const free = pick(cands);
      this.passableLanes = [free];

      let blocked = [0, 1, 2].filter((l) => l !== free && freeOfDemon(l));
      if (!blocked.length) blocked = [0, 1, 2].filter((l) => l !== free);
      const n = lv >= 2 && Math.random() < 0.6 ? 2 : 1;
      for (let i = blocked.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [blocked[i], blocked[j]] = [blocked[j], blocked[i]];
      }
      for (let i = 0; i < n && i < blocked.length; i++) this._addObstacle(type, blocked[i], CFG.spawnAheadZ);
    } else {
      // 低栏/高杆：统一动作即可通过，可以占满整排（视觉更爽）
      let lanes = [0, 1, 2].filter(freeOfDemon);
      if (!lanes.length) lanes = [0, 1, 2];
      for (let i = lanes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
      }
      const maxCount = lv >= 3 ? 3 : lv >= 1 ? 2 : 1;
      const count = 1 + Math.floor(Math.random() * maxCount);
      for (let i = 0; i < count && i < lanes.length; i++) this._addObstacle(type, lanes[i], CFG.spawnAheadZ);
      // 低栏/高杆不需要变道，玩家可能停在任意一条道
      this.passableLanes = [0, 1, 2];
    }
  }

  _addObstacle(type, lane, z) {
    const mesh = this.world.acquire(type);
    mesh.position.set(LANE_X[lane], 0, z);
    this.obstacles.push({ type, lane, z, mesh, scored: false });
  }

  _moveObstacles(dz) {
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
      const prevZ = o.z;
      o.z += dz;
      o.mesh.position.z = o.z;

      // 扫掠判定：只在"跨过玩家所在平面(z=0)"的那一帧结算一次。
      // 这样即使掉帧导致 dz 很大（高速 36 / 低帧率），也不会出现
      // 障碍物一帧跨过玩家却没判定的"隧穿"问题。
      if (!o.scored && prevZ < 0 && o.z >= 0) {
        o.scored = true;
        const hit = this._isHit(o);
        if (hit) {
          if (this.invT <= 0) this._takeHit(o);
        } else {
          this.combo++;
          this.bestCombo = Math.max(this.bestCombo, this.combo);
          this.cleared++;
          // 连击加成：每段连击 +10%，上限 3 倍
          const mult = Math.min(3, 1 + (this.combo - 1) * 0.1);
          this.score += 100 * mult;
          if (this.hooks.onClear) this.hooks.onClear(this.combo, 100 * mult);
        }
      }

      if (o.z > CFG.despawnZ) {
        this.world.release(o.mesh);
        this.obstacles.splice(i, 1);
      }
    }
  }

  _addDemon(lane, z) {
    const mesh = this.world.acquire('demon');
    mesh.position.set(LANE_X[lane], 0, z);
    this.demons.push({
      id: ++this.demonSeq,      // 稳定 id：发射事件用它指认目标，渲染层的拳弹据此追踪
      lane, z, mesh, scored: false,
      hp: this.modeConf.demonHp, maxHp: this.modeConf.demonHp,
      hitT: 0, knockT: 0, hittable: false,
    });
  }

  /**
   * 恶魔推进 + 扫掠判定（与障碍同一套防隧穿思路，只在跨过 z=0 那一帧结算）。
   * 恶魔不高（占 0~1.15）：起跳够高可以从头上跃过，
   * 但最稳的处理方式还是迎面几拳 —— 这正是它存在的意义。
   */
  _moveDemons(dz, dt) {
    for (let i = this.demons.length - 1; i >= 0; i--) {
      const d = this.demons[i];
      const prevZ = d.z;
      d.z += dz;
      d.mesh.position.z = d.z;
      if (d.hitT > 0) d.hitT = Math.max(0, d.hitT - dt);
      if (d.knockT > 0) d.knockT = Math.max(0, d.knockT - dt);
      // 每帧刷新"能不能打"：规则层算一次，出手判定和渲染高亮共用同一个真相
      d.hittable = this._inPunchRange(d);

      if (!d.scored && prevZ < 0 && d.z >= 0) {
        d.scored = true;
        const over = this.jumpY > CFG.demonJumpClear;   // 跳得比恶魔头顶还高 → 跃过
        if (!over && Math.abs(this.laneF - d.lane) <= CFG.laneTol && this.invT <= 0) {
          this._demonStrike(d, i);
          continue;   // 已经被移出数组
        }
      }

      if (d.z > CFG.despawnZ) {
        this.world.release(d.mesh);
        this.demons.splice(i, 1);
      }
    }
  }

  /* ---------- 碰撞 ---------- */

  /** 判断某个障碍物是否撞到玩家 */
  _isHit(o) {
    // 用连续的横向位置判定：玩家正在两道之间时，只能被确实挨着的障碍碰到
    if (Math.abs(this.laneF - o.lane) > CFG.laneTol) return false;

    const spec = OBSTACLE[o.type];
    // 玩家当前占据的高度区间
    const headTop = this.duck ? 1.05 : 2.1;
    const pBottom = this.jumpY;
    const pTop = pBottom + headTop;

    // 高度区间有交叠 → 撞上
    return pBottom < spec.yMax && pTop > spec.yMin;
  }

  /**
   * 被小恶魔迎面撞上。
   * 刻意"手软"：只扣 1 血，但给一段明显更长的无敌时间，
   * 并且把恶魔一起撞散 —— 不会被同一只怪连着打好几下。
   * 玩家真想死，得靠反复撞墙；被怪碰到不会"轻易送走"。
   */
  _demonStrike(d, i) {
    this.world.demonKill(d.mesh.position.x, d.mesh.position.z);
    this.world.release(d.mesh);
    this.demons.splice(i, 1);
    this._takeHit({ type: 'demon' });
  }

  _takeHit(o) {
    const C = this.modeConf;
    const demon = !!o && o.type === 'demon';
    this.lives--;
    this.hits++;
    this.combo = 0;
    this.invT = demon ? C.demonInvincible : C.invincible;
    this.world.hitFlash();
    if (this.hooks.onHit) this.hooks.onHit(o ? o.type : '', this.lives);
    if (this.lives <= 0) {
      this.lives = 0;
      this.state = 'over';
      if (this.hooks.onOver) this.hooks.onOver(this._summary());
    }
  }

  _summary() {
    return {
      score: Math.floor(this.score),
      distance: Math.floor(this.distance),
      cleared: this.cleared,
      demons: this.kills,
      punches: this.punches,
      hits: this.hits,
      bestCombo: this.bestCombo,
      level: this.level,                 // 玩家等级（按距离成长）
      diffLevel: this.diffLevel,         // 难度等级（影响速度/间距）
      levelsGained: this.levelsGained,
      lives: this.lives,
      livesMax: this.livesMax,
      mode: this.modeConf.key,
      modeLabel: this.modeConf.label,
    };
  }

  get summary() { return this._summary(); }
}
