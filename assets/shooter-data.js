/* ============================================================
   靶场神枪手 · 数据与调参表
   SECTION: shooter-data
   ------------------------------------------------------------
   这里只放「常量 / 枪表 / 靶型表 / 关卡曲线 / 文案 / 音效」，不含任何玩法逻辑与 DOM：
   想改手感就改这张表，玩法逻辑在 shooter-core.js，渲染在 shooter.js。

   一句话玩法：你是靶场射手，靶子从挡板后升起、横穿、飞越 ——
   用鼠标瞄准开枪，命中位置决定环数（打正中十倍分），
   打空断连击，**打中炸雷靶要倒扣分数和时间**，在时限内冲过配额分就算过关。
   ============================================================ */
window.SHOOTER_DATA = (function () {
  'use strict';

  /* SECTION: layout
     设计空间（虚拟坐标系）。玩法坐标全用这套，与窗口像素无关：
     canvas backing store 固定按 W×H×dpr，CSS 负责等比缩放。 */
  var LAYOUT = { W: 900, H: 600 };

  /* SECTION: range 靶场几何
     纵深分三段：远处的靶画得小、也给的分高（小靶更难打中）。
     y 轴向下为正，所以 far 在上、near 在下；挡板(bench)以下是枪台。 */
  var RANGE = {
    wallTop: 26,          // 背景墙顶沿
    wallH: 74,            // 背景墙高度（写靶道编号）
    benchY: 486,          // 枪台上沿：靶子最低不越过这条线
    padX: 58,             // 靶心横向活动余量（靶半径 + 一点边距）
    /* 三段纵深：y0~y1 是靶心的允许区间，scale 乘在基准半径上，mult 是分数倍率 */
    depths: [
      { id: 'far', name: '远靶道', y0: 142, y1: 208, scale: 0.70, mult: 1.45 },
      { id: 'mid', name: '中靶道', y0: 228, y1: 308, scale: 0.86, mult: 1.20 },
      { id: 'near', name: '近靶道', y0: 328, y1: 424, scale: 1.00, mult: 1.00 }
    ]
  };
  function depthById(id) {
    for (var i = 0; i < RANGE.depths.length; i++) { if (RANGE.depths[i].id === id) { return RANGE.depths[i]; } }
    return RANGE.depths[2];
  }

  /* 基准靶半径（设计像素）：各靶型按此再乘自己的 r 与纵深 scale */
  var BASE_R = 34;

  /* SECTION: guns 军械库
     六把枪不止长得不一样 —— 弹匣、射速、换弹、散布、弹丸数、分数倍率全不同：

       rps        射速（发/秒）。间隔 = 1/rps，扣扳机再快也不会超过它。
       mag        弹匣容量。打完自动换弹，也可以 R 手动换弹（比自动快，但不省钱）。
       reload     换弹耗时（秒）。换弹期间打不出去 —— 这是节奏成本。
       spread0    准星散布下限（设计像素）。屏息/开镜再乘 steady。
       kick       每开一枪散布增加量。连射越打越飘 —— 泼水的枪必须靠射速补。
       decay      散布回落速度（像素/秒）。
       maxBloom   散布上限（泼满一梭子的准星半径）。
       ↑ 这四个数是一组权衡，标定时以"近靶道 10 环半径 7.5px、靶半径 34px"为尺子：
         稳定射击时散布应落在 2~8px（认真瞄就打内十），泼满应顶到 12~30px
         （只能蹭到 6/4 环）。散布一旦超过靶半径，命中就变成抽奖，手感即废 ——
         单测里有一条断言专门钉住这个上限。
       pellets    每发弹丸数（霰弹枪 5 颗）：任一颗碰到靶就算命中，
                  所以容错最高，代价是 mult 只有 0.46 —— 一发糊上去不如步枪一枪。
       mult       分数倍率：命中分、奖励分全乘它。**快枪不一定更高分**，
                  倍率与射速/散布是一组权衡，不是数值大小排序。
       steady     屏息对这把枪的收益倍率（狙击开镜收得最狠）。
       pace       **过关要求的折算系数**。关卡的"需击落 N 靶"会乘这个数再取整 ——
                  因为扳机慢的枪在同样的靶量下就是打不完：狙击枪 0.75 折算后
                  与手枪在同一关用掉的时间基本齐平（这个数字是量出来的，
                  守门断言见 tools/test-shooter-core.mjs 的"各枪最紧一关用时占比"）。
                  分数的倍率轴（mult）与进度轴（pace）分开，才有"枪不同但都能玩"。
       price      解锁需要的累计金币（金币跨局累计，存 shooter-coins）。 */
  var GUNS = [
    {
      id: 'pistol', name: '制式手枪', art: '🔫', en: 'M1911 · SIDEARM',
      rps: 5.0, mag: 12, reload: 1.05, spread0: 2.0, kick: 3.4, decay: 26,
      maxBloom: 17,
      pace: 1.00,   // 过关要求的折算系数
      pellets: 1, mult: 1.00, steady: 0.50, price: 0,
      body: '#5a6472', accent: '#c8d2e0',
      desc: '均衡、可靠，什么关都能打 —— 新手就从它起步'
    },
    {
      id: 'revolver', name: '猎用左轮', art: '🎯', en: '.357 MAGNUM',
      rps: 2.4, mag: 6, reload: 1.85, spread0: 1.4, kick: 3.0, decay: 20,
      maxBloom: 12,
      pace: 1.00,   // 过关要求的折算系数
      pellets: 1, mult: 1.45, steady: 0.42, price: 140,
      body: '#7a5a3c', accent: '#e6cfa6',
      desc: '慢，但每一发都值钱；枪枪回零、屏息收益高 —— 打远靶道的利器'
    },
    {
      id: 'smg', name: '微型冲锋枪', art: '💨', en: 'SMG · SPRAY',
      rps: 11.0, mag: 30, reload: 1.7, spread0: 3.6, kick: 2.6, decay: 22,
      maxBloom: 20,
      pace: 1.00,   // 过关要求的折算系数
      pellets: 1, mult: 0.60, steady: 0.62, price: 300,
      body: '#4b5563', accent: '#9fd6ff',
      desc: '弹匣大、射速猛，靠泼水续连击；一梭子打完准星已经飘到 6 环区'
    },
    {
      id: 'shotgun', name: '泵动霰弹枪', art: '💥', en: '12 GAUGE',
      rps: 1.5, mag: 6, reload: 2.35, spread0: 6.0, kick: 8.0, decay: 26,
      maxBloom: 30,
      pace: 1.00,   // 过关要求的折算系数
      pellets: 5, mult: 0.46, steady: 0.72, price: 520,
      body: '#6b4a2f', accent: '#ffb45c',
      desc: '一炮五颗弹丸，只要有一颗蹭上就算命中 —— 容错最高，倍率最低'
    },
    {
      id: 'sniper', name: '狙击步枪', art: '🔭', en: 'BOLT · LONG RANGE',
      /* 这把枪曾是全关卡的吞吐瓶颈：5 发 / 0.95 秒每秒 / 2.5 秒换弹 = 每分钟只能击落 35 个靶，
         于是"打够击落数"这件事在数学上就对它不公平（见单测守门断言）。
         现在把弹匣与射速抬到能跟上靶量，倍率相应从 2.3 降到 2.1 —— 它仍然是全场最慢、一枪最值的枪。
         抬完的吞吐：8 发 / (8÷1.35 秒连射 + 1.95 秒换弹) ≈ 每秒 1 个靶，
         无尽第 3 轮（要求 44 靶 / 55 秒）留约 20% 余量。 */
      rps: 1.35, mag: 8, reload: 1.95, spread0: 0.8, kick: 12.0, decay: 14,
      maxBloom: 26,
      pace: 0.75,   // 过关要求的折算系数
      pellets: 1, mult: 2.10, steady: 0.28, price: 820,
      body: '#37474f', accent: '#7dffb0',
      desc: '一枪抵两倍分，后坐力大到要等准星回落 —— 屏息能救回来'
    },
    {
      id: 'duelist', name: '双持神枪', art: '⚡', en: 'TWIN DERRINGER',
      rps: 7.2, mag: 16, reload: 2.1, spread0: 2.6, kick: 4.2, decay: 24,
      maxBloom: 24,
      pace: 1.10,   // 过关要求的折算系数
      pellets: 1, mult: 1.18, steady: 0.46, price: 1250,
      body: '#2f3542', accent: '#ffe066',
      desc: '决赛用枪：又快又贵，飘起来比谁都凶 —— 手稳才压得住'
    }
  ];
  function gunById(id) {
    for (var i = 0; i < GUNS.length; i++) { if (GUNS[i].id === id) { return GUNS[i]; } }
    return GUNS[0];
  }

  /* SECTION: rules 全局规则常量 */
  var RULES = {
    /* 连击：命中后 COMBO_WINDOW 秒内再命中则续上，打空/中炸弹/超时会断 */
    COMBO_WINDOW: 2.4,
    /* 连段 → 倍率档位（达到 n 连段取该档；不线性，最后跳到 ×8 给爆发留空间） */
    STREAK_TIERS: [{ n: 0, x: 1 }, { n: 3, x: 2 }, { n: 6, x: 3 }, { n: 10, x: 4 }, { n: 15, x: 6 }, { n: 22, x: 8 }],
    /* 反应窗地板：任何一个靶「可被打中」的时间不得短于此（生成时反推限速）。
       这是本作对玩家的公平性承诺，单测里有专门的全关卡守门断言。 */
    HIT_FLOOR: 1.05,
    /* 同屏靶心之间的最小间隙（半径和之外再留这么多像素）：
       否则两个靶叠在一起，玩家瞄准一个却打中另一个 —— 尤其会误伤炸雷靶。 */
    SPAWN_PAD: 12,
    /* 炸弹靶与计分靶的额外避让：炸雷靶周围这么多像素内不得出现计分靶心 */
    BOMB_AVOID: 46,
    /* 空仓后自动换弹的延迟（秒）—— 留一个"咔哒"的挫败瞬间，但不至于发呆 */
    AUTO_RELOAD_DELAY: 0.22,
    /* 屏息：STEADY 上限秒数、消耗速率、恢复速率、恢复前的等待 */
    STEADY: { max: 1.8, drain: 1.0, regen: 0.62, regenDelay: 0.55 }
  };

  /* 命中分数：按"弹着点到靶心的距离 / 当前靶半径"定环数。
     一靶一命 —— 打中即结算，位置决定收益，所以"瞄哪儿"永远比"打几发"重要。 */
  var SCORE = {
    BULL: { f: 0.07, pts: 20, label: '内十' },
    RINGS: [{ f: 0.22, pts: 10, label: '10 环' }, { f: 0.46, pts: 8, label: '8 环' },
      { f: 0.74, pts: 6, label: '6 环' }, { f: 1.0, pts: 4, label: '4 环' }],
    /* 奖励与惩罚 */
    GOLD_PTS: 60, GOLD_COINS: 3,
    BOMB_PTS: 120, BOMB_TIME: 2.2,     // 打中炸雷靶：倒扣分数 + 扣时（不减击落数）
    CLOCK_BONUS: 3.5,                  // 打中秒表靶：加时
    CLEAR_BONUS: 220, CLEAR_PER_LEVEL: 55,
    TIME_BONUS_PER_SEC: 15,            // 过关时剩余秒数折分
    PERFECT_RING_BONUS: 30,            // 一枪内十的额外奖励
    /* 评级：按命中率（命中发数 / 击发数） */
    GRADES: [{ min: 0.86, name: 'S', bonus: 1.5 }, { min: 0.72, name: 'A', bonus: 1.25 },
      { min: 0.55, name: 'B', bonus: 1.1 }, { min: 0, name: 'C', bonus: 1.0 }],
    /* 过关金币：基础 + 评级奖励 + 每 6 发命中攒 1 枚 */
    COINS_CLEAR_BASE: 12, COINS_GRADE: { S: 18, A: 12, B: 7, C: 3 }, COINS_PER_HITS: 6
  };

  /* SECTION: targets 靶型表
     motion：轨迹种类，具体积分在 shooter-core.js（static/pop/linear/sine/arc/drift/pulse/blink）
       r      相对 BASE_R 的半径
       value  分数倍率（命中基础分还要乘纵深与枪倍率）
       life   场上最长存活（秒）；移动靶还会按"横穿所需时间"取更长的那个
       speed  基准水平速度（设计像素/秒），关卡 speed 再乘
       coins  命中给的金币
       bad    true = 不可射击的炸雷靶（打中受罚，放着不管会自己消失）
       weight 默认出现权重，关卡可覆盖
     ---------------------------------------------------------- */
  var TARGETS = {
    ring: { id: 'ring', name: '环靶', art: '🎯', motion: 'pop', r: 1.0, value: 1.0, life: 3.4, speed: 0, label: '起靶' },
    slide: { id: 'slide', name: '平移靶', art: '➡️', motion: 'linear', r: 0.92, value: 1.25, life: 4.2, speed: 118, label: '横移' },
    wave: { id: 'wave', name: '起伏靶', art: '🌊', motion: 'sine', r: 0.86, value: 1.45, life: 4.4, speed: 132, amp: 44, freq: 1.5, label: '波浪' },
    flyer: { id: 'flyer', name: '飞碟靶', art: '🛸', motion: 'arc', r: 0.8, value: 1.7, life: 3.6, speed: 176, rise: 118, label: '抛物线' },
    shrinker: { id: 'shrinker', name: '收缩靶', art: '🔍', motion: 'pulse', r: 1.0, value: 1.55, life: 4.0, speed: 0, pulse: 0.62, label: '会缩放' },
    splitter: { id: 'splitter', name: '分裂靶', art: '✂️', motion: 'linear', r: 1.12, value: 1.1, life: 4.0, speed: 96, split: 2, label: '打散变小靶' },
    mini: { id: 'mini', name: '小子弹靶', art: '🔹', motion: 'drift', r: 0.52, value: 1.9, life: 2.6, speed: 150, label: '碎片' },
    gold: { id: 'gold', name: '黄金靶', art: '💰', motion: 'linear', r: 0.74, value: 1.0, life: 2.8, speed: 208, coins: SCORE.GOLD_COINS, label: '值钱还给金币' },
    clock: { id: 'clock', name: '秒表靶', art: '⏱️', motion: 'pop', r: 0.8, value: 0.6, life: 2.6, speed: 0, timeBonus: SCORE.CLOCK_BONUS, label: '加时间' },
    blink: { id: 'blink', name: '闪隐靶', art: '👻', motion: 'blink', r: 0.86, value: 2.1, life: 4.6, speed: 104, on: 0.85, off: 0.7, label: '时隐时现' },
    bomb: { id: 'bomb', name: '炸雷靶', art: '💣', motion: 'drift', r: 0.78, value: 0, life: 4.2, speed: 58, bad: true, label: '千万别打' }
  };
  var TYPE_IDS = ['ring', 'slide', 'wave', 'flyer', 'shrinker', 'splitter', 'gold', 'clock', 'blink', 'bomb'];

  /* SECTION: levels 关卡曲线
     每一关给：时限 time、需击落 downs、生成间隔 gap（秒，随关卡收紧）、
     同屏上限 live、速度倍率 speed、靶型权重 weights、可用纵深 depths、分数倍率 scale。

     **过关条件是"击落多少个靶"，不是"打到多少分"** —— 这是刻意的：
     分数被枪的倍率、纵深、连击拉扯，六把枪在同一张配额表上压力完全不同
     （霰弹枪 0.46 倍率按分数配额会数学上过不去，狙击枪又能秒过）。
     击落数只与"你有多快找到并打中一个可打的靶"有关，对每把枪都是同一把尺子；
     分数则专心服务最高分、评级与金币。守门断言见 tools/test-shooter-core.mjs。

     downs 的标定：按"该关在场上的总靶量 × 0.6"给 —— 于是它要求的是
     "别漏掉太多靶"，而不是"手速无限"。同屏上限 live 会自然限制靶量。 */
  var LEVELS = [
    { name: '新手靶场', tag: '靶子只会升起来等你 —— 先找环数感觉', time: 62, downs: 16, gap: [1.05, 1.5], live: 2, speed: 0.82, scale: 1.0, weights: { ring: 10 }, depths: ['near', 'mid'] },
    { name: '首次横移', tag: '平移靶上道，打提前量', time: 62, downs: 19, gap: [0.95, 1.4], live: 3, speed: 0.9, scale: 1.0, weights: { ring: 7, slide: 5 }, depths: ['near', 'mid'] },
    { name: '波浪起伏', tag: '靶子开始上下走 —— 别追着弹道跑', time: 60, downs: 22, gap: [0.88, 1.3], live: 3, speed: 0.98, scale: 1.0, weights: { ring: 5, slide: 5, wave: 4 }, depths: ['near', 'mid'] },
    { name: '飞碟抛出', tag: '抛物线靶飞出，瞄预测位置', time: 60, downs: 25, gap: [0.8, 1.25], live: 4, speed: 1.05, scale: 1.05, weights: { ring: 4, slide: 4, wave: 4, flyer: 4 }, depths: ['near', 'mid', 'far'] },
    { name: '雷区警戒', tag: '混进炸雷靶 —— 打中倒扣 120 分还扣时间', time: 58, downs: 28, gap: [0.78, 1.2], live: 4, speed: 1.12, scale: 1.1, weights: { ring: 4, slide: 4, wave: 3, flyer: 3, shrinker: 3, bomb: 3 }, depths: ['near', 'mid', 'far'] },
    { name: '分裂靶阵', tag: '大靶打散成两枚小靶，别浪费', time: 58, downs: 29, gap: [0.74, 1.15], live: 5, speed: 1.18, scale: 1.15, weights: { ring: 3, slide: 3, wave: 3, flyer: 3, shrinker: 3, splitter: 3, bomb: 3 }, depths: ['near', 'mid', 'far'] },
    { name: '黄金与幽灵', tag: '金靶跑得最快，闪隐靶只在现身时打得中', time: 56, downs: 31, gap: [0.7, 1.1], live: 5, speed: 1.25, scale: 1.2, weights: { ring: 3, slide: 3, wave: 3, flyer: 3, shrinker: 2, splitter: 2, gold: 3, blink: 3, bomb: 3 }, depths: ['near', 'mid', 'far'] },
    { name: '速度考核', tag: '全场提速，靠屏息把准星收回来', time: 56, downs: 33, gap: [0.66, 1.0], live: 5, speed: 1.34, scale: 1.25, weights: { ring: 2, slide: 3, wave: 3, flyer: 4, shrinker: 3, splitter: 2, gold: 2, blink: 3, bomb: 4 }, depths: ['near', 'mid', 'far'] },
    { name: '读秒补时', tag: '时间不够就抢秒表靶 —— 但它分低', time: 55, downs: 35, gap: [0.62, 0.96], live: 6, speed: 1.42, scale: 1.3, weights: { ring: 2, slide: 3, wave: 3, flyer: 3, shrinker: 3, splitter: 2, gold: 3, clock: 2, blink: 3, bomb: 4 }, depths: ['near', 'mid', 'far'] },
    { name: '总决赛', tag: '满场靶，节奏最快 —— 别漏靶比瞄得准更要命', time: 55, downs: 38, gap: [0.58, 0.9], live: 6, speed: 1.5, scale: 1.35, weights: { ring: 2, slide: 3, wave: 3, flyer: 4, shrinker: 3, splitter: 3, gold: 3, clock: 2, blink: 4, bomb: 5 }, depths: ['near', 'mid', 'far'] }
  ];

  /* 无尽：第 10 关之后每多一关按此递推，密度/速度/同屏数都有封顶（防止物理不可解） */
  var ENDLESS = {
    downsAdd: 3, gapMul: 0.965, speedAdd: 0.05,
    maxGap: 0.42, maxSpeed: 1.95, maxLive: 8, maxBombWeight: 6
  };

  /* SECTION: scoring helper
     取配置（1~10 用表，之后无尽递推）。放在 data 层是因为纯查表，
     core 只消费它，不在此处做任何状态推演。 */
  function levelConfig(level) {
    var lv = Math.max(1, level | 0);
    var src;
    if (lv <= LEVELS.length) { src = LEVELS[lv - 1]; } else {
      var over = lv - LEVELS.length;
      var last = LEVELS[LEVELS.length - 1];
      var gapLo = Math.max(ENDLESS.maxGap, last.gap[0] * Math.pow(ENDLESS.gapMul, over));
      var gapHi = Math.max(gapLo * 1.25, last.gap[1] * Math.pow(ENDLESS.gapMul, over));
      src = {
        name: '无尽 第 ' + over + ' 轮',
        tag: '没有终点的靶场 —— 看你能连到几倍',
        time: last.time,
        downs: last.downs + ENDLESS.downsAdd * over,
        gap: [gapLo, gapHi],
        live: Math.min(ENDLESS.maxLive, last.live + (over > 2 ? 1 : 0)),
        speed: Math.min(ENDLESS.maxSpeed, last.speed + ENDLESS.speedAdd * over),
        scale: Math.min(1.8, last.scale + 0.03 * over),
        weights: {},
        depths: ['near', 'mid', 'far']
      };
      for (var k in last.weights) {
        if (Object.prototype.hasOwnProperty.call(last.weights, k)) {
          src.weights[k] = (k === 'bomb') ? Math.min(ENDLESS.maxBombWeight, last.weights[k]) : last.weights[k];
        }
      }
    }
    return {
      level: lv, name: src.name, tag: src.tag, time: src.time, downs: src.downs,
      gap: src.gap, live: src.live, speed: src.speed, scale: src.scale,
      weights: src.weights, depths: src.depths, endless: lv > LEVELS.length
    };
  }

  /* SECTION: copy 结算页提示与命中文案 */
  var TIPS = [
    '连击别断：×8 倍率下一个 4 环也比 ×1 的 10 环值钱。',
    '打空一发就断连击 —— 宁可慢一拍，也不要甩枪。',
    '屏息（按住右键 / Shift）能把散布收到一半以下，狙击枪收得最狠。',
    '远靶道的小靶给 1.45 倍分 —— 敢瞄就敢赚。',
    '炸雷靶放着不管它会自己飘走，打中才罚你。',
    '秒表靶分值低，但快没时间时它就是命。',
    '换弹前把弹匣打空能白赚一发 —— 手动 R 换弹更快，但要自己算节奏。',
    '分裂靶打散出来的小靶分值 1.9 倍，顺手清掉。'
  ];

  /* SECTION: Audio · Web Audio 合成音效（无外部资源）
     枪声 = 短噪声爆破 + 低频推力；环数越高"叮"的音高越高。 */
  var Audio = (function () {
    var ctx = null, enabled = true, noiseBuf = null;

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
    function noise(c) {
      if (noiseBuf) { return noiseBuf; }
      var len = Math.floor(c.sampleRate * 0.4);
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
      g.gain.exponentialRampToValueAtTime(vol || 0.14, c.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + (dur || 0.12));
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + (dur || 0.12) + 0.02);
    }
    function sweep(f1, f2, dur, vol, type) {
      if (!enabled) { return; }
      var c = ac(); if (!c) { return; }
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(f1, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, f2), c.currentTime + dur);
      g.gain.setValueAtTime(vol || 0.13, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + dur + 0.02);
    }
    /* 枪声：width 控制噪声带宽度，tail 控制低频推力长度 —— 六把枪靠这两个参数区分 */
    function bang(vol, width, tail) {
      if (!enabled) { return; }
      var c = ac(); if (!c) { return; }
      var src = c.createBufferSource(); src.buffer = noise(c);
      var bp = c.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 1500 * width; bp.Q.value = 0.7;
      var g = c.createGain();
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.12 + tail);
      src.connect(bp); bp.connect(g); g.connect(c.destination);
      src.start(); src.stop(c.currentTime + 0.14 + tail);

      var o = c.createOscillator(), og = c.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(150, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(38, c.currentTime + tail);
      og.gain.setValueAtTime(vol * 0.7, c.currentTime);
      og.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + tail);
      o.connect(og); og.connect(c.destination);
      o.start(); o.stop(c.currentTime + tail + 0.02);
    }

    return {
      get enabled() { return enabled; },
      set enabled(v) { enabled = !!v; },
      resume: resume,
      /* 各枪音色：狙击 = 又闷又长的推力，冲锋枪 = 干脆的短促爆点 */
      shot: function (gunId) {
        if (gunId === 'sniper') { bang(0.3, 0.55, 0.3); }
        else if (gunId === 'shotgun') { bang(0.29, 0.8, 0.2); }
        else if (gunId === 'smg') { bang(0.16, 1.9, 0.07); }
        else if (gunId === 'revolver') { bang(0.25, 0.9, 0.16); }
        else if (gunId === 'duelist') { bang(0.21, 1.3, 0.12); }
        else { bang(0.2, 1.25, 0.11); }
      },
      dry: function () { blip(2100, 0.04, 'square', 0.07); },
      reload: function () { blip(760, 0.05, 'square', 0.1); setTimeout(function () { blip(520, 0.06, 'square', 0.1); }, 130); },
      reloadDone: function () { blip(1180, 0.06, 'square', 0.11); },
      /* 命中：环数越高音越高（金属靶"叮"） */
      hit: function (pts) { blip(620 + pts * 42, 0.13, 'sine', 0.13); blip(1240 + pts * 70, 0.09, 'triangle', 0.07); },
      bull: function () { blip(1480, 0.16, 'sine', 0.15); setTimeout(function () { blip(2220, 0.16, 'sine', 0.12); }, 70); },
      miss: function () { blip(190, 0.09, 'sine', 0.06); },
      bomb: function () {
        if (!enabled) { return; }
        bang(0.34, 0.4, 0.34);
        sweep(320, 60, 0.4, 0.2, 'sawtooth');
      },
      gold: function () { sweep(880, 1320, 0.1, 0.13); setTimeout(function () { blip(1760, 0.12, 'sine', 0.12); }, 90); },
      clock: function () { blip(980, 0.08, 'square', 0.12); setTimeout(function () { blip(1320, 0.1, 'square', 0.12); }, 90); },
      drop: function () { blip(360, 0.1, 'sine', 0.05); },
      combo: function (x) { sweep(420 + x * 90, 780 + x * 150, 0.16, 0.12); },
      countdown: function (last) { blip(last ? 1180 : 720, last ? 0.2 : 0.1, 'sine', 0.14); },
      levelup: function () {
        [660, 880, 1100, 1320].forEach(function (f, i) { setTimeout(function () { blip(f, 0.18, 'sine', 0.14); }, i * 110); });
      },
      over: function () { sweep(420, 90, 0.7, 0.18, 'sawtooth'); }
    };
  })();

  return {
    LAYOUT: LAYOUT, RANGE: RANGE, BASE_R: BASE_R, depthById: depthById,
    GUNS: GUNS, gunById: gunById,
    RULES: RULES, SCORE: SCORE,
    TARGETS: TARGETS, TYPE_IDS: TYPE_IDS,
    LEVELS: LEVELS, ENDLESS: ENDLESS, levelConfig: levelConfig,
    TIPS: TIPS,
    Audio: Audio
  };
})();
