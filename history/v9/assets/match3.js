/* ============================================================
   AI图标消消乐 · 渲染与交互主控
   SECTION: match3-main
   ============================================================ */
window.MATCH3_APP = (function () {
  'use strict';

  var D = window.MATCH3_DATA;
  var Core = window.MATCH3_CORE;
  var ICONS = D.ICONS;

  /* SECTION: state */
  var board = null;          // core 实例
  var el = {};               // DOM 引用
  var tileEls = new Map();   // uid -> HTMLElement
  var active = false;

  var level = 1;
  var moves = 0;
  var target = 0;
  var levelScore = 0;        // 本关得分
  var total = 0;             // 累计总分（用于最高分）
  var best = 0;
  var bestLevel = 1;
  var busy = false;          // 动画进行中，屏蔽输入
  var sel = null;            // {r,c}
  var chain = 0;

  var CELL = 0;              // 格子像素边长，由 resize 计算
  var GAP = 4;

  /* SECTION: icon-preload
     运行时给 img.src 赋值加载远程图标；加载成功才显示图片，
     失败则保留 CSS 徽章兜底（品牌配色 + 标志字），网络恢复后自动生效。 */
  var iconLoaded = {};
  var preloadStarted = false;

  function preloadIcons(onFirst) {
    if (preloadStarted) { return; }
    preloadStarted = true;
    var pending = ICONS.length;
    for (var i = 0; i < ICONS.length; i++) {
      (function (icon) {
        var im = new Image();
        im.onload = function () {
          iconLoaded[icon.id] = true;
          applyIconToTiles(icon);
          if (--pending === 0 && onFirst) { onFirst(); }
        };
        im.onerror = function () {
          iconLoaded[icon.id] = false;
          if (--pending === 0 && onFirst) { onFirst(); }
        };
        im.src = icon.img;
        im.alt = icon.name + ' 图标';
      })(ICONS[i]);
    }
  }

  /* 图标到达后，把已渲染的对应徽章替换为真实图标 */
  function applyIconToTiles(icon) {
    if (!board) { return; }
    var color = iconIndex(icon.id);
    tileEls.forEach(function (node) {
      if (parseInt(node.dataset.color, 10) === color) { paintFace(node, icon); }
    });
  }

  function iconIndex(id) {
    for (var i = 0; i < ICONS.length; i++) { if (ICONS[i].id === id) { return i; } }
    return -1;
  }

  /* 给单个格子绘制图标层：远程图标 + 徽章兜底 */
  function paintFace(node, icon) {
    var face = node.querySelector('.m3-face');
    if (!face) { return; }
    face.style.background = 'linear-gradient(150deg,' + icon.c1 + ' 0%,' + icon.c2 + ' 100%)';
    var badge = face.querySelector('.m3-badge');
    if (badge) { badge.textContent = icon.letter; }

    var old = face.querySelector('img');
    if (iconLoaded[icon.id]) {
      if (!old) {
        old = document.createElement('img');
        old.alt = icon.name;
        old.className = 'm3-img';
        old.draggable = false;
        old.onerror = function () { old.style.display = 'none'; };
        face.appendChild(old);
      }
      old.style.display = '';
      if (old.getAttribute('src') !== icon.img) { old.src = icon.img; }
    } else if (old) {
      old.style.display = 'none';
    }
  }

  /* SECTION: storage */
  function loadStore() {
    try {
      best = parseInt(window.localStorage.getItem('match3-best') || '0', 10) || 0;
      bestLevel = parseInt(window.localStorage.getItem('match3-level') || '1', 10) || 1;
    } catch (e) { best = 0; bestLevel = 1; }
  }

  function saveStore() {
    try {
      window.localStorage.setItem('match3-best', String(best));
      window.localStorage.setItem('match3-level', String(bestLevel));
    } catch (e) { /* 忽略隐私模式限制 */ }
  }

  /* SECTION: layout
     视图隐藏或尚未开局时 board / 容器宽度不可用，必须先守卫再计算格子尺寸 */
  function resize() {
    if (!el.board || !board) { return; }
    var w = el.board.clientWidth;
    if (!w) { return; }
    CELL = Math.floor((w - GAP * (board.cols + 1)) / board.cols);
    el.board.style.height = (CELL * board.rows + GAP * (board.rows + 1)) + 'px';
    positionAll(true);
  }

  function xOf(c) { return GAP + c * (CELL + GAP); }
  function yOf(r) { return GAP + r * (CELL + GAP); }

  function positionAll(instant) {
    tileEls.forEach(function (node) {
      var r = parseInt(node.dataset.r, 10), c = parseInt(node.dataset.c, 10);
      if (instant) { node.style.transition = 'none'; }
      node.style.transform = 'translate3d(' + xOf(c) + 'px,' + yOf(r) + 'px,0)';
      node.style.width = CELL + 'px';
      node.style.height = CELL + 'px';
      if (instant) { void node.offsetWidth; node.style.transition = ''; }
    });
  }

  /* SECTION: tile-dom */
  function makeTileEl(t) {
    var node = document.createElement('div');
    node.className = 'm3-tile';
    node.dataset.uid = t.uid;
    node.dataset.color = t.color;
    node.dataset.r = t.r;
    node.dataset.c = t.c;
    node.style.width = CELL + 'px';
    node.style.height = CELL + 'px';

    var face = document.createElement('div');
    face.className = 'm3-face';
    var badge = document.createElement('span');
    badge.className = 'm3-badge';
    face.appendChild(badge);
    node.appendChild(face);

    if (t.special) { node.classList.add('sp-' + t.special); }
    paintFace(node, ICONS[t.color] || ICONS[0]);
    return node;
  }

  /* SECTION: sync
     把 core 网格同步到 DOM：新增、移除、移动，并修正重排后的配色与特殊标记 */
  function sync(opts) {
    opts = opts || {};
    var seen = new Set();
    var snap = board.snapshot();
    var i;

    for (i = 0; i < snap.length; i++) {
      var t = snap[i];
      seen.add(t.uid);
      var node = tileEls.get(t.uid);
      if (!node) {
        node = makeTileEl(t);
        tileEls.set(t.uid, node);
        el.board.appendChild(node);
        if (opts.spawnAbove) {
          /* 新图标从棋盘上方落下 */
          node.style.transition = 'none';
          node.dataset.r = t.r; node.dataset.c = t.c;
          node.style.transform = 'translate3d(' + xOf(t.c) + 'px,' + yOf(-1) + 'px,0)';
          void node.offsetWidth;
          node.style.transition = '';
        }
      }
      node.dataset.r = t.r;
      node.dataset.c = t.c;

      /* 重排会改变颜色：配色与徽章需跟着刷新 */
      if (parseInt(node.dataset.color, 10) !== t.color) {
        node.dataset.color = t.color;
        paintFace(node, ICONS[t.color] || ICONS[0]);
      }
      /* 重排会清空特殊图标：移除残留的标记类 */
      var wantSp = t.special ? 'sp-' + t.special : '';
      if (node.dataset.sp !== wantSp) {
        node.classList.remove('sp-row', 'sp-col', 'sp-bomb');
        if (wantSp) { node.classList.add(wantSp); }
        node.dataset.sp = wantSp;
      }
    }

    /* 移除已消除的格子 */
    var gone = [];
    tileEls.forEach(function (node, uid) { if (!seen.has(uid)) { gone.push(uid); } });
    for (i = 0; i < gone.length; i++) {
      var n = tileEls.get(gone[i]);
      if (n && n.parentNode) { n.parentNode.removeChild(n); }
      tileEls.delete(gone[i]);
    }
  }

  /* SECTION: animate */
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  function markCleared(cells) {
    for (var i = 0; i < cells.length; i++) {
      var t = board.at(cells[i].r, cells[i].c);
      if (!t) { continue; }
      var node = tileEls.get(t.uid);
      if (node) { node.classList.add('popping'); }
    }
  }

  function floatText(r, c, txt, cls) {
    var f = document.createElement('div');
    f.className = 'm3-float' + (cls ? ' ' + cls : '');
    f.textContent = txt;
    f.style.left = (xOf(c) + CELL / 2) + 'px';
    f.style.top = (yOf(r) + CELL / 2) + 'px';
    el.board.appendChild(f);
    setTimeout(function () { if (f.parentNode) { f.parentNode.removeChild(f); } }, 800);
  }

  /* SECTION: hud */
  function renderHud() {
    el.score.textContent = levelScore.toLocaleString('zh-CN');
    el.total.textContent = total.toLocaleString('zh-CN');
    el.best.textContent = Math.max(best, total).toLocaleString('zh-CN');
    el.level.textContent = level;
    el.moves.textContent = moves;
    el.target.textContent = target.toLocaleString('zh-CN');
    var ratio = target ? Math.min(1, levelScore / target) : 0;
    el.progressBar.style.width = (ratio * 100).toFixed(1) + '%';
    el.movesBox.classList.toggle('low', moves <= 5 && moves > 0);
    el.overTitle.textContent = levelScore >= target ? '目标达成' : '还差 ' + Math.max(0, target - levelScore).toLocaleString('zh-CN') + ' 分';
  }

  /* SECTION: flow */
  function startLevel(lv) {
    level = lv;
    var cfg = D.levelConfig(lv);
    target = cfg.target;
    moves = cfg.moves;
    levelScore = 0;
    chain = 0;
    sel = null;
    busy = false;

    board = new Core({ rows: 8, cols: 8, colorCount: ICONS.length });
    tileEls.forEach(function (n) { if (n.parentNode) { n.parentNode.removeChild(n); } });
    tileEls.clear();
    CELL = 0;
    resize();
    sync({ spawnAbove: false });
    positionAll(true);
    board.drainEvents();
    show(el.ovStart, false);
    show(el.ovOver, false);
    show(el.ovLevel, false);
    renderHud();
    D.Audio.shuffle();
  }

  function show(node, on) { if (node) { node.classList.toggle('show', !!on); } }

  /* 一关结束：达标为通关，步数耗尽为失败；刷新本地最高分与关卡进度 */
  function endLevel(win) {
    busy = true;
    var isRecord = total > best;
    if (isRecord) { best = total; }
    if (win && level + 1 > bestLevel) { bestLevel = level + 1; }
    saveStore();

    el.rLevel.textContent = level;
    el.rLevelScore.textContent = levelScore.toLocaleString('zh-CN');
    el.rTotal.textContent = total.toLocaleString('zh-CN');
    el.rBest.textContent = best.toLocaleString('zh-CN');
    el.rRecord.classList.toggle('show', isRecord);
    el.rTip.textContent = D.TIPS[Math.floor(Math.random() * D.TIPS.length)];
    el.ovOverTitle.textContent = win ? '关卡通关' : '步数用尽';
    el.ovOverArt.textContent = win ? '🏆' : '🧩';
    show(el.ovOver, true);
    if (win) { D.Audio.win(); } else { D.Audio.lose(); }
  }

  /* SECTION: resolve-loop
     交换成功后：消除 → 下落 → 连锁，直到无可消除 */
  async function resolveLoop(pivot) {
    chain = 0;
    var anyCleared = false;

    while (true) {
      var result = board.resolve(pivot);
      if (!result) { break; }
      anyCleared = true;
      chain++;
      var gained = result.score * chain;
      levelScore += gained;
      total += gained;

      markCleared(result.cleared);
      if (result.cleared.length) {
        var mid = result.cleared[Math.floor(result.cleared.length / 2)];
        floatText(mid.r, mid.c, '+' + gained, chain > 1 ? 'hot' : '');
      }
      if (chain > 1) { floatText(0, board.cols - 1, '连锁 ×' + chain, 'chain'); }
      D.Audio.pop(chain);

      var evs = board.drainEvents();
      for (var e = 0; e < evs.length; e++) {
        if (evs[e].type === 'boom') { D.Audio.boom(); shake(); }
        else if (evs[e].type === 'create') { D.Audio.special(); }
      }

      await wait(190);
      board.applyClear(result);
      sync();
      await wait(90);

      var moved = board.gravity();
      sync({ spawnAbove: true });
      positionAll(false);
      await wait(moved.length ? 250 : 60);

      renderHud();
      pivot = null;
    }

    if (!anyCleared) { return false; }

    /* 死局检测：无可操作步骤时自动重排 */
    if (!board.hasAnyMove()) {
      el.shuffleTip.classList.add('show');
      D.Audio.shuffle();
      await wait(320);
      board.shuffle();
      sync();
      positionAll(true);
      await wait(180);
      el.shuffleTip.classList.remove('show');
      board.drainEvents();
    }
    return true;
  }

  function shake() {
    if (!el.boardWrap) { return; }
    el.boardWrap.classList.remove('shake');
    void el.boardWrap.offsetWidth;
    el.boardWrap.classList.add('shake');
    setTimeout(function () { el.boardWrap.classList.remove('shake'); }, 300);
  }

  /* SECTION: fire-special
     引爆一枚特殊图标：标记 → 计分 → 清除 → 下落补位 */
  async function fireSpecial(r, c) {
    var res = board.detonate(r, c);
    if (!res) { return 0; }
    D.Audio.boom();
    shake();
    markCleared(res.cleared);
    levelScore += res.score;
    total += res.score;
    floatText(r, c, '+' + res.score, 'hot');
    board.drainEvents();
    await wait(200);
    board.applyClear(res);
    sync();
    await wait(80);
    board.gravity();
    sync({ spawnAbove: true });
    positionAll(false);
    await wait(250);
    return res.score;
  }

  /* SECTION: try-move */
  async function tryMove(a, b) {
    if (busy) { return; }
    if (!board.isAdjacent(a, b)) { return; }
    busy = true;
    clearSel();

    /* 两个特殊图标直接交换 → 两枚都引爆 */
    if (board.isSpecialPair(a, b)) {
      D.Audio.swap();
      await wait(140);
      await fireSpecial(a.r, a.c);
      await fireSpecial(b.r, b.c);
      moves--;
      renderHud();
      await resolveLoop(null);
      await afterMove();
      return;
    }

    /* 交换中包含特殊图标 → 优先直接引爆该枚，消耗一步 */
    var tA = board.at(a.r, a.c), tB = board.at(b.r, b.c);
    if (tA && tA.special) {
      await fireSpecial(a.r, a.c);
      moves--; renderHud();
      await resolveLoop(null);
      await afterMove();
      return;
    }
    if (tB && tB.special) {
      await fireSpecial(b.r, b.c);
      moves--; renderHud();
      await resolveLoop(null);
      await afterMove();
      return;
    }

    /* 普通交换 */
    board.swap(a, b);
    sync();
    positionAll(false);
    D.Audio.swap();
    await wait(200);

    var matched = board.hasMatches();
    if (!matched) {
      /* 无效交换：动画回弹 */
      D.Audio.bad();
      board.swap(a, b);
      sync();
      positionAll(false);
      var na = nodeAt(a.r, a.c), nb = nodeAt(b.r, b.c);
      if (na) { na.classList.add('nope'); }
      if (nb) { nb.classList.add('nope'); }
      await wait(240);
      if (na) { na.classList.remove('nope'); }
      if (nb) { nb.classList.remove('nope'); }
      busy = false;
      return;
    }

    moves--;
    renderHud();
    await resolveLoop([a, b]);
    await afterMove(null);
  }

  function nodeAt(r, c) {
    var found = null;
    tileEls.forEach(function (n) {
      if (parseInt(n.dataset.r, 10) === r && parseInt(n.dataset.c, 10) === c) { found = n; }
    });
    return found;
  }

  /* 一步结束后判定：达标进通关面板，步数耗尽进结算面板 */
  async function afterMove() {
    renderHud();
    busy = false;
    if (levelScore >= target) {
      /* 通关即刻存档，保证从通关面板直接返回门户也能回显进度 */
      markLevelCleared();
      await wait(360);
      busy = true;
      show(el.ovLevel, true);
      D.Audio.levelup();
      return;
    }
    if (moves <= 0) {
      await wait(360);
      endLevel(false);
    }
  }

  /* SECTION: record
     通关时刷新本地最高分与已到达关卡 */
  function markLevelCleared() {
    if (total > best) { best = total; }
    if (level + 1 > bestLevel) { bestLevel = level + 1; }
    saveStore();
  }

  /* SECTION: selection */
  function clearSel() {
    if (sel) {
      var n = nodeAt(sel.r, sel.c);
      if (n) { n.classList.remove('sel'); }
    }
    sel = null;
  }

  function setSel(rc) {
    clearSel();
    sel = rc;
    var n = nodeAt(rc.r, rc.c);
    if (n) { n.classList.add('sel'); }
  }

  /* SECTION: pointer-input
     支持点击选中 + 拖动方向交换，移动端与桌面统一处理 */
  function bindInput() {
    var down = null;
    var DRAG = 0;

    function rcFromEvent(ev) {
      var rect = el.board.getBoundingClientRect();
      var x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      var c = Math.floor((x - GAP) / (CELL + GAP));
      var r = Math.floor((y - GAP) / (CELL + GAP));
      if (r < 0 || c < 0 || r >= board.rows || c >= board.cols) { return null; }
      /* 落在间隙上时就近吸附 */
      return { r: r, c: c };
    }

    el.board.addEventListener('pointerdown', function (ev) {
      if (!active || busy) { return; }
      var rc = rcFromEvent(ev);
      if (!rc) { return; }
      ev.preventDefault();
      D.Audio.resume();
      DRAG = Math.max(16, CELL * 0.34);
      down = { r: rc.r, c: rc.c, x: ev.clientX, y: ev.clientY, used: false };
      try { el.board.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    });

    el.board.addEventListener('pointermove', function (ev) {
      if (!down || down.used || busy) { return; }
      var dx = ev.clientX - down.x, dy = ev.clientY - down.y;
      if (Math.abs(dx) < DRAG && Math.abs(dy) < DRAG) { return; }
      down.used = true;
      var b;
      if (Math.abs(dx) > Math.abs(dy)) {
        b = { r: down.r, c: down.c + (dx > 0 ? 1 : -1) };
      } else {
        b = { r: down.r + (dy > 0 ? 1 : -1), c: down.c };
      }
      if (b.r < 0 || b.c < 0 || b.r >= board.rows || b.c >= board.cols) { down = null; return; }
      var a = { r: down.r, c: down.c };
      down = null;
      tryMove(a, b);
    });

    el.board.addEventListener('pointerup', function (ev) {
      if (!down) { return; }
      var d = down;
      down = null;
      if (d.used || busy) { return; }
      var rc = { r: d.r, c: d.c };
      if (sel && board.isAdjacent(sel, rc)) {
        var a = sel;
        tryMove(a, rc);
      } else if (sel && sel.r === rc.r && sel.c === rc.c) {
        clearSel();
      } else {
        setSel(rc);
      }
    });

    el.board.addEventListener('pointercancel', function () { down = null; });
  }

  /* SECTION: boot */
  function cacheDom() {
    var ids = ['m3BoardWrap', 'm3Board', 'm3Score', 'm3Total', 'm3Best', 'm3Level', 'm3Moves',
      'm3Target', 'm3Progress', 'm3MovesBox', 'm3OverTitle', 'm3ShuffleTip',
      'm3OvStart', 'm3OvLevel', 'm3OvOver', 'm3OvOverTitle', 'm3OvOverArt',
      'm3RLevel', 'm3RLevelScore', 'm3RTotal', 'm3RBest', 'm3RRecord', 'm3RTip',
      'm3BtnStart', 'm3BtnRetry', 'm3BtnLevelUp', 'm3BtnQuit', 'm3BtnSound'];
    for (var i = 0; i < ids.length; i++) { el[ids[i]] = document.getElementById(ids[i]); }
    el.board = el.m3Board;
    el.boardWrap = el.m3BoardWrap;
    el.score = el.m3Score; el.total = el.m3Total; el.best = el.m3Best;
    el.level = el.m3Level; el.moves = el.m3Moves; el.target = el.m3Target;
    el.progressBar = el.m3Progress; el.movesBox = el.m3MovesBox;
    el.overTitle = el.m3OverTitle; el.shuffleTip = el.m3ShuffleTip;
    el.ovStart = el.m3OvStart; el.ovLevel = el.m3OvLevel; el.ovOver = el.m3OvOver;
    el.ovOverTitle = el.m3OvOverTitle; el.ovOverArt = el.m3OvOverArt;
    el.rLevel = el.m3RLevel; el.rLevelScore = el.m3RLevelScore;
    el.rTotal = el.m3RTotal; el.rBest = el.m3RBest;
    el.rRecord = el.m3RRecord; el.rTip = el.m3RTip;
  }

  function bindButtons() {
    el.m3BtnStart.addEventListener('click', function () { D.Audio.resume(); startLevel(level); });
    el.m3BtnRetry.addEventListener('click', function () { D.Audio.resume(); startLevel(level); });
    el.m3BtnLevelUp.addEventListener('click', function () {
      D.Audio.resume();
      show(el.ovLevel, false);
      startLevel(level + 1);
    });
    el.m3BtnQuit.addEventListener('click', function () {
      busy = true;
      show(el.ovOver, false);
      show(el.ovLevel, false);
      show(el.ovStart, true);
    });
    el.m3BtnSound.addEventListener('click', function () {
      D.Audio.enabled = !D.Audio.enabled;
      el.m3BtnSound.textContent = D.Audio.enabled ? '🔊' : '🔇';
      el.m3BtnSound.classList.toggle('off', !D.Audio.enabled);
      if (D.Audio.enabled) { D.Audio.resume(); D.Audio.swap(); }
    });
  }

  function onKey(e) {
    if (!active) { return; }
    var k = e.key;
    if (k === 'm' || k === 'M') { el.m3BtnSound.click(); return; }
    if (k === 'r' || k === 'R') {
      if (!busy && el.ovOver.classList.contains('show')) { startLevel(level); }
      return;
    }
    if (k === 'Escape') {
      if (active && window.APP_ROUTER) { window.APP_ROUTER.go('portal'); }
    }
  }

  return {
    mount: function () {
      cacheDom();
      loadStore();
      bindButtons();
      bindInput();
      window.addEventListener('keydown', onKey);
      var cfg = D.levelConfig(level);
      target = cfg.target; moves = cfg.moves;
      renderHud();
      preloadIcons();
      show(el.ovStart, true);
    },
    activate: function () {
      active = true;
      loadStore();
      renderHud();
      preloadIcons();
      /* 视图从 display:none 恢复后必须重算格子尺寸 */
      requestAnimationFrame(function () { resize(); });
    },
    deactivate: function () {
      active = false;
      /* 视图隐藏时不残留选中高亮 */
      clearSel();
    },
    resize: function () { if (active) { resize(); } },
    isActive: function () { return active; },
    stats: function () { return { best: best, level: bestLevel }; }
  };
})();
