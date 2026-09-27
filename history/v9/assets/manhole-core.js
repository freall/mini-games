/* ============================================================
   开车不要压井盖儿 · 纯逻辑核心
   SECTION: manhole-core
   ------------------------------------------------------------
   这里不碰任何 DOM、不碰 canvas：跑道生成、车轮碰撞判定、计分、
   道具效果、关卡递进全在这，可以脱离浏览器直接用 node 跑断言
   （tools/test-manhole-core.mjs）。

   坐标系（设计空间，与窗口像素无关）：
     x → 马路横向，0 在左路肩外沿，LAYOUT.W 在右；路面区域 = marginX ~ W-marginX
     y → 纵向，0 在屏幕顶端，LAYOUT.H 在底端；**路面向下滚动**，
         车固定在 y = PLAYER.y 不动，靠世界元素下移制造"车在前进"的错觉。
     距离米数从关卡开始累计，只增不减，用于换算分数与生成节奏。

   核心规则（一句话）：**车轮压到井盖 = 输**。
     判定不是看车身中心，而是取左右两个车轮的落点分别与井盖做圆-圆相交测试
     （用平方距离避免开方，也避免浮点误差导致的边界抖动）。
   ============================================================ */
window.MANHOLE_CORE = (function () {
  'use strict';

  /* SECTION: 空间换算
     设计空间宽度拆成 4 条车道，车道 i 的中心线 x。 */
  function roadLeft(D) { return D.ROAD.marginX; }
  function roadRight(D) { return D.LAYOUT.W - D.ROAD.marginX; }
  function laneWidth(D, lanes) { return (roadRight(D) - roadLeft(D)) / lanes; }
  function laneCenterX(D, lanes, i) {
    return roadLeft(D) + laneWidth(D, lanes) * (i + 0.5);
  }
  /* 像素 → 车道数（0-based），用于自动选道与生成时的空位计算 */
  function laneOfX(D, lanes, x) {
    var w = laneWidth(D, lanes);
    var i = Math.floor((x - roadLeft(D)) / w);
    return Math.max(0, Math.min(lanes - 1, i));
  }

  /* 车道横向范围 [left, right] */
  function laneBounds(D, lanes, i) {
    var w = laneWidth(D, lanes);
    var l = roadLeft(D) + w * i;
    return { left: l, right: l + w };
  }

  /* SECTION: 车辆参数
     data 层的 VEHICLES 表 + PLAYER 基准合成出"这局车的有效玩家参数"。
     判定/操控用的字段形状与 D.PLAYER 完全兼容（w/h/wheelRadius/steerSpeed），
     另带 speed（整体速度倍率）与 mult（分数倍率）。
     所有 core 判定函数都接受可选的 veh 尾参：不传 = 用 D.PLAYER（小轿车基准），
     这样旧调用点与既有单测语义一个字都不用变。 */
  function playerParams(D, vehId) {
    var v = D.vehicleById ? D.vehicleById(vehId) : null;
    if (!v) { v = { id: 'sedan', name: '小轿车', mult: 1, w: D.PLAYER.w, h: D.PLAYER.h, speed: 1 }; }
    return {
      id: v.id, name: v.name,
      /* 视觉字段也要带：drawCar 直接读 veh.body / veh.accent 画车身 ——
         踩过的坑：漏掉 body 后渲染层每帧 undefined[0] 报错，
         判定全对、单测全绿，冒烟 pageerror 刷屏才抓到。 */
      art: v.art || '🚗', body: v.body, accent: v.accent,
      mult: v.mult || 1,
      w: v.w, h: v.h, wheelRadius: v.wheelRadius || D.PLAYER.wheelRadius,
      /* 横向巡航速度 = 基准 × 车辆灵活度（键盘长按的横移速度） */
      steerSpeed: D.PLAYER.steerSpeed * (v.steer || 1),
      /* 整体速度倍率：乘进世界滚动速度 —— 同一条路，快车只是开得快，
         井盖到达时间被等比压缩（"行距 ≥ 两次并线"的公平性不变式是
         时间缩放不变的：快车横移也快，缩放后仍成立）。 */
      speed: v.speed || 1
    };
  }

  /* SECTION: 车身占用的车道集合
     **这是判定与"玩家以为自己在哪条道"保持一致的关键**。
     只用车身中心所在车道会有个隐蔽的坑：车心在车道 1（x=274，车道 1 从 273.5 起）
     但左轮在 222 —— 已经压到车道 0 的范围里了。玩家看着"我在车道 1"，
     车轮却真的碾在车道 0 的井盖上，会觉得游戏在耍赖。
     所以这里按**车轮实际落点**报占用车道：车轮压到哪条道的范围，就算占用哪条道。
     生成器与玩家的并线判断都以此为准，视觉与判定才不会打架。 */
  function occupiedLanes(D, lanes, cx, veh) {
    var ws = wheels(D, lanes, cx, D.PLAYER.y, veh);
    var out = [];
    for (var i = 0; i < ws.length; i++) {
      var l = laneOfX(D, lanes, ws[i].x);
      if (out.indexOf(l) < 0) { out.push(l); }
    }
    return out;
  }

  /* 车是否"安稳地待在某一条车道里"（两个车轮都在同一条车道的范围内，
     且留出车轮半径的余量）—— 只有这时候才算真正对准了车道。 */
  function alignedLane(D, lanes, cx, veh) {
    var ws = wheels(D, lanes, cx, D.PLAYER.y, veh);
    var l0 = laneOfX(D, lanes, ws[0].x), l1 = laneOfX(D, lanes, ws[1].x);
    if (l0 !== l1) { return -1; }
    var b = laneBounds(D, lanes, l0);
    if (ws[0].x - ws[0].r < b.left || ws[1].x + ws[1].r > b.right) { return -1; }
    return l0;
  }

  /* 车宽（随车道宽缩放，保证四车道永远是"一辆车 + 一条缝"的观感）。
     veh 可选：不同车辆有不同的车身宽度占比（自行车窄、越野车宽）。 */
  function carWidth(D, lanes, veh) {
    var P = veh || D.PLAYER;
    return laneWidth(D, lanes) * P.w;
  }

  /* SECTION: 车轮落点
     左右前轮（够用了 —— 前轮压盖就是压盖，后轮通常跟着前轮走）。
     返回 [{x, y, r}, {x, y, r}]，车身中心 (cx, cy)。

     轮距取"车身外沿向内缩一个轮半径"，即车轮贴在车身两侧，
     这样车轮判定带 = 车身覆盖带，玩家看到的车身有多宽，判定就有多宽。

     **每辆车的 wheelRadius 都验证过同一个不变式**（单测守着）：
     井盖压在车身正中时必有车轮碰到（half ≤ 2×wheelRadius + 井盖半径），
     井盖从两轮间"钻过去"的漏洞在窄车（自行车）上同样不会出现。 */
  function wheels(D, lanes, cx, cy, veh) {
    var P = veh || D.PLAYER;
    var half = carWidth(D, lanes, veh) / 2;
    var r = P.wheelRadius;
    var off = Math.max(0, half - r);
    return [
      { x: cx - off, y: cy, r: r },
      { x: cx + off, y: cy, r: r }
    ];
  }

  /* 车身正下方的判定带：「压到井盖就算输」的**完整语义**。
     只用车轮判会漏掉一种情况 —— 井盖正好在车身正中、两个车轮之间
     （车轮间距 = 车身宽 - 2×轮半径 = 87.7px，而井盖直径才 60px，
     它能整个躲在两轮之间）。玩家看到的是"车从井盖上碾过去"，不能判他没事。

     所以井盖判定 = 车轮碰到 **或** 井盖完全落在车身覆盖范围内（左右都不露出来）。
     用"完全覆盖"而不是"有重叠"是有意的：车轮判定已经覆盖了车身两侧的接触，
     这里的补集只是车底正中那一段，两者合起来正好等于"车身覆盖到就算压到"，
     不会把"井盖只在车身角上蹭掉一点"这类过于严苛的情形也算进去。 */
  function underBody(D, lanes, cx, cy, obs, veh) {
    var P = veh || D.PLAYER;
    var half = carWidth(D, lanes, veh) / 2;
    var hh = P.h / 2;
    /* 纵向：井盖必须真的在车身前后范围内 */
    if (Math.abs(obs.y - cy) > hh) { return false; }
    /* 横向：井盖的左右边缘都要落在车身内 */
    return (obs.x - obs.r) >= (cx - half) && (obs.x + obs.r) <= (cx + half);
  }

  /* SECTION: 碰撞
     圆-圆相交：圆心距平方 ≤ 半径和平方。
     **用平方比较、且边界取 <=**：井盖半径与车轮半径都是整数，
     圆心距正好等于半径和时算压到（"贴着井盖边沿"视觉上就是压上去了），
     这样单测里可以构造精确的临界点，不会因为浮点误差在边界上抖。 */
  function circlesOverlap(ax, ay, ar, bx, by, br) {
    var dx = ax - bx, dy = ay - by, rr = ar + br;
    return dx * dx + dy * dy <= rr * rr;
  }

  /* 车轮组 vs 一个井盖：任一车轮压到、**或井盖整个落在车底正中**即算压到
     （见 underBody 的注释：只有车轮判会漏掉车底正中的那一块） */
  function carHits(D, lanes, cx, cy, obs, veh) {
    var ws = wheels(D, lanes, cx, cy, veh);
    for (var i = 0; i < ws.length; i++) {
      if (circlesOverlap(ws[i].x, ws[i].y, ws[i].r, obs.x, obs.y, obs.r)) { return true; }
    }
    return underBody(D, lanes, cx, cy, obs, veh);
  }

  /* SECTION: 车身判定（拾取物 / 干扰物）
     **注意与井盖判定的区别**：井盖必须用「车轮落点」判（车轮压到才算压到，
     车底正中跨在两轮之间的井盖不该算），而金币、路锥这类东西是**车身范围**内的
     接触就算数 —— 用车轮判会让放在车正中的金币永远捡不到（踩过一次）。
     车身是个矩形，这里退化成"矩形 vs 圆"的最近点测试，够精确也够快。 */
  function carBodyHits(D, lanes, cx, cy, obs, veh) {
    var P = veh || D.PLAYER;
    var hw = carWidth(D, lanes, veh) / 2, hh = P.h / 2;
    var nx = Math.max(cx - hw, Math.min(cx + hw, obs.x));
    var ny = Math.max(cy - hh, Math.min(cy + hh, obs.y));
    var dx = nx - obs.x, dy = ny - obs.y;
    return dx * dx + dy * dy <= obs.r * obs.r;
  }

  /* 车身版扫掠：与 sweptHit 同理，防止高速穿过小物件 */
  function sweptBodyHit(D, lanes, cx, cy, obs, dy, veh) {
    if (carBodyHits(D, lanes, cx, cy, obs, veh)) { return true; }
    if (!dy) { return false; }
    var stepMax = Math.max(6, obs.r);
    var steps = Math.min(24, Math.ceil(Math.abs(dy) / stepMax));
    for (var i = 1; i <= steps; i++) {
      if (carBodyHits(D, lanes, cx, cy, { x: obs.x, y: obs.y - dy * (i / steps), r: obs.r }, veh)) { return true; }
    }
    return false;
  }

  /* SECTION: 扫掠判定（防穿透）
     帧间位移可能大于井盖直径：60fps 下最高速 640×1.55 ≈ 992px/s，
     一帧位移 16.5px，而井盖直径 40~60px —— 单独看末位置是够用的，
     但一旦卡顿（dt 被放大到 0.1s），一帧位移能到 99px，
     井盖会整个"跳过"车轮所在的高度，出现**穿过井盖却判不到碰撞**的漏洞。
     所以判定沿着本帧的位移轨迹采样若干点，取任一采样点命中即为命中。
     step 取 min(井盖直径, 车轮直径) 的一半，保证采样不会漏掉重叠区间。 */
  function sweptHit(D, lanes, cx, cy, obs, dy, veh) {
    if (carHits(D, lanes, cx, cy, obs, veh)) { return true; }
    if (!dy) { return false; }
    var P = veh || D.PLAYER;
    var stepMax = Math.max(6, Math.min(obs.r * 2, P.wheelRadius * 2) * 0.5);
    var steps = Math.min(24, Math.ceil(Math.abs(dy) / stepMax));
    for (var i = 1; i <= steps; i++) {
      /* 往回采样：obs 已在本帧末位置，向"上一帧的位置"方向回溯 */
      if (carHits(D, lanes, cx, cy, { x: obs.x, y: obs.y - dy * (i / steps), r: obs.r }, veh)) { return true; }
    }
    return false;
  }

  /* 「擦过去」判定：没压到，但某个车轮离井盖边缘足够近。
     用 圆心距 - 半径和 得到"净间隙"，小于阈值即算惊险擦过。
     必须先确认没压到（间隙为负就是压到了，那要算碰撞不算擦过）。 */
  function nearMissGap(D, lanes, cx, cy, obs, veh) {
    var ws = wheels(D, lanes, cx, cy, veh);
    var best = Infinity;
    for (var i = 0; i < ws.length; i++) {
      var dx = ws[i].x - obs.x, dy = ws[i].y - obs.y;
      var gap = Math.sqrt(dx * dx + dy * dy) - (ws[i].r + obs.r);
      if (gap < best) { best = gap; }
    }
    return best;
  }

  /* SECTION: 计分 */
  /* 连击倍率：每躲过 comboStep 个井盖 +1，封顶 comboMax */
  function comboMult(dodged, D) {
    return Math.min(D.SCORE.comboMax, 1 + Math.floor(dodged / D.SCORE.comboStep));
  }

  /* 一个拾取物的得分（连击倍率同样生效，所以贴着井盖捡金币很赚）。
     veh 可选：不同车辆有分数倍率（开得快/宽是真实风险，收益也真实）。 */
  function pickupScore(kind, dodged, D, veh) {
    var base = D.SCORE[kind] || 0;
    var m = (veh && veh.mult) || 1;
    return Math.round(base * comboMult(dodged, D) * m);
  }

  /* 关卡结算分：路程基础分 + 通关奖励 */
  function levelScore(meters, level, D) {
    return Math.round(meters * D.SCORE.perMeter) + D.SCORE.levelBonus * Math.max(1, level | 0);
  }

  /* SECTION: 跑道生成
     世界按"行"推进：每行进一段路，按当前密度决定这一行放几个井盖、放哪几条车道。

     两条硬性约束（都由单测守着）：
       1. **单行不封路**：一行井盖不能占满所有车道。
       2. **多行可连续通过**：相邻的若干行之间必须存在一条"接力"路径 ——
          因为玩家平均只有一次并线的时间窗，如果行 A 逼你往右、行 B 又立刻逼你往左，
          人根本来不及（这就是"看着有缝、实际必死"的坑）。

     实现方式：生成时记着**上几行**的占用，用"车道接力"的办法挑这一行的井盖位置 ——
     先算出上几行之后还"活着"的车道集合（可达车道），这一行只允许占用其中一部分，
     永远保留至少一条可达车道，并且把可达集合更新下去。 */
  var REACH_ROWS = 3;              // 需要保证连续可通过的行数（够玩家一次并线的余量）

  /* 给定上一轮的可达车道集合，挑这一行放井盖的车道。
     reachable：进入这一行时玩家可能所在的车道（上几行之后依然安全的位置） */
  function makeRow(D, cfg, lanes, rng, reachable) {
    var cols = [];
    /* 这一行想放 n 个井盖：密度越高 n 越大，但绝不允许填满所有车道 */
    var want;
    var r = rng();
    if (cfg.obstaclesPer100m > 8) { want = r < 0.45 ? 3 : 2; }
    else if (cfg.obstaclesPer100m > 6) { want = r < 0.5 ? 2 : 1; }
    else { want = r < 0.3 ? 2 : 1; }

    /* 并排上限：不能超过 车道数-1，且不超过关卡配的 cluster 能力 */
    var maxTogether = Math.max(1, lanes - 1);
    if (cfg.cluster <= 0) { maxTogether = Math.min(maxTogether, 1); }
    else { maxTogether = Math.min(maxTogether, cfg.cluster + 1); }
    var n = Math.min(want, maxTogether);

    var pool = [];
    for (var i = 0; i < lanes; i++) { pool.push(i); }
    shuffle(pool, rng);

    /* 打乱后逐个尝试放置，边放边校验"可达车道不能被清空"。
       先放哪些车道是随机的，但**只要会封死路就跳过** —— 这比"先定车道再修正"
       简单，且天然保留了随机感。 */
    for (var k = 0; k < pool.length && cols.length < n; k++) {
      var cand = cols.concat([pool[k]]);
      var left = freeLanes(lanes, cand);
      if (!left.length) { continue; }                       // 单行封路 → 不放过
      if (reachable && !survives(reachable, left, lanes)) { continue; }  // 接力断了 → 跳过
      cols.push(pool[k]);
    }

    /* 兜底：一个都没放下（理论上不会发生，因为 left 至少留一条），
       就退化成"只放一个井盖"，保证永远有路。 */
    if (!cols.length) { cols.push(pool[0]); }
    cols.sort(function (a, b) { return a - b; });
    return cols;
  }

  /* 车道集合差集：total 条车道里去掉 used 之后剩下的 */
  function freeLanes(lanes, used) {
    var out = [];
    for (var i = 0; i < lanes; i++) { if (used.indexOf(i) < 0) { out.push(i); } }
    return out;
  }

  /* 接力可行性：从 after 里的某条车道出发，能否在 rows 行之内回到"安全车道"。
     简化判据：after 与 next 两个集合必须有交集，
     或者 next 里存在一条车道，它与 after 中某条车道的距离 ≤ 玩家一次并线的余量。
     因为一行之间的时间窗通常只够换一条车道，这里把余量定为 1 条车道 ——
     留 2 条会过于宽松（等于不检查），留 0 条就成了"原地不动才行"。 */
  function survives(after, next, lanes) {
    for (var i = 0; i < after.length; i++) {
      for (var j = 0; j < next.length; j++) {
        if (Math.abs(after[i] - next[j]) <= 1) { return true; }
      }
    }
    return false;
  }

  /* 计算"通过这一行之后玩家可能所在的车道集合"：
     对 after 集合里每条车道，它可以原地不动，也可以左右并线一条。 */
  function reachAfter(prev, rowCols, lanes) {
    var ok = [];
    for (var i = 0; i < prev.length; i++) {
      for (var d = -1; d <= 1; d++) {
        var l = prev[i] + d;
        if (l < 0 || l >= lanes) { continue; }
        if (rowCols.indexOf(l) >= 0) { continue; }   // 这条车道这一行有井盖
        if (ok.indexOf(l) < 0) { ok.push(l); }
      }
    }
    return ok;
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* 井盖半径：略小于半个车道宽，保证相邻车道的井盖不会视觉粘连 */
  function manholeRadius(D, lanes) {
    return Math.round(Math.min(30, laneWidth(D, lanes) * 0.30));
  }

  /* SECTION: 车间距
     两行井盖之间的纵向像素距离。这是本作的**难度公平性开关**。

     行距按「反应时间」而不是按「像素」来定：
       行距 = 速度 × 目标反应时间(秒) × 随机浮动
     目标反应时间随关卡**缓慢**收紧（1.05s → 0.62s），但永远不会低于下限。

     但光有反应时间还不够 —— 还有一个**并线时间窗**约束（踩过的坑）：
     玩家从一条车道挪到隔壁需要 ~0.16s 才能真正"落位"，而两行之间如果只隔
     0.6s，玩家躲完第一行后只剩 0.44s，遇到"行 A 逼你往右、行 B 又逼你往左"
     的连环局面就会在两道之间被撞（实测 AI 与单测都复现过：车停在 x=425、
     正从车道 2 往车道 1 挪，结果车道 1 的井盖到了）。
     所以行距还要保证至少留出 LANE_SETTLE_S × 2 的并线余量。 */
  var REACT_BASE = 1.05;    // 第 1 关的反应时间预算（秒）
  var REACT_MIN = 0.62;     // 反应时间下限，封顶难度
  var LANE_SETTLE_S = 0.20; // 并线一条车道所需的落位时间（含少量余量）

  function rowSpacing(D, cfg, rng) {
    var lvK = Math.min(1, (cfg.level - 1) / 9);                 // 1~10 关线性收紧
    if (cfg.level > 10) { lvK = 1; }
    var react = REACT_BASE - (REACT_BASE - REACT_MIN) * lvK;    // 1.05s → 0.62s
    /* 反应时间不能小于"连续两次并线"所需的时间，否则连环变向必然来不及 */
    var floor = LANE_SETTLE_S * 2 + 0.24;                        // = 0.64s
    var jitter = 0.86 + (rng ? rng() : 0.5) * 0.32;             // ±16% 的随机浮动，别太机械
    var t = react * jitter;
    /* 浮动之后还要再兜一次底 —— 只在浮动之前夹住是没用的（0.62 × 0.86 = 0.533，
       单测抓到了这个漏洞） */
    if (t < floor) { t = floor; }
    return cfg.speed * t;
  }

  /* SECTION: 世界
     一个"世界"实例就是跑一关的全部可变态。用构造函数而非闭包，
     这样单测里可以造多个世界互不干扰，也方便存档/重放。 */
  function World(D, level, rng, opts) {
    opts = opts || {};
    this.D = D;
    this.rng = rng || Math.random;
    this.cfg = D.levelConfig(level);
    this.lanes = Math.max(2, Math.min(D.ROAD.lanes, opts.lanes || D.ROAD.lanes));
    /* 车辆：默认小轿车（旧调用不传 vehicleId 时行为与以前完全一致）。
       veh 挂在实例上 —— 选车在局与局之间，reset 不重置它。 */
    this.veh = playerParams(D, opts.vehicleId);
    this.reset(level);
  }

  World.prototype.reset = function (level) {
    var D = this.D;
    if (level) { this.cfg = D.levelConfig(level); }
    this.running = false;
    this.over = false;
    this.won = false;
    this.level = this.cfg.level;
    this.distance = 0;             // 已跑米数
    /* 世界滚动速度 = 关卡速度 × 车辆速度倍率。
       行距（rowSpacing）仍按关卡速度生成 → 空间路况对每辆车完全相同，
       但快车到达下一行的时间 = 行距/(速度×veh.speed) 被等比压缩 → 更难。 */
    this.speed = this.cfg.speed * (this.veh ? this.veh.speed : 1);   // 世界滚动速度（px/s）
    this.speedMul = 1;             // 道具造成的速度倍率（加速带/减速）
    this.speedMulMs = 0;
    this.carX = laneCenterX(D, this.lanes, Math.floor(this.lanes / 2));
    this.carY = D.PLAYER.y;
    this.targetLane = Math.floor(this.lanes / 2);
    this.steer = 0;                // -1 左 / +1 右（长按）
    this.tilt = 0;                 // 车身倾斜（观感）
    this.obs = [];                 // 路上的井盖等元素
    this.dodged = 0;               // 连续躲过的井盖数（连击）
    this.bestDodged = 0;
    this.coins = 0;                // 本局捡到的金币枚数（存档累计，车辆解锁用）
    this.meters = 0;
    this.score = 0;
    this.nearMisses = 0;
    this.lucky = 0;                // 幸运星颗数
    this.shieldMs = 0;
    this.magnetMs = 0;
    this.hitAt = 0;                // 压盖时间戳（ms，用于失控表现）
    this.hitCount = 0;
    this.graceMs = D.RULES.startGraceMs;
    this.nextRowY = -120;          // 下一批井盖从屏幕上方多远处进
    /* 可达车道集合：通关接力用。开局时玩家可以在任意车道上 */
    this.reach = [];
    for (var li = 0; li < this.lanes; li++) { this.reach.push(li); }
    this.spawned = 0;
    this.cleared = 0;              // 已从底部离开屏幕的井盖数
    this.floaters = [];            // 飘字（得分/提示）
    this.lastNearMissObs = null;
  };

  World.prototype.start = function () { this.running = true; return this; };

  /* 当前实际滚动速度（含道具倍率） */
  World.prototype.curSpeed = function () { return this.speed * this.speedMul; };

  /* SECTION: 横向移动
     两种输入方式：① 直接给定目标 x（触控/鼠标拖）② 长按方向键（steer）。
     都夹在路面范围内，车轮永远不会跑到路肩上去。 */
  World.prototype.setCarX = function (x) {
    var D = this.D;
    var half = carWidth(D, this.lanes, this.veh) / 2;
    var lo = roadLeft(D) + half, hi = roadRight(D) - half;
    this.carX = Math.max(lo, Math.min(hi, x));
  };

  /* 按车道移动（键盘左右键：一次一条车道，手感更可控） */
  World.prototype.shiftLane = function (dir) {
    var D = this.D;
    var i = laneOfX(D, this.lanes, this.carX);
    var next = Math.max(0, Math.min(this.lanes - 1, i + dir));
    this.targetLane = next;
    this.carX = laneCenterX(D, this.lanes, next);
    this.tilt = dir * 0.5;
    return next !== i;
  };

  /* SECTION: 更新
     dt 秒。返回本帧发生的事件列表（渲染层据此播放音效/特效；
     逻辑层不发声音、不碰 DOM —— 事件驱动是这两层唯一的耦合方式）。 */
  World.prototype.update = function (dt) {
    var D = this.D, ev = [];
    if (!this.running || this.over || this.won) { return ev; }

    /* 道具计时 */
    if (this.speedMulMs > 0) {
      this.speedMulMs -= dt * 1000;
      if (this.speedMulMs <= 0) { this.speedMulMs = 0; this.speedMul = 1; ev.push({ t: 'slowEnd' }); }
    }
    if (this.shieldMs > 0) { this.shieldMs = Math.max(0, this.shieldMs - dt * 1000); }
    if (this.magnetMs > 0) { this.magnetMs = Math.max(0, this.magnetMs - dt * 1000); }
    if (this.graceMs > 0) { this.graceMs = Math.max(0, this.graceMs - dt * 1000); }

    /* 长按方向盘：连续横向移动（车辆灵活度影响横移速度） */
    if (this.steer) {
      var D2 = D;
      var speed = this.veh.steerSpeed * laneWidth(D2, this.lanes);
      this.setCarX(this.carX + this.steer * speed * dt);
      this.tilt += (this.steer * 0.5 - this.tilt) * Math.min(1, dt * 12);
    } else {
      this.tilt += (0 - this.tilt) * Math.min(1, dt * 10);
    }

    var sp = this.curSpeed();
    /* 路程：滚动像素 → 米。1 米 = 12 设计像素（车长 78px ≈ 5.5 米，比例正常）。
       分数乘车辆倍率：快车/宽车是真实风险，赚分也必须真实。 */
    var px = sp * dt;
    this.distance += px;
    this.meters = this.distance / 12;
    this.score += px / 12 * D.SCORE.perMeter * this.veh.mult;

    /* 世界元素下移。
       **必须先移动、后判定**：判定用的是元素在本帧末的位置，
       这样"车压到井盖"与"车轮已经越过井盖"发生在同一帧时才不会漏判 ——
       否则高速下（一帧位移可达 10px+）会直接穿过井盖而不触发碰撞。
       这也是先移动后生成的原因：新生成的行不应该在同一帧就被判定。 */
    for (var i = this.obs.length - 1; i >= 0; i--) {
      var o = this.obs[i];
      o.y += px;
      if (o.scroll) { o.y += D.WORLD.spawnScroll * dt; }
      if (o.kind === 'nitro') { o.phase = (o.phase || 0) + dt * 8; }
    }

    /* SECTION: 生成
       开局保护期内不刷井盖（startGraceMs），免得一进来就被贴脸。 */
    if (this.graceMs <= 0) {
      this.nextRowY -= px;
      if (this.nextRowY <= -200) {
        this.spawnRow(ev);
        this.nextRowY = rowSpacing(D, this.cfg, this.rng);
      }
    }

    /* SECTION: 判定
       逐元素分类处理：石头/路锥/水洼是"躲开就行"的干扰物，
       井盖是"压到就输"，拾取物是加分。 */
    for (var j = this.obs.length - 1; j >= 0; j--) {
      var t = this.obs[j];
      /* 吸附：磁铁把附近的金币往车上拉 */
      if (this.magnetMs > 0 && t.kind === 'coin') {
        t.x += (this.carX - t.x) * Math.min(1, dt * 6);
      }

      if (t.kind === 'manhole') {
        /* 用扫掠判定而不是单点判定：防止高速/掉帧时"穿过"井盖（见 sweptHit 注释） */
        if (sweptHit(D, this.lanes, this.carX, this.carY, t, px + (t.scroll ? D.WORLD.spawnScroll * dt : 0), this.veh)) {
          if (this.shieldMs > 0) {
            /* 护盾挡下：井盖被撞碎，照样算躲过一个 */
            ev.push({ t: 'shielded', x: t.x, y: t.y });
            this.obs.splice(j, 1);
            this.dodged++;
            continue;
          }
          if (this.lucky > 0) {
            /* 幸运星顶掉一次压盖 */
            this.lucky--;
            ev.push({ t: 'lucky', x: t.x, y: t.y });
            this.obs.splice(j, 1);
            this.dodged++;
            continue;
          }
          if (!t.hit) {
            t.hit = true;
            this.hitCount++;
            this.hitAt = 1;      // 渲染层读它做失控表现，1 = 本帧刚压到
            this.over = true;    // 压到井盖 = 输，没有第二条命
            this.running = false;
            ev.push({ t: 'crash', x: t.x, y: t.y, meter: this.meters });
            return ev;
          }
        }
        /* 擦过去：没压到、但车轮贴着边沿过去的，给奖励分（冒险的回报）。
           只在"井盖与车纵向足够接近"的窗口里评一次；用 |y 差| 判窗口而不是
           `t.y > carY - ...`，这样窗口对车的纵向位置是对称的，不会因为
           井盖已经从车侧面滑过去而反复触发。 */
        if (!t.near && !t.passed && Math.abs(t.y - this.carY) < D.PLAYER.h * 0.75) {
          var gap = nearMissGap(D, this.lanes, this.carX, this.carY, t, this.veh);
          if (gap >= 0 && gap < D.SCORE.nearMissRadius) {
            t.near = true;
            this.nearMisses++;
            var nearGain = D.SCORE.nearMiss * comboMult(this.dodged, D) * this.veh.mult;
            this.score += nearGain;
            ev.push({ t: 'nearMiss', x: t.x, y: t.y, gain: nearGain });
          }
        }
      } else if (t.kind === 'coin' || t.kind === 'star' || t.kind === 'nitro' || t.kind === 'shield') {
        /* 拾取物用**车身**判定（不是车轮）：金币小，高速下同样会被"穿过"，
           所以照样走扫掠版本。 */
        if (sweptBodyHit(D, this.lanes, this.carX, this.carY, t, px + (t.scroll ? D.WORLD.spawnScroll * dt : 0), this.veh)) {
          ev.push(this.applyPickup(t));
          this.obs.splice(j, 1);
          continue;
        }
      } else if (t.kind === 'hazard') {
        /* 路锥/水洼：也是车身接触即算，撞上去只是减速 + 断连击，不致命（致命的是井盖） */
        if (!t.hit && sweptBodyHit(D, this.lanes, this.carX, this.carY, t, px + (t.scroll ? D.WORLD.spawnScroll * dt : 0), this.veh)) {
          t.hit = true;
          this.applySlow(D.RULES.slowMs, D.RULES.slowMult);
          this.dodged = 0;
          ev.push({ t: 'bump', x: t.x, y: t.y });
          this.obs.splice(j, 1);
          continue;
        }
      }

      /* 出屏回收：统计"躲过的井盖"（连击），并释放数组 */
      if (t.y > this.D.LAYOUT.H + 90) {
        if (t.kind === 'manhole') {
          this.dodged++;
          if (this.dodged > this.bestDodged) { this.bestDodged = this.dodged; }
          this.cleared++;
          if (this.dodged % D.SCORE.comboStep === 0) { ev.push({ t: 'combo', mult: comboMult(this.dodged, D) }); }
        }
        this.obs.splice(j, 1);
      }
    }

    /* SECTION: 通关 */
    if (this.meters >= this.cfg.distance) {
      this.won = true;
      this.running = false;
      this.score += D.SCORE.levelBonus * this.level * this.veh.mult;
      ev.push({ t: 'win', meter: this.meters, level: this.level });
    }
    return ev;
  };

  /* SECTION: 生成一行
     一行可以包含：若干井盖（分布在部分车道上）+ 井盖旁的金币 + 偶尔的道具与干扰物。
     硬约束：井盖不能占满全部车道（否则无法通过），金币绝不放在井盖正上方。 */
  World.prototype.spawnRow = function (ev) {
    var D = this.D, rng = this.rng, cfg = this.cfg, lanes = this.lanes;
    var r = manholeRadius(D, lanes);
    var y = this.nextRowY;
    var cols = makeRow(D, cfg, lanes, rng, this.reach);
    var free = [];
    for (var i = 0; i < lanes; i++) { if (cols.indexOf(i) < 0) { free.push(i); } }

    /* 更新可达车道集合：把"这一行之后玩家还能站在哪些车道"往下传，
       下一行生成时会用它继续保证有路（见 makeRow / survives 的注释）。 */
    var nextReach = reachAfter(this.reach, cols, lanes);
    if (nextReach.length) { this.reach = nextReach; }
    else { this.reach = free.length ? free : [0]; }

    for (var k = 0; k < cols.length; k++) {
      this.obs.push({
        kind: 'manhole', x: laneCenterX(D, lanes, cols[k]), y: y, r: r, lane: cols[k]
      });
    }
    this.spawned += cols.length;

    /* 金币：只放在**可达车道**上（否则玩家为了拿金币要走进死路，
       那不是"高风险高回报"而是"骗你去死"）。 */
    var coinPool = [];
    for (var ci = 0; ci < this.reach.length; ci++) {
      if (free.indexOf(this.reach[ci]) >= 0) { coinPool.push(this.reach[ci]); }
    }
    if (!coinPool.length) { coinPool = free; }
    if (coinPool.length && rng() < 0.72) {
      var lane = coinPool[Math.floor(rng() * coinPool.length)];
      var cx = laneCenterX(D, lanes, lane);
      var cnt = 1 + (rng() < 0.45 ? 1 : 0);
      for (var c = 0; c < cnt; c++) {
        this.obs.push({ kind: 'coin', x: cx, y: y - c * 46, r: 15, lane: lane });
      }
    }
    /* 高风险金币：夹在两块井盖中间的窄缝里。
       注意缝里放金币是有讲究的 —— 只有当这条缝**本身是可达车道**时才放，
       否则玩家冲进去就出不来了。 */
    if (cols.length >= 2 && rng() < 0.3) {
      for (var m = 0; m < cols.length - 1; m++) {
        var midLane = cols[m] + 1;
        if (midLane !== cols[m + 1]) { continue; }          // 只有紧邻的两块井盖之间才有缝
        if (this.reach.indexOf(midLane) < 0) { continue; }  // 这条缝必须是可以走的
        this.obs.push({ kind: 'coin', x: laneCenterX(D, lanes, midLane), y: y + 30, r: 15, risky: true });
        break;
      }
    }

    /* 道具：同样只放在可达车道上（捡不到 = 白给） */
    if (coinPool.length && rng() < 0.13) {
      var lane2 = coinPool[Math.floor(rng() * coinPool.length)];
      var kinds = ['star', 'nitro', 'shield'];
      var kind = kinds[Math.floor(rng() * kinds.length)];
      this.obs.push({
        kind: kind, x: laneCenterX(D, lanes, lane2), y: y - 60, r: 17, phase: 0
      });
    }

    /* 干扰物：路锥/水洼。密度高了才出现，单纯增加"看起来挤"的压迫感。
       干扰物不致命，但也不该堵在可达车道上逼玩家硬吃减速 ——
       只放在"可达车道之外的空位"上，当作路边的视觉压力。 */
    var hazPool = [];
    for (var hi = 0; hi < free.length; hi++) {
      if (this.reach.indexOf(free[hi]) < 0) { hazPool.push(free[hi]); }
    }
    if (hazPool.length && cfg.obstaclesPer100m > 5 && rng() < 0.26) {
      var lane3 = hazPool[Math.floor(rng() * hazPool.length)];
      this.obs.push({
        kind: 'hazard', haz: rng() < 0.5 ? 'cone' : 'puddle',
        x: laneCenterX(D, lanes, lane3), y: y + 40, r: 18, lane: lane3
      });
    }
  };

  /* SECTION: 拾取效果 */
  World.prototype.applyPickup = function (t) {
    var D = this.D, ev = { t: 'pickup', kind: t.kind, x: t.x, y: t.y };
    if (t.kind === 'coin') {
      this.coins++;                                  // 真钱：跨局累计，车库解锁用
      ev.gain = pickupScore('coin', this.dodged, D, this.veh);
      this.score += ev.gain;
    } else if (t.kind === 'star') {
      ev.gain = pickupScore('star', this.dodged, D, this.veh);
      this.score += ev.gain;
      this.lucky = Math.min(D.RULES.luckyMax, this.lucky + 1);
      ev.lucky = this.lucky;
    } else if (t.kind === 'nitro') {
      ev.gain = pickupScore('nitro', this.dodged, D, this.veh);
      this.score += ev.gain;
      this.applySpeed(D.RULES.nitroMs, D.RULES.nitroMult);
    } else if (t.kind === 'shield') {
      this.shieldMs = D.RULES.shieldMs;
    }
    return ev;
  };

  World.prototype.applySpeed = function (ms, mult) {
    this.speedMulMs = ms;
    this.speedMul = mult;
  };
  World.prototype.applySlow = function (ms, mult) {
    /* 减速不与加速叠加：谁后触发谁生效（减速会顶掉加速带的冲刺） */
    this.speedMulMs = ms;
    this.speedMul = mult;
  };

  /* 车当前占用的车道（按车轮落点算，可能与车身中心所在车道不同） */
  World.prototype.occupied = function () {
    return occupiedLanes(this.D, this.lanes, this.carX, this.veh);
  };
  /* 车是否已安稳对准某条车道（-1 = 正在两条道之间） */
  World.prototype.aligned = function () {
    return alignedLane(this.D, this.lanes, this.carX, this.veh);
  };
  /* 建议的目标 x：把车对准车道 i 的中心 */
  World.prototype.laneTargetX = function (i) {
    return laneCenterX(this.D, this.lanes, i);
  };

  /* SECTION: 进度 */
  World.prototype.progress = function () {
    return Math.max(0, Math.min(1, this.meters / this.cfg.distance));
  };
  World.prototype.combo = function () {
    return comboMult(this.dodged, this.D);
  };
  /* 剩余"本关允许压盖次数"（本作是 1 条命，压一次就结束，但保留接口方便调参） */
  World.prototype.livesLeft = function () {
    return Math.max(0, this.D.RULES.lives - this.hitCount);
  };

  /* SECTION: 存档键名与统计（供门户回显） */
  function statsOf(world) {
    return {
      level: world.level, meters: Math.round(world.meters),
      distance: world.cfg.distance, score: Math.round(world.score),
      dodged: world.dodged, bestDodged: world.bestDodged,
      nearMisses: world.nearMisses, lucky: world.lucky,
      coins: world.coins,
      vehicle: world.veh ? world.veh.id : 'sedan',
      vehName: world.veh ? world.veh.name : '小轿车',
      vehMult: world.veh ? world.veh.mult : 1,
      shieldMs: Math.round(world.shieldMs), over: world.over, won: world.won,
      progress: world.progress(), combo: world.combo(),
      carX: world.carX, lanes: world.lanes, speed: world.curSpeed(),
      obs: world.obs.length
    };
  }

  return {
    World: World,
    /* 车辆 */
    playerParams: playerParams,
    /* 空间 */
    roadLeft: roadLeft, roadRight: roadRight, laneWidth: laneWidth,
    laneCenterX: laneCenterX, laneOfX: laneOfX, carWidth: carWidth,
    laneBounds: laneBounds, occupiedLanes: occupiedLanes, alignedLane: alignedLane,
    wheels: wheels, underBody: underBody, manholeRadius: manholeRadius,
    /* 判定 */
    circlesOverlap: circlesOverlap, carHits: carHits, nearMissGap: nearMissGap,
    sweptHit: sweptHit, carBodyHits: carBodyHits, sweptBodyHit: sweptBodyHit,
    /* 计分 */
    comboMult: comboMult, pickupScore: pickupScore, levelScore: levelScore,
    /* 生成 */
    makeRow: makeRow, rowSpacing: rowSpacing, shuffle: shuffle,
    freeLanes: freeLanes, survives: survives, reachAfter: reachAfter,
    REACH_ROWS: REACH_ROWS,
    statsOf: statsOf
  };
})();
