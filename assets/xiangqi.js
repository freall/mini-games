/* ============================================================
   象棋开局教学 · 渲染与交互主控
   SECTION: xiangqi-main
   ------------------------------------------------------------
   分层：xiangqi-engine.js（规则引擎：走法/合法过滤/将军/中文记谱，无 DOM）
         xiangqi-openings.js（开局库·纯数据，10 个开局的主变与讲解）
         xiangqi-board.js（Canvas 棋盘渲染：底纹/棋子/选中/提示/动画）
         本文件（界面逻辑 + 开关控制 + 存档 + 视图路由）
   本文件不做规则判定 —— 合法性与记谱全问 engine，画出来的就是判出来的。

   SECTION: 并入小游戏乐园时改了什么（源项目 js/app.js → 本文件）
     1. 顶层立即启动（selectOpening + requestAnimationFrame）挪进 mount()：
        多页面站点与单文件版都是"进了视图才挂载"，脚本加载时不能自己跑起来。
     2. 加 window.XIANGQI_APP = { mount, activate, deactivate, resize, isActive,
        stats, _debug* }，与乐园其它六款游戏接口一致（boot.js / portal.js 靠它挂载）。
     3. 练习模式按钮文案的 300ms 轮询定时器改为常驻但加 active 门控：
        切走视图后不再空转（原版常驻定时器在门户页也一直跑）。
     4. Escape 返回乐园：单文件版走 APP_ROUTER.go('portal')，
        多页面版由 boot.js 提供的 router stub 换真实跳转。
     5. 存档：走通一个开局即记分并解锁下一个（xiangqi-best / -level / -done），
        门户卡片回显这两项。
     6. 视觉作用域：视图里的样式全部限定在 #viewXiangqi 下，
        棋盘容器改成自适应宽度（原版写死 500~620px 栅格，窄屏会溢出）。
   ============================================================ */
window.XIANGQI_APP = (function () {
  'use strict';

  var E = window.XQEngine, B = window.XQBoard, G = window.XQOpenings;

  /* ---------------- 存档（与本项目其他游戏一致的 key 风格） ---------------- */
  var K_BEST = 'xiangqi-best',        /* 最高分 */
      K_LEVEL = 'xiangqi-level',      /* 已解锁到第几关（按开局序号推进） */
      K_SCORE = 'xiangqi-score',      /* 累计分（用于算最高分） */
      K_DONE = 'xiangqi-done',        /* JSON：已完整走通的开局 id 列表 */
      K_MODE = 'xiangqi-mode',        /* 上次使用的模式：0 演示 / 1 练习 */
      K_FLIP = 'xiangqi-flip';        /* 棋盘朝向：1 = 黑在下 */

  var best = 0, unlocked = 1, cleared = {}, lastMode = 0, flipSaved = 0, deepOpening = '';

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
    unlocked = Math.max(1, Math.min(G.OPENINGS.length, readStore(K_LEVEL, 1)));
    lastMode = readStore(K_MODE, 0);
    flipSaved = readStore(K_FLIP, 0);
    try {
      var d = JSON.parse(window.localStorage.getItem(K_DONE) || '[]');
      cleared = {};
      if (Object.prototype.toString.call(d) === '[object Array]') {
        for (var i = 0; i < d.length; i++) { cleared[d[i]] = true; }
      }
    } catch (e) { cleared = {}; }
    /* SECTION: 深链
       ?opening=<id>&mode=practice 的优先级高于存档 —— 门户/书签进来就该停在那儿。
       放在 loadStore 里而不是 mount 里：activate 每次回本视图都会读存档，
       放在外面会被覆盖回去（军棋那款踩过同样的坑）。 */
    try {
      var q = (window.location.search || '').match(/[?&]opening=([\w-]+)/);
      if (q && G.OPENINGS.some(function (o) { return o.id === q[1]; })) { deepOpening = q[1]; }
      var m = (window.location.search || '').match(/[?&]mode=(demo|practice)/);
      if (m) { lastMode = m[1] === 'practice' ? 1 : 0; }
    } catch (e2) { /* 忽略 */ }
  }

  /* ---------------- DOM ---------------- */
  function $(id) { return document.getElementById(id); }
  function txt(id, s) { var n = $(id); if (n && n.textContent !== s) { n.textContent = s; } }

  var canvas = null, ctx = null, el = {};
  var mounted = false, active = false;

  /* ---------------- 状态 ---------------- */
  var S = {
    opening: null,
    /* 主变序列：每项 {boardBefore, boardAfter, mv, text, note, side, no, check} */
    line: [],
    index: -1,          /* 已走到第几手（-1 = 初始局面） */
    playing: false,
    timer: null,
    anim: null,
    mode: 'demo',       /* demo | practice */
    lastMove: null,
    selected: null,
    hints: [],
    practice: null,
    orient: 'r'         /* 'r' 红在下（默认） | 'b' 黑在下 */
  };

  var raf = (window.requestAnimationFrame || function (fn) {
    return setTimeout(function () { fn(Date.now()); }, 16);
  });

  function f(s) { return s === 'r' ? 'b' : 'r'; }

  /* cacheDom：挂载后缓存所有节点引用（mount 有 mounted 门控，只做一次） */
  function cacheDom() {
    var ids = ['xqBoard', 'xqOpeningList', 'xqOpeningCount', 'xqOpTitle', 'xqOpAlias',
      'xqOpMeta', 'xqOpIntro', 'xqOpIdea', 'xqOpKeys', 'xqMoveList', 'xqOpTrap',
      'xqStepLabel', 'xqStepNote', 'xqCounterBox', 'xqBtnPlay', 'xqBtnPrev', 'xqBtnNext',
      'xqBtnReset', 'xqBtnPractice', 'xqBtnFlip', 'xqRngSpeed', 'xqSpeedVal',
      'xqChkCoord', 'xqChkHint', 'xqScore', 'xqCleared', 'xqStageName'];
    for (var i = 0; i < ids.length; i++) { el[ids[i]] = $(ids[i]); }
    canvas = el.xqBoard;
    if (canvas) {
      ctx = canvas.getContext('2d', { alpha: false });
      if (ctx) { canvas.width = B.W; canvas.height = B.H; }
    }
  }

  /* =====================================================================
   *  开局加载
   * ===================================================================== */
  function buildLine(op) {
    var line = [];
    var board = E.parseFen(E.START_FEN).board;
    var side = 'r';
    op.moves.forEach(function (m, i) {
      var lm = E.legalMoves(board, side);
      var hit = null;
      for (var k = 0; k < lm.length; k++) {
        if (E.moveToChinese(board, lm[k]).text === m.text) { hit = lm[k]; break; }
      }
      if (!hit) { side = f(side); return; }
      var nb = E.boardApply(board, hit);
      var ns = f(side);
      line.push({
        boardBefore: board, boardAfter: nb, mv: hit,
        text: m.text, note: m.note || '', side: side,
        no: Math.floor(i / 2) + 1,
        check: E.isInCheck(nb, ns)
      });
      board = nb; side = ns;
    });
    return line;
  }

  function openingById(id) {
    for (var i = 0; i < G.OPENINGS.length; i++) {
      if (G.OPENINGS[i].id === id) { return G.OPENINGS[i]; }
    }
    return G.OPENINGS[0];
  }
  function opIndex(id) {
    for (var i = 0; i < G.OPENINGS.length; i++) { if (G.OPENINGS[i].id === id) { return i; } }
    return 0;
  }

  function selectOpening(id) {
    var op = openingById(id);
    S.opening = op;
    S.line = buildLine(op);
    S.index = -1;
    S.lastMove = null;
    S.selected = null;
    S.hints = [];
    S.anim = null;
    stopPlay();
    S.mode = 'demo';
    S.practice = null;
    if (el.xqBoard) { el.xqBoard.classList.remove('practice-on'); }

    renderSidebar();
    renderInfo();
    renderMoves();
    render();
    setNote('点击「播放」逐手演示，或直接点棋谱中的任意一手跳转。');

    if (el.xqOpeningList) {
      var items = el.xqOpeningList.querySelectorAll('.xq-op-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('active', items[i].getAttribute('data-id') === op.id);
      }
    }
    renderHud();
  }

  /* =====================================================================
   *  左侧列表
   * ===================================================================== */
  function renderSidebar() {
    if (!el.xqOpeningList) { return; }
    var groups = [
      { label: '红方先手开局', side: 'r' },
      { label: '黑方应对体系', side: 'b' }
    ];
    el.xqOpeningList.innerHTML = '';
    groups.forEach(function (g) {
      var items = G.OPENINGS.filter(function (o) { return o.side === g.side; });
      if (!items.length) { return; }
      var h = document.createElement('div');
      h.className = 'xq-group-title';
      h.textContent = g.label;
      el.xqOpeningList.appendChild(h);
      items.forEach(function (o) {
        var li = document.createElement('button');
        li.type = 'button';
        li.className = 'xq-op-item';
        li.setAttribute('data-id', o.id);
        li.innerHTML =
          '<span class="xq-op-name">' + o.name + '</span>' +
          '<span class="xq-op-sub">' + (o.alias[0] || o.family) + '</span>' +
          '<span class="xq-lv xq-lv' + o.level + '">' + ['入门', '进阶', '高阶'][o.level - 1] + '</span>';
        li.onclick = function () { selectOpening(o.id); };
        el.xqOpeningList.appendChild(li);
      });
    });
    if (el.xqOpeningCount) { el.xqOpeningCount.textContent = G.OPENINGS.length + ' 种'; }
  }

  /* =====================================================================
   *  右侧信息
   * ===================================================================== */
  function renderInfo() {
    var op = S.opening;
    if (!op || !el.xqOpTitle) { return; }
    el.xqOpTitle.textContent = op.name;
    el.xqOpAlias.innerHTML = op.alias.length
      ? op.alias.map(function (a) { return '<span class="xq-chip">' + a + '</span>'; }).join('')
      : '';
    el.xqOpMeta.innerHTML =
      '<span class="xq-chip xq-chip-' + (op.side === 'r' ? 'red' : 'dark') + '">' +
      (op.side === 'r' ? '红方先手' : '黑方应法') + '</span>' +
      '<span class="xq-chip">' + op.family + '</span>' +
      '<span class="xq-chip">' + ['入门', '进阶', '高阶'][op.level - 1] + '</span>' +
      op.tag.map(function (t) { return '<span class="xq-chip xq-chip-soft">' + t + '</span>'; }).join('');
    el.xqOpIntro.textContent = op.intro;

    el.xqOpIdea.innerHTML = '<div class="xq-sec-h">核心思路</div>' +
      op.idea.map(function (p, i) {
        return '<p class="xq-idea-p"><b>' + (i + 1) + '.</b> ' + p + '</p>';
      }).join('');

    el.xqOpKeys.innerHTML = '<div class="xq-sec-h">关键手讲解</div>' +
      op.keys.map(function (k) {
        var m = S.line[k.at];
        var t = m ? m.text : '';
        return '<div class="xq-key-row" data-at="' + k.at + '">' +
          '<span class="xq-key-no">' + (k.at + 1) + '</span>' +
          '<span class="xq-key-move">' + (t || '—') + '</span>' +
          '<span class="xq-key-text">' + k.title + '：' + k.text + '</span>' +
          '</div>';
      }).join('');

    var rows = el.xqOpKeys.querySelectorAll('.xq-key-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        row.onclick = function () { goto(parseInt(row.getAttribute('data-at'), 10)); };
      })(rows[i]);
    }

    var traps = (op.trap || []).slice();
    (op.counters || []).forEach(function (c) {
      traps.push('<b>【' + (c.name0 || '对方变着') + '】</b> ' +
        c.moves.map(function (m) { return m.text; }).join(' → '));
    });
    el.xqOpTrap.innerHTML = '<div class="xq-sec-h">陷阱与变着</div>' +
      (traps.length ? traps.map(function (t) { return '<p class="xq-trap-p">⚠ ' + t + '</p>'; }).join('')
                    : '<p class="xq-trap-p xq-muted">本开局变化平稳，暂无常见陷阱。</p>');

    if (el.xqCounterBox) { el.xqCounterBox.innerHTML = ''; }
  }

  /* =====================================================================
   *  棋谱列表
   * ===================================================================== */
  function renderMoves() {
    if (!el.xqMoveList) { return; }
    el.xqMoveList.innerHTML = '';
    var rows = [];
    var cur = { no: null, r: '', b: '' };
    S.line.forEach(function (m, i) {
      var no = Math.floor(i / 2) + 1;
      if (no !== cur.no) {
        if (cur.no !== null) { rows.push(cur); }
        cur = { no: no, r: '', b: '', idxR: null, idxB: null };
      }
      if (m.side === 'r') { cur.r = m.text; cur.idxR = i; }
      else { cur.b = m.text; cur.idxB = i; }
    });
    if (cur.no !== null) { rows.push(cur); }

    rows.forEach(function (row) {
      var div = document.createElement('div');
      div.className = 'xq-mv-row';
      div.innerHTML =
        '<span class="xq-mv-no">' + row.no + '.</span>' +
        '<button type="button" class="xq-mv xq-red" data-i="' + row.idxR + '">' + row.r + '</button>' +
        '<button type="button" class="xq-mv xq-dark" data-i="' +
        (row.idxB === null ? -1 : row.idxB) + '">' + (row.b || '') + '</button>';
      el.xqMoveList.appendChild(div);
    });
    var btns = el.xqMoveList.querySelectorAll('.xq-mv');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        var idx = parseInt(b.getAttribute('data-i'), 10);
        if (idx < 0) { return; }
        b.onclick = function () { goto(idx); };
      })(btns[i]);
    }
    highlightMove();
  }

  function highlightMove() {
    if (!el.xqMoveList) { return; }
    var btns = el.xqMoveList.querySelectorAll('.xq-mv');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('cur', parseInt(btns[i].getAttribute('data-i'), 10) === S.index);
    }
    var cur = el.xqMoveList.querySelector('.xq-mv.cur');
    if (cur && cur.scrollIntoView) { cur.scrollIntoView({ block: 'nearest' }); }
  }

  /* =====================================================================
   *  局面渲染
   * ===================================================================== */
  function currentBoard() {
    if (S.index < 0) { return E.parseFen(E.START_FEN).board; }
    return S.line[S.index].boardAfter;
  }
  /* 红方在下，与逻辑 row 一致；翻转时行列都要镜像 */
  function view(r, c) {
    return S.orient === 'r' ? { r: r, c: c } : { r: 9 - r, c: 8 - c };
  }

  function render() {
    if (!ctx) { return; }
    var b = (S.practice && S.practice.active) ? S.practice.board : currentBoard();

    var selected = null, hints = [], hintTargets = [];
    if (S.selected) {
      selected = view(S.selected.r, S.selected.c);
      var piece = b[S.selected.r][S.selected.c];
      var ms = E.pieceMoves(b, S.selected.r, S.selected.c);
      var lm = E.legalMoves(b, piece.s);
      var legalSet = {};
      lm.forEach(function (m) { legalSet[m.fr + ',' + m.fc + ',' + m.tr + ',' + m.tc] = true; });
      var key = function (m) { return S.selected.r + ',' + S.selected.c + ',' + m.r + ',' + m.c; };
      hints = ms.filter(function (m) { return legalSet[key(m)]; })
                 .map(function (m) { return view(m.r, m.c); });
      hintTargets = ms.filter(function (m) { return legalSet[key(m)]; })
                       .map(function (m) { return { r: m.r, c: m.c }; });
    }

    var lastMove = null;
    if (S.lastMove) {
      var a = view(S.lastMove.fr, S.lastMove.fc), z = view(S.lastMove.tr, S.lastMove.tc);
      lastMove = { fr: a.r, fc: a.c, tr: z.r, tc: z.c };
    }

    var check = null;
    var side = (S.practice && S.practice.active) ? S.practice.side
               : (S.index < 0 ? 'r' : f(S.line[S.index].side));
    if (E.isInCheck(b, side)) {
      var k = E.findKing(b, side);
      if (k) { check = view(k.r, k.c); }
    }

    var anim = null;
    if (S.anim) {
      var capV = S.anim.captured ? view(S.anim.captured.r, S.anim.captured.c) : null;
      anim = {
        from: view(S.anim.from.r, S.anim.from.c),
        to: view(S.anim.to.r, S.anim.to.c),
        t: S.anim.t, piece: S.anim.piece,
        captured: capV ? { r: capV.r, c: capV.c, p: S.anim.captured.p } : null
      };
    }

    var drawBoard = b;
    if (S.orient === 'b') { drawBoard = flip(b); }

    B.render(ctx, drawBoard, {
      selected: selected, hints: hints, hintTargets: hintTargets,
      lastMove: lastMove, check: check, anim: anim
    });

    if (el.xqChkCoord && el.xqChkCoord.checked) { drawCoords(); }

    updateControls();
  }

  function drawCoords() {
    ctx.save();
    ctx.fillStyle = 'rgba(90,61,28,0.72)';
    ctx.font = '600 11px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var topY = 22, botY = B.H - 22;
    for (var c = 0; c < 9; c++) {
      var redLabel = ['九', '八', '七', '六', '五', '四', '三', '二', '一'][c];
      var blkLabel = String(c + 1);
      var up = S.orient === 'r' ? blkLabel : redLabel;
      var dn = S.orient === 'r' ? redLabel : blkLabel;
      ctx.fillText(up, B.px(c), topY);
      ctx.fillText(dn, B.px(c), botY);
    }
    ctx.restore();
  }

  function updateControls() {
    if (!el.xqBtnPrev) { return; }
    var n = S.line.length;
    var inPractice = !!(S.practice && S.practice.active);
    el.xqBtnPrev.disabled = inPractice || S.index <= -1;
    el.xqBtnNext.disabled = inPractice || S.index >= n - 1;
    el.xqBtnPlay.disabled = inPractice;
    el.xqStepLabel.textContent = inPractice
      ? ('练习模式 · 第 ' + (S.practice.step + 1) + ' 手轮到你走（' +
         (S.practice.side === 'r' ? '红方' : '黑方') + '）')
      : (S.index < 0 ? '初始局面' : ('第 ' + (Math.floor(S.index / 2) + 1) + ' 回合 · ' +
         (S.line[S.index].side === 'r' ? '红方' : '黑方') + ' ' + S.line[S.index].text));

    /* 播放按钮的文案每帧都要刷：练习模式下按钮是禁用的，但文案不能停在
       上一次的旧值（曾经漏了 inPractice 分支，退出练习后文案还是「▶ 播放」） */
    el.xqBtnPlay.innerHTML = inPractice
      ? '练习中'
      : (S.playing ? '⏸ 暂停' : (S.index >= n - 1 ? '↻ 重播' : '▶ 播放'));
  }

  function setNote(html, cls) {
    if (!el.xqStepNote) { return; }
    el.xqStepNote.className = 'xq-step-note' + (cls ? ' ' + cls : '');
    el.xqStepNote.innerHTML = html;
  }

  /* =====================================================================
   *  走子与动画
   * ===================================================================== */
  function goto(i, animate, keepPlaying) {
    if (i < -1 || i >= S.line.length) { return; }
    if (!keepPlaying) { stopPlay(); }
    S.index = i;
    S.selected = null;
    S.hints = [];
    var step = S.line[i];
    if (i < 0) {
      S.lastMove = null;
      setNote('初始局面：红先行。');
      render(); highlightMove();
      return;
    }
    S.lastMove = { fr: step.mv.fr, fc: step.mv.fc, tr: step.mv.tr, tc: step.mv.tc };

    if (animate) {
      startAnim(step, function () { afterStep(step); });
    } else {
      afterStep(step);
    }
  }

  function afterStep(step) {
    render(); highlightMove();
    var sName = step.side === 'r' ? '红' : '黑';
    var html = '<b class="xq-mv-hl">' + step.no + '.</b> <b>' + sName + '</b> ' +
               '<span class="xq-mono">' + step.text + '</span>';
    if (step.note) { html += '<br>' + step.note; }

    var parts = E.moveToChinese(step.boardBefore, step.mv).parts;
    if (parts) {
      html += '<div class="xq-why">为什么这么记：<b>' + parts.name + '</b>（棋子）＋ <b>' +
        parts.from + '</b>（起点纵线）＋ <b>' + parts.dir + '</b>（' +
        (parts.dir === '平' ? '横走' : '纵走') + '）＋ <b>' + parts.to + '</b>（' +
        (parts.dir === '平' ? '目标纵线' : '步数或目标纵线') + '）</div>';
    }
    if (step.check) {
      html += '<div class="xq-check-warn">⚡ 这步棋形成<b>将军</b>！</div>';
    }
    setNote(html, step.note ? '' : 'plain');
  }

  function speedRatio() {
    return el.xqRngSpeed ? (parseFloat(el.xqRngSpeed.value) / 100) : 0.45;
  }

  function startAnim(step, done) {
    var b = step.boardBefore;
    var piece = b[step.mv.fr][step.mv.fc];
    var cap = b[step.mv.tr][step.mv.tc];
    S.anim = {
      from: { r: step.mv.fr, c: step.mv.fc },
      to: { r: step.mv.tr, c: step.mv.tc },
      t: 0, piece: piece,
      captured: cap ? { r: step.mv.tr, c: step.mv.tc, p: cap } : null,
      dur: 260 + 520 * speedRatio(), start: performance.now(), onDone: done,
      baseBoard: b
    };
    raf(animTick);
  }

  function animTick(now) {
    var a = S.anim;
    if (!a) { return; }
    if (now == null) { now = performance.now(); }
    a.t = Math.min(1, (now - a.start) / a.dur);
    var e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;  /* easeInOutQuad */
    var tmp = a.baseBoard.map(function (r) { return r.slice(); });
    var flipped = S.orient === 'b';
    B.render(ctx, flipped ? flip(tmp) : tmp, {
      selected: null, hints: [],
      lastMove: null,
      anim: {
        from: flipped ? { r: 9 - a.from.r, c: 8 - a.from.c } : a.from,
        to: flipped ? { r: 9 - a.to.r, c: 8 - a.to.c } : a.to,
        t: e, piece: a.piece,
        captured: a.captured
          ? (flipped ? { r: 9 - a.captured.r, c: 8 - a.captured.c, p: a.captured.p } : a.captured)
          : null
      }
    });
    if (a.t < 1) { raf(animTick); }
    else { S.anim = null; if (a.onDone) { a.onDone(); } }
  }
  function flip(b) {
    var out = [];
    for (var r = 0; r < 10; r++) { out.push(b[9 - r].slice().reverse()); }
    return out;
  }

  /* =====================================================================
   *  播放控制
   * ===================================================================== */
  function play() {
    if (S.playing) { stopPlay(); return; }
    if (S.index >= S.line.length - 1) { S.index = -1; S.lastMove = null; }
    S.playing = true;
    updateControls();
    tick();
  }

  function tick() {
    if (!S.playing) { return; }
    var next = S.index + 1;
    if (next >= S.line.length) { stopPlay(); return; }
    goto(next, true, true);          /* keepPlaying=true：别把自己停掉 */
    S.timer = setTimeout(tick, 900 + 1600 * speedRatio() + 300);
  }

  function stopPlay() {
    S.playing = false;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    updateControls();
  }

  /* =====================================================================
   *  练习模式：跟着开局库走，你走对了才继续
   * ===================================================================== */
  function startPractice() {
    if (!S.opening) { return; }
    if (S.playing) { stopPlay(); }
    S.practice = { active: true, step: 0, board: E.parseFen(E.START_FEN).board, side: 'r', msg: '' };
    goto(-1);
    /* goto 会 stopPlay，但不会清 practice；这里重设一次保证回到起点 */
    S.practice = { active: true, step: 0, board: E.parseFen(E.START_FEN).board, side: 'r', msg: '' };
    S.mode = 'practice';
    writeStore(K_MODE, 1);
    setNote('<b>练习模式</b>：按开局库的着法顺序走。轮到<b>红方</b>，请走出 <b>' +
            S.line[0].text + '</b> 之前应先思考——点棋子再点落点。', 'practice');
    render();
    renderHud();
  }

  function exitPractice() {
    S.practice = null;
    S.mode = 'demo';
    writeStore(K_MODE, 0);
    goto(-1);
    setNote('已退出练习模式。');
    renderHud();
    updateControls();
  }

  function practiceClick(cell) {
    var P = S.practice;
    if (!P || !P.active) { return; }
    var b = P.board;
    var piece = b[cell.r][cell.c];

    if (!S.selected) {
      if (!piece || piece.s !== P.side) {
        setNote('现在轮到<b>' + (P.side === 'r' ? '红方' : '黑方') + '</b>走子。', 'warn');
        return;
      }
      S.selected = { r: cell.r, c: cell.c };
      render(); return;
    }

    var mv = { fr: S.selected.r, fc: S.selected.c, tr: cell.r, tc: cell.c };
    var lm = E.legalMoves(b, P.side);
    var legal = null;
    for (var i = 0; i < lm.length; i++) {
      var m = lm[i];
      if (m.fr === mv.fr && m.fc === mv.fc && m.tr === mv.tr && m.tc === mv.tc) { legal = m; break; }
    }

    if (!legal) {
      if (piece && piece.s === P.side) { S.selected = { r: cell.r, c: cell.c }; render(); return; }
      setNote('这步不合规则，再想想。', 'warn'); S.selected = null; render(); return;
    }

    var expect = S.line[P.step];
    var played = E.moveToChinese(b, legal).text;
    if (played !== expect.text) {
      setNote('走法合法，但和本开局的谱着不同。开局库要求的是 <b>' + expect.text +
              '</b>（你走了 ' + played + '）。' +
              '<br><span class="xq-muted">想自由探索可按「退出练习」。</span>', 'warn');
      S.selected = null; render(); return;
    }

    var cap = b[mv.tr][mv.tc];
    var pieceObj = b[mv.fr][mv.fc];
    S.selected = null;
    S.anim = {
      from: { r: mv.fr, c: mv.fc }, to: { r: mv.tr, c: mv.tc }, t: 0, piece: pieceObj,
      captured: cap ? { r: mv.tr, c: mv.tc, p: cap } : null,
      dur: 260 + 520 * speedRatio(), start: performance.now(), baseBoard: b,
      onDone: function () {
        P.board = E.boardApply(b, mv);
        P.step++;
        P.side = f(P.side);
        render();
        if (P.step >= S.line.length) { finishPractice(); return; }
        var nx = S.line[P.step];
        if (nx.side === 'b') {
          setNote('✅ 走对了！现在看黑方如何应对……', 'practice');
          setTimeout(autoOpponent, 420);
        } else {
          setNote('✅ 走对了！继续走 <b>' + nx.text + '</b>。', 'practice');
        }
        renderHud();
      }
    };
    raf(animTick);
  }

  function autoOpponent() {
    var P = S.practice;
    if (!P || !P.active) { return; }
    var nx = S.line[P.step];
    if (!nx || nx.side !== 'b') { return; }
    var b = P.board;
    var lm = E.legalMoves(b, 'b');
    var mv = null;
    for (var i = 0; i < lm.length; i++) {
      if (E.moveToChinese(b, lm[i]).text === nx.text) { mv = lm[i]; break; }
    }
    if (!mv) { P.step++; return; }
    var cap = b[mv.tr][mv.tc];
    S.anim = {
      from: { r: mv.fr, c: mv.fc }, to: { r: mv.tr, c: mv.tc }, t: 0,
      piece: b[mv.fr][mv.fc],
      captured: cap ? { r: mv.tr, c: mv.tc, p: cap } : null,
      dur: 260 + 520 * speedRatio(), start: performance.now(), baseBoard: b,
      onDone: function () {
        P.board = E.boardApply(b, mv);
        P.step++; P.side = f(P.side);
        render();
        if (P.step >= S.line.length) { finishPractice(); return; }
        var nn = S.line[P.step];
        setNote('黑方走 <span class="xq-mono">' + nx.text + '</span>。' +
                (nx.note ? '<br>' + nx.note : '') +
                '<br>轮到你走 <b>' + nn.text + '</b>。', 'practice');
        renderHud();
      }
    };
    raf(animTick);
  }

  /* 走通一个开局 → 记分、解锁下一个（门户卡片要显示这两项） */
  function finishPractice() {
    var P = S.practice;
    if (!P || !P.active || P.finished) { return; }
    P.finished = true;
    var op = S.opening;
    var lineLen = S.line.length;
    /* 得分：手数 × 20，高阶开局加成；重复走通只补一半（鼓励换开局） */
    var base = lineLen * 20 * (1 + (op.level - 1) * 0.25);
    var gain = cleared[op.id] ? Math.round(base * 0.5) : Math.round(base);
    var score = readStore(K_SCORE, 0) + gain;
    writeStore(K_SCORE, score);
    if (score > best) { best = score; writeStore(K_BEST, best); }
    if (!cleared[op.id]) {
      cleared[op.id] = true;
      var ids = [];
      for (var k in cleared) { if (Object.prototype.hasOwnProperty.call(cleared, k)) { ids.push(k); } }
      writeStore(K_DONE, JSON.stringify(ids));
      var idx = opIndex(op.id);
      if (idx + 1 >= unlocked && idx + 2 <= G.OPENINGS.length) {
        unlocked = idx + 2;
        writeStore(K_LEVEL, unlocked);
      }
    }
    setNote('🎉 <b>完成！</b> 你完整走出了「' + op.name + '」的全部 ' + lineLen +
            ' 手，本局 +' + gain + ' 分，累计 <b>' + score + '</b> 分。' +
            '<br><span class="xq-muted">换一个开局继续吧 —— 左侧列表里已解锁 ' +
            unlocked + ' / ' + G.OPENINGS.length + ' 个。</span>', 'practice');
    render(); renderInfo(); renderHud(); updateControls();
  }

  function syncPracticeBtn() {
    if (!el.xqBtnPractice) { return; }
    var on = !!(S.practice && S.practice.active);
    el.xqBtnPractice.textContent = on ? '✕ 退出练习' : '🎯 练习模式';
    el.xqBtnPractice.classList.toggle('on', on);
  }

  /* HUD：最高分 + 已走通的开局数 + 当前开局名 */
  function renderHud() {
    txt('xqScore', best > 0 ? String(best) : '0');
    var n = 0;
    for (var k in cleared) { if (Object.prototype.hasOwnProperty.call(cleared, k)) { n++; } }
    txt('xqCleared', n + ' / ' + G.OPENINGS.length);
    txt('xqStageName', S.opening ? S.opening.name : '—');
    syncPracticeBtn();
  }

  /* =====================================================================
   *  事件
   * ===================================================================== */
  function canvasClick(ev) {
    if (!canvas) { return; }
    var rect = canvas.getBoundingClientRect();
    var mx = (ev.clientX - rect.left) * (canvas.width / rect.width);
    var my = (ev.clientY - rect.top) * (canvas.height / rect.height);
    var cell = B.toCell(mx, my);
    if (!cell) { return; }
    if (S.orient === 'b') { cell = { r: 9 - cell.r, c: 8 - cell.c }; }

    if (S.practice && S.practice.active) { practiceClick(cell); return; }

    /* 演示模式：点击棋子看该子走法（自由查看） */
    var b = currentBoard();
    var piece = b[cell.r][cell.c];
    if (!S.selected) {
      if (piece) { S.selected = cell; render(); }
      return;
    }
    if (S.selected.r === cell.r && S.selected.c === cell.c) { S.selected = null; render(); return; }
    if (piece && piece.s === b[S.selected.r][S.selected.c].s) { S.selected = cell; render(); return; }
    S.selected = null; render();
  }

  function keydown(e) {
    if (!active) { return; }
    if (e.key === 'Escape') {
      /* Escape 返回乐园：单文件版走视图路由，多页面版由 boot.js 的 stub 换真实跳转 */
      if (window.APP_ROUTER && typeof window.APP_ROUTER.go === 'function') {
        window.APP_ROUTER.go('portal');
        e.preventDefault();
      }
      return;
    }
    var t = e.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) { return; }
    if (e.key === 'ArrowRight') {
      if (el.xqBtnNext && !el.xqBtnNext.disabled) { el.xqBtnNext.click(); e.preventDefault(); }
    }
    if (e.key === 'ArrowLeft') {
      if (el.xqBtnPrev && !el.xqBtnPrev.disabled) { el.xqBtnPrev.click(); e.preventDefault(); }
    }
    if (e.key === ' ') {
      if (el.xqBtnPlay && !el.xqBtnPlay.disabled) { el.xqBtnPlay.click(); e.preventDefault(); }
    }
  }

  function bind() {
    if (el.xqBoard) { el.xqBoard.addEventListener('click', canvasClick); }
    if (el.xqBtnPlay) { el.xqBtnPlay.onclick = play; }
    if (el.xqBtnPrev) {
      el.xqBtnPrev.onclick = function () { stopPlay(); goto(S.index - 1, false); };
    }
    if (el.xqBtnNext) {
      el.xqBtnNext.onclick = function () { stopPlay(); goto(S.index + 1, true); };
    }
    if (el.xqBtnReset) {
      el.xqBtnReset.onclick = function () { stopPlay(); goto(-1); };
    }
    if (el.xqRngSpeed) {
      el.xqRngSpeed.oninput = function () { txt('xqSpeedVal', el.xqRngSpeed.value + '%'); };
    }
    if (el.xqChkCoord) { el.xqChkCoord.onchange = render; }
    if (el.xqChkHint) { el.xqChkHint.onchange = render; }
    if (el.xqBtnPractice) {
      el.xqBtnPractice.onclick = function () {
        if (S.practice && S.practice.active) { exitPractice(); }
        else { startPractice(); }
      };
    }
    if (el.xqBtnFlip) {
      el.xqBtnFlip.onclick = function () {
        S.orient = S.orient === 'r' ? 'b' : 'r';
        flipSaved = S.orient === 'b' ? 1 : 0;
        writeStore(K_FLIP, flipSaved);
        render();
      };
    }
    document.addEventListener('keydown', keydown);
  }

  /* 练习模式按钮的文案切换：常驻轻量定时器，只在视图激活时干活 */
  setInterval(function () {
    if (active) { syncPracticeBtn(); }
  }, 300);

  /* =====================================================================
   *  模块 API（与乐园其它六款游戏一致）
   * ===================================================================== */
  function statsOf() {
    var n = 0;
    for (var k in cleared) { if (Object.prototype.hasOwnProperty.call(cleared, k)) { n++; } }
    return {
      mode: S.mode,
      practice: !!(S.practice && S.practice.active),
      opening: S.opening ? S.opening.id : '',
      name: S.opening ? S.opening.name : '',
      moves: S.line.length,
      index: S.index,
      playing: !!S.playing,
      orient: S.orient,
      best: best,
      cleared: n,
      unlocked: unlocked,
      step: S.practice ? S.practice.step : -1,
      finished: !!(S.practice && S.practice.finished)
    };
  }

  return {
    mount: function () {
      if (mounted) { return; }
      mounted = true;
      cacheDom();
      loadStore();
      bind();
      if (flipSaved) { S.orient = 'b'; }
      if (el.xqChkCoord) { el.xqChkCoord.checked = true; }
      if (el.xqChkHint) { el.xqChkHint.checked = true; }
      txt('xqSpeedVal', (el.xqRngSpeed ? el.xqRngSpeed.value : 45) + '%');
      selectOpening(deepOpening || G.OPENINGS[0].id);
      if (lastMode) { startPractice(); }
      renderHud();
    },
    activate: function () {
      active = true;
      loadStore();
      renderHud();
      /* 切回本视图时补画一帧：切走期间 canvas 可能被别的视图遮过 */
      raf(function () { render(); });
    },
    deactivate: function () {
      active = false;
      stopPlay();                 /* 切走就停播，别在后台空转 */
    },
    resize: function () { render(); },
    isActive: function () { return active; },
    stats: statsOf,

    /* SECTION: 自动化钩子
       真实播放/动画有 300~1500ms 的时序，测试需要同步推进 ——
       这里把同一段逻辑裸跑（跳过动画帧，直接落到终局状态）。 */
    _debugSelect: function (id) {
      this.mount();
      selectOpening(id);
      return statsOf();
    },
    _debugStep: function (n) {
      this.mount();
      var target = (n == null ? S.index + 1 : n);
      goto(target, false);
      return statsOf();
    },
    _debugPlayAll: function () {
      this.mount();
      stopPlay();
      for (var i = 0; i < S.line.length; i++) { goto(i, false); }
      return statsOf();
    },
    /* 按开局库谱着走完一整局（练习模式的同步版：跳过动画与黑方延时） */
    _debugPractice: function () {
      this.mount();
      startPractice();
      var P = S.practice;
      var guard = 0;
      while (P.active && P.step < S.line.length && guard++ < 200) {
        var expect = S.line[P.step];
        var b = P.board;
        var lm = E.legalMoves(b, expect.side);
        var mv = null;
        for (var i = 0; i < lm.length; i++) {
          if (E.moveToChinese(b, lm[i]).text === expect.text) { mv = lm[i]; break; }
        }
        if (!mv) { break; }
        P.board = E.boardApply(b, mv);
        P.step++;
        P.side = f(P.side);
        if (P.step >= S.line.length) { break; }
      }
      if (P.step >= S.line.length) { finishPractice(); }
      render();
      return statsOf();
    },
    /* 故意走一步不合谱着的棋，验证"走错给提示、不推进"（同步版） */
    _debugPracticeWrong: function () {
      this.mount();
      if (!S.practice || !S.practice.active) { startPractice(); }
      var P = S.practice;
      var b = P.board;
      var lm = E.legalMoves(b, P.side);
      var expect = S.line[P.step];
      var wrong = null;
      for (var i = 0; i < lm.length; i++) {
        if (E.moveToChinese(b, lm[i]).text !== expect.text) { wrong = lm[i]; break; }
      }
      if (!wrong) { return { ok: false, reason: 'no-alternative' }; }
      S.selected = { r: wrong.fr, c: wrong.fc };
      practiceClick({ r: wrong.tr, c: wrong.tc });
      var note = el.xqStepNote ? el.xqStepNote.textContent : '';
      var step = P.step;
      var finished = !!P.finished;
      S.selected = null; render();
      return {
        ok: true, expected: expect.text, played: E.moveToChinese(b, wrong).text,
        note: note, step: step, finished: finished
      };
    },
    /* 读走法解说文本（源项目踩过的坑：讲解里出现 undefined/NaN） */
    _debugNoteText: function () { return el.xqStepNote ? el.xqStepNote.textContent : ''; },
    _state: function () { return S; },
    _engine: E,
    _core: { E: E, B: B, G: G }
  };
})();
