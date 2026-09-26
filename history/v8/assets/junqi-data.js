/* ============================================================
   烽火军棋 · 数据与调参表
   SECTION: junqi-data
   ------------------------------------------------------------
   只放「棋盘几何 / 棋子与吃子表 / 关卡曲线 / 配色 / 音效」，
   不含任何玩法逻辑与 DOM：改手感改这张表，规则在 junqi-core.js，渲染在 junqi.js。

   一句话玩法：红方（玩家）对战蓝方（电脑自动），两人轮流走子，
   大子吃小子、同级同归于尽、炸弹与任何子同归于尽、地雷只认工兵，
   **扛走对方军旗就算赢**。暗棋模式下对方的子看不见军衔，只能靠战报推。

   SECTION: 棋盘口径（本作自定的一套，与实体军棋盘的通行画法一致）
     · 全盘 5 列 × 12 行 = 60 个交叉点，每方半场 30 点：
       25 个兵站（可放子） + 5 个行营（不可放子、 Inside 不可被吃）
     · 每方后两行的 5 个点里，(0,1) (0,3) 是大本营，**只有一个入口**
     · 行营按骰子五点（X 形）排在半场中部：(2,1)(2,3)(3,2)(4,1)(4,3)
     · 铁路：环着行营区的一圈粗线（本方第 1 行、第 5 行、左右两列），
       两军对垒的第 5 行经中线相连 —— 所以铁路能直接冲到对面去
     · 行营与周围兵站之间还有斜线（只有行营参与的斜线，兵站之间没有）
     局部坐标 local(0=最己方底线 … 5=最前线)，蓝方在上（r=i），红方在下（r=11-i）。
   ============================================================ */
window.JUNQI_DATA = (function () {
  'use strict';

  var ROWS = 12, COLS = 5;
  var UNIT = 100;                    // 相邻两点的图上距离（viewBox 单位）

  /* SECTION: pieces
     rank 是"比大小"的等级；bomb/mine/flag 走特例，不参与比较。
     val 是 AI 估子力用的相对价值（军旗给 1000 等于"不能丢"）。 */
  var PIECES = [
    { k: 'siLing', name: '司令', rank: 9, n: 1, val: 100 },
    { k: 'junZhang', name: '军长', rank: 8, n: 1, val: 82 },
    { k: 'shiZhang', name: '师长', rank: 7, n: 2, val: 62 },
    { k: 'lvZhang', name: '旅长', rank: 6, n: 2, val: 50 },
    { k: 'tuanZhang', name: '团长', rank: 5, n: 2, val: 41 },
    { k: 'yingZhang', name: '营长', rank: 4, n: 2, val: 32 },
    { k: 'lianZhang', name: '连长', rank: 3, n: 3, val: 24 },
    { k: 'paiZhang', name: '排长', rank: 2, n: 3, val: 18 },
    { k: 'gongBing', name: '工兵', rank: 1, n: 3, val: 21 },
    { k: 'zhaDan', name: '炸弹', rank: 0, n: 2, val: 36, bomb: true },
    { k: 'diLei', name: '地雷', rank: -1, n: 3, val: 15, mine: true, immobile: true },
    { k: 'junQi', name: '军旗', rank: -2, n: 1, val: 1000, flag: true, immobile: true }
  ];

  var BY_KIND = {};
  PIECES.forEach(function (p, i) { p.idx = i; BY_KIND[p.k] = p; });
  var KIND_N = PIECES.length;                        // 12 种
  var MASK_ALL = (1 << KIND_N) - 1;
  var MASK_MOVABLE = PIECES.reduce(function (m, p) { return m | (p.immobile ? 0 : (1 << p.idx)); }, 0);
  var MASK_MINE = 1 << BY_KIND.diLei.idx;
  var MASK_FLAG = 1 << BY_KIND.junQi.idx;
  var MASK_BOMB = 1 << BY_KIND.zhaDan.idx;
  var MASK_ENGINEER = 1 << BY_KIND.gongBing.idx;

  /* SECTION: placement
     布阵约束（local 行号）：军旗必须落在大本营；地雷只能在后三行；
     炸弹不进大本营行；行营不能放子。每方正好 25 子填满 25 个兵站。 */
  var DEPLOY = {
    mineRows: [0, 1, 2],       // 地雷允许的行
    bombMinRow: 1,             // 炸弹从第 1 行往后放（大本营行不放炸弹）
    flagRows: [0],             // 军旗只在大本营行
    total: 25
  };

  /* SECTION: board geometry */
  var LOCAL_CAMP = [[2, 1], [2, 3], [3, 2], [4, 1], [4, 3]];
  var LOCAL_HQ = [[0, 1], [0, 3]];
  var campSet = {}, hqSet = {};
  LOCAL_CAMP.forEach(function (p) { campSet[p[0] + ':' + p[1]] = 1; });
  LOCAL_HQ.forEach(function (p) { hqSet[p[0] + ':' + p[1]] = 1; });

  function localRow(side, r) { return side === 1 ? r : (ROWS - 1) - r; }
  function rowOf(side, i) { return side === 1 ? i : (ROWS - 1) - i; }
  function isRailLocal(i, c) {
    return i === 1 || i === 5 || ((i === 2 || i === 3 || i === 4) && (c === 0 || c === 4));
  }

  /* nodes[id] = { id, r, c, side, local, kind, rail, x, y, hqEntry } */
  var nodes = [];
  for (var side = 0; side < 2; side++) {
    for (var i = 0; i < 6; i++) {
      for (var c = 0; c < COLS; c++) {
        var r = rowOf(side, i), key = i + ':' + c;
        var kind = hqSet[key] ? 'hq' : (campSet[key] ? 'camp' : 'station');
        nodes.push({
          id: r * COLS + c, r: r, c: c, side: side, local: i, kind: kind,
          rail: kind === 'station' && isRailLocal(i, c),
          x: c * UNIT, y: r * UNIT,
          /* 大本营唯一的入口点（供"守门"判定与 AI 护旗用） */
          hqEntry: hqSet[key] ? rowOf(side, 1) * COLS + c : -1,
          /* 大本营编号（军旗只能放这儿） */
          isHq: !!hqSet[key]
        });
      }
    }
  }
  nodes.sort(function (a, b) { return a.id - b.id; });

  var BY_ID = {};
  nodes.forEach(function (n) { BY_ID[n.id] = n; });
  var BY_RC = {};
  nodes.forEach(function (n) { BY_RC[n.r + ',' + n.c] = n; });

  function at(r, c) { return BY_RC[r + ',' + c] || null; }

  /* SECTION: edges
     正交四邻都连；斜线只在"至少一端是行营"时存在（画成行营的辐射线）；
     大本营只留一个入口，另外三个方向全部断开。
     先去重建边表（同一对点只记一次），再由边表推双向邻接 ——
     双向邻接如果靠"两端各自 link"来建，正交边会被记两遍。 */
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var edges = [];
  var seen = {};
  function addEdge(a, b, kind) {
    var key = Math.min(a.id, b.id) + '-' + Math.max(a.id, b.id);
    if (seen[key]) { return; }
    seen[key] = 1;
    edges.push({ a: Math.min(a.id, b.id), b: Math.max(a.id, b.id), kind: kind });
  }
  function edgeKind(a, b) { return (a.rail && b.rail) ? 'rail' : 'road'; }

  nodes.forEach(function (a) {
    ORTH.forEach(function (d) {
      var b = at(a.r + d[0], a.c + d[1]);
      if (!b) { return; }
      if (a.kind === 'hq' || b.kind === 'hq') {
        /* 大本营只有一个入口：正对自己半场内侧的那一条 */
        var hq = a.kind === 'hq' ? a : b;
        var other = a.kind === 'hq' ? b : a;
        var inward = hq.side === 1 ? 1 : -1;      // 蓝方入口在下方，红方入口在上方
        if (other.r - hq.r === inward && other.c === hq.c) { addEdge(hq, other, edgeKind(hq, other)); }
        return;
      }
      addEdge(a, b, edgeKind(a, b));
    });
    if (a.kind === 'camp') {
      DIAG.forEach(function (d) {
        var b = at(a.r + d[0], a.c + d[1]);
        if (b && b.kind !== 'hq') { addEdge(a, b, 'road'); }
      });
    }
  });

  var adj2 = {};
  nodes.forEach(function (n) { adj2[n.id] = []; });
  edges.forEach(function (e) {
    var A = BY_ID[e.a], B = BY_ID[e.b];
    adj2[A.id].push({ to: B.id, kind: e.kind, dr: Math.sign(B.r - A.r), dc: Math.sign(B.c - A.c) });
    adj2[B.id].push({ to: A.id, kind: e.kind, dr: Math.sign(A.r - B.r), dc: Math.sign(A.c - B.c) });
  });

  /* SECTION: railStep
     铁路滑行要按"方向"一路走到底，所以给每个铁路点建一张方向表。 */
  var railStep = {};
  nodes.forEach(function (n) {
    railStep[n.id] = n.rail
      ? adj2[n.id].filter(function (e) { return e.kind === 'rail'; })
      : [];
  });

  /* SECTION: advOf
     某一方站在某个点上"压过去多少行"（0 = 自己底线，11 = 对方底线）。
     斜线/中线都算进去，AI 用它鼓励往前压、也用来判断谁在威胁大本营。 */
  function advOf(side, nodeId) {
    var r = BY_ID[nodeId].r;
    return side === 0 ? (ROWS - 1) - r : r;
  }

  /* SECTION: rules constants（判负节奏）
     长时间不吃子就按子力 adjudicate，避免和棋局无限拖。 */
  var RULES = {
    QUIET_LIMIT: 64,        // 连续 64 手（双方合计）无伤亡 → 判子力
    PLY_LIMIT: 300,         // 硬上限
    PIECES_PER_SIDE: DEPLOY.total,
    AI_THINK_MIN: 260,
    AI_THINK_MAX: 620
  };

  /* SECTION: levels
     9 关按军衔晋级。AI 强度三档参数：
       reply  对手反击的忌惮系数（0 = 只顾吃子，1 = 完全避兑）
       noise  选着随机扰动（越大越糙）
       refine 精算前多少件候选（越大越细）
       guard  护旗意识（把入口让开要不要罚）
       layout 蓝方布阵的护旗强度（0 散放 → 1 严加密）
       think  思考演出时长 ms */
  var LEVELS = [
    { no: 1, name: '新兵', en: 'RECRUIT', reply: 0.15, noise: 42, refine: 5, guard: 0, layout: 0.10, think: 620 },
    { no: 2, name: '排长', en: 'Lance Cpl', reply: 0.30, noise: 32, refine: 8, guard: 0.2, layout: 0.22, think: 560 },
    { no: 3, name: '连长', en: 'Cpl', reply: 0.45, noise: 24, refine: 10, guard: 0.4, layout: 0.34, think: 500 },
    { no: 4, name: '营长', en: 'Sgt', reply: 0.60, noise: 17, refine: 13, guard: 0.6, layout: 0.46, think: 450 },
    { no: 5, name: '团长', en: 'Lt Col', reply: 0.72, noise: 12, refine: 16, guard: 0.75, layout: 0.58, think: 410 },
    { no: 6, name: '旅长', en: 'Col', reply: 0.84, noise: 8, refine: 20, guard: 0.85, layout: 0.70, think: 370 },
    { no: 7, name: '师长', en: 'Maj Gen', reply: 0.94, noise: 5, refine: 26, guard: 0.95, layout: 0.82, think: 330 },
    { no: 8, name: '军长', en: 'Gen', reply: 1.05, noise: 3, refine: 32, guard: 1, layout: 0.90, think: 300 },
    { no: 9, name: '司令', en: 'Cdr', reply: 1.18, noise: 1.5, refine: 40, guard: 1, layout: 1, think: 270 }
  ];

  /* SECTION: score
     赢一局的分：基础 × 难度倍率，再叠子力、速胜、暗棋加成；
     输了也有"换子分"，不至于一局白打。 */
  var SCORE = {
    base: 700,
    levelMult: [1, 1.22, 1.45, 1.7, 2, 2.35, 2.75, 3.2, 3.8],
    hiddenMult: 1.35,
    materialDiv: 9,          // 剩余子力 / 9 计入得分
    speedBonus: 6,           // 每比 100 手少一手加的分
    speedPlies: 100,
    loseRatio: 0.22,         // 输棋时按打掉对方的子力给分
    drawRatio: 0.5
  };

  /* SECTION: theme */
  var SIDE = [
    { id: 0, name: '红方', en: 'RED', ink: '#ffe9e6', face: '#c8322c', face2: '#7d1410', edge: '#ff8b78', glow: 'rgba(255,90,80,.45)' },
    { id: 1, name: '蓝方', en: 'BLUE', ink: '#e6f1ff', face: '#20509c', face2: '#0d2a5c', edge: '#7db4ff', glow: 'rgba(90,150,255,.45)' }
  ];

  var TEXT = {
    win: '军旗插上高地',
    lose: '军旗被扛',
    draw: '战线僵持',
    stalemate: '困毙无子可动',
    flag: '扛旗破阵',
    adjudicate: '按子力判定'
  };

  /* SECTION: Audio · Web Audio 现场合成，无外部资源
     军棋是回合制，音效只服务"落子有没有到位"：
     选子/落子/吃子/同归于尽/挖雷/扛旗/晋级/失旗。 */
  var Audio = (function () {
    var ctx = null, enabled = true;

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
    function tone(freq, dur, type, gain, when, slide) {
      var c = ac();
      if (!c || !enabled) { return; }
      var t0 = c.currentTime + (when || 0);
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slide) { o.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t0 + dur); }
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.16, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    function noise(dur, gain, when, cutoff) {
      var c = ac();
      if (!c || !enabled) { return; }
      var t0 = c.currentTime + (when || 0);
      var len = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) { d[i] = (Math.random() * 2 - 1) * (1 - i / len); }
      var src = c.createBufferSource(); src.buffer = buf;
      var f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 1600;
      var g = c.createGain(); g.gain.value = gain || 0.2;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(t0);
    }

    return {
      get enabled() { return enabled; },
      set enabled(v) { enabled = !!v; },
      resume: resume,
      select: function () { tone(660, 0.06, 'square', 0.07); },
      unselect: function () { tone(430, 0.05, 'square', 0.05); },
      step: function () { noise(0.05, 0.10, 0, 900); tone(240, 0.07, 'triangle', 0.09); },
      win: function () { tone(520, 0.10, 'square', 0.13); tone(780, 0.16, 'square', 0.11, 0.08); },
      eat: function () { noise(0.16, 0.26, 0, 2400); tone(150, 0.14, 'sawtooth', 0.13); },
      loseFight: function () { noise(0.14, 0.22, 0, 1300); tone(220, 0.2, 'sawtooth', 0.1, 0, 90); },
      trade: function () { noise(0.34, 0.34, 0, 3200); tone(90, 0.34, 'square', 0.16, 0, 46); },
      dig: function () { tone(1250, 0.05, 'sine', 0.1); noise(0.10, 0.16, 0.02, 5200); },
      flag: function () { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, 0.24, 'square', 0.14, i * 0.1); }); },
      defeat: function () { [392, 330, 262, 196].forEach(function (f, i) { tone(f, 0.32, 'sawtooth', 0.14, i * 0.13); }); },
      levelUp: function () { [659, 784, 988].forEach(function (f, i) { tone(f, 0.2, 'triangle', 0.14, i * 0.09); }); },
      blocked: function () { tone(140, 0.1, 'square', 0.08); }
    };
  })();

  return {
    ROWS: ROWS, COLS: COLS, UNIT: UNIT,
    PIECES: PIECES, BY_KIND: BY_KIND, KIND_N: KIND_N,
    MASK_ALL: MASK_ALL, MASK_MOVABLE: MASK_MOVABLE,
    MASK_MINE: MASK_MINE, MASK_FLAG: MASK_FLAG, MASK_BOMB: MASK_BOMB, MASK_ENGINEER: MASK_ENGINEER,
    DEPLOY: DEPLOY, RULES: RULES, LEVELS: LEVELS, SCORE: SCORE, SIDE: SIDE, TEXT: TEXT,
    NODES: nodes, N: nodes.length,
    EDGES: edges, ADJ: adj2, RAIL_STEP: railStep,
    at: at, localRow: localRow, rowOf: rowOf, advOf: advOf,
    CAMPS: nodes.filter(function (n) { return n.kind === 'camp'; }).map(function (n) { return n.id; }),
    HQS: nodes.filter(function (n) { return n.kind === 'hq'; }).map(function (n) { return n.id; }),
    STATIONS: nodes.filter(function (n) { return n.kind !== 'camp'; }).map(function (n) { return n.id; }),
    AUDIO: Audio
  };
})();
