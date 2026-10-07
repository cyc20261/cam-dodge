/**
 * pose.js —— MediaPipe Pose 封装 + 手势识别
 *
 * 职责边界：
 *   1. 驱动摄像头 + MediaPipe PoseLandmarker，输出 33 个关键点
 *   2. 把关键点翻译成"游戏语义"：变道 / 起跳 / 下蹲
 *   3. 全部识别在本地浏览器完成，画面不出本机（答辩可强调的隐私卖点）
 *
 * ── 低延迟设计（v2）────────────────────────────────
 * 旧版把检测挂在 requestAnimationFrame 上，有两个问题：
 *   a) 相机 30fps、屏幕 60fps，一半渲染帧拿到的都是旧数据 → 平白多等一帧
 *   b) 相机帧常在两次渲染之间到达，却要等到下一次 rAF 才处理 → 又多一帧
 * 现在改成用 video.requestVideoFrameCallback 驱动：相机一出新帧立刻识别，
 * 识别完立刻把结果推给游戏逻辑，不再等渲染帧。可省 1~2 帧（约 16~33ms）。
 *
 * 同时把"稳定优先"的保守参数下调为"跟手优先"：
 *   EMA 平滑 0.35 → 0.55；起跳/下蹲 2 帧触发 → 1 帧；变道阈值 0.28 → 0.20
 */

// BlazePose 33 关键点索引
export const LM = {
  NOSE: 0,
  L_SH: 11, R_SH: 12,
  L_EL: 13, R_EL: 14,
  L_WR: 15, R_WR: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
};

/* ============ 工具函数 ============ */

function vis(lms, i) {
  return lms[i] && typeof lms[i].visibility === 'number' ? lms[i].visibility : 1;
}

/** 取两个关键点的中点 */
function mid(lms, a, b) {
  const A = lms[a], B = lms[b];
  if (!A || !B) return null;
  return { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, v: Math.min(vis(lms, a), vis(lms, b)) };
}

/* ============ 姿态追踪器 ============ */

export class PoseTracker {
  constructor(config) {
    this.config = config; // { wasmBase, modelUrl, modelUrlFull }
    this.landmarker = null;
    this.video = null;
    this.stream = null;
    this.running = false;
    this.lastTs = -1;
    this.latest = null;      // 最近一次结果 { landmarks, ts }
    this.onResult = null;
    this.delegate = null;

    // 模型档位：lite 起步（快），检测不到人时自动升级 full（稳）
    this.quality = 'lite';

    // —— 诊断指标（识别不出人体时全靠它定位原因）——
    this.calls = 0;          // 累计调用检测次数
    this.hits = 0;           // 其中"画面里有人"的次数
    this.brightness = 0;     // 画面平均亮度 0~255
    this.boosting = false;   // 是否正在做暗光提亮

    // —— 性能 / 延迟指标（供自适应降质与 HUD 显示）——
    this.detectMs = 0;       // 单次 detectForVideo 耗时（EMA）
    this.lastResultAt = 0;
    this.fps = 0;            // 实际检测帧率
    this._n = 0; this._t0 = 0;

    // 降质节流：1 = 每帧相机都检测；2 = 隔一帧；越大越省算力
    this.throttle = 1;
    this._frameSkip = 0;

    this._raf = null;
    this._rvfcHandle = null;
    this._watchdog = null;
    this._useRvfc = true;
    this._boostCanvas = null;
    this._probeCanvas = null;
  }

  /** 打开摄像头。quality 用于低端设备降分辨率换取更低延迟 */
  async openCamera(videoEl, quality = 'high') {
    this.video = videoEl;
    const res = quality === 'low'
      ? { width: { ideal: 320 }, height: { ideal: 240 } }
      : quality === 'mid'
        ? { width: { ideal: 480 }, height: { ideal: 360 } }
        : { width: { ideal: 640 }, height: { ideal: 480 } };

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { ...res, facingMode: 'user' },
      audio: false,
    });
    videoEl.srcObject = this.stream;
    await new Promise((resolve) => {
      if (videoEl.readyState >= 2) return resolve();
      videoEl.onloadeddata = () => resolve();
    });
    await videoEl.play().catch(() => {});
    return { width: videoEl.videoWidth, height: videoEl.videoHeight };
  }

  get modelUrl() {
    return this.quality === 'full' ? (this.config.modelUrlFull || this.config.modelUrl) : this.config.modelUrl;
  }

  /** 以指定档位创建 landmarker，GPU 优先，失败自动降级 CPU */
  async _createLandmarker(fileset) {
    const { PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const baseOptions = { modelAssetPath: this.modelUrl, delegate: 'GPU' };
    // 置信度：早先压到 0.4（比官方默认 0.5 松），是为了让"半身入镜 / 逆光"
    // 这些勉强认得出的有效帧别被判成无人。但实机反馈是**太灵敏**了：
    // 阈值放松后，画面里的杂物、椅背、墙上的人影都会被当成"疑似人体"而输出
    // 一组飘忽的关键点 —— 玩家自己没动，游戏却在乱变道 / 乱起跳。
    // 现在回到 0.45：比官方默认略松（保住半身场景），但足以滤掉这些假人体。
    const common = {
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
      outputSegmentationMasks: false,
    };
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, { baseOptions, ...common });
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('[pose] GPU delegate 失败，降级 CPU：', e);
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { ...baseOptions, delegate: 'CPU' },
        ...common,
      });
      this.delegate = 'CPU';
    }
  }

  /** 加载 MediaPipe 模型。GPU 不可用时自动降级 CPU */
  async loadModel(quality = 'lite') {
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(this.config.wasmBase);
    this.quality = quality;
    await this._createLandmarker(fileset);
    return this.delegate;
  }

  /**
   * 换模型档位（不打断摄像头流）。
   * 用途：lite 长时间检测不到人时，现场升级到 full 再试 —— full 对
   * "只露上半身 / 逆光 / 遮挡"明显更稳，代价是单次推理更贵。
   */
  async switchModel(quality) {
    if (quality === this.quality) return this.quality;
    if (quality === 'full' && !this.config.modelUrlFull) return this.quality;
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(this.config.wasmBase);
    if (this.landmarker) {
      try { this.landmarker.close(); } catch {}
      this.landmarker = null;
    }
    this.quality = quality;
    await this._createLandmarker(fileset);
    return this.quality;
  }

  /**
   * 启动检测。优先 requestVideoFrameCallback（相机出帧即触发，延迟最低），
   * 不支持则退回 rAF。
   * @param {(result) => void} onResult 每得到一次结果就回调，不等渲染帧
   */
  start(onResult) {
    this.onResult = onResult;
    this.running = true;
    this._n = 0; this._t0 = performance.now();
    this._startLoop();

    // 看门狗：有些摄像头 / 虚拟摄像头 / 浏览器版本下，
    // requestVideoFrameCallback 注册了却一帧都不回调，表现就是"永远识别不出人体"。
    // 检测到这种情况自动改用 rAF 轮询，不让玩家干等。
    let lastSeenCalls = this.calls;
    let sinceChange = performance.now();
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (!this.running) return;
      if (this.calls > lastSeenCalls) { lastSeenCalls = this.calls; return; }
      if (performance.now() - sinceChange < 1500) return;
      if (this._useRvfc) {
        console.warn('[pose] requestVideoFrameCallback 无回调，切换 rAF 轮询');
        this._useRvfc = false;
      } else {
        console.warn('[pose] 检测循环无进展：视频流可能没有新帧');
        clearInterval(this._watchdog); this._watchdog = null;
        return;
      }
      sinceChange = performance.now();
      this._cancelLoop();
      this._startLoop();
    }, 800);
  }

  _startLoop() {
    const v = this.video;
    if (this._useRvfc && typeof v.requestVideoFrameCallback === 'function') {
      const cb = () => {
        if (!this.running) return;
        this._detectOnce();
        this._rvfcHandle = v.requestVideoFrameCallback(cb);
      };
      this._rvfcHandle = v.requestVideoFrameCallback(cb);
    } else {
      const tick = () => {
        if (!this.running) return;
        this._detectOnce();
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
  }

  _cancelLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._rvfcHandle != null && this.video && this.video.cancelVideoFrameCallback) {
      try { this.video.cancelVideoFrameCallback(this._rvfcHandle); } catch {}
      this._rvfcHandle = null;
    }
  }

  /**
   * 取平均亮度。每 12 次检测量一次，代价可忽略。
   * 用途：房间太暗时 MediaPipe 直接漏检，玩家需要被明确告知"开灯"，
   * 而不是看着"未识别到人体"一头雾水。
   */
  _measureBrightness() {
    const v = this.video;
    if (!v || !v.videoWidth) return;
    try {
      if (!this._probeCanvas) this._probeCanvas = document.createElement('canvas');
      const cv = this._probeCanvas;
      cv.width = 48; cv.height = 27;
      const c = cv.getContext('2d');
      c.drawImage(v, 0, 0, cv.width, cv.height);
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      this.brightness = Math.round(sum / (d.length / 4));
    } catch { /* 跨域 / 尚未就绪，忽略 */ }
  }

  /**
   * 暗光提亮：把视频帧画到 canvas 上做 gamma/亮度提升，再送去识别。
   * 只在亮度不足时启用 —— 多一次全帧拷贝有成本，但总比一直检测不到人强。
   */
  _frameSource() {
    const v = this.video;
    if (this.brightness === 0 || this.brightness > 70) { this.boosting = false; return v; }
    try {
      if (!this._boostCanvas) this._boostCanvas = document.createElement('canvas');
      const cv = this._boostCanvas;
      if (cv.width !== v.videoWidth || cv.height !== v.videoHeight) {
        cv.width = v.videoWidth; cv.height = v.videoHeight;
      }
      const c = cv.getContext('2d');
      const gain = Math.min(2.4, 110 / Math.max(this.brightness, 12));
      c.filter = `brightness(${gain.toFixed(2)}) contrast(1.15)`;
      c.drawImage(v, 0, 0, cv.width, cv.height);
      this.boosting = true;
      return cv;
    } catch {
      this.boosting = false;
      return v;
    }
  }

  _detectOnce() {
    const v = this.video;
    if (!v || !this.landmarker || v.readyState < 2) return;

    // 节流：机器跑不动时隔帧检测，把算力让给渲染，优先保证画面不掉帧
    if (this.throttle > 1 && (this._frameSkip = (this._frameSkip + 1) % this.throttle) !== 0) return;

    // MediaPipe 要求时间戳严格递增
    const ts = performance.now();
    if (ts <= this.lastTs) return;
    this.lastTs = ts;

    if (this.calls % 12 === 0) this._measureBrightness();
    this.calls++;

    const t0 = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(this._frameSource(), ts);
    } catch (e) {
      return; // 偶发丢帧，忽略
    }
    const cost = performance.now() - t0;
    // 第一次推理包含模型预热（实测可达数秒），不能计入延迟指标，
    // 否则自适应降质器会在开局就把画质砍下去
    if (this.calls > 1) this.detectMs = this.detectMs ? this.detectMs * 0.8 + cost * 0.2 : cost;
    else this.detectMs = 0;

    const lms = result && result.landmarks && result.landmarks[0];
    if (lms) this.hits++;
    this.latest = lms ? { landmarks: lms, ts } : null;
    this.lastResultAt = ts;

    this._n++;
    const now = performance.now();
    if (now - this._t0 >= 1000) {
      this.fps = Math.round((this._n * 1000) / (now - this._t0));
      this._n = 0; this._t0 = now;
    }

    if (this.onResult) this.onResult(this.latest);
  }

  /** 结果"新鲜度"：距上一次出结果过了多少毫秒 */
  ageMs(now = performance.now()) {
    return this.lastResultAt ? now - this.lastResultAt : Infinity;
  }

  setThrottle(n) { this.throttle = Math.max(1, Math.min(4, n | 0)); }

  stop() {
    this.running = false;
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    this._cancelLoop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.landmarker) { try { this.landmarker.close(); } catch {} this.landmarker = null; }
    this.latest = null;
    this.calls = 0; this.hits = 0;
    this._useRvfc = true;   // 下一次重新尝试使用更好的驱动方式
  }
}

/* ============ 手势识别器 ============ */

/**
 * 输出信号：
 *   lane   : -1 左道 / 0 中道 / 1 右道
 *   jump   : 本次是否触发起跳（边沿信号，带冷却）
 *   duck   : 当前是否处于下蹲（电平信号）
 * 模式：
 *   'full' 全身可见（髋/膝可追踪）
 *   'half' 仅上半身可见（讲台/近距离场景）
 */
/**
 * 灵敏度参数（集中在 CONFIG，方便现场按房间光线/摄像头调）
 *
 * ── 为什么上一版会"没做动作却动了" ──────────────────────
 * MediaPipe 的关键点输出本身就带抖动，而且人站着不动时本来就在缓慢漂移
 * （呼吸、重心转移、衣服轮廓变化），这部分不是随机噪声、无法靠平滑消除。
 * 实测这段自然漂移换算到归一化位移 dy 大约 ±0.08，
 * 而旧版起跳阈值 RISE_TH 只有 0.085 —— 阈值就在漂移区间里，必然误触发。
 *
 * ── 现在的做法 ──────────────────────────────────────
 *   1) 阈值抬到显著高于自然漂移、又远低于刻意动作的幅度内侧
 *      （刻意跳跃 dy 约 0.4~0.8，是阈值的 2.5~5 倍，所以仍然跟手）
 *   2) 引入"慢基线"：追踪近期的缓慢漂移，判定用快基线相对慢基线的偏移。
 *      于是"慢慢站歪了、重心偏了"会被吸收掉，只有真正的快速动作才触发。
 *      这是同时做到「不误触」和「够跟手」的关键。
 *   3) 车道切换加双阈值：小幅犹豫要看两帧，大幅移动立刻响应。
 */
export const CONFIG = {
  /* ── 双通道平滑（v7 提速的核心）──
     以前只有一个 EMA：它既决定"触发跟不跟手"，又决定"基线/静止怎么判"。
     把 EMA 提上去换速度，噪声就会涌进基线维护 → 幽灵动作复发；
     把 EMA 压住保稳，动作又慢半拍。两头不可兼得。
     现在拆开：
       EMA      快通道，只管触发判定 → 调大 = 更跟手
       EMA_BASE 慢通道，只管基线漂移/静止簿记 → 调小 = 更稳
     噪声只影响快通道，而快通道的判定全部带"方向 + 幅度"双重门槛，
     所以提速不再以牺牲抗噪为代价。 */
  EMA: 0.72,          // 快平滑系数：0.5 → 0.72，砍掉约 1 帧滞后
  EMA_BASE: 0.30,     // 慢平滑系数：只喂给静止判定与基线漂移吸收

  /* ── 基线维护：决定"什么算动了" ── */
  STILL_WIN: 400,     // 静止判定窗口(ms)：看最近这段时间里位移的峰谷差
  STILL_RANGE: 0.09,  // 峰谷差小于此值才算"站住没动"（辅判据，见 STILL_VEL）
  STILL_VEL: 0.35,    // 慢通道速度(/s)小于此值也算静止：漂移是慢的、动作是快的，两者差一个数量级。
                      // 只用"峰谷差"会把大振幅的慢漂移误判成"在动"，于是基线被永久冻住 → 幽灵动作。
  DRIFT_FOLLOW: 0.08, // 静止且偏移很小时：慢基线缓慢追随，吸收呼吸/重心漂移
  DRIFT_BAND: 0.20,   // 静止时 |dy| 在此之内才当"漂移"吸收；超过则视为刻意保持的姿势，冻结基线不吸收
  REBASE_DELAY_UP: 500,    // 持续抬高的新姿势（如从坐姿站起来）维持多久后重设基线
  REBASE_DELAY_DOWN: 1600, // 持续下沉更保守：别把玩家主动保持的长蹲给吸收了
  REBASE_RATE: 0.12,       // 重锚速度（每帧收敛比例，30fps 下约 0.8s 收敛完）

  /* ── 竖直判定 ──
     ⚠ 门槛按"实机手感太灵敏"的反馈统一上浮约 25%。
     注意阈值单位是**肩宽**（dy 会除以标定尺度 S），现场一个人抬身 10cm，
     换算成肩宽往往就有 0.3~0.4 —— 所以 0.12 这种数看着小，实际非常容易够到。 */
  DEAD: 0.06,         // 竖直死区：dy 在此之内一律视为没动（0.05 → 0.06）
  RISE: 0.15,         // 起跳阈值（0.12 → 0.15）
  RISE_STRONG: 0.30,  // 已明确越过阈值（真跳的中后段）：单帧立即放行，不再等确认帧
  RE_ARM: 0.08,       // 滞回：dy 要回到这个范围内，才允许下一次起跳
  MAX_ATTACK: 420,    // 从离开原位到越过阈值的最长时间；超过就是"姿势改变"不是跳
  CONFIRM: 2,         // 常规位置信号需要连续几帧成立（明确越过 RISE_STRONG 或速度够快则免）
  PRED: 0.09,         // 用短窗口速度预判 90ms 后的位置
  RISE_VEL_FAST: 1.0, // 上抬快通道"单独达标"线：这么猛一定是真跳，不必等佐证（保住最快那一档）
  RISE_VEL: 0.7,      // 上抬快通道"需佐证"线：配合下面慢通道一起成立即可提前触发
  RISE_VEL_B: 0.45,   // 上抬的慢通道佐证速度(/s)：噪声很难让两条通道同时同向达标
  DROP: 0.15,         // 下蹲阈值（位置通道，需配合屈膝角/快速下沉/持续下沉才放行）（0.12 → 0.15）
  DROP_RUN: 2,        // 位置通道连续下沉多少帧放行（噪声突发远短于此）
  SINK_VEL_FAST: 1.0, // 下沉快通道"单独达标"线
  SINK_VEL: 0.7,      // 下沉快通道"需佐证"线
  SINK_VEL_B: 0.45,   // 下沉的慢通道佐证速度(/s)

  /* ── 变道 ──
     阈值单位同样是肩宽：横向挪动 0.14（屏幕比例）≈ 0.5 个肩宽，正是"一步"的量级。
     早先降到 0.24/0.15 是为了跟手，但实机手感偏"窜" —— 侧一下身就滑到边道。
     现在上浮到 0.30/0.20：一步仍然够到，但半身晃动不会被判成变道。 */
  LANE_TH: 0.30,      // 变道阈值（相对当前横向参考）（0.24 → 0.30）
  LANE_STRONG: 0.62,  // 甩得这么远直接放行（识别丢失几帧后会这样）
  LANE_MIN: 0.22,     // 走"速度快通道"时要求的最小横向位移（0.18 → 0.22）
  LANE_FAST: 1.2,     // 短窗口横向速度(/s)：达到即视为真的迈了一步，一帧放行
  LANE_STEP: 0.20,    // "最近这段时间的横向挪动量"超过这个才算真的迈了一步（0.15 → 0.20）
  LANE_BACK: 0.18,    // 回到中间的回滞阈值
  X_FOLLOW: 0.03,     // 人在中间区域时，横向参考跟随的速度（约 1.5s 时间常数）
  LANE_DWELL: 90,     // 变道后最小驻留时间(ms)：70 → 90，连摆两步不再被吞，也防连窜
  LANE_WIN: 160,      // 短窗口长度(ms)：横向/竖直"快速动作"的判定基线

  JUMP_COOLDOWN: 280, // 一次起跳的最小间隔(ms)
  DUCK_RELEASE: 80,   // 蹲下信号的释放延迟(ms)

  /* ── 挥拳（v2：多通道融合）──
     MediaPipe 的 z 轴（越负越靠近摄像头）天然适合表达"正对镜头的直拳"：
     打拳 = 拳头 z 在极短时间内快速变小。前伸量用肩宽归一化，与摄像头远近无关。

     ⚠ 为什么必须加兜底通道（v1 的实机教训）：
     z 轴是 MediaPipe 三个轴里最不可靠的一个 —— 噪声大、动态范围小，
     而且不同摄像头/机位差异明显。实测很多人在自己电脑前挥拳，
     前伸量根本到不了 0.42，怎么打都"识别不出来"。
     所以现在三条通道任一成立即出拳：
       ① 前伸量 + 速度   —— 正对镜头的直拳（z 通道）
       ② 极快前伸速度     —— 快速刺拳（幅度没到阈值也放行）
       ③ 画面内手腕甩速   —— 侧勾拳 / 斜拳 / z 不可靠时的兜底
     全部要求"手腕可见"且够快：慢动作、日常摆臂、身体前倾都达不到速度线。 */
  PUNCH_EXT: 0.24,      // ① 拳头伸到身前多远（肩宽比例）才算"出去了"（0.42 → 0.24）
  // ① 前伸速度门槛（前伸量/秒）。
  // ⚠ 这条不能压太低：z 轴噪声（约 ±0.008）经肩宽归一化后会被放大到 ±0.08，
  // 在 160ms 判定窗里能伪造出约 0.95/s 的假速度。阈值必须留在这条噪声线之上，
  // 否则"慢慢前倾"也会被当成出拳（实测 0.85 时就会误触）。
  // 真正的拳头（0.2s 内前伸 0.4~0.8）速度在 2~6/s，1.35 留了足够余量。
  PUNCH_VEL: 1.35,
  PUNCH_VEL_FAST: 2.2,  // ② 极快前伸速度：单速度通道即可放行（快速刺拳）
  PUNCH_EXT_MIN: 0.09,  // 走速度类通道时，至少要"稍微伸出去一点"，防手臂乱晃（0.06 → 0.09）
  PUNCH_SPD2D: 3.0,     // ③ 手腕在画面里的移动速度（肩宽/秒）：侧勾拳的兜底通道（2.6 → 3.0）
  PUNCH_EMA: 0.7,       // 前伸量的快平滑系数（越大越跟手）
  PUNCH_BACK: 0.12,     // 收回到此以内才允许下一次出拳（一伸一收算一拳）
  // 连打节奏 —— 这三个数是"打不完就被撞"的一部分解法（另一半在 game.js 的击退）。
  // 旧值 380/320 意味着最快也要 3 拳/秒，而怪贴脸时的窗口只有一秒多；
  // 现在一伸一收的节奏由玩家的手控制，收得回来就能接着打。
  PUNCH_REARM_MS: 240,  // 出拳后这么久强制解除 latch：连续挥拳不会被"忘记收回"卡住
  PUNCH_COOLDOWN: 190,  // 两次出拳的最小间隔(ms)：低于一次真实收拳的时间，不会有"一拳算两拳"

  MIN_VIS: 0.35,      // 关键点可见度门槛（针对肩部主参照），低于此值该帧数据作废
};

export class GestureRecognizer {
  constructor(cfg) {
    this.cfg = Object.assign({}, CONFIG, cfg || {});
    this.reset();
  }

  reset() {
    this.baseline = null;      // 标定基准（开局那一瞬的绝对位置）
    this.calib = { n: 0, hipY: 0, hipX: 0, shY: 0, shX: 0, scale: 0 };
    this.raw = null;           // 原始采样（未平滑）
    this.sm = null;            // 快平滑：响应动作（触发判定用）
    this.smB = null;           // 慢平滑：静止判定 / 基线漂移簿记用（不参与触发）
    this.slow = null;          // 慢基线：判定参照，会缓慢追随"新的静止姿势"
    this.mode = 'full';
    this.lastJumpAt = 0;
    this.lastDuckAt = 0;       // 最近一次判定为"正在蹲"的时刻
    this.lastLaneAt = 0;
    this.pendingLane = null;   // 候选车道（等待第二帧确认）
    this.state = { lane: 0, jump: false, duck: false, punch: false };
    this.debug = {};
    this._tick = 0;

    // —— 挥拳状态 ——
    this.extL = 0; this.extR = 0;     // 双臂前伸量（快平滑，肩宽归一化）
    this.histP = [];                  // 前伸量短窗采样（速度判定用）
    this.histW = [];                  // 双腕画面坐标短窗采样（侧勾拳通道用）
    this.punchLatchL = false;
    this.punchLatchR = false;
    this.lastPunchAt = 0;
    this.punchSrc = '';               // 最近一次出拳命中的通道（调试用）

    // —— 时序状态 ——
    this.lastT = null;         // 上一帧时间戳，用于把速度换算到真实时间
    this.dyPrev = 0;           // 上一帧的 dy
    this.dyVel = 0;            // dy 的变化速度（平滑后）
    this.upSince = null;       // 最近一次"在原位"的时刻 → 用来判断动作发起的快慢
    this.stillSince = null;    // 最近一次"还在动"的时刻
    this.hist = [];            // 慢通道位置采样（400ms），用于静止判定 / 漂移吸收
    this.histF = [];           // 快通道位置采样（LANE_WIN），用于"快速动作"速度判定
    this.yFastVel = 0;         // 短窗口竖直速度(/s)，正 = 正在下沉
    this.laneVelF = 0;         // 短窗口横向速度(/s)，正 = 往右道
    this._still = true;        // 上一帧的静止判定结果
    this.xRef = null;            // 横向参考点（缓慢跟随版的标定基准）
    this.xRange = 0;            // 最近窗口内的横向位移量
    this.riseRun = 0;          // 起跳信号连续成立的帧数
    this.dropRun = 0;          // 下蹲信号连续成立的帧数
    this.jumpLatch = false;    // 本次上抬是否已经结算过（不许一个姿势反复起跳）
  }

  /** 把快慢基线直接对齐到当前帧。标定完成、或全身/半身模式切换时调用 */
  _snapTo(f, now) {
    this.sm = { hipY: f.hipY, hipX: f.hipX, shY: f.shY, shX: f.shX };
    this.smB = { ...this.sm };
    this.slow = { ...this.sm };
    if (!this.xRef) this.xRef = { ...this.sm };
    this.hist = [];
    this.histF = [];
    this.dyPrev = 0;
    this.dyVel = 0;
    this.yFastVel = 0;
    this.laneVelF = 0;
    this.xRange = 0;
    this.riseRun = 0;
    this.dropRun = 0;
    this.upSince = now;
    this.stillSince = now;
    this.jumpLatch = false;
    this.lastT = null;
    // 挥拳状态一并重置（模式切换那一帧的 z 不可信）
    this.extL = 0; this.extR = 0;
    this.histP = [];
    this.histW = [];
    this.punchLatchL = false; this.punchLatchR = false;
  }

  /* --- 标定：站立取中位数（抗离群值） --- */
  feedCalibration(lms) {
    const f = this._features(lms);
    if (!f) return false;

    const c = this.calib;
    // 丢掉前 8 帧：刚让你站好时身体还在调整，这几帧会污染基准
    if (c.n >= 8) {
      (c.ys ||= { hipY: [], hipX: [], shY: [], shX: [], scale: [] });
      c.ys.hipY.push(f.hipY); c.ys.hipX.push(f.hipX);
      c.ys.shY.push(f.shY); c.ys.shX.push(f.shX);
      c.ys.scale.push(f.scale);
    }
    c.n++;
    // 前 8 帧热身 + 32 帧采样 ≈ 1.3s @30fps
    return c.n >= 40 && (c.ys ? c.ys.hipY.length : 0) >= 24;
  }

  /**
   * 用中位数而不是平均数。
   * 平均数会被采样期间的某一次晃动（比如伸手扶了下桌子）拉偏，
   * 基准偏了之后，你静止站着时系统会认为你一直在"偏离"，于是持续误判。
   * @param {number} minSamples 最少需要多少个有效采样点。
   *   正常流程要 8 个以上才够稳；"跳过标定"时允许低到 1 个。
   */
  finishCalibration(minSamples = 8) {
    const c = this.calib;
    const ys = c.ys;
    if (!ys || ys.hipY.length < minSamples) return false;

    const med = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      const m = a.length >> 1;
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };

    this.baseline = {
      hipY: med(ys.hipY), hipX: med(ys.hipX),
      shY: med(ys.shY), shX: med(ys.shX),
      scale: Math.max(med(ys.scale), 1e-4),
    };
    this.sm = { ...this.baseline };
    this.smB = { ...this.baseline };
    this.slow = { ...this.baseline };
    this.hist = [];
    this.histF = [];
    this.dyPrev = 0;
    this.dyVel = 0;
    this.yFastVel = 0;
    this.laneVelF = 0;
    this.upSince = null;      // 等第一帧真实数据到来再起算，避免污染攻击时间
    this.stillSince = null;
    this.jumpLatch = false;
    this.lastT = null;
    this.extL = 0; this.extR = 0;
    this.histP = [];
    this.histW = [];
    this.punchLatchL = false; this.punchLatchR = false;
    this.lastPunchAt = 0;
    return true;
  }

  /** 抽取归一化特征（与摄像头远近无关） */
  _features(lms) {
    if (!lms || lms.length < 33) return null;
    const sh = mid(lms, LM.L_SH, LM.R_SH);
    const hip = mid(lms, LM.L_HIP, LM.R_HIP);
    if (!sh || !hip) return null;

    const C = this.cfg;

    // ⚠ 可见度门（v3 修正）：
    // 只对"肩部"做硬门槛 —— 它是全身/半身两种模式共同的主参照。
    // 髋部不能一刀切：凑近笔记本摄像头只拍上半身时，MediaPipe 对髋部
    // 输出的是"猜测值"，visibility 常年低于 0.5。上一版把髋也卡进门槛，
    // 结果半身场景每一帧都被拒收，标定永远采不满，直接被超时踢进键盘模式。
    // 髋部可见度现在只用来决定 full/half 模式，不再拒收整帧。
    if (sh.v < C.MIN_VIS) return null;

    // 尺度：优先肩宽，肩不可见时用髋宽
    let scale = Math.abs(lms[LM.L_SH].x - lms[LM.R_SH].x);
    if (!isFinite(scale) || scale < 1e-4) scale = Math.abs(lms[LM.L_HIP].x - lms[LM.R_HIP].x);
    if (!isFinite(scale) || scale < 1e-4) scale = 0.15;

    const lowerVis = Math.min(vis(lms, LM.L_HIP), vis(lms, LM.R_HIP), vis(lms, LM.L_KNEE), vis(lms, LM.R_KNEE));
    const ankleVis = Math.min(vis(lms, LM.L_ANKLE), vis(lms, LM.R_ANKLE));

    // 全身模式需要：髋部足够可见 且 膝盖大体可见（否则全身判定全是猜测）
    const fullOk = hip.v >= C.MIN_VIS && lowerVis > C.MIN_VIS * 0.8;

    // z 轴（越负越靠近摄像头）：挥拳判定的核心通道。
    // 老版本关键点/合成数据可能没有 z，兜底为 0（相当于"没伸出去"，绝不会误触）。
    const z = (p) => (p && typeof p.z === 'number') ? p.z : 0;

    return {
      shY: sh.y, shX: sh.x, shV: sh.v,
      hipY: hip.y, hipX: hip.x, hipV: hip.v,
      scale,
      fullOk,
      lowerOk: fullOk,
      ankleOk: ankleVis > C.MIN_VIS,
      wrists: mid(lms, LM.L_WR, LM.R_WR),
      ankles: mid(lms, LM.L_ANKLE, LM.R_ANKLE),
      // 挥拳用的原始通道：双腕 z + 双肩 z 中点 + 腕部可见度
      wrZL: z(lms[LM.L_WR]), wrZR: z(lms[LM.R_WR]),
      shZ: (z(lms[LM.L_SH]) + z(lms[LM.R_SH])) / 2,
      wrVisL: vis(lms, LM.L_WR), wrVisR: vis(lms, LM.R_WR),
      // 双腕的画面坐标（归一化）：侧勾拳/斜拳通道用（见 CONFIG.PUNCH_SPD2D）
      wrL: lms[LM.L_WR] ? { x: lms[LM.L_WR].x, y: lms[LM.L_WR].y } : null,
      wrR: lms[LM.R_WR] ? { x: lms[LM.R_WR].x, y: lms[LM.R_WR].y } : null,
      lms,
    };
  }

  /**
   * 每次识别到结果就调用，返回手势状态
   * @param {Array} lms 关键点
   * @param {number} now performance.now()
   */
  update(lms, now) {
    this.state.jump = false; // jump 是边沿信号，默认本帧不触发
    this.state.punch = false; // punch 同样是边沿信号
    this._tick++;

    const f = this._features(lms);
    if (!f) {
      // 没识别到可靠的人体：保持车道，但立刻松开所有持续型动作。
      // 否则蹲下信号会卡住，人已经站起来游戏里还在蹲。
      this.state.duck = false;
      this.jumpLatch = false;
      this.debug.lost = true;
      return this.state;
    }
    this.debug.lost = false;
    if (!this.baseline || !this.sm) return this.state;

    if (this.upSince == null) { this.upSince = now; this.stillSince = now; }

    const C = this.cfg;

    // 全身 / 半身切换时主参照点从髋变成肩（或反过来），两者数值不可比。
    // 不重新锚定的话，切换那一帧会凭空产生一次巨大位移，直接误触发一次跳跃。
    const mode = f.lowerOk ? 'full' : 'half';
    if (mode !== this.mode) {
      this.mode = mode;
      this._snapTo(f, now);
      this.debug.rebased = true;
      return this.state;
    }

    const B = this.baseline;
    const S = Math.max(f.scale, B.scale);
    const ky = this.mode === 'full' ? 'hipY' : 'shY';
    const kx = this.mode === 'full' ? 'hipX' : 'shX';

    const dt = this.lastT ? Math.min(0.2, Math.max(0.004, (now - this.lastT) / 1000)) : 1 / 30;
    this.lastT = now;
    this.debug.detectFps = dt > 0 ? Math.round(1 / dt) : 0;

    /* ---- 挥拳：多通道融合（v2）----
       前伸量 ext = (肩z - 腕z) / 肩宽 —— 正值表示拳头在身前。
       三条通道任一成立即出拳（详见 CONFIG.PUNCH_* 的说明）：
         ① ext > PUNCH_EXT 且 前伸速度 > PUNCH_VEL      —— 直拳
         ② 前伸速度 > PUNCH_VEL_FAST 且 ext > EXT_MIN   —— 快速刺拳
         ③ 手腕画面移动速度 > PUNCH_SPD2D 且 手在躯干高度 —— 侧勾拳 / z 不可靠时兜底
       latch：一次前伸只结算一拳；收回（ext < PUNCH_BACK）或过了 REARM 时间后重新武装。
       双手任一触发即可；冷却内不重复结算。 */
    if (f.wrVisL > C.MIN_VIS) this.extL += ((f.shZ - f.wrZL) / S - this.extL) * C.PUNCH_EMA;
    if (f.wrVisR > C.MIN_VIS) this.extR += ((f.shZ - f.wrZR) / S - this.extR) * C.PUNCH_EMA;
    this.histP.push({ t: now, l: this.extL, r: this.extR });
    while (this.histP.length > 2 && now - this.histP[0].t > C.LANE_WIN) this.histP.shift();
    const p0 = this.histP[0];
    let velL = 0, velR = 0;
    if (p0 && now - p0.t > 20) {
      const dw = (now - p0.t) / 1000;
      velL = (this.extL - p0.l) / dw;
      velR = (this.extR - p0.r) / dw;
    }

    // ③ 手腕画面移动速度：短窗内腕相对肩的位移速度（肩宽/秒）。
    // 打侧勾/斜拳时 z 变化很小，但手腕在画面里会明显甩出去 —— 这条通道专门兜它。
    let spdL = 0, spdR = 0;
    if (f.wrL && f.wrR && S > 1e-4) {
      this.histW.push({
        t: now,
        lx: (f.wrL.x - f.shX) / S, ly: (f.wrL.y - f.shY) / S,
        rx: (f.wrR.x - f.shX) / S, ry: (f.wrR.y - f.shY) / S,
      });
      while (this.histW.length > 2 && now - this.histW[0].t > C.LANE_WIN) this.histW.shift();
      const w0 = this.histW[0];
      if (w0 && now - w0.t > 20) {
        const dw = (now - w0.t) / 1000;
        spdL = Math.hypot((f.wrL.x - f.shX) / S - w0.lx, (f.wrL.y - f.shY) / S - w0.ly) / dw;
        spdR = Math.hypot((f.wrR.x - f.shX) / S - w0.rx, (f.wrR.y - f.shY) / S - w0.ry) / dw;
      }
    }
    // ③ 的高度门：拳头一般在胸口～肩的高度。手垂在身侧（走路摆臂）会落在肩下
    //    0.82 个肩宽以外，被挡掉；抬到胸口以上就放行（画面 y 向下增大）。
    //    早先是 0.9 —— 实战里"手抬到腰腹高度随手一摆"就会被判成出拳，太灵敏，收到 0.82。
    const torsoOkL = f.wrL ? f.wrL.y < this.sm.shY + 0.82 * S : false;
    const torsoOkR = f.wrR ? f.wrR.y < this.sm.shY + 0.82 * S : false;

    const fireL = !this.punchLatchL && (
      (this.extL > C.PUNCH_EXT && velL > C.PUNCH_VEL)
      || (velL > C.PUNCH_VEL_FAST && this.extL > C.PUNCH_EXT_MIN)
      || (spdL > C.PUNCH_SPD2D && torsoOkL)
    );
    const fireR = !this.punchLatchR && (
      (this.extR > C.PUNCH_EXT && velR > C.PUNCH_VEL)
      || (velR > C.PUNCH_VEL_FAST && this.extR > C.PUNCH_EXT_MIN)
      || (spdR > C.PUNCH_SPD2D && torsoOkR)
    );
    if ((fireL || fireR) && now - this.lastPunchAt > C.PUNCH_COOLDOWN) {
      this.state.punch = true;
      this.lastPunchAt = now;
      // 记下这次是"哪只手 + 哪条通道"打出来的（调试面板可见，
      // 现场判断该调哪个阈值时，这一条比什么都直观）。
      const ch = (ext, vel, spd, torso) => (
        (ext > C.PUNCH_EXT && vel > C.PUNCH_VEL) ? 'z'
          : (vel > C.PUNCH_VEL_FAST && ext > C.PUNCH_EXT_MIN) ? 'v'
            : (spd > C.PUNCH_SPD2D && torso) ? 'w' : '-'
      );
      if (fireL && fireR) this.punchSrc = `L${ch(this.extL, velL, spdL, torsoOkL)}/R${ch(this.extR, velR, spdR, torsoOkR)}`;
      else if (fireL) this.punchSrc = 'L' + ch(this.extL, velL, spdL, torsoOkL);
      else this.punchSrc = 'R' + ch(this.extR, velR, spdR, torsoOkR);
      if (fireL) this.punchLatchL = true;
      if (fireR) this.punchLatchR = true;
    }
    // 重新武装：手臂收回，或距上次出拳够久（防止"忘记收回"把连打卡死）
    if (this.extL < C.PUNCH_BACK) this.punchLatchL = false;
    if (this.extR < C.PUNCH_BACK) this.punchLatchR = false;
    if (this.punchLatchL || this.punchLatchR) {
      if (now - this.lastPunchAt > C.PUNCH_REARM_MS) { this.punchLatchL = false; this.punchLatchR = false; }
    }

    /* ---- 平滑 ----
       这里刻意用固定系数，不做"动静自适应"。
       试过自适应：用最近一段时间的位移量决定 alpha，结果形成正反馈 ——
       一旦某帧被判成"在动"就切弱滤波，弱滤波下噪声看起来又像在动，
       于是永久卡在弱滤波上，站着不动误跳次数从 0 涨到几十次。
       而这里真不是瓶颈：一次跳跃的位移约为阈值的 3~5 倍，
       即便 0.5 的系数，第一帧的输出就已经越过阈值了。
       要省心又要快，靠下面的"速度预判"提前放行，而不是放开滤波。 */
    const A = C.EMA;
    this.sm.hipY += (f.hipY - this.sm.hipY) * A;
    this.sm.hipX += (f.hipX - this.sm.hipX) * A;
    this.sm.shY += (f.shY - this.sm.shY) * A;
    this.sm.shX += (f.shX - this.sm.shX) * A;

    // 慢通道：同一批数据用更小的 α 再平滑一次，只用于"静止判定 / 基线漂移"。
    // 它的滞后对判定无害（基线本来就该慢慢动），但它的抗噪直接决定了
    // 强干扰下会不会把噪声当成"人在动"而冻结基线。
    const AB = C.EMA_BASE;
    this.smB.hipY += (f.hipY - this.smB.hipY) * AB;
    this.smB.hipX += (f.hipX - this.smB.hipX) * AB;
    this.smB.shY += (f.shY - this.smB.shY) * AB;
    this.smB.shX += (f.shX - this.smB.shX) * AB;

    /* ---- 相对当前基线的竖直偏移 ---- */
    let dy = (this.sm[ky] - this.slow[ky]) / S;
    if (Math.abs(dy) < C.DEAD) dy = 0;
    const vel = (dy - this.dyPrev) / dt;
    this.dyVel += (vel - this.dyVel) * 0.5;
    this.dyPrev = dy;

    /* ---- 静止检测 + 基线重锚 ----
       这一整块是"站起来就一直跳"的根治处：
       旧版要求"绝对偏移也要小"才允许基线追随，于是玩家一旦整体换了个姿势
       （坐姿站起来 / 从凑近屏幕变成站直），基线被永久冻结在旧高度，
       dy 恒为负 → 每 280ms 起跳一次，永远不停。
       现在只看"最近这段时间有没有在动"，并把一个大偏移维持够久的情况
       判定为"玩家换了姿势"，主动把基线搬过去。

       注意这里要用标定时的固定尺度 Sref 做归一化，不能用当帧的 S：
       当帧尺度本身每帧抖 ±10%，除以它会把噪声放大好几倍，
       静止判定将永远不成立，基线也就再也不肯追随了。 */
    // _updateLane 用的"横向位移量"也从这个窗口取，不再单独算瞬时速度
    const Sref = B.scale;
    const yNow = this.sm[ky] / Sref;
    const xNow = this.sm[kx] / Sref;

    // 慢通道采样：静止判定与漂移吸收都用它（抗噪优先）
    this.hist.push({ y: this.smB[ky] / Sref, x: this.smB[kx] / Sref, t: now });
    while (this.hist.length > 2 && now - this.hist[0].t > C.STILL_WIN) this.hist.shift();
    if (this.hist.length > 64) this.hist.shift();

    // 快通道采样：只保留最近 LANE_WIN 毫秒，用来算"快速动作"速度。
    // 这是提速的关键 —— 不再依赖"双重 EMA 出来的加速度"（那个天然滞后两拍），
    // 而是直接看"最近 160ms 里到底挪了多少"，真动作一帧就攒够方向与幅度。
    this.histF.push({ y: yNow, x: xNow, t: now });
    while (this.histF.length > 2 && now - this.histF[0].t > C.LANE_WIN) this.histF.shift();

    const hf = this.histF[0];
    if (hf && now - hf.t > 20) {
      const dw = (now - hf.t) / 1000;
      this.yFastVel = (yNow - hf.y) / dw;      // 正 = 下沉
      this.laneVelF = -(xNow - hf.x) / dw;     // 正 = 往右道
    } else {
      this.yFastVel = 0;
      this.laneVelF = 0;
    }

    // 慢通道速度：从 hist 里取"约 LANE_WIN 毫秒前"那一点做差分。
    let yVelB = 0;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      if (now - this.hist[i].t >= C.LANE_WIN) {
        const dw = (now - this.hist[i].t) / 1000;
        if (dw > 0.02) yVelB = (this.smB[ky] / Sref - this.hist[i].y) / dw;
        break;
      }
    }

    let still = false;
    let range = 0;
    let xRange = 0;
    if (this.hist.length >= 2 && now - this.hist[0].t >= C.STILL_WIN * 0.8) {
      let mn = Infinity, mx = -Infinity, xmn = Infinity, xmx = -Infinity;
      for (const h of this.hist) {
        if (h.y < mn) mn = h.y; if (h.y > mx) mx = h.y;
        if (h.x < xmn) xmn = h.x; if (h.x > xmx) xmx = h.x;
      }
      range = mx - mn;
      xRange = xmx - xmn;
    }
    // 静止判定取"或"的两条判据：
    //   ① 位移峰谷差小  —— 抓逐帧微抖
    //   ② 慢通道速度小  —— 抓"大振幅但很慢"的漂移
    // 只用①会踩坑：强漂移下峰谷差被顶到 STILL_RANGE 之上 → 判成"在动" →
    // 基线永久冻结 → 漂移直接暴露成 dy → 幽灵动作。②用速度把这类慢漂移捞回来。
    const ranged = this.hist.length >= 2 && now - this.hist[0].t >= C.STILL_WIN * 0.8;
    still = (ranged && range < C.STILL_RANGE) || Math.abs(yVelB) < C.STILL_VEL;
    this.xRange = xRange;
    this._still = still;

    let rebased = false;
    if (!still) {
      this.stillSince = now;   // 还在动 → 基线冻结，动作才被完整保留下来
    } else {
      const held = now - this.stillSince;
      // 静止时把"小幅偏移"当漂移吸收掉（呼吸/重心/强干扰）。
      // 关键是 DRIFT_BAND 这条线：只吸收 |dy| < 0.20 的小偏移。
      //   · 设太小（如旧版 0.10）→ 强干扰下基线被永久冻在 DROP 阈值附近，持续误蹲；
      //   · 不设上限（"只要静止就追随"）→ 会把玩家"刻意保持的动作"一并吸收，
      //     站起来做动作时 dy 永远很小 → 什么都触发不了（就是刚才遇到的"没反馈"）。
      // 0.20 卡在"漂移带(≤0.17)"与"真实动作(≥0.4)"之间：两头都照顾到。
      let rate = 0;
      if (Math.abs(dy) < C.DRIFT_BAND) rate = C.DRIFT_FOLLOW;          // 小偏移：当作漂移吸收
      else if (dy < 0 && held > C.REBASE_DELAY_UP) rate = C.REBASE_RATE;    // 站起来了
      else if (dy > 0 && held > C.REBASE_DELAY_DOWN) rate = C.REBASE_RATE;  // 坐下去了
      if (rate > 0) {
        for (const k of ['hipY', 'hipX', 'shY', 'shX']) this.slow[k] += (this.sm[k] - this.slow[k]) * rate;
        dy = (this.sm[ky] - this.slow[ky]) / S;
        if (Math.abs(dy) < C.DEAD) dy = 0;
        rebased = true;
      }
    }

    /* ---- 滞回：只有回到原位附近，才允许下一次起跳 ----
       少了这步，"换了个姿势"这种持续状态每过一个冷却就跳一次。 */
    if (dy > -C.RE_ARM) this.upSince = now;

    /* ---- 变道 ----
       这里主要看"横向速度"，而不是只看"横向位置"。
       位置会因为你重心慢慢晃就漂出去 —— 那种情况玩家根本没想变道，
       旧行为在这里会产生"我没动，人却跑到隔壁道"的怪事。
       而迈一步明显更快：约 0.5 个肩宽 / 0.4 秒 ≈ 1.2/秒；
       慢慢晃动通常不到 0.2/秒，两者差一个数量级，很容易分开。 */
    // 横向参考点。不要用标定那一刻的绝对值：
    // 人在标定那几秒里本身就在晃，取中位数很可能取到一个偏的位置，
    // 之后"原始摇晃"会把累计偏差推过阈值，人没动也会变道。
    // 这里让它只在"人处于中间区域"时缓慢跟随，既吸收摇晃，
    // 又不会在玩家特意站到边道时把他拽回中间。
    if (!this.xRef) this.xRef = { ...this.baseline };
    const xr = this.xRef;
    const laneRaw = (xr[kx] - this.sm[kx]) / S; // 画面右侧 = x 减小
    if (Math.abs(laneRaw) < C.LANE_BACK) {
      xr[kx] += (this.sm[kx] - xr[kx]) * C.X_FOLLOW;
    }

    // 位移窗口：只看"最近这段时间横向挪了多少"。
    // 单帧速度没法用 —— 纯噪声就能造出 1.0/秒 的假速度。
    const moveX = this.xRange;
    const laneVelRaw = moveX / C.STILL_WIN * 1000;
    this._updateLane(laneRaw, moveX, now);

    /* ---- 起跳 ----
       速度改用"短窗口位移"（最近 LANE_WIN 毫秒挪了多少），
       而不是 dv/dt 的 EMA —— 后者是对已经平滑过的信号再平滑，天然滞后两拍。
       短窗口速度在真起跳的第一帧就能给出明确方向，噪声则凑不出持续同向的位移。 */
    const up = -dy;
    const velUp = -this.yFastVel;    // 快通道上抬速度
    const velUpB = -yVelB;           // 慢通道上抬速度（佐证用）
    // 两级快通道：
    //   · 冲得极猛（> RISE_VEL_FAST）→ 单通道立刻认账，不等佐证
    //     （慢通道对极快动作天然滞后，硬等它会把最快那一档拖慢半拍）
    //   · 中速（> RISE_VEL 且慢通道同向 > RISE_VEL_B）→ 两条通道同时成立才认账，
    //     于是门槛可以压得很低，速度快的红利拿满、噪声尖峰又混不进来
    const fastUp = velUp > C.RISE_VEL_FAST || (velUp > C.RISE_VEL && velUpB > C.RISE_VEL_B);
    // 预判式提前触发：位置还没到位、但正以足够速度往上冲时，提前 PRED 秒放行
    const riseNow = up > C.RISE;
    const risePred = up > C.RISE * 0.55 && fastUp && up + velUp * C.PRED > C.RISE;
    const rise = riseNow || risePred;

    let handsUp = false;
    if (f.wrists && f.wrists.v > C.MIN_VIS) {
      // 用平滑后的肩高做参照（旧版用未平滑的原始值，逐帧抖 → 误判）
      handsUp = f.wrists.y < this.sm.shY - 0.08 * S;
    }

    let feetUp = false;
    if (this.mode === 'full' && f.ankleOk && f.ankles && f.ankles.v > C.MIN_VIS) {
      // 脚踝真的抬到髋部以上才算离地。
      // 旧版阈值是"低于髋 + 0.15 个肩宽"，几乎站姿就满足，
      // 一旦下半身出画面 MediaPipe 瞎猜踝点，就会凭空起跳。
      feetUp = f.ankles.y < B.hipY - 0.05 * S;
    }

    const wantJump = rise || handsUp || feetUp;
    if (wantJump) this.riseRun++;
    else this.riseRun = 0;

    if (!wantJump) {
      this.jumpLatch = false;               // 回到原位，下一次上抬可以生效
    } else if (!this.jumpLatch && now - this.lastJumpAt > C.JUMP_COOLDOWN) {
      // 同一次上抬过程只结算一次（latch），并且：
      // 必须在"离开原位之后很快就冲过阈值"才算跳。
      // 慢慢直起腰、换个站姿这类姿势改变虽然也让 dy 变负，
      // 但它离开原位已经很久了，不该被当成跳。
      const attack = now - this.upSince;
      // 不对称确认：冲得够猛→一帧就放行（真的起跳不会被拖慢）；
      // 磨磨蹭蹭晃过阈值→要连续 CONFIRM 帧，把噪声的尖峰挡在外面。
      // 注意只有真的放行才 latch：没放行的话，下一帧还可能攒够确认次数，不能就此作废。
      const solid = handsUp || feetUp || this.riseRun >= C.CONFIRM || up > C.RISE_STRONG || fastUp;
      if (solid && (handsUp || feetUp || attack <= C.MAX_ATTACK)) {
        this.state.jump = true;
        this.lastJumpAt = now;
        this.jumpLatch = true;
      }
    }

    /* ---- 下蹲（持续型信号）----
       蹲是一个"保持"的动作，本来就该比跳跃稳一点。
       关键：噪声不会弯膝盖，所以全身模式下用"屈膝角"作主判定最稳，
       位置通道只在"长时间持续下沉"时才放行 —— 连续帧数定得远高于噪声突发，
       避免缓慢漂移 / 抖动偶发越过阈值就误蹲（强干扰下据此消除误蹲）。 */
    const drop = dy > C.DROP;
    this.dropRun = drop ? this.dropRun + 1 : 0;
    const kneeBent = this.mode === 'full' && this._kneeBent(f.lms);
    // 下沉速度同样走短窗口：真蹲的髋部在 160ms 内就掉下去一大截，
    // 噪声/漂移在这个窗口里攒不出这么多位移，所以可以安全地"一帧放行"。
    const sinkFast = this.yFastVel > C.SINK_VEL_FAST
      || (this.yFastVel > C.SINK_VEL && yVelB > C.SINK_VEL_B);
    // 全身：屈膝角（噪声免疫，最快）+ 快速下沉（一帧）+ 位置通道兜底（连续多帧）
    // 半身：无膝盖可用，靠快速下沉 + 持续下沉双保险
    const duckNow = kneeBent || sinkFast || this.dropRun >= C.DROP_RUN;

    if (duckNow) {
      this.state.duck = true;
      this.lastDuckAt = now;
    } else if (this.state.duck && now - this.lastDuckAt > C.DUCK_RELEASE) {
      // 延迟释放：单帧掉帧不至于让蹲姿闪烁，但也不会卡住不放
      this.state.duck = false;
    }

    this.debug = {
      lost: false, mode: this.mode,
      dy: +dy.toFixed(3), up: +up.toFixed(3), velUp: +velUp.toFixed(2),
      attack: Math.round(now - this.upSince), still, rebased,
      alpha: +A.toFixed(2), range: +range.toFixed(3),
      dxRaw: +laneRaw.toFixed(3), moveX: +moveX.toFixed(3),
      rise, handsUp, feetUp, drop, kneeBent, sinkFast,
      punch: this.state.punch, extL: +this.extL.toFixed(2), extR: +this.extR.toFixed(2),
      punchSrc: this.punchSrc,
      velL: +velL.toFixed(2), velR: +velR.toFixed(2),
      spdL: +spdL.toFixed(2), spdR: +spdR.toFixed(2),
      punchSpd: +Math.max(spdL, spdR).toFixed(1),
      laneVelF: +this.laneVelF.toFixed(2), yFastVel: +this.yFastVel.toFixed(2),
      scale: +S.toFixed(3), vis: +Math.min(f.shV, f.hipV).toFixed(2),
    };
    return this.state;
  }

  /**
   * 变道判定：以横向速度为主，位置为辅。
   *   速度够快（迈步）→ 立刻响应，不慢半拍
   *   位置已经甩得很远 → 也放行（中途识别丢了几帧时会这样）
   *   其余情况一律不动 —— 慢慢漂过去不算迈步
   * 刚变过道 → 驻留期内不允许反向，避免系统在两条道之间来回抖
   */
  _updateLane(laneRaw, moveX, now) {
    const C = this.cfg;
    const cur = this.state.lane;
    const v = this.laneVelF;   // 短窗口横向速度(/s)：正 = 往右道

    // 方向判定有两条通道：
    //   ① 位置：已经挪过 LANE_TH —— 稳，但要等位移慢慢积累，慢
    //   ② 速度：横向速度超过 LANE_FAST 且该方向位移已过 LANE_MIN —— 快，几乎当场响应
    // ② 必须同时满足"快"和"已经出去一点"两个条件：
    //   噪声尖峰 → 速度快但没有净位移；慢漂移 → 位移够但速度慢。两者都进不来。
    let want = cur;
    if (laneRaw > C.LANE_TH || (v > C.LANE_FAST && laneRaw > C.LANE_MIN)) want = 1;
    else if (laneRaw < -C.LANE_TH || (v < -C.LANE_FAST && laneRaw < -C.LANE_MIN)) want = -1;
    else if (Math.abs(laneRaw) < C.LANE_BACK) want = 0;

    if (want === cur) { this.pendingLane = cur; return; }

    if (now - this.lastLaneAt <= C.LANE_DWELL) {
      this.pendingLane = want;
      return; // 驻留期内先记下，等过了驻留时间再说
    }

    // 必须真的迈了一步：最近 STILL_WIN 毫秒里横向挪动超过 LANE_STEP，
    // 或者这一下横向速度够快（方向与位移在上面已经校验过）。
    const fastStep = Math.abs(v) > C.LANE_FAST;
    if (moveX > C.LANE_STEP || Math.abs(laneRaw) > C.LANE_STRONG || fastStep) {
      this.state.lane = want;
      this.lastLaneAt = now;
    }
  }

  /** 髋-膝-踝夹角，判断是否屈膝 */
  _kneeBent(lms) {
    const ang = (a, b, c) => {
      if (!lms[a] || !lms[b] || !lms[c]) return Math.PI;
      const v1 = { x: lms[a].x - lms[b].x, y: lms[a].y - lms[b].y };
      const v2 = { x: lms[c].x - lms[b].x, y: lms[c].y - lms[b].y };
      const d = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-6);
      return Math.acos(Math.max(-1, Math.min(1, d)));
    };
    return Math.min(ang(LM.L_HIP, LM.L_KNEE, LM.L_ANKLE), ang(LM.R_HIP, LM.R_KNEE, LM.R_ANKLE)) < 2.4;
  }
}
