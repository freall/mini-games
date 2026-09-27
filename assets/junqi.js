/* ============================================================
   烽火军棋 · 渲染与交互主控
   SECTION: junqi-main
   ------------------------------------------------------------
   分层：junqi-data.js（棋盘几何 + 棋子表 + 音效）
         junqi-core.js（纯逻辑：走子/吃子/推演/AI，无 DOM）
         本文件（SVG 棋盘 + 输入 + 战报 + 覆盖层 + 存档）
   本文件不做任何规则判定 —— 所有合法性与 AI 都问 core，画出来的就是判出来的。

   SECTION: 为什么棋盘用 SVG 而不是 Canvas / DOM 绝对定位
     军棋盘的形状是"点 + 连线"，斜线（行营辐射）与铁路双线用 SVG 一次画完，
     缩放靠 viewBox 白送；命中测试用一层透明圆片（jq-hit）统一处理，
     不需要量像素、不需要 resize 换算 —— 也就绕开了 README 里那个
     "高度由内容决定 → 覆盖层被裁掉"的老坑（覆盖层这里直接 position:fixed）。
   ============================================================ */
window.JUNQI_APP = (function () {
  'use strict';

  var D = window.JUNQI_DATA;
  var C = window.JUNQI_CORE;
  var SVGNS = 'http://www.w3.org/2000/svg';
  /* 一方开局总子力（用来把"打掉对方多少"折算成战果数字） */
  var SIDE_TOTAL = D.PIECES.reduce(function (v, p) { return v + p.val * p.n; }, 0);

  /* SECTION: state */
  var el = {};
  var st = null;                 // core 的对局状态
  var active = false, mounted = false;
  var phase = 'start';           // start | deploy | play | over
  var sel = null;                // 选中的棋子 id
  var marks = [];                // 选中后的合法落点
  var pieceEls = {};             // pid -> <g>
  var nodeEls = {};              // nodeId -> 透明命中圆
  var hqEls = {};                // nodeId -> 大本营方框（告急时闪红）
  var markLayer = null, pieceLayer = null, fxLayer = null, svgEl = null;
  var logRows = 0;
  var aiBusy = false, aiTimer = null;
  var lastScore = 0;
  var soundOn = true;

  /* 存档（与本项目其他游戏一致的 key 风格） */
  var K_BEST = 'junqi-best', K_WINS = 'junqi-wins', K_STREAK = 'junqi-streak',
      K_LEVEL = 'junqi-level', K_MODE = 'junqi-mode', K_SOUND = 'junqi-sound';
  var best = 0, wins = 0, streak = 0, unlocked = 1;
  var level = 1, hidden = true;

  function readStore(key, def) {
    try {
      var v = parseInt(window.localStorage.getItem(key) || '', 10);
      return isNaN(v) ? def : v;
    } catch (e) { return def; }
  }
  function writeStore(key, val) {
    try { window.localStorage.setItem(key, String(val)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function loadStore() {
    best = readStore(K_BEST, 0);
    wins = readStore(K_WINS, 0);
    streak = readStore(K_STREAK, 0);
    unlocked = Math.max(1, Math.min(D.LEVELS.length, readStore(K_LEVEL, 1)));
    /* 模式：1 = 明棋，0 = 暗棋（默认暗棋，军棋的味道就在这儿） */
    hidden = readStore(K_MODE, 0) === 0;
    soundOn = readStore(K_SOUND, 1) === 1;
    level = Math.min(level, unlocked);
    /* SECTION: 深链
       ?level=3&mode=open|dark 的优先级高于存档 —— 门户/书签进来就该停在那儿。
       放在 loadStore 里而不是 mount 里：activate 每次回本视图都会读存档，
       放在外面会被覆盖回去（第一版就踩过：深链进明棋，出来一看还是暗棋）。 */
    try {
      var q = (window.location.search || '').match(/[?&]level=([1-9])/);
      if (q) { level = Math.min(Math.max(1, parseInt(q[1], 10)), unlocked); }
      var m = (window.location.search || '').match(/[?&]mode=(open|dark)/);
      if (m) { hidden = m[1] === 'dark'; }
    } catch (e) { /* 忽略 */ }
  }

  function $(id) { return document.getElementById(id); }
  function txt(id, s) { var n = $(id); if (n && n.textContent !== s) { n.textContent = s; } }
  function show(node, on) { if (node) { node.classList.toggle('show', !!on); } }

  /* SECTION: svg helpers */
  function mk(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) { n.setAttribute(k, attrs[k]); } }
    return n;
  }
  function radialGrad(id, c1, c2) {
    var g = mk('radialGradient', { id: id, cx: '36%', cy: '28%', r: '82%' });
    g.appendChild(mk('stop', { offset: '0%', 'stop-color': c1 }));
    g.appendChild(mk('stop', { offset: '62%', 'stop-color': c2 }));
    g.appendChild(mk('stop', { offset: '100%', 'stop-color': c2, 'stop-opacity': '.85' }));
    return g;
  }

  /* SECTION: buildBoard · 一次性把 defs、线、点、特效层、命中层建好，之后只更新棋子 */
  function buildBoard() {
    var host = el.jqBoard;
    if (!host) { return; }
    host.innerHTML = '';
    pieceEls = {};
    var pad = 44;
    var W = (D.COLS - 1) * D.UNIT + pad * 2, H = (D.ROWS - 1) * D.UNIT + pad * 2;
    var svg = mk('svg', {
      viewBox: (-pad) + ' ' + (-pad) + ' ' + W + ' ' + H,
      class: 'jq-svg', role: 'img',
      'aria-label': '军棋棋盘：红方在下、蓝方在上，粗线是铁路，椭圆是行营，方框是大本营'
    });
    svgEl = svg;

    /* defs：三色渐变将章（红/蓝/背面）+ 投影 + 沙盘网点纹理 */
    var defs = mk('defs', {});
    defs.appendChild(radialGrad('jqGradRed', '#e2685a', '#8b1a13'));
    defs.appendChild(radialGrad('jqGradBlue', '#4f8fe0', '#0f3168'));
    /* 背面（暗棋里看不见的敌子）要明显比空兵站亮，否则一眼看去像"没子" */
    defs.appendChild(radialGrad('jqGradBack', '#68779c', '#28324c'));
    var sh = mk('filter', { id: 'jqSh', x: '-45%', y: '-45%', width: '190%', height: '190%' });
    sh.appendChild(mk('feDropShadow', { dx: 0, dy: 2.6, stdDeviation: 2.4, 'flood-color': '#000', 'flood-opacity': '.62' }));
    defs.appendChild(sh);
    var pat = mk('pattern', { id: 'jqGrid', width: 22, height: 22, patternUnits: 'userSpaceOnUse' });
    pat.appendChild(mk('circle', { cx: 1.4, cy: 1.4, r: 1, fill: 'rgba(150,190,255,.075)' }));
    defs.appendChild(pat);
    svg.appendChild(defs);
    svg.appendChild(mk('rect', {
      x: -pad + 6, y: -pad + 6, width: W - 12, height: H - 12, rx: 14, fill: 'url(#jqGrid)'
    }));

    /* 沙盘外框 + 四角刻度（阵地题名改放 HTML：画在 viewBox 里会压住第一排棋子） */
    var gFrame = mk('g', { class: 'jq-frame' });
    gFrame.appendChild(mk('rect', {
      x: -pad + 6, y: -pad + 6, width: W - 12, height: H - 12, rx: 14
    }));
    [[-pad + 6, -pad + 6, 1, 1], [W - pad - 6, -pad + 6, -1, 1],
     [-pad + 6, H - pad - 6, 1, -1], [W - pad - 6, H - pad - 6, -1, -1]].forEach(function (c) {
      gFrame.appendChild(mk('path', { d: 'M' + (c[0] + 26 * c[2]) + ' ' + c[1] + ' L' + c[0] + ' ' + c[1] + ' L' + c[0] + ' ' + (c[1] + 26 * c[3]) }));
    });
    svg.appendChild(gFrame);

    var gLine = mk('g', { class: 'jq-lines' });
    D.EDGES.forEach(function (e) {
      var a = D.NODES[e.a], b = D.NODES[e.b];
      var common = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      if (e.kind === 'rail') {
        /* 三层叠出钢轨感：粗底 → 枕木（短横虚线）→ 轨面高光 */
        gLine.appendChild(mk('line', Object.assign({}, common, { class: 'jq-rail' })));
        gLine.appendChild(mk('line', Object.assign({}, common, { class: 'jq-tie' })));
        gLine.appendChild(mk('line', Object.assign({}, common, { class: 'jq-rail-hi' })));
      } else {
        gLine.appendChild(mk('line', Object.assign({}, common, { class: 'jq-road' })));
      }
    });
    svg.appendChild(gLine);

    var gNode = mk('g', { class: 'jq-nodes' });
    hqEls = {};
    D.NODES.forEach(function (n) {
      var shape;
      if (n.kind === 'camp') {
        shape = mk('ellipse', { cx: n.x, cy: n.y, rx: 30, ry: 24, class: 'jq-camp' });
      } else if (n.kind === 'hq') {
        shape = mk('rect', { x: n.x - 31, y: n.y - 28, width: 62, height: 56, rx: 10, class: 'jq-hq' });
        hqEls[n.id] = shape;
      } else {
        shape = mk('circle', { cx: n.x, cy: n.y, r: 20, class: 'jq-station' });
      }
      gNode.appendChild(shape);
      if (n.kind !== 'station') {
        var lab = mk('text', {
          x: n.x, y: n.y + (n.kind === 'camp' ? 4 : 5), class: 'jq-nlabel',
          'text-anchor': 'middle'
        });
        lab.textContent = n.kind === 'camp' ? '行营' : '大本营';
        gNode.appendChild(lab);
      }
    });
    svg.appendChild(gNode);

    /* 中线：两军对垒的那条缝，画成会流动的火线 */
    var mid = (D.ROWS / 2 - 0.5) * D.UNIT;
    svg.appendChild(mk('line', {
      x1: -pad + 8, y1: mid, x2: (D.COLS - 1) * D.UNIT + pad - 8, y2: mid, class: 'jq-front'
    }));

    markLayer = mk('g', { class: 'jq-marks' });
    svg.appendChild(markLayer);
    pieceLayer = mk('g', { class: 'jq-pieces' });
    svg.appendChild(pieceLayer);
    fxLayer = mk('g', { class: 'jq-fx' });
    svg.appendChild(fxLayer);

    /* 命中层在最上面：一个透明圆片负责该点的所有点击 */
    var gHit = mk('g', { class: 'jq-hits' });
    nodeEls = {};
    D.NODES.forEach(function (n) {
      var h = mk('circle', { cx: n.x, cy: n.y, r: 36, class: 'jq-hit', 'data-node': n.id });
      h.appendChild(mk('title', {})).textContent = C.posLabel(n.id);
      gHit.appendChild(h);
      nodeEls[n.id] = h;
    });
    svg.appendChild(gHit);

    host.appendChild(svg);
    svg.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-node]') : null;
      if (!t) { return; }
      onPick(parseInt(t.getAttribute('data-node'), 10));
    });
  }

  /* SECTION: 特效
     打击感全靠"挂类名 + 到点自清理"，不做逐帧计算；
     任何特效元素都带 pointer-events:none（.jq-fx 上），不会挡住点击。 */
  function fx(nodeId, cls, text, extra) {
    if (!fxLayer) { return null; }
    var n = D.NODES[nodeId];
    var e = mk(cls.indexOf('float') >= 0 ? 'text' : cls.indexOf('trail') >= 0 && cls.indexOf('dot') < 0 ? 'path' : 'circle',
      Object.assign({ class: cls, x: n.x, y: n.y, cx: n.x, cy: n.y }, extra || {}));
    if (text != null) { e.textContent = text; }
    fxLayer.appendChild(e);
    var life = cls.indexOf('float') >= 0 ? 1200 : (cls.indexOf('trail') >= 0 ? 1650 : 620);
    setTimeout(function () {
      if (e.parentNode) { e.parentNode.removeChild(e); }
    }, life);
    return e;
  }
  function fxBurst(nodeId, kind) {
    fx(nodeId, 'jq-burst ' + (kind || 'win'), null, { r: 16 });
    fx(nodeId, 'jq-shock', null, { r: 10 });
  }
  function fxFloat(nodeId, text, kind) {
    var e = fx(nodeId, 'jq-float ' + (kind || 'good'), text);
    e.setAttribute('text-anchor', 'middle');
    return e;
  }
  function fxTrail(from, to) {
    var a = D.NODES[from], b = D.NODES[to];
    fx(from, 'jq-trail', null, { d: 'M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y });
    fx(from, 'jq-trail-dot', null, { r: 15 });
  }
  function shake() {
    if (!svgEl) { return; }
    svgEl.classList.remove('shake');
    /* 强制重排一次，让连续两次撞车都能重新播放动画 */
    void svgEl.getBoundingClientRect();
    svgEl.classList.add('shake');
    setTimeout(function () { if (svgEl) { svgEl.classList.remove('shake'); } }, 280);
  }

  /* SECTION: pieces */
  function pieceEl(pid) {
    var g = pieceEls[pid];
    if (g) { return g; }
    g = mk('g', { class: 'jq-p jq-born' });
    g.setAttribute('filter', 'url(#jqSh)');
    g.appendChild(mk('circle', { class: 'jq-disc', r: 31 }));
    g.appendChild(mk('circle', { class: 'jq-inner', r: 25 }));
    g.appendChild(mk('circle', { class: 'jq-ring', r: 35 }));
    var t = mk('text', { class: 'jq-nm', 'text-anchor': 'middle', y: 7 });
    g.appendChild(t);
    pieceLayer.appendChild(g);
    pieceEls[pid] = g;
    setTimeout(function () { g.classList.remove('jq-born'); }, 380);
    return g;
  }

  function syncPieces() {
    if (!st) { return; }
    var alive = {};
    Object.keys(st.pieces).forEach(function (pid) {
      var p = st.pieces[pid];
      if (!p.alive) { return; }
      alive[pid] = 1;
      var n = D.NODES[p.node], g = pieceEl(pid);
      var known = C.isKnown(st, pid, 0);
      g.setAttribute('class', 'jq-p jq-s' + p.owner + (known ? '' : ' jq-face-down') + (sel === pid ? ' jq-sel' : ''));
      /* 将章面色：暗棋里看不见的敌子用"背面"渐变，翻开后恢复阵营色 */
      var fill = !known ? 'url(#jqGradBack)' : (p.owner === 0 ? 'url(#jqGradRed)' : 'url(#jqGradBlue)');
      var disc = g.querySelector('.jq-disc');
      if (disc.getAttribute('fill') !== fill) { disc.setAttribute('fill', fill); }
      g.style.transform = 'translate(' + n.x + 'px,' + n.y + 'px)';
      /* ✦ 太小、？太像占位符 —— 背面用实心五角星当"军徽"，一眼是"有子但看不清" */
      var label = known ? D.BY_KIND[p.k].name : '★';
      var t = g.querySelector('.jq-nm');
      if (t.textContent !== label) { t.textContent = label; }
      if (g.getAttribute('data-node') !== String(p.node)) { g.setAttribute('data-node', p.node); }
    });
    Object.keys(pieceEls).forEach(function (pid) {
      if (alive[pid]) { return; }
      var g = pieceEls[pid];
      delete pieceEls[pid];
      /* 阵亡不直接消失：先翻面示众（暗棋里"原来它是军长"）再淡出，
         换类名 jq-ghost 是为了不被 .jq-p 的计数（测试/兵力统计）算进去 */
      g.setAttribute('class', 'jq-ghost jq-s' + (st.pieces[pid] ? st.pieces[pid].owner : 0));
      setTimeout(function () {
        if (g.parentNode) { g.parentNode.removeChild(g); }
      }, 620);
    });
  }

  function drawMarks() {
    if (!markLayer) { return; }
    while (markLayer.firstChild) { markLayer.removeChild(markLayer.firstChild); }
    if (!sel) { return; }
    marks.forEach(function (m) {
      var n = D.NODES[m.to];
      if (m.capture) {
        markLayer.appendChild(mk('circle', { cx: n.x, cy: n.y, r: 31, class: 'jq-mark-atk' }));
      } else {
        markLayer.appendChild(mk('circle', { cx: n.x, cy: n.y, r: n.kind === 'station' ? 11 : 15, class: 'jq-mark-dot' }));
      }
    });
  }

  /* SECTION: 提示条（选中我方的子说兵符；点对方的子说嫌疑 —— 暗棋的核心乐趣） */
  function hint(msg) { if (el.jqHint) { el.jqHint.textContent = msg; } }

  function describeSel() {
    if (!sel) { return; }
    var p = st.pieces[sel];
    var reach = marks.length;
    hint('⚔ ' + D.BY_KIND[p.k].name + ' · ' + C.posLabel(p.node) + ' —— 可走 ' + reach + ' 处'
      + (reach ? '（绿点进军 / 红环吃子）' : '：它动不了'));
  }

  function showSuspects(pid) {
    var p = st.pieces[pid];
    if (!st.hidden || p.owner === 0) {
      hint('🔍 ' + D.SIDE[p.owner].name + ' ' + D.BY_KIND[p.k].name + ' · ' + C.posLabel(p.node));
      return;
    }
    var list = C.suspects(st, pid, 0);
    var txt2 = list.map(function (x) {
      return D.BY_KIND[x.k].name + ' ' + Math.round(x.p * 100) + '%';
    }).join(' · ');
    hint('🔍 蓝方 ' + C.posLabel(p.node) + ' 未翻开 —— 嫌疑：' + (txt2 || '推不出来'));
  }

  /* SECTION: 战报 */
  function pushLog(evt) {
    var box = el.jqLog;
    if (!box) { return; }
    var empty = box.querySelector('.jq-empty');
    if (empty) { box.removeChild(empty); }
    var d = C.describe(st, evt, 0);
    var row = document.createElement('div');
    row.className = 'jq-row k' + d.kind + (evt.side === 0 ? ' me' : ' foe');
    var no = document.createElement('i');
    no.textContent = String(evt.no);
    var sp = document.createElement('span');
    sp.textContent = d.head + d.tail;
    row.appendChild(no); row.appendChild(sp);
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 40) { box.removeChild(box.lastChild); }
    logRows = box.children.length;
  }
  function resetLog() {
    if (!el.jqLog) { return; }
    el.jqLog.innerHTML = '';
    var e = document.createElement('div');
    e.className = 'jq-empty';
    e.textContent = '尚无战事 —— 阵亡者会在这里翻开身份，'
      + '暗棋的推演就靠这份清单。';
    el.jqLog.appendChild(e);
    logRows = 0;
  }

  /* SECTION: HUD
     除了数字，还要把"现在谁在走 / 谁占上风 / 旗有没有危险"一眼说清 ——
     回合横幅 + 兵力对比条 + 大本营告急闪红。 */
  function turnHeadline() {
    if (phase === 'deploy') { return '布阵阶段'; }
    if (phase === 'paused') { return '战线暂停'; }
    if (phase === 'over') {
      return !st ? '待命' : (st.winner === 0 ? '我方获胜' : st.winner === 1 ? '我方失旗' : '战线僵持');
    }
    if (phase !== 'play') { return '待命'; }
    if (st && st.over) { return '结算中'; }
    return (st && st.turn === 1) ? (aiBusy ? '蓝方思考中' : '蓝方行棋') : '红方行棋';
  }

  function renderHud() {
    var lv = D.LEVELS[level - 1];
    txt('jqTurn', st ? (st.turn === 0 ? '红方' : '蓝方') : '—');
    txt('jqAlive0', st ? C.aliveCount(st, 0) + ' 子' : '25 子');
    txt('jqAlive1', st ? C.aliveCount(st, 1) + ' 子' : '25 子');
    /* 战果 = 打掉对方多少子力（开局总值减去对方剩余），比"阶段"值得占一格 */
    txt('jqKill', st ? (SIDE_TOTAL - C.material(st, 1)) : '0');
    txt('jqBest', best.toLocaleString('zh-CN'));
    txt('jqStreak', streak > 0 ? streak + ' 连胜' : '—');
    txt('jqLevelName', lv.no + ' · ' + lv.name);
    txt('jqModeTag', hidden ? '暗棋（对方军衔不公开）' : '明棋（双方都看得见）');
    txt('jqPlies', st ? st.plies + ' 手' : '0 手');

    /* 旗危检测：只在真正行棋时算（要枚举对方全部着法） */
    var danger = false;
    if (st && !st.over && phase === 'play') {
      try { danger = !!C.threatOf(st, 0).flagRisk; } catch (e) { danger = false; }
    }
    var bar = el.jqTurnBar;
    if (bar) {
      var blueTurn = !!(st && st.turn === 1 && !st.over && phase === 'play');
      bar.classList.toggle('foe', blueTurn);
      bar.classList.toggle('danger', danger);
      txt('jqTurnText', turnHeadline() + (danger && phase === 'play' ? ' · 军旗告急' : ''));
      txt('jqTurnSub', danger && phase === 'play'
        ? '蓝方一步之内够到你的军旗 —— 回防或把它堵在入口外'
        : (phase === 'play' && st && st.quiet > 18 ? '长时间无伤亡，再拖就按子力判定' : ''));
    }
    var m0 = st ? C.material(st, 0) : 1, m1 = st ? C.material(st, 1) : 1;
    var sum = (m0 + m1) || 1;
    if (el.jqMatRed) { el.jqMatRed.style.width = (m0 / sum * 100).toFixed(1) + '%'; }
    if (el.jqMatBlue) { el.jqMatBlue.style.width = (m1 / sum * 100).toFixed(1) + '%'; }
    txt('jqMatTxtR', '红方 ' + (st ? C.aliveCount(st, 0) : 25) + ' 子 · 兵力 ' + m0);
    txt('jqMatTxtB', '蓝方 ' + (st ? C.aliveCount(st, 1) : 25) + ' 子 · 兵力 ' + m1);
    Object.keys(hqEls).forEach(function (id) {
      var n = D.NODES[id];
      var own = n.side === 0;
      var flagHere = st && st.occ[id] && st.pieces[st.occ[id]].k === 'junQi';
      hqEls[id].classList.toggle('danger', !!(danger && own && flagHere));
    });

    if (el.jqPips) {
      var want = D.LEVELS.map(function (x, i) {
        return (i < unlocked ? 'on' : '') + (i + 1 === level ? ' cur' : '');
      });
      var cur = el.jqPips.children.length === D.LEVELS.length
        ? Array.prototype.map.call(el.jqPips.children, function (n) { return n.className; })
        : null;
      var same = cur && cur.every(function (v, i) { return v === want[i]; });
      if (!same) {
        el.jqPips.innerHTML = '';
        want.forEach(function (cls, i) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'jq-pip ' + cls;
          b.setAttribute('data-level', String(i + 1));
          b.title = D.LEVELS[i].name;
          b.setAttribute('aria-label', '选择关口 ' + D.LEVELS[i].name);
          el.jqPips.appendChild(b);
        });
      }
    }
    if (el.jqBtnSound) { el.jqBtnSound.textContent = soundOn ? '🔊' : '🔇'; }
  }

  function renderAll() {
    renderHud();
    syncPieces();
    drawMarks();
  }

  /* SECTION: toast */
  var toastTimer = null;
  function toast(msg) {
    var n = el.jqToast;
    if (!n) { return; }
    n.textContent = msg;
    n.classList.add('show');
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { n.classList.remove('show'); }, 1400);
  }

  /* SECTION: 选择与落子 */
  function selectPiece(pid) {
    sel = pid;
    /* core 的 nodeMoves 只给 {to,capture,via}（它是按"点"算的），
       这里补上 pid/from，marks 就能直接喂给 makeMove */
    marks = st ? C.nodeMoves(st, pid).map(function (m) {
      m.pid = pid; m.from = st.pieces[pid].node; return m;
    }) : [];
    D.AUDIO.select();
    syncPieces();
    drawMarks();
    describeSel();
  }
  function deselect(silent) {
    if (!sel) { return; }
    sel = null; marks = [];
    if (!silent) { D.AUDIO.unselect(); }
    syncPieces();
    drawMarks();
  }

  function onPick(nodeId) {
    if (phase === 'deploy') { onDeployPick(nodeId); return; }
    if (phase !== 'play' || !st || st.over) { return; }
    if (aiBusy || st.turn !== 0) { toast('蓝方正在思考…'); return; }
    var pid = st.occ[nodeId];
    var m = sel ? marks.filter(function (x) { return x.to === nodeId; })[0] : null;
    if (m) { playerMove(m); return; }
    if (pid && st.pieces[pid].owner === 0) {
      if (pid === sel) { deselect(); hint('已收回命令 —— 点红方的子选中，再点亮起的落点进军。'); return; }
      selectPiece(pid);
      return;
    }
    if (pid) { showSuspects(pid); return; }
    deselect();
    hint('空点：先点一个红方的子，落点会亮出来。');
  }

  /* SECTION: 一子里的声、光、抖动
     文案只给短促的 2~4 字（飘在棋盘上），细节留在战报里。
     暗棋口径：阵亡者一律翻开，所以飘字里写死者的军衔不算泄底。 */
  function fxOfEvent(evt) {
    var r = evt.res, mine = evt.side === 0;
    if (evt.side === 1) { fxTrail(evt.from, evt.to); }   // 标出蓝方这子从哪来
    if (!evt.def) { return; }
    if (r.flag) {
      fxBurst(evt.to, 'boom'); fxFloat(evt.to, '扛旗!', 'amber'); shake(); return;
    }
    if (evt.dig) {
      fxBurst(evt.to, 'win'); fxFloat(evt.to, '挖雷!', 'good'); return;
    }
    if (r.aDie && r.bDie) {
      fxBurst(evt.to, 'boom'); fxFloat(evt.to, '同归于尽', 'amber'); shake(); return;
    }
    if (r.bDie) {
      fxBurst(evt.to, mine ? 'win' : 'bad');
      fxFloat(evt.to, (mine ? '击破 +' : '损 -') + D.BY_KIND[mine ? evt.dK : evt.aK].val, mine ? 'good' : 'bad');
      if (!mine) { shake(); }
      return;
    }
    fxBurst(evt.to, 'bad');
    fxFloat(evt.to, '阵亡 -' + D.BY_KIND[evt.aK].val, 'bad');
    shake();
  }

  function afterMove(evt) {
    pushLog(evt);
    fxOfEvent(evt);
    deselect(true);
    renderAll();
    soundOf(evt);
    if (st.over) { finishGame(); return; }
    if (st.turn === 1) { scheduleAi(); }
  }

  function playerMove(m) {
    var rec = C.makeMove(st, m);
    afterMove(rec.evt);
  }

  function soundOf(evt) {
    if (!soundOn) { return; }
    var r = evt.res;
    if (r.flag) { D.AUDIO.flag(); }
    else if (evt.dig) { D.AUDIO.dig(); }
    else if (r.aDie && r.bDie) { D.AUDIO.trade(); }
    else if (r.bDie) { D.AUDIO.win(); }
    else if (r.aDie) { D.AUDIO.loseFight(); }
    else { D.AUDIO.step(); }
  }

  /* SECTION: AI 回合
     真实点击流程走 setTimeout（有"对方在想"的节奏感），
     自动化测试用 _debugAi() 同步跑同一段逻辑。 */
  function scheduleAi() {
    if (!st || st.over || st.turn !== 1) { return; }
    aiBusy = true;
    renderHud();
    var lv = D.LEVELS[st.level - 1];
    aiTimer = setTimeout(function () { aiTimer = null; runAi(); }, lv.think);
  }
  function cancelAi() {
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    aiBusy = false;
  }
  function runAi() {
    if (!st || st.over || st.turn !== 1) { aiBusy = false; renderHud(); return null; }
    var pk = C.chooseMove(st, 1);
    aiBusy = false;
    if (!pk) { C.checkEnd(st); finishGame(); return null; }
    var rec = C.makeMove(st, pk.mv);
    toast('蓝方：' + pk.why);
    afterMove(rec.evt);
    return pk;
  }

  /* SECTION: 布阵 */
  function onDeployPick(nodeId) {
    var pid = st.occ[nodeId];
    if (!pid) {
      if (sel) { deselect(); hint('布阵：点两枚红方的子交换位置。'); }
      return;
    }
    if (st.pieces[pid].owner !== 0) { showSuspects(pid); return; }
    if (!sel) { selectPiece(pid); hint('已选 ' + D.BY_KIND[st.pieces[pid].k].name + ' —— 再点一枚红方的子跟它换位置。'); return; }
    if (pid === sel) { deselect(); return; }
    if (C.canSwap(st, 0, sel, pid)) {
      C.swap(st, 0, sel, pid);
      D.AUDIO.select();
      deselect(true);
      renderAll();
      hint('已交换。军旗只能在大本营，地雷只能压后三行，炸弹不进大本营行。');
    } else {
      D.AUDIO.blocked();
      toast('这两个换不了（位置不合布阵规则）');
      selectPiece(pid);
    }
  }

  /* SECTION: 开局流程 */
  function newGame(opts) {
    opts = opts || {};
    cancelAi();
    level = Math.max(1, Math.min(D.LEVELS.length, opts.level || level));
    hidden = opts.hidden == null ? hidden : !!opts.hidden;
    writeStore(K_MODE, hidden ? 0 : 1);
    st = C.createGame({
      seed: opts.seed == null ? ((Date.now() & 0x3fffffff) ^ (Math.floor(Math.random() * 1e6))) : opts.seed,
      level: level, hidden: hidden
    });
    st.phase = 'deploy';
    sel = null; marks = []; pieceEls = {}; lastScore = 0;
    resetLog();
    buildBoard();
    phase = opts.skipDeploy ? 'play' : 'deploy';
    if (phase === 'play') { st.phase = 'play'; }
    show(el.jqDeploy, phase === 'deploy');
    show(el.jqOvStart, false); show(el.jqOvPause, false); show(el.jqOvOver, false);
    hint(phase === 'deploy'
      ? '布阵阶段：点两枚红方的子交换位置；想直接开打就按「开战」。'
      : '点红方的子选中，点亮起的落点进军；铁路上大子能直行到底，工兵可拐弯。');
    renderAll();
    if (soundOn) { D.AUDIO.resume(); }
    return statsOf();
  }

  function beginBattle() {
    if (!st || phase !== 'deploy') { return statsOf(); }
    phase = 'play';
    st.phase = 'play';
    show(el.jqDeploy, false);
    deselect(true);
    renderAll();
    hint('你的回合。行营里的子打不到，大本营进去就出不来。');
    if (soundOn) { D.AUDIO.win(); }
    return statsOf();
  }

  /* SECTION: 结算 */
  function finishGame() {
    if (phase === 'over') { return; }
    phase = 'over';
    if (st.phase) { st.phase = 'over'; }
    deselect(true);
    lastScore = C.scoreOf(st, 0);
    var iWon = st.winner === 0;
    var drew = st.winner === -1;
    var prevBest = best;
    if (iWon) {
      wins++;
      streak++;
      if (level >= unlocked && unlocked < D.LEVELS.length) {
        unlocked++;
        writeStore(K_LEVEL, unlocked);
      }
    } else if (!drew) {
      streak = 0;
    }
    var isRecord = lastScore > prevBest;
    if (isRecord) { best = lastScore; writeStore(K_BEST, best); }
    writeStore(K_WINS, wins);
    writeStore(K_STREAK, streak);

    txt('jqOverArt', iWon ? '🚩' : drew ? '🛡️' : '⚑');
    txt('jqOverTitle', iWon ? D.TEXT.win : drew ? D.TEXT.draw : D.TEXT.lose);
    txt('jqOverEn', iWon ? 'VICTORY' : drew ? 'DRAW' : 'DEFEAT');
    var why = el.jqOverWhy;
    if (why) {
      why.textContent = endSentence();
      why.className = 'jq-why ' + (iWon ? 'good' : drew ? '' : 'bad');
    }
    txt('jqRLevel', D.LEVELS[level - 1].name);
    txt('jqRPlies', String(st.plies));
    txt('jqRScore', lastScore.toLocaleString('zh-CN'));
    txt('jqRBest', best.toLocaleString('zh-CN'));
    txt('jqRAlive', C.aliveCount(st, 0) + ' / ' + C.aliveCount(st, 1));
    txt('jqRStreak', String(streak));
    txt('jqRMode', hidden ? '暗棋' : '明棋');
    show(el.jqRRecord, iWon && isRecord);
    var btnNext = el.jqBtnNextLevel;
    if (btnNext) {
      btnNext.style.display = (iWon && level < D.LEVELS.length) ? '' : 'none';
      btnNext.textContent = level < D.LEVELS.length ? '晋级：' + D.LEVELS[level].name + ' 关' : '已是最高关';
    }
    fillChooser(el.jqChooserOver);
    show(el.jqOvOver, true);
    renderAll();
    if (soundOn) { iWon ? D.AUDIO.levelUp() : drew ? D.AUDIO.step() : D.AUDIO.defeat(); }
  }

  /* 输得不明不白最难受 —— 结算给一句"这局怎么结束的" */
  function endSentence() {
    var r = st.reason, w = st.winner;
    if (r === 'flag') {
      return w === 0 ? '你扛走了蓝方军旗 —— 阵地拿下了。'
        : '蓝方冲过大本营入口把军旗扛了 —— 旗点只有一个入口，守旗的子别轻易调走。';
    }
    if (r === 'stalemate') {
      return w === 0 ? '蓝方已无子可动，困毙。' : '你的子全被封死（或只剩地雷军旗），困毙。';
    }
    return '长时间没有伤亡，按剩余子力判定：红方 ' + C.material(st, 0) + ' · 蓝方 ' + C.material(st, 1) + '。';
  }

  /* SECTION: 面板里的关口/模式选择器（覆盖层是 position:fixed，
     会把棋盘上的同款选择器盖住，所以面板里必须自带一份） */
  function fillChooser(host, label) {
    if (!host) { return; }
    host.innerHTML = '';
    var t = document.createElement('div');
    t.className = 'jq-chooser-title';
    t.textContent = label || '换个关口 / 换个玩法：';
    host.appendChild(t);
    var row = document.createElement('div');
    row.className = 'jq-chooser-row';
    D.LEVELS.forEach(function (lv, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'jq-chip' + (i + 1 === level ? ' sel' : '') + (i + 1 > unlocked ? ' lock' : '');
      b.setAttribute('data-level', String(i + 1));
      b.textContent = lv.name;
      b.title = i + 1 > unlocked ? '先赢下前一关才解锁' : '第 ' + lv.no + ' 关 · ' + lv.name;
      row.appendChild(b);
    });
    host.appendChild(row);
    var row2 = document.createElement('div');
    row2.className = 'jq-chooser-row';
    [['暗棋', 0], ['明棋', 1]].forEach(function (pair) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'jq-chip mode' + ((pair[1] === 0) === hidden ? ' sel' : '');
      b.setAttribute('data-mode', pair[1] === 0 ? 'dark' : 'open');
      b.textContent = pair[0];
      row2.appendChild(b);
    });
    var s = document.createElement('span');
    s.className = 'jq-chooser-note';
    s.textContent = '暗棋 ×' + D.SCORE.hiddenMult + ' 分';
    row2.appendChild(s);
    host.appendChild(row2);
  }

  /* 面板外的关口条 + 面板内的选择器都靠这两个委托处理器分发。
     单文件版里所有脚本同页共存，而摩尔斯也用了 data-mode 属性 ——
     所以必须限定在本视图内，否则点摩尔斯的标签会改掉军棋的模式。 */
  function onChooserClick(ev) {
    var node = ev.target.closest ? ev.target.closest('[data-level],[data-mode]') : null;
    if (!node) { return; }
    var view = $('viewJunqi');
    if (view && !view.contains(node)) { return; }
    if (node.hasAttribute('data-level')) {
      var want = parseInt(node.getAttribute('data-level'), 10);
      if (want > unlocked) { toast('先赢下当前关口才晋级'); D.AUDIO.blocked(); return; }
      level = want;
      writeStore(K_LEVEL, Math.max(unlocked, level));
    }
    if (node.hasAttribute('data-mode')) {
      hidden = node.getAttribute('data-mode') === 'dark';
      writeStore(K_MODE, hidden ? 0 : 1);
    }
    fillChooser(el.jqChooserStart); fillChooser(el.jqChooserOver);
    renderHud();
  }

  /* SECTION: 覆盖层 */
  function openStart() {
    phase = 'start';
    show(el.jqOvStart, true); show(el.jqOvOver, false); show(el.jqOvPause, false);
    show(el.jqDeploy, false);
    txt('jqStartBest', best.toLocaleString('zh-CN'));
    txt('jqStartWins', String(wins));
    txt('jqStartLevel', D.LEVELS[level - 1].name);
    fillChooser(el.jqChooserStart, '选个关口（赢了自动晋级）：');
    renderHud();
  }

  function togglePause(on) {
    if (phase !== 'play' && phase !== 'paused') { return; }
    if (on) {
      phase = 'paused';
      if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
      show(el.jqOvPause, true);
    } else {
      phase = 'play';
      show(el.jqOvPause, false);
      renderHud();
      if (st && !st.over && st.turn === 1) { scheduleAi(); }
    }
    renderHud();
  }

  /* SECTION: 键盘 */
  function keydown(e) {
    if (!active) { return; }
    var k = e.key;
    if (k === 'Escape') {
      if (phase === 'play' || phase === 'paused') { togglePause(phase !== 'paused'); return; }
      if (window.APP_ROUTER) { window.APP_ROUTER.go('portal'); }
      return;
    }
    if (k === 'p' || k === 'P') { togglePause(phase !== 'paused'); return; }
    if (k === 'm' || k === 'M') { toggleSound(); return; }
    if (k === 'Enter') {
      if (phase === 'deploy') { beginBattle(); }
      else if (phase === 'start') { newGame({ level: level }); }
      else if (phase === 'over') { newGame({ level: level }); }
      return;
    }
    if (k === 'd' || k === 'D') { deselect(); }
  }

  function toggleSound() {
    soundOn = !soundOn;
    writeStore(K_SOUND, soundOn ? 1 : 0);
    D.AUDIO.enabled = soundOn;
    renderHud();
  }

  /* SECTION: stats（门户回显 + 自动化断言都读这里） */
  function statsOf() {
    var s = st ? C.statsOf(st) : null;
    var danger = false;
    if (st && !st.over && phase === 'play') {
      try { danger = !!C.threatOf(st, 0).flagRisk; } catch (e) { danger = false; }
    }
    return {
      phase: phase, level: level, unlocked: unlocked, hidden: hidden,
      best: best, wins: wins, streak: streak, score: lastScore,
      selected: sel, marks: marks.length, logRows: logRows, aiBusy: aiBusy,
      danger: danger,
      material: st ? [C.material(st, 0), C.material(st, 1)] : null,
      state: s,
      pieces: s ? s.alive : [25, 25],
      turn: s ? s.turn : 0,
      plies: s ? s.plies : 0,
      over: s ? s.over : false,
      winner: s ? s.winner : null,
      reason: s ? s.reason : ''
    };
  }

  /* SECTION: mount */
  function cacheDom() {
    el.jqBoard = $('jqBoard');
    el.jqDeploy = $('jqDeploy');
    el.jqBtnRelayout = $('jqBtnRelayout');
    el.jqBtnBattle = $('jqBtnBattle');
    el.jqLog = $('jqLog');
    el.jqHint = $('jqHint');
    el.jqToast = $('jqToast');
    el.jqBtnSound = $('jqBtnSound');
    el.jqPips = $('jqPips');
    el.jqTurnBar = $('jqTurnBar');
    el.jqMatRed = $('jqMatRed');
    el.jqMatBlue = $('jqMatBlue');
    el.jqChooserStart = $('jqChooserStart');
    el.jqChooserOver = $('jqChooserOver');
    el.jqOvStart = $('jqOvStart');
    el.jqOvPause = $('jqOvPause');
    el.jqOvOver = $('jqOvOver');
    el.jqOverWhy = $('jqOverWhy');
    el.jqRRecord = $('jqRRecord');
    el.jqBtnStart = $('jqBtnStart');
    el.jqBtnRetry = $('jqBtnRetry');
    el.jqBtnNextLevel = $('jqBtnNextLevel');
    el.jqBtnResume = $('jqBtnResume');
    el.jqBtnQuit = $('jqBtnQuit');
  }

  function bind() {
    document.addEventListener('keydown', keydown);
    document.addEventListener('click', onChooserClick);
    if (el.jqBtnSound) { el.jqBtnSound.addEventListener('click', toggleSound); }
    if (el.jqBtnRelayout) {
      el.jqBtnRelayout.addEventListener('click', function () {
        if (phase !== 'deploy' || !st) { return; }
        C.relayout(st, 0);
        deselect(true); renderAll();
        D.AUDIO.select();
        hint('重新铺开了一版。也可以直接点两枚子自己换。');
      });
    }
    if (el.jqBtnBattle) { el.jqBtnBattle.addEventListener('click', beginBattle); }
    if (el.jqBtnStart) { el.jqBtnStart.addEventListener('click', function () { newGame({ level: level }); }); }
    if (el.jqBtnRetry) { el.jqBtnRetry.addEventListener('click', function () { newGame({ level: level }); }); }
    if (el.jqBtnNextLevel) {
      el.jqBtnNextLevel.addEventListener('click', function () {
        newGame({ level: Math.min(D.LEVELS.length, level + 1) });
      });
    }
    if (el.jqBtnResume) { el.jqBtnResume.addEventListener('click', function () { togglePause(false); }); }
    if (el.jqBtnQuit) {
      el.jqBtnQuit.addEventListener('click', function () {
        cancelAi();
        if (st && !st.over) {
          /* 主动收兵：按当前子力判定，别留一局悬着 */
          var m0 = C.material(st, 0), m1 = C.material(st, 1);
          st.over = true;
          st.winner = m0 === m1 ? -1 : (m0 > m1 ? 0 : 1);
          st.reason = 'adjudicate';
        }
        show(el.jqOvPause, false);
        finishGame();
      });
    }
    /* 点面板外的棋盘空白也能取消选择（命中层已经处理了点，这里兜住 svg 本身） */
    if (el.jqBoard) {
      el.jqBoard.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('[data-node]')) { return; }
        deselect();
      });
    }
  }

  return {
    mount: function () {
      if (mounted) { return; }
      mounted = true;
      cacheDom();
      loadStore();
      D.AUDIO.enabled = soundOn;
      bind();
      buildBoard();
      st = C.createGame({ seed: 20260926, level: level, hidden: hidden });
      resetLog();
      openStart();
      renderAll();
    },
    activate: function () {
      active = true;
      loadStore();
      renderHud();
    },
    deactivate: function () {
      active = false;
      cancelAi();
    },
    resize: function () { /* SVG 靠 viewBox 缩放，无需重算 */ },
    isActive: function () { return active; },
    stats: statsOf,

    /* SECTION: 自动化钩子
       真实点击有 AI 思考延时，测试需要同步推进 —— 这里把同一段逻辑裸跑。 */
    _debugStart: function (lv, hid, seed) {
      this.mount();
      return newGame({ level: lv || level, hidden: hid === false ? false : !!hid, seed: seed == null ? 4242 : seed, skipDeploy: true });
    },
    _debugBattle: function () { return beginBattle(); },
    _debugMove: function (i) {
      if (!st || st.over || st.turn !== 0) { return statsOf(); }
      var ms = C.allMoves(st, 0);
      if (!ms.length) { return statsOf(); }
      playerMove(ms[(i || 0) % ms.length]);
      /* afterMove 排了带思考延时的 AI；测试要同步推进，先把定时器撤掉 */
      cancelAi();
      if (st.turn === 1 && !st.over) { runAi(); }
      return statsOf();
    },
    _debugAi: function () {
      cancelAi();
      runAi();
      return statsOf();
    },
    /* 把对方的旗送到嘴边，立刻产生一次"扛旗"结束（谁=1 表示蓝方胜） */
    _debugFinish: function (who) {
      if (!st) { return statsOf(); }
      var atkSide = who === 1 ? 1 : 0, defSide = 1 - atkSide;
      var flag = C.alivePids(st, defSide).filter(function (pid) { return st.pieces[pid].k === 'junQi'; })[0];
      if (!flag) { return statsOf(); }
      var hq = st.pieces[flag].node, entry = D.NODES[hq].hqEntry;
      var atker = C.mobilePids(st, atkSide).filter(function (pid) { return pid !== flag; })[0];
      if (!atker) { return statsOf(); }
      var oldNode = st.pieces[atker].node, occupier = st.occ[entry];
      if (occupier) { st.pieces[occupier].alive = false; }
      st.occ[oldNode] = null; st.occ[entry] = atker; st.pieces[atker].node = entry;
      if (phase === 'start' || phase === 'deploy') { phase = 'play'; }
      var rec = C.makeMove(st, { pid: atker, from: entry, to: hq, capture: flag });
      pushLog(rec.evt);
      finishGame();
      return statsOf();
    },
    _state: function () { return st; },
    _core: C
  };
})();
