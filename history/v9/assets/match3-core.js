/* ============================================================
   AI图标消消乐 · 棋盘核心逻辑（纯状态，不含 DOM）
   SECTION: match3-core
   ============================================================ */
window.MATCH3_CORE = (function () {
  'use strict';

  var ROWS = 8, COLS = 8;

  function key(r, c) { return r * COLS + c; }

  /* SECTION: ctor */
  function Match3(opts) {
    opts = opts || {};
    this.rows = opts.rows || ROWS;
    this.cols = opts.cols || COLS;
    this.colorCount = Math.max(5, opts.colorCount || 8);
    this.uidSeq = 1;
    this.grid = [];
    this.events = [];
    this.build();
  }

  Match3.prototype.key = key;

  Match3.prototype.at = function (r, c) {
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) { return null; }
    return this.grid[r][c];
  };

  Match3.prototype.makeTile = function (color, special) {
    return { uid: this.uidSeq++, color: color, special: special || null, r: 0, c: 0 };
  };

  Match3.prototype.randomColor = function () {
    return Math.floor(Math.random() * this.colorCount);
  };

  /* SECTION: build
     初始填充：避免出现现成的三连，并保证至少存在一步可消除操作 */
  Match3.prototype.build = function () {
    this.grid = [];
    for (var r = 0; r < this.rows; r++) {
      this.grid.push(new Array(this.cols).fill(null));
    }
    var guard = 0;
    do {
      for (var r2 = 0; r2 < this.rows; r2++) {
        for (var c = 0; c < this.cols; c++) {
          var col = this.randomColor();
          var tries = 0;
          while (tries < 24 && this.wouldMatch(r2, c, col)) {
            col = this.randomColor();
            tries++;
          }
          var t = this.makeTile(col, null);
          t.r = r2; t.c = c;
          this.grid[r2][c] = t;
        }
      }
      guard++;
    } while (!this.hasAnyMove() && guard < 40);
  };

  /* 判定在 (r,c) 放置 color 是否会立刻形成三连 */
  Match3.prototype.wouldMatch = function (r, c, color) {
    var left1 = this.at(r, c - 1), left2 = this.at(r, c - 2);
    if (left1 && left2 && left1.color === color && left2.color === color) { return true; }
    var up1 = this.at(r - 1, c), up2 = this.at(r - 2, c);
    if (up1 && up2 && up1.color === color && up2.color === color) { return true; }
    return false;
  };

  /* SECTION: runs
     扫描全部横/纵连续段（长度 >= 3），作为消除与特殊图标生成的依据 */
  Match3.prototype.findRuns = function () {
    var runs = [];
    var r, c, k, t, len;
    for (r = 0; r < this.rows; r++) {
      c = 0;
      while (c < this.cols) {
        t = this.grid[r][c];
        if (!t) { c++; continue; }
        k = c + 1;
        while (k < this.cols && this.grid[r][k] && this.grid[r][k].color === t.color) { k++; }
        len = k - c;
        if (len >= 3) {
          runs.push({ dir: 'h', r: r, c0: c, c1: k - 1, len: len, color: t.color });
        }
        c = k;
      }
    }
    for (c = 0; c < this.cols; c++) {
      r = 0;
      while (r < this.rows) {
        t = this.grid[r][c];
        if (!t) { r++; continue; }
        k = r + 1;
        while (k < this.rows && this.grid[k][c] && this.grid[k][c].color === t.color) { k++; }
        len = k - r;
        if (len >= 3) {
          runs.push({ dir: 'v', c: c, r0: r, r1: k - 1, len: len, color: t.color });
        }
        r = k;
      }
    }
    return runs;
  };

  Match3.prototype.hasMatches = function () {
    return this.findRuns().length > 0;
  };

  /* SECTION: resolve
     计算一次消除：返回被清除的格子、需要生成的特殊图标与得分。
     pivot 为玩家本次交换落点，用于决定特殊图标生成位置。 */
  Match3.prototype.resolve = function (pivot) {
    var runs = this.findRuns();
    if (!runs.length) { return null; }

    var clearSet = new Map();          // key -> tile
    var creates = [];                  // {r,c,special,color}
    var i, j;

    for (i = 0; i < runs.length; i++) {
      var run = runs[i];
      var cells = [];
      if (run.dir === 'h') {
        for (j = run.c0; j <= run.c1; j++) { cells.push({ r: run.r, c: j }); }
      } else {
        for (j = run.r0; j <= run.r1; j++) { cells.push({ r: j, c: run.c }); }
      }
      for (j = 0; j < cells.length; j++) {
        var kk = key(cells[j].r, cells[j].c);
        var tl = this.at(cells[j].r, cells[j].c);
        if (tl) { clearSet.set(kk, tl); }
      }
      /* 四连生成直线清除，五连及以上生成全色清除 */
      if (run.len >= 4) {
        var special = run.len >= 5 ? 'bomb' : (run.dir === 'h' ? 'row' : 'col');
        var spot = this.pickSpot(cells, pivot);
        creates.push({ r: spot.r, c: spot.c, special: special, color: run.color });
      }
    }

    /* 特殊图标被卷入消除时连锁引爆 */
    this.expandSpecials(clearSet);

    var cleared = [];
    clearSet.forEach(function (tile, k) {
      var r = Math.floor(k / COLS), c = k % COLS;
      cleared.push({ r: r, c: c, uid: tile.uid, special: tile.special, color: tile.color });
    });

    /* 生成特殊图标：这些格子不清除，而是原地变身 */
    var kept = [];
    for (i = 0; i < creates.length; i++) {
      var cr = creates[i];
      var ck = key(cr.r, cr.c);
      if (!clearSet.has(ck)) { continue; }
      clearSet.delete(ck);
      kept.push(cr);
    }

    /* 重算最终清除清单 */
    var finalCleared = [];
    clearSet.forEach(function (tile, k) {
      var r = Math.floor(k / COLS), c = k % COLS;
      finalCleared.push({ r: r, c: c, uid: tile.uid, special: tile.special, color: tile.color });
    });

    var score = this.scoreFor(finalCleared.length, kept.length);
    return { cleared: finalCleared, creates: kept, score: score, runCount: runs.length };
  };

  Match3.prototype.scoreFor = function (n, specials) {
    return n * 10 + specials * 60;
  };

  /* 特殊图标优先落在玩家交换的落点，否则落在连续段中点 */
  Match3.prototype.pickSpot = function (cells, pivot) {
    if (pivot && pivot.length) {
      for (var i = 0; i < cells.length; i++) {
        for (var j = 0; j < pivot.length; j++) {
          if (cells[i].r === pivot[j].r && cells[i].c === pivot[j].c) { return cells[i]; }
        }
      }
    }
    return cells[Math.floor(cells.length / 2)];
  };

  /* SECTION: expand-specials
     被清除的特殊图标触发整行/整列/全色清除，连锁传播；
     以 uid 去重防止重复引爆造成死循环。 */
  Match3.prototype.expandSpecials = function (clearSet) {
    var self = this;
    var fired = {};
    var queue = [];
    clearSet.forEach(function (tile) {
      if (tile.special) { queue.push(tile); }
    });

    var guard = 0;
    while (queue.length && guard < 4000) {
      guard++;
      var t = queue.shift();
      if (fired[t.uid]) { continue; }
      fired[t.uid] = true;
      var targets = [];
      var i;

      if (t.special === 'row') {
        for (i = 0; i < this.cols; i++) { targets.push(this.at(t.r, i)); }
      } else if (t.special === 'col') {
        for (i = 0; i < this.rows; i++) { targets.push(this.at(i, t.c)); }
      } else if (t.special === 'bomb') {
        var color = this.dominantColor();
        for (i = 0; i < this.rows; i++) {
          for (var j = 0; j < this.cols; j++) {
            var tl = this.grid[i][j];
            if (tl && tl.color === color) { targets.push(tl); }
          }
        }
      }

      for (i = 0; i < targets.length; i++) {
        var tt = targets[i];
        if (!tt) { continue; }
        var k = key(tt.r, tt.c);
        var isNew = !clearSet.has(k);
        clearSet.set(k, tt);
        if (isNew && tt.special && !fired[tt.uid]) { queue.push(tt); }
      }
      this.events.push({ type: 'boom', special: t.special });
    }
  };

  /* 全色清除的目标色：取当前棋盘上数量最多的一种 */
  Match3.prototype.dominantColor = function () {
    var counts = [];
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var t = this.grid[r][c];
        if (t) { counts[t.color] = (counts[t.color] || 0) + 1; }
      }
    }
    var best = 0, bestN = -1;
    for (var i = 0; i < counts.length; i++) {
      if (counts[i] && counts[i] > bestN) { bestN = counts[i]; best = i; }
    }
    return best;
  };

  /* SECTION: apply
     执行清除：把格子置空，并按 creates 原地生成特殊图标 */
  Match3.prototype.applyClear = function (result) {
    var i;
    for (i = 0; i < result.cleared.length; i++) {
      var cl = result.cleared[i];
      this.grid[cl.r][cl.c] = null;
    }
    for (i = 0; i < result.creates.length; i++) {
      var cr = result.creates[i];
      var t = this.makeTile(cr.color, cr.special);
      t.r = cr.r; t.c = cr.c;
      this.grid[cr.r][cr.c] = t;
      this.events.push({ type: 'create', special: cr.special, r: cr.r, c: cr.c });
    }
  };

  /* 直接引爆单个特殊图标（玩家点击触发），返回与 resolve 同构的结果 */
  Match3.prototype.detonate = function (r, c) {
    var t = this.at(r, c);
    if (!t || !t.special) { return null; }
    var clearSet = new Map();
    clearSet.set(key(r, c), t);
    this.expandSpecials(clearSet);
    var cleared = [];
    clearSet.forEach(function (tile, k) {
      var rr = Math.floor(k / COLS), cc = k % COLS;
      cleared.push({ r: rr, c: cc, uid: tile.uid, special: tile.special, color: tile.color });
    });
    return { cleared: cleared, creates: [], score: cleared.length * 20, runCount: 0 };
  };

  /* SECTION: gravity
     下落补位：返回全部需要移动的格子（含新填充，fromR 为负数表示从棋盘上方落入） */
  Match3.prototype.gravity = function () {
    var moved = [];
    for (var c = 0; c < this.cols; c++) {
      var write = this.rows - 1;
      for (var r = this.rows - 1; r >= 0; r--) {
        var t = this.grid[r][c];
        if (!t) { continue; }
        if (write !== r) {
          this.grid[write][c] = t;
          this.grid[r][c] = null;
          t.r = write;
          moved.push({ uid: t.uid, r: write, c: c, fromR: r, isNew: false });
        }
        write--;
      }
      /* 顶部空位补新图标 */
      var spawn = 1;
      for (var r2 = write; r2 >= 0; r2--) {
        var nt = this.makeTile(this.randomColor(), null);
        nt.r = r2; nt.c = c;
        this.grid[r2][c] = nt;
        moved.push({ uid: nt.uid, r: r2, c: c, fromR: -spawn, isNew: true, color: nt.color });
        spawn++;
      }
    }
    return moved;
  };

  /* SECTION: swap */
  Match3.prototype.swap = function (a, b) {
    var ta = this.at(a.r, a.c), tb = this.at(b.r, b.c);
    if (!ta || !tb) { return false; }
    this.grid[a.r][a.c] = tb;
    this.grid[b.r][b.c] = ta;
    ta.r = b.r; ta.c = b.c;
    tb.r = a.r; tb.c = a.c;
    return true;
  };

  Match3.prototype.isAdjacent = function (a, b) {
    return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
  };

  /* 两个特殊图标直接交换时立即引爆（常见消消乐规则） */
  Match3.prototype.isSpecialPair = function (a, b) {
    var ta = this.at(a.r, a.c), tb = this.at(b.r, b.c);
    return !!(ta && ta.special && tb && tb.special);
  };

  /* SECTION: moves-check */
  Match3.prototype.hasAnyMove = function () {
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var t = this.grid[r][c];
        if (t && t.special) { return true; }
        if (c + 1 < this.cols && this.moveCreatesMatch(r, c, r, c + 1)) { return true; }
        if (r + 1 < this.rows && this.moveCreatesMatch(r, c, r + 1, c)) { return true; }
      }
    }
    return false;
  };

  Match3.prototype.moveCreatesMatch = function (r1, c1, r2, c2) {
    this.swapRaw(r1, c1, r2, c2);
    var ok = this.hasMatches();
    this.swapRaw(r1, c1, r2, c2);
    return ok;
  };

  /* 仅交换网格内容，不更新 tile 坐标（供试算使用） */
  Match3.prototype.swapRaw = function (r1, c1, r2, c2) {
    var a = this.grid[r1][c1], b = this.grid[r2][c2];
    this.grid[r1][c1] = b;
    this.grid[r2][c2] = a;
  };

  /* SECTION: shuffle
     死局重排：只重新分配颜色，保留格子身份，直到既无现成三连又有可操作步骤 */
  Match3.prototype.shuffle = function () {
    var colors = [];
    var r, c;
    for (r = 0; r < this.rows; r++) {
      for (c = 0; c < this.cols; c++) {
        var t = this.grid[r][c];
        if (t) { colors.push(t.color); }
      }
    }
    var guard = 0;
    do {
      for (var i = colors.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = colors[i]; colors[i] = colors[j]; colors[j] = tmp;
      }
      var idx = 0;
      for (r = 0; r < this.rows; r++) {
        for (c = 0; c < this.cols; c++) {
          var tt = this.grid[r][c];
          if (tt) { tt.color = colors[idx++]; tt.special = null; }
        }
      }
      guard++;
    } while ((this.hasMatches() || !this.hasAnyMove()) && guard < 60);
    this.events.push({ type: 'shuffle' });
    return true;
  };

  /* SECTION: events */
  Match3.prototype.drainEvents = function () {
    var evs = this.events;
    this.events = [];
    return evs;
  };

  Match3.prototype.snapshot = function () {
    var out = [];
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var t = this.grid[r][c];
        if (t) { out.push({ uid: t.uid, color: t.color, special: t.special, r: r, c: c }); }
      }
    }
    return out;
  };

  return Match3;
})();
