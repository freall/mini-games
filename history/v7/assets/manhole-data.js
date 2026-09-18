/* ============================================================
   开车不要压井盖儿 · 数据与调参表
   SECTION: manhole-data
   ------------------------------------------------------------
   这里只放「常量 / 关卡曲线 / 文案 / 音效」，不含任何玩法逻辑与 DOM：
   想改手感就改这张表，逻辑在 manhole-core.js，渲染在 manhole.js。

   一句话玩法：你开车在四车道的马路上往前跑，路面上到处是井盖，
   压上去就算输 —— 要一路躲着井盖把车开到最后。
   ============================================================ */
window.MANHOLE_DATA = (function () {
  'use strict';

  /* SECTION: layout
     设计空间（虚拟坐标系）。所有玩法坐标都用这套，与窗口实际像素无关：
     canvas 的 backing store 固定按 W×H×dpr，CSS 负责等比缩放。 */
  var LAYOUT = { W: 900, H: 640 };

  /* SECTION: geometry
     马路与车道。四车道均分，车的宽度按车道宽的百分比算。 */
  var ROAD = {
    marginX: 96,                    // 路肩宽度（草地/护栏），两侧对称
    lanes: 4,                       // 车道数（每关由 levelConfig 决定实际用几条）
    dashLen: 34,                    // 车道虚线长度
    dashGap: 30                     // 车道虚线间隔
  };

  var PLAYER = {
    w: 0.62,                        // 车身宽 = 车道宽 × 0.62
    h: 78,                          // 车长（设计像素）
    y: 512,                         // 车的中心纵向位置（固定，路面向下滚）
    steerSpeed: 6.4,                // 横向移动速度（车道/秒）——键盘长按时的巡航速度
    /* SECTION: wheel
       判定不看车身中心，而看两个车轮的落点：车轮压到井盖才算压中。
       这是本作最核心的规则 —— 斜着擦过去但车轮在井盖外侧，不该算输。

       **轮距不在这里配**：它由 manhole-core.js 的 wheelTrackOffset() 推导
       （= 井盖半径 + 轮半径，且不超过半个车身），
       目的是保证"井盖压在车身正中时必定有车轮碰到"这个不变式成立。
       以前这里放的是 wheelOffset: 0.30（车身宽 × 0.30 = 32.9px），
       轮距只有 65.8px，比井盖的直径还窄 —— 于是井盖能从两个车轮之间"钻过去"，
       车碾过井盖却不死（单测 + 探针都复现过）。参数化的写法容易再次踩坑，
       所以改成推导，配置项只留判定圆半径。 */
    wheelRadius: 11                 // 车轮判定半径（设计像素）
  };

  /* SECTION: vehicles 车库
     不同车不止长得不一样 —— 速度、横向灵活性、车身宽窄、分数倍率全都不同：

       speed       整体速度倍率。乘进世界滚动速度与横向速度：**空间路况对每辆车完全相同**
                   （同一条路），快车只是开得快 → 井盖到达时间被压缩 → 更难。
                   反应时间/并线时间的公平性体系都是"时间缩放不变"的：
                   快车横移也快，"行距 ≥ 两次并线"的不变式在每辆车上都保持成立
                   （AI 守门断言对每辆车分别验证，见 test-manhole-core.mjs）。
       steer       横向灵活度倍率（乘 PLAYER.steerSpeed）。自行车/摩托转向快、越野车笨重。
       w / h       车身占车道宽的比例 / 车长（设计像素）。窄车判定带窄 → 容错高。
       wheelRadius 车轮判定半径。判定与绘制都用它（画出来的轮子就是判定用的轮子）。
       mult        分数倍率：路程分、惊险奖励、道具分、通关奖励全部 ×mult ——
                   开得快/车身宽是真实的风险，赚得也必须是真实的。
       price       解锁需要的累计金币（捡到的金币跨局累计，存 manhole-coins）。
                   price=0 的是初始车（自行车 / 小轿车）。

     每辆车都验证过的判定不变式（勿破坏，单测守着）：
       · 车宽 < 车道宽（能并线）；
       · 井盖直径(60) < 车宽（"车身覆盖即压到"语义成立）；
       · 轮距 + 2×(轮半径+井盖半径) 覆盖整个车底带 —— 井盖从两轮间钻不过去。 */
  var VEHICLES = [
    {
      id: 'bike', name: '自行车', art: '🚲', price: 0, stars: 1,
      speed: 0.82, steer: 1.22, w: 0.36, h: 52, wheelRadius: 7, mult: 0.8,
      body: ['#0f3a5e', '#2f8fc9', '#7cd0f2', '#0c2f4e'], accent: '#9adfff',
      desc: '慢慢骑，看得清 —— 容错最高，赚得最少'
    },
    {
      id: 'ebike', name: '电动自行车', art: '🛵', price: 400, stars: 2,
      speed: 0.92, steer: 1.12, w: 0.40, h: 58, wheelRadius: 8, mult: 0.9,
      body: ['#0c4a32', '#22a86b', '#71e6ac', '#093a27'], accent: '#7ef0bd',
      desc: '外卖骑手的默契：不快，但稳'
    },
    {
      id: 'sedan', name: '小轿车', art: '🚗', price: 0, stars: 3,
      speed: 1.00, steer: 1.00, w: 0.62, h: 78, wheelRadius: 11, mult: 1.0,
      body: ['#7b1230', '#e0344f', '#ff6a7d', '#a01632'], accent: '#ff8a9a',
      desc: '基准车：速度、宽度、收益都是标杆'
    },
    {
      id: 'suv', name: '越野车', art: '🚙', price: 1200, stars: 3,
      speed: 1.06, steer: 0.88, w: 0.74, h: 84, wheelRadius: 12, mult: 1.15,
      body: ['#4a3a10', '#b8922e', '#f0d070', '#3a2d0c'], accent: '#ffd97a',
      desc: '又宽又笨，缝里难钻 —— 但分给得多'
    },
    {
      id: 'moto', name: '摩托车', art: '🏍️', price: 2500, stars: 4,
      speed: 1.18, steer: 1.30, w: 0.42, h: 60, wheelRadius: 8, mult: 1.3,
      body: ['#33104d', '#7a35c2', '#b57ef0', '#270a3d'], accent: '#c9a0ff',
      desc: '快，而且车把极灵 —— 钻缝专家'
    },
    {
      id: 'race', name: '赛车', art: '🏎️', price: 5000, stars: 5,
      speed: 1.32, steer: 1.08, w: 0.56, h: 74, wheelRadius: 10, mult: 1.6,
      body: ['#5e4400', '#e8a813', '#ffd34d', '#4a3500'], accent: '#ffe082',
      desc: '最快的一辆，井盖迎面砸过来 —— 倍率也是最高的'
    }
  ];

  /* 按车辆 id 取表项；找不到（旧存档写了不存在的 id 之类）就回落到小轿车 */
  function vehicleById(id) {
    for (var i = 0; i < VEHICLES.length; i++) {
      if (VEHICLES[i].id === id) { return VEHICLES[i]; }
    }
    return VEHICLES[2];   // sedan
  }

  /* SECTION: world
     路面向玩家滚动的速度（设计像素/秒）。开局慢、逐关快，
     速度压力是这款游戏的主要难度来源。 */
  var WORLD = {
    baseSpeed: 300,                 // 第 1 关的滚动速度
    speedPerLevel: 34,              // 每关递增
    maxSpeed: 640,                  // 封顶（再快就纯靠运气了）
    spawnScroll: 220,               // 场景元素自身的向下速度（相对路面，制造纵深）
    keyScroll: 620                  // 视差层（远山/路灯）的滚动速度比例
  };

  /* SECTION: 关卡曲线
     每关一段路（以"路程"计而不是以时间计）：开满 distance 米就通关。
     井盖密度、井盖排布复杂度、允许的压盖次数都随关卡收紧。 */
  var LEVELS = [
    /* 1 */ { distance: 620,  obstaclesPer100m: 3.6, minGapRows: 3, maxGapRows: 5, cluster: 0, maxHit: 1, speed: 300, name: '小区门口', tag: '热身：井盖不多，找找手感' },
    /* 2 */ { distance: 760,  obstaclesPer100m: 4.4, minGapRows: 3, maxGapRows: 4, cluster: 0, maxHit: 1, speed: 334, name: '早高峰', tag: '车多了，井盖也密起来' },
    /* 3 */ { distance: 900,  obstaclesPer100m: 5.2, minGapRows: 2, maxGapRows: 4, cluster: 0, maxHit: 1, speed: 368, name: '老城区', tag: '老路的井盖是连成串的' },
    /* 4 */ { distance: 1000, obstaclesPer100m: 6.0, minGapRows: 2, maxGapRows: 3, cluster: 1, maxHit: 1, speed: 402, name: '施工路段', tag: '开始出现并排井盖，只能钻缝' },
    /* 5 */ { distance: 1100, obstaclesPer100m: 6.8, minGapRows: 2, maxGapRows: 3, cluster: 1, maxHit: 1, speed: 436, name: '雨夜', tag: '路滑，眼睛也得跟上' },
    /* 6 */ { distance: 1200, obstaclesPer100m: 7.6, minGapRows: 1, maxGapRows: 3, cluster: 2, maxHit: 1, speed: 470, name: '快速路', tag: '三连井盖，缝隙越来越小' },
    /* 7 */ { distance: 1300, obstaclesPer100m: 8.4, minGapRows: 1, maxGapRows: 2, cluster: 2, maxHit: 1, speed: 504, name: '环线匝道', tag: '速度上来了，别手抖' },
    /* 8 */ { distance: 1400, obstaclesPer100m: 9.2, minGapRows: 1, maxGapRows: 2, cluster: 3, maxHit: 1, speed: 538, name: '立交桥下', tag: '密集阵，靠预判' },
    /* 9 */ { distance: 1500, obstaclesPer100m: 10.0, minGapRows: 1, maxGapRows: 2, cluster: 3, maxHit: 1, speed: 572, name: '午夜高速', tag: '只剩一条缝的时候最刺激' },
    /* 10 */{ distance: 1600, obstaclesPer100m: 11.0, minGapRows: 1, maxGapRows: 1, cluster: 3, maxHit: 1, speed: 606, name: '鬼门关', tag: '最后一关：满路井盖' }
  ];

  /* 第 10 关之后：无尽模式，每关继续加密度与速度（有封顶） */
  var ENDLESS = {
    distanceAdd: 120,               // 每关加长
    densityAdd: 0.9,                // 每关加密
    speedAdd: 30,
    maxDensity: 14,
    maxCluster: 3,
    maxGapRows: 1
  };

  /* SECTION: rules
     压到井盖算输 —— 但给一次"侥幸"的余地，避免开局一发入魂太挫败。
     幸运星（⭐）能让这一局多扛一次压盖，攒够还能换一次"井盖清场"。 */
  var RULES = {
    lives: 1,                       // 车辆耐久：压到井盖即报废（核心规则，不改）
    hitFlashMs: 900,                // 压盖后的失控表现时长
    luckyMax: 2,                    // 幸运星最多攒这么多次豁免
    nitroMs: 2600,                  // 加速带持续时间
    nitroMult: 1.55,                // 加速倍率
    shieldMs: 5000,                 // 护盾持续时间
    magnetMs: 6000,                 // 吸铁石持续时间
    slowMs: 2200,                   // 减速带（负面）持续时间
    slowMult: 0.55,
    startGraceMs: 1200              // 开局保护：这段时间不刷井盖，别一上来就死
  };

  /* SECTION: 计分 */
  var SCORE = {
    perMeter: 1,                    // 每前进 1 米得 1 分（基础分）
    nearMiss: 30,                   // 贴近井盖擦过去（车轮离井盖边缘很近但没压到）
    nearMissRadius: 26,             // 「擦过去」的判定距离（设计像素，轮心到井盖边缘）
    coin: 50,                       // 井盖旁边的金币
    star: 120,                      // 幸运星
    nitro: 80,                      // 加速带
    levelBonus: 400,                // 通关奖励
    comboStep: 3,                   // 每连续躲过几个井盖，倍率 +1
    comboMax: 8                     // 倍率上限
  };

  /* ==== 道具 ==== */
  var PICKUPS = [
    { id: 'coin',  art: '🪙', label: '金币',   desc: '井盖旁边常常有，顺手捡' },
    { id: 'star',  art: '⭐', label: '幸运星', desc: '攒满可豁免一次压盖' },
    { id: 'nitro', art: '🚀', label: '加速带', desc: '短时间冲刺，分数涨得更快' },
    { id: 'shield', art: '🛡️', label: '护盾',  desc: '一段时间内压到井盖也不报废' }
  ];

  /* ==== 路面元素（除井盖外的干扰物） ==== */
  var HAZARDS = [
    { id: 'cone',  art: '🚧', r: 17, label: '路锥' },
    { id: 'puddle', art: '💧', r: 20, label: '水洼' }
  ];

  /* SECTION: 关卡命名与提示文案 */
  var TIPS = [
    '车轮压到井盖才算输 —— 车身擦过去没事，别自己吓自己。',
    '井盖旁边有金币，想拿分就得往边上蹭，风险自己权衡。',
    '连续躲过井盖会攒连击，倍率越高，跑到终点分越高。',
    '幸运星攒满 2 颗，压到井盖时会自动救你一命。',
    '护盾在手的那几秒，可以横着穿井盖阵，别客气。',
    '加速带让路程涨得飞快，但反应时间也变短了 —— 值不值看你。',
    '眼睛往前看一点：井盖是成排刷的，提前选好要走的车道。',
    '四车道不是每条都能走，学会提前并线比手快更重要。'
  ];

  var HIT_LINES = [
    '咣当 —— 后轮压上去了',
    '哐！井盖被压得跳起来',
    '你压到了井盖，副驾在尖叫',
    '轮子磕上了井盖，车开始歪'
  ];

  /* SECTION: Audio · Web Audio 合成音效（无外部资源）
     全部现场合成：引擎声用锯齿波 + 滤波，提示音用正弦短包络。 */
  var Audio = (function () {
    var ctx = null, enabled = true, engineOsc = null, engineGain = null, engineFilter = null;
    var noiseBuf = null;

    function ac() {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { return null; }
        try { ctx = new AC(); } catch (e) { return null; }
      }
      return ctx;
    }

    function resume() {
      var c = ac();
      if (c && c.state === 'suspended') { try { c.resume(); } catch (e) { /* 忽略 */ } }
    }

    /* 白噪声缓冲（引擎底噪、压盖的金属声都用它） */
    function noise(c) {
      if (noiseBuf) { return noiseBuf; }
      var len = Math.floor(c.sampleRate * 0.5);
      noiseBuf = c.createBuffer(1, len, c.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) { d[i] = Math.random() * 2 - 1; }
      return noiseBuf;
    }

    function blip(freq, dur, type, vol) {
      if (!enabled) { return; }
      var c = ac(); if (!c) { return; }
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, c.currentTime);
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(vol || 0.16, c.currentTime + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + (dur || 0.12));
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + (dur || 0.12) + 0.02);
    }

    /* 弯音：拾取道具/连击上升感的短促滑音 */
    function sweep(f1, f2, dur, vol) {
      if (!enabled) { return; }
      var c = ac(); if (!c) { return; }
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f1, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, f2), c.currentTime + dur);
      g.gain.setValueAtTime(vol || 0.14, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + dur + 0.02);
    }

    return {
      get enabled() { return enabled; },
      set enabled(v) { enabled = !!v; if (!v) { this.engineStop(); } },
      resume: resume,
      /* 压到井盖：低频闷响 + 金属噪声，听感就是"咣当" */
      crash: function () {
        if (!enabled) { return; }
        var c = ac(); if (!c) { return; }
        var o = c.createOscillator(), g = c.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(180, c.currentTime);
        o.frequency.exponentialRampToValueAtTime(42, c.currentTime + 0.42);
        g.gain.setValueAtTime(0.3, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.48);
        o.connect(g); g.connect(c.destination);
        o.start(); o.stop(c.currentTime + 0.5);

        var src = c.createBufferSource(); src.buffer = noise(c);
        var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.2;
        var ng = c.createGain();
        ng.gain.setValueAtTime(0.24, c.currentTime);
        ng.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.3);
        src.connect(bp); bp.connect(ng); ng.connect(c.destination);
        src.start(); src.stop(c.currentTime + 0.32);
      },
      coin: function () { sweep(880, 1320, 0.11, 0.13); },
      star: function () { sweep(660, 1560, 0.22, 0.15); setTimeout(function () { blip(1760, 0.14, 'sine', 0.13); }, 110); },
      nitro: function () { sweep(320, 1180, 0.3, 0.16); },
      shield: function () { blip(520, 0.16, 'sine', 0.14); setTimeout(function () { blip(780, 0.18, 'sine', 0.13); }, 120); },
      nearMiss: function () { blip(1240, 0.06, 'sine', 0.07); },
      levelup: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { blip(f, 0.16, 'triangle', 0.13); }, i * 95); }); },
      over: function () { [420, 340, 262, 180].forEach(function (f, i) { setTimeout(function () { blip(f, 0.26, 'sawtooth', 0.12); }, i * 130); }); },
      countdown: function () { blip(440, 0.1, 'square', 0.11); },
      /* 引擎声：一个常驻振荡器 + 低通，频率随车速变化。
         车停/切走时必须停掉，否则回到门户还在嗡嗡响。 */
      engineStart: function () {
        if (!enabled) { return; }
        var c = ac(); if (!c || engineOsc) { return; }
        engineOsc = c.createOscillator();
        engineGain = c.createGain();
        engineFilter = c.createBiquadFilter();
        engineOsc.type = 'sawtooth';
        engineOsc.frequency.value = 62;
        engineFilter.type = 'lowpass';
        engineFilter.frequency.value = 320;
        engineGain.gain.value = 0.028;
        engineOsc.connect(engineFilter); engineFilter.connect(engineGain); engineGain.connect(c.destination);
        engineOsc.start();
      },
      engineSet: function (speed01) {
        if (!enabled || !engineOsc || !ctx) { return; }
        try {
          engineOsc.frequency.setTargetAtTime(52 + speed01 * 96, ctx.currentTime, 0.08);
          engineFilter.frequency.setTargetAtTime(240 + speed01 * 620, ctx.currentTime, 0.08);
        } catch (e) { /* 忽略 */ }
      },
      engineStop: function () {
        if (engineGain && ctx) {
          try { engineGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.06); } catch (e) { /* 忽略 */ }
        }
        var o = engineOsc, g = engineGain;
        engineOsc = null; engineGain = null; engineFilter = null;
        if (o) { setTimeout(function () { try { o.stop(); } catch (e) { /* 忽略 */ } }, 220); }
        if (g) { setTimeout(function () { try { g.disconnect(); } catch (e) { /* 忽略 */ } }, 260); }
      }
    };
  })();

  /* SECTION: helpers */
  /* 按关卡号取配置：1~10 用表，之后按无尽模式递推（密度与速度都有封顶） */
  function levelConfig(level) {
    var lv = Math.max(1, level | 0);
    if (lv <= LEVELS.length) {
      var e = LEVELS[lv - 1];
      return {
        level: lv, name: e.name, tag: e.tag, distance: e.distance,
        obstaclesPer100m: e.obstaclesPer100m, minGapRows: e.minGapRows, maxGapRows: e.maxGapRows,
        cluster: e.cluster, speed: e.speed, endless: false
      };
    }
    var over = lv - LEVELS.length;
    var last = LEVELS[LEVELS.length - 1];
    return {
      level: lv,
      name: '无尽 ' + over,
      tag: '井盖无极限，看你能开多远',
      distance: last.distance + ENDLESS.distanceAdd * over,
      obstaclesPer100m: Math.min(ENDLESS.maxDensity, last.obstaclesPer100m + ENDLESS.densityAdd * over),
      minGapRows: 1,
      maxGapRows: ENDLESS.maxGapRows,
      cluster: Math.min(ENDLESS.maxCluster, last.cluster + (over > 2 ? 1 : 0)),
      speed: Math.min(WORLD.maxSpeed, last.speed + ENDLESS.speedAdd * over),
      endless: true
    };
  }

  return {
    LAYOUT: LAYOUT, ROAD: ROAD, PLAYER: PLAYER, WORLD: WORLD,
    RULES: RULES, SCORE: SCORE, PICKUPS: PICKUPS, HAZARDS: HAZARDS,
    LEVELS: LEVELS, ENDLESS: ENDLESS,
    TIPS: TIPS, HIT_LINES: HIT_LINES,
    VEHICLES: VEHICLES, vehicleById: vehicleById,
    levelConfig: levelConfig,
    Audio: Audio
  };
})();
