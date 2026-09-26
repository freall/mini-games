/* ============================================================
   烽火军棋 · 纯逻辑核心
   SECTION: junqi-core
   ------------------------------------------------------------
   不碰 DOM：布阵、走子生成、吃子结算、暗棋推演、胜负判定、AI 全在这，
   可以脱离浏览器直接用 node 跑断言（tools/test-junqi-core.mjs）。

   SECTION: 规则清单（本作实现的全部规则，UI 与单测都以此为准）
     1. 走子：公路走一步（含进出行营的斜线）；铁路上可直线滑行任意格，
        途中遇到第一个有子的点即停（敌子可吃、己子挡路）；
        **只有工兵能在铁路上拐弯**（沿铁路任意绕行）。
     2. 行营：坐在行营里的子不得被攻击（安全岛），但它自己可以打人。
     3. 大本营：只有一个入口；**走进大本营的子永远出不来**
        （开局就摆在大本营里的子同理）。军旗必须落在大本营。
     4. 不动子：地雷、军旗永不移动。
     5. 吃子：大子吃小子，同级同归于尽；炸弹与任何子同归于尽；
        地雷只认工兵（工兵挖雷，其余子撞雷即亡、雷不动）；扛走军旗立即获胜。
     6. 司令阵亡 → 该方军旗被迫翻开（暗棋的通行规则）。
     7. 判负：军旗被扛 / 轮到你走却无任何合法着法（困毙）。
     8. 连续 RULES.QUIET_LIMIT 手无伤亡 → 按剩余子力判定，防无限拖局。
     9. 暗棋：对方军衔不公开。阵亡者翻开；存活者按公开战果**收窄嫌疑集合**
        （"它吃了我的团长还活着"→ 它只能是能吃掉团长的那几个军衔之一）。
        双方开局子力构成（12 种 25 子）是公开信息，所以"还剩哪些种类没翻开"
        也是公开信息 —— AI 用嫌疑分布做期望，**不看底牌**。

   SECTION: 知识口径
     本作的棋盘几何是自己在 junqi-data.js 里定义的一套（5 列 × 12 行、
     每半场 25 兵站 + 5 行营 + 2 大本营、环行营区一圈铁路），
     与实体军棋盘的通行画法一致，但以下细则按本作口径实现并在游戏内说明：
     · 行营与本方/对方半场的斜线只从行营辐射（兵站之间没有斜线）
     · 大本营的三个方向里只保留朝本方内侧的那一个入口
     · 中线 5 个点两两对接，且都是铁路 —— 所以开局就能沿铁路直冲对面
   ============================================================ */
window.JUNQI_CORE = (function () {
  'use strict';

  var D = window.JUNQI_DATA;

  /* SECTION: rng */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  /* SECTION: fight · 吃子表（全作唯一事实来源，单测逐格核对） */
  function fight(atkK, defK) {
    var A = D.BY_KIND[atkK], B = D.BY_KIND[defK];
    if (B.flag) { return { aDie: false, bDie: true, flag: true }; }
    if (A.immobile) { return { aDie: true, bDie: false }; }      // 地雷/军旗不会主动打人
    if (A.bomb || B.bomb) { return { aDie: true, bDie: true, boom: true }; }
    if (B.mine) {
      return A.k === 'gongBing'
        ? { aDie: false, bDie: true, dig: true }
        : { aDie: true, bDie: false };
    }
    if (A.rank > B.rank) { return { aDie: false, bDie: true }; }
    if (A.rank < B.rank) { return { aDie: true, bDie: false }; }
    return { aDie: true, bDie: true };
  }

  /* 由 fight() 反推两张"嫌疑收窄"表 —— 规则只在一处定义，推导演绎自动跟着改
     BEAT_AS[死者]   = 作为进攻方，能吃掉它且自己活着回来的军衔集合
     HOLD_AS[进攻者] = 作为防守方，挨这一下不会死的军衔集合（同归于尽不算守住） */
  var BEAT_AS = {}, HOLD_AS = {};
  D.PIECES.forEach(function (victim) {
    var m = 0;
    D.PIECES.forEach(function (atk) {
      var r = fight(atk.k, victim.k);
      if (r.bDie && !r.aDie) { m |= 1 << atk.idx; }
    });
    BEAT_AS[victim.k] = m;
  });
  D.PIECES.forEach(function (atk) {
    var m = 0;
    D.PIECES.forEach(function (victim) {
      if (!fight(atk.k, victim.k).bDie) { m |= 1 << victim.idx; }
    });
    HOLD_AS[atk.k] = m;
  });

  /* SECTION: placement
     布阵合法性：军旗只进大本营；地雷只进后三行；炸弹不进大本营行；行营不放子。 */
  function nodeAllows(side, nodeId, kind) {
    var n = D.NODES[nodeId];
    if (!n || n.side !== side) { return false; }
    if (n.kind === 'camp') { return false; }
    var def = D.BY_KIND[kind];
    if (!def) { return false; }
    var i = D.localRow(side, n.r);
    if (def.flag) { return n.kind === 'hq'; }
    if (def.mine) { return D.DEPLOY.mineRows.indexOf(i) >= 0; }
    if (def.bomb) { return i >= D.DEPLOY.bombMinRow; }
    return true;
  }

  function stationNodes(side) {
    return D.NODES.filter(function (n) { return n.side === side && n.kind !== 'camp'; }).map(function (n) { return n.id; });
  }
  function hqNodes(side) {
    return D.NODES.filter(function (n) { return n.side === side && n.kind === 'hq'; }).map(function (n) { return n.id; });
  }
  function mineNodes(side) {
    return D.NODES.filter(function (n) {
      return n.side === side && n.kind !== 'camp' && D.DEPLOY.mineRows.indexOf(D.localRow(side, n.r)) >= 0;
    }).map(function (n) { return n.id; });
  }
  function bombNodes(side) {
    return D.NODES.filter(function (n) {
      return n.side === side && n.kind !== 'camp' && D.localRow(side, n.r) >= D.DEPLOY.bombMinRow;
    }).map(function (n) { return n.id; });
  }

  function pick(rng, arr) { return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]; }
  function without(arr, v) { return arr.filter(function (x) { return x !== v; }); }

  /* SECTION: randomLayout
     guard（0~1）= 护旗强度：关越高，蓝方越会把地雷糊在军旗大本营的入口上。
     返回 [{node, k}]，长度必须正好 25。 */
  function randomLayout(side, rng, guard) {
    guard = guard || 0;
    var free = stationNodes(side);
    var out = [];
    var hqs = hqNodes(side);
    var flagHq = pick(rng, hqs);

    out.push({ node: flagHq, k: 'junQi' });
    free = without(free, flagHq);

    var entry = D.NODES[flagHq].hqEntry;
    var mines = mineNodes(side).filter(function (id) { return free.indexOf(id) >= 0; });
    var mineLeft = D.BY_KIND.diLei.n;

    /* ① 军旗门口堵一颗雷（最实在的护旗） */
    if (guard > 0 && mines.indexOf(entry) >= 0 && rng() < guard) {
      out.push({ node: entry, k: 'diLei' }); free = without(free, entry);
      mines = without(mines, entry); mineLeft--;
    }
    /* ② 另一个大本营放雷，别把能动的子白关进去 */
    var bluffHq = hqs.filter(function (id) { return id !== flagHq; })[0];
    if (guard > 0.25 && bluffHq != null && free.indexOf(bluffHq) >= 0 && rng() < guard * 0.8) {
      out.push({ node: bluffHq, k: 'diLei' }); free = without(free, bluffHq);
      mines = without(mines, bluffHq); mineLeft--;
    }
    /* ③ 剩下的雷优先贴着入口的邻点铺，凑不上再随机 */
    var ring = entry == null ? [] : D.ADJ[entry].map(function (e) { return e.to; })
      .filter(function (id) { return mines.indexOf(id) >= 0 && free.indexOf(id) >= 0; });
    while (mineLeft > 0) {
      var cand = (guard > 0 && ring.length && rng() < guard) ? ring
        : mines.filter(function (id) { return free.indexOf(id) >= 0; });
      if (!cand.length) { break; }
      var node = pick(rng, cand);
      out.push({ node: node, k: 'diLei' });
      free = without(free, node); mines = without(mines, node);
      ring = ring.filter(function (id) { return id !== node; });
      mineLeft--;
    }
    /* ④ 炸弹：合法点里随机丢 */
    var bombs = bombNodes(side).filter(function (id) { return free.indexOf(id) >= 0; });
    var bombLeft = D.BY_KIND.zhaDan.n;
    while (bombLeft > 0 && bombs.length) {
      var b = pick(rng, bombs);
      out.push({ node: b, k: 'zhaDan' });
      free = without(free, b); bombs = without(bombs, b); bombLeft--;
    }
    while (bombLeft > 0) {          // 兜底（合法点被占光）：退回任意空点
      var b2 = pick(rng, free);
      out.push({ node: b2, k: 'zhaDan' }); free = without(free, b2); bombLeft--;
    }
    /* ⑤ 其余 19 子随机铺满剩下的兵站 */
    var rest = [];
    D.PIECES.forEach(function (p) {
      if (p.k === 'junQi' || p.k === 'diLei' || p.k === 'zhaDan') { return; }
      for (var i = 0; i < p.n; i++) { rest.push(p.k); }
    });
    shuffle(rng, rest); shuffle(rng, free);
    for (var j = 0; j < rest.length; j++) { out.push({ node: free[j], k: rest[j] }); }
    return out;
  }

  function shuffle(rng, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function layoutValid(side, layout) {
    if (!layout || layout.length !== D.DEPLOY.total) { return false; }
    var used = {}, cnt = {}, flags = 0;
    for (var i = 0; i < layout.length; i++) {
      var it = layout[i];
      if (used[it.node]) { return false; }
      used[it.node] = 1;
      cnt[it.k] = (cnt[it.k] || 0) + 1;
      if (!nodeAllows(side, it.node, it.k)) { return false; }
      if (D.BY_KIND[it.k].flag) { flags++; }
    }
    if (flags !== 1) { return false; }
    for (var j = 0; j < D.PIECES.length; j++) {
      if ((cnt[D.PIECES[j].k] || 0) !== D.PIECES[j].n) { return false; }
    }
    return true;
  }

  /* SECTION: state */
  function newPiece(st, owner, k, node) {
    var pid = 'p' + (st.seq++) + '_' + owner;
    var p = {
      id: pid, owner: owner, k: k, node: node, alive: true, revealed: false,
      /* mask 是"公开信息能推到哪一步"，开局只能是全集合 ——
         一开始就写成精确军衔等于让 AI 和嫌疑提示直接看穿暗棋 */
      mask: D.MASK_ALL
    };
    st.pieces[pid] = p; st.occ[node] = pid; st.byOwner[owner].push(pid);
    return p;
  }

  function createGame(opts) {
    opts = opts || {};
    var rng = makeRng(opts.seed == null ? ((Date.now() & 0x7fffffff) ^ 0x5bf036) : opts.seed);
    var hidden = opts.hidden !== false;
    var level = Math.max(1, Math.min(D.LEVELS.length, opts.level || 1));
    var st = {
      hidden: hidden, level: level, seed: opts.seed == null ? 0 : opts.seed,
      occ: new Array(D.N).fill(null), pieces: {}, byOwner: [[], []],
      seq: 1, turn: 0, plies: 0, quiet: 0,
      winner: null, reason: '', over: false,
      log: [], logNo: 0, lastFrom: {}, repeat: {}, phase: 'deploy'
    };
    var lays = [
      opts.layout0 || randomLayout(0, rng, opts.guard0 == null ? 0.2 : opts.guard0),
      opts.layout1 || randomLayout(1, rng, D.LEVELS[level - 1].layout)
    ];
    if (!layoutValid(0, lays[0])) { throw new Error('红方布阵不合法'); }
    if (!layoutValid(1, lays[1])) { throw new Error('蓝方布阵不合法'); }
    for (var s = 0; s < 2; s++) {
      lays[s].forEach(function (it) { newPiece(st, s, it.k, it.node); });
    }
    return st;
  }

  /* SECTION: 可见性
     自己的子对自己永远透明；暗棋只隐藏对方的军衔。 */
  function isKnown(st, pid, observer) {
    var p = st.pieces[pid];
    if (!p) { return true; }
    return !st.hidden || p.owner === observer || p.revealed;
  }
  function nameOf(st, pid, observer) {
    var p = st.pieces[pid];
    if (!p) { return '？'; }
    return isKnown(st, pid, observer) ? D.BY_KIND[p.k].name : '？';
  }

  /* SECTION: movegen */
  function railNext(from, dr, dc) {
    var es = D.ADJ[from];
    for (var i = 0; i < es.length; i++) {
      if (es[i].kind === 'rail' && es[i].dr === dr && es[i].dc === dc) { return es[i].to; }
    }
    return -1;
  }

  /* 能不能打这个点上的子：友军不行、行营里的不行 */
  function targetable(st, node, occPid, owner) {
    if (occPid == null) { return false; }
    if (st.pieces[occPid].owner === owner) { return false; }
    return D.NODES[node].kind !== 'camp';
  }

  function nodeMoves(st, pid) {
    var p = st.pieces[pid];
    if (!p || !p.alive) { return []; }
    var def = D.BY_KIND[p.k], n = D.NODES[p.node];
    if (def.immobile || n.kind === 'hq') { return []; }
    var out = [], hit = {};
    function push(to, capture, via) {
      if (hit[to]) { if (via === 'rail') { hit[to].via = 'rail'; } return; }
      hit[to] = { to: to, capture: capture, via: via };
      out.push(hit[to]);
    }
    /* 公路一步 */
    D.ADJ[p.node].forEach(function (e) {
      var occ = st.occ[e.to];
      if (occ == null) { push(e.to, null, 'road'); }
      else if (targetable(st, e.to, occ, p.owner)) { push(e.to, occ, 'road'); }
    });
    if (n.rail) {
      /* 铁路直线滑行：方向一路到底，途中第一个有子者收尾 */
      var dirs = {};
      D.ADJ[p.node].forEach(function (e) { if (e.kind === 'rail') { dirs[e.dr + ',' + e.dc] = 1; } });
      Object.keys(dirs).forEach(function (key) {
        var d = key.split(','), dr = +d[0], dc = +d[1], cur = p.node;
        for (;;) {
          var nxt = railNext(cur, dr, dc);
          if (nxt < 0) { break; }
          var occ = st.occ[nxt];
          if (occ == null) { push(nxt, null, 'rail'); cur = nxt; continue; }
          if (targetable(st, nxt, occ, p.owner)) { push(nxt, occ, 'rail'); }
          break;
        }
      });
      /* 工兵专属：铁路任意拐弯 = 只在铁路边上做 BFS */
      if (p.k === 'gongBing') {
        var q = [p.node], vis = {};
        vis[p.node] = 1;
        while (q.length) {
          var cur2 = q.shift(), es = D.ADJ[cur2];
          for (var i = 0; i < es.length; i++) {
            if (es[i].kind !== 'rail') { continue; }
            var occ2 = st.occ[es[i].to];
            if (occ2 == null) {
              if (!vis[es[i].to]) { vis[es[i].to] = 1; push(es[i].to, null, 'rail'); q.push(es[i].to); }
            } else if (targetable(st, es[i].to, occ2, p.owner)) {
              push(es[i].to, occ2, 'rail');
            }
          }
        }
      }
    }
    return out;
  }

  function alivePids(st, side) {
    return st.byOwner[side].filter(function (pid) { return st.pieces[pid].alive; });
  }
  /* 能动的子：排除地雷/军旗，以及站在大本营里的（一进不出） */
  function mobilePids(st, side) {
    return alivePids(st, side).filter(function (pid) {
      var p = st.pieces[pid];
      return !D.BY_KIND[p.k].immobile && D.NODES[p.node].kind !== 'hq';
    });
  }
  function allMoves(st, side) {
    var out = [];
    mobilePids(st, side).forEach(function (pid) {
      nodeMoves(st, pid).forEach(function (m) {
        out.push({ pid: pid, from: st.pieces[pid].node, to: m.to, capture: m.capture, via: m.via });
      });
    });
    return out;
  }

  /* SECTION: make / unmake
     AI 要"走一步、再看看对手反手吃什么"，所以必须能精确回退。 */
  function makeMove(st, mv) {
    var p = st.pieces[mv.pid];
    var def = mv.capture == null ? null : st.pieces[mv.capture];
    var rec = {
      pid: p.id, from: p.node, to: mv.to, defId: def ? def.id : null,
      snap: [], turn: st.turn, plies: st.plies, quiet: st.quiet,
      winner: st.winner, reason: st.reason, over: st.over, logNo: st.logNo,
      hadLastFrom: (p.id in st.lastFrom), lastFrom: st.lastFrom[p.id],
      repeatKey: p.id + '>' + mv.to, forcedFlag: null
    };
    function snap(pid) {
      var q = st.pieces[pid];
      rec.snap.push({ pid: pid, node: q.node, alive: q.alive, revealed: q.revealed, mask: q.mask });
    }
    snap(p.id);
    if (def) { snap(def.id); }

    var res = { aDie: false, bDie: false, flag: false };
    if (def) {
      res = fight(p.k, def.k);
      if (res.bDie) { def.alive = false; def.revealed = true; }
      if (res.aDie) { p.alive = false; p.revealed = true; }
      /* 公开战果 → 收窄存活者的嫌疑集合（两个都死就没得推了） */
      if (!res.aDie && res.bDie && !p.revealed) { p.mask &= BEAT_AS[def.k]; }
      if (res.aDie && !res.bDie && !def.revealed) { def.mask &= HOLD_AS[p.k]; }
      if (res.flag) { st.winner = p.owner; st.reason = 'flag'; st.over = true; }
    } else {
      p.mask &= D.MASK_MOVABLE;          // 会动的子必然不是地雷/军旗
    }

    /* 落点归属：进攻方活着就站上去；死了则防守方留在原地 */
    st.occ[rec.from] = null;
    if (res.aDie) { st.occ[rec.to] = res.bDie ? null : def.id; }
    else { st.occ[rec.to] = p.id; p.node = rec.to; }

    /* 司令阵亡 → 该方军旗被迫翻开 */
    var lostSiling = (def && !def.alive && def.k === 'siLing') ? def.owner
      : (!p.alive && p.k === 'siLing' ? p.owner : null);
    if (lostSiling != null && st.hidden) {
      st.byOwner[lostSiling].forEach(function (pid2) {
        var q = st.pieces[pid2];
        if (q.alive && q.k === 'junQi' && !q.revealed) { q.revealed = true; rec.forcedFlag = pid2; }
      });
    }

    st.quiet = (res.aDie || res.bDie) ? 0 : st.quiet + 1;
    st.plies++;
    st.lastFrom[p.id] = rec.from;
    st.repeat[rec.repeatKey] = (st.repeat[rec.repeatKey] || 0) + 1;
    st.turn = 1 - st.turn;
    st.logNo++;
    rec.evt = {
      no: st.logNo, side: p.owner, atk: p.id, def: def ? def.id : null,
      from: rec.from, to: rec.to, res: res, aK: p.k, dK: def ? def.k : null,
      dig: !!res.dig, boom: !!res.boom, over: st.over
    };
    st.log.push(rec.evt);
    if (!st.over) { checkEnd(st); }
    return rec;
  }

  function unmakeMove(st, rec) {
    rec.snap.forEach(function (s) {
      var q = st.pieces[s.pid];
      q.node = s.node; q.alive = s.alive; q.revealed = s.revealed; q.mask = s.mask;
    });
    if (rec.forcedFlag) { st.pieces[rec.forcedFlag].revealed = false; }
    st.occ[rec.to] = rec.defId;
    st.occ[rec.from] = rec.pid;
    st.turn = rec.turn; st.plies = rec.plies; st.quiet = rec.quiet;
    st.winner = rec.winner; st.reason = rec.reason; st.over = rec.over; st.logNo = rec.logNo;
    if (rec.hadLastFrom) { st.lastFrom[rec.pid] = rec.lastFrom; } else { delete st.lastFrom[rec.pid]; }
    st.repeat[rec.repeatKey] = (st.repeat[rec.repeatKey] || 0) - 1;
    if (st.repeat[rec.repeatKey] <= 0) { delete st.repeat[rec.repeatKey]; }
    st.log.pop();
    return st;
  }

  /* SECTION: end */
  function material(st, side) {
    return st.byOwner[side].reduce(function (v, pid) {
      var p = st.pieces[pid];
      return v + (p.alive ? D.BY_KIND[p.k].val : 0);
    }, 0);
  }
  function aliveCount(st, side) {
    return st.byOwner[side].filter(function (pid) { return st.pieces[pid].alive; }).length;
  }
  function checkEnd(st) {
    if (st.over) { return st; }
    var side = st.turn;
    if (!allMoves(st, side).length) {
      st.over = true; st.winner = 1 - side; st.reason = 'stalemate'; return st;
    }
    if (st.quiet >= D.RULES.QUIET_LIMIT || st.plies >= D.RULES.PLY_LIMIT) {
      var m0 = material(st, 0), m1 = material(st, 1);
      st.over = true;
      st.winner = m0 === m1 ? -1 : (m0 > m1 ? 0 : 1);
      st.reason = 'adjudicate';
    }
    return st;
  }

  /* SECTION: belief
     暗棋期望：某个未翻开的子"是什么"= 嫌疑集合 ∩ 尚未翻开的子力构成，按数量加权。
     子力构成与阵亡清单都是公开信息，所以这套推算玩家自己也能做，AI 没有偷看底牌。 */
  function poolOf(st, observer) {
    var cnt = new Array(D.KIND_N).fill(0), total = 0;
    alivePids(st, 1 - observer).forEach(function (pid) {
      var p = st.pieces[pid];
      if (!p.revealed) { cnt[D.BY_KIND[p.k].idx]++; total++; }
    });
    return { cnt: cnt, total: total };
  }
  function suspects(st, pid, observer) {
    var p = st.pieces[pid];
    if (!p) { return []; }
    if (isKnown(st, pid, observer)) { return [{ k: p.k, p: 1 }]; }
    var pool = poolOf(st, observer);
    var list = [], sum = 0;
    D.PIECES.forEach(function (def) {
      var w = (p.mask & (1 << def.idx)) ? pool.cnt[def.idx] : 0;
      if (w > 0) { list.push({ k: def.k, w: w }); sum += w; }
    });
    /* 嫌疑集合与剩余构成完全对不上（推演出矛盾）时退化成按构成均匀猜 */
    if (!sum) {
      D.PIECES.forEach(function (def) {
        if (pool.cnt[def.idx] > 0) { list.push({ k: def.k, w: pool.cnt[def.idx] }); sum += pool.cnt[def.idx]; }
      });
    }
    if (!sum) { return []; }
    return list.map(function (x) { return { k: x.k, p: x.w / sum }; });
  }
  function evValue(st, pid, observer) {
    var list = suspects(st, pid, observer), s = 0, w = 0;
    list.forEach(function (x) { s += x.p * D.BY_KIND[x.k].val; w += x.p; });
    return w ? s / w : 30;
  }
  /* 从 observer 视角看一次对撞的期望净收益（正 = observer 占便宜） */
  function evClash(st, moverPid, targetPid, observer) {
    var mover = st.pieces[moverPid], target = st.pieces[targetPid];
    if (!mover || !target) { return 0; }
    var A = suspects(st, moverPid, observer), B = suspects(st, targetPid, observer);
    var sum = 0, wsum = 0;
    for (var i = 0; i < A.length; i++) {
      for (var j = 0; j < B.length; j++) {
        var r = fight(A[i].k, B[j].k), w = A[i].p * B[j].p, g = 0;
        if (r.flag) { g = mover.owner === observer ? 900 : -900; }
        else {
          if (r.bDie) { g += (target.owner === observer ? -1 : 1) * D.BY_KIND[B[j].k].val; }
          if (r.aDie) { g += (mover.owner === observer ? -1 : 1) * D.BY_KIND[A[i].k].val; }
        }
        sum += g * w; wsum += w;
      }
    }
    return wsum ? sum / wsum : 0;
  }

  /* SECTION: 着法评分
     静态分 = 立即战果期望 + 推进 + 炸弹纪律 + 反循环；
     再按关卡系数扣掉"对手反手能吃多少"与"旗会不会被扛"。 */
  function posBonus(st, side, p, to) {
    var s = (D.advOf(side, to) - D.advOf(side, p.node)) * (0.9 + Math.max(0, st.quiet - 18) * 0.12);
    if (p.k === 'gongBing') {
      var minesLeft = alivePids(st, 1 - side).filter(function (q) { return st.pieces[q].k === 'diLei'; }).length;
      /* 对方还有雷，工兵往雷区（对方后三行）钻就是正事 */
      if (minesLeft && D.localRow(1 - side, D.NODES[to].r) >= 3) { s += 3.5; }
    }
    if (D.NODES[to].kind === 'camp') { s += 1.2; }
    if (D.NODES[to].kind === 'hq') { s -= 6; }        // 进大本营就出不来，等于自废一子
    return s;
  }

  function staticScore(st, mv, observer) {
    var p = st.pieces[mv.pid];
    var s = 0;
    if (mv.capture != null) {
      var def = st.pieces[mv.capture];
      if (D.BY_KIND[def.k].flag && isKnown(st, def.id, observer)) { return 1e6; }
      s += evClash(st, p.id, def.id, observer);
      /* 暗棋：按"它是军旗的嫌疑比例"给一点尝试奖励 ——
         绝不能直接读 def.k，那是底牌，玩家也看不到 */
      if (!isKnown(st, def.id, observer)) {
        var sus = suspects(st, def.id, observer), pFlag = 0;
        sus.forEach(function (x) { if (x.k === 'junQi') { pFlag = x.p; } });
        s += 40 * pFlag;
      }
      /* 炸弹换小子不值 */
      if (p.k === 'zhaDan') {
        var ev = evValue(st, def.id, observer);
        if (ev < 55) { s -= (55 - ev) * 1.5; }
      }
      /* 拿大子去啃看不清的子，期望已经算进去了，再压一手"输不起" */
      if (!isKnown(st, def.id, observer) && D.BY_KIND[p.k].val >= 70) { s -= 6; }
    }
    s += posBonus(st, observer, p, mv.to);
    if (st.lastFrom[p.id] != null && mv.to === st.lastFrom[p.id]) { s -= 7; }
    var rep = st.repeat[p.id + '>' + mv.to] || 0;
    if (rep) { s -= 5 * rep; }
    return s;
  }

  /* 对手下一手能占多少便宜，以及能不能直接扛走我们的旗 */
  function threatOf(st, observer) {
    var best = 0, flagRisk = false, flagNode = null;
    alivePids(st, observer).forEach(function (pid) {
      if (st.pieces[pid].k === 'junQi') { flagNode = st.pieces[pid].node; }
    });
    mobilePids(st, 1 - observer).forEach(function (pid) {
      nodeMoves(st, pid).forEach(function (m) {
        if (flagNode != null && m.to === flagNode) { flagRisk = true; return; }
        if (m.capture == null) { return; }
        var loss = -evClash(st, pid, m.capture, observer);
        if (loss > best) { best = loss; }
      });
    });
    return { gain: best, flagRisk: flagRisk };
  }

  /* SECTION: chooseMove
     两段式：静态分排序 → 取前 refine 件逐个试算对手反击。
     难度只动三个旋钮：忌惮系数 reply、候选数 refine、扰动 noise。 */
  function chooseMove(st, side, opts) {
    opts = opts || {};
    var L = D.LEVELS[Math.max(0, Math.min(D.LEVELS.length - 1,
      (opts.level || st.level) - 1))];
    var rng = opts.rng || makeRng(((st.seed || 0) * 7919 + st.plies * 104729 + side * 31 + 13) >>> 0);
    var moves = allMoves(st, side);
    if (!moves.length) { return null; }

    var scored = moves.map(function (mv) { return { mv: mv, base: staticScore(st, mv, side) }; });
    scored.sort(function (a, b) { return b.base - a.base; });

    /* 扛旗是终结技，不用算 */
    if (scored[0].base >= 1e5) {
      return { mv: scored[0].mv, score: scored[0].base, why: '扛旗', cands: 1 };
    }

    var refine = Math.min(L.refine, scored.length), cands = [];
    for (var j = 0; j < refine; j++) {
      var c = scored[j], rec = makeMove(st, c.mv);
      var t = threatOf(st, side);
      var s = c.base - L.reply * Math.max(0, t.gain);
      if (t.flagRisk) { s -= 1200 * L.guard; }
      s += (rng() - 0.5) * 2 * L.noise;
      unmakeMove(st, rec);
      cands.push({ mv: c.mv, score: s });
    }
    cands.sort(function (a, b) { return b.score - a.score; });
    var top = cands[0];
    var why = top.mv.capture != null ? '吃 ' + nameOf(st, top.mv.capture, side)
      : (D.NODES[top.mv.to].kind === 'hq' ? '占大本营' : (st.quiet > 18 ? '推进' : '调度'));
    return { mv: top.mv, score: top.score, why: why, cands: cands.length };
  }

  /* SECTION: deploy
     布阵阶段可以两两交换，但换完必须仍然合法（旗还在大本营、雷还在后三行、炸弹别进大本营行）。 */
  function canSwap(st, side, pidA, pidB) {
    if (!pidA || !pidB || pidA === pidB) { return false; }
    var a = st.pieces[pidA], b = st.pieces[pidB];
    if (!a || !b || a.owner !== side || b.owner !== side) { return false; }
    if (!a.alive || !b.alive) { return false; }
    return nodeAllows(side, b.node, a.k) && nodeAllows(side, a.node, b.k);
  }
  function swap(st, side, pidA, pidB) {
    if (!canSwap(st, side, pidA, pidB)) { return false; }
    var a = st.pieces[pidA], b = st.pieces[pidB];
    var na = a.node, nb = b.node;
    a.node = nb; b.node = na;
    st.occ[na] = b.id; st.occ[nb] = a.id;
    return true;
  }
  function relayout(st, side, rng) {
    var lay = randomLayout(side, rng || makeRng((st.seed || 1) * 31 + st.plies + 7), 0.2);
    if (!layoutValid(side, lay)) { return false; }
    st.byOwner[side].forEach(function (pid) { delete st.pieces[pid]; });
    for (var i = 0; i < D.N; i++) {
      if (st.occ[i] && st.pieces[st.occ[i]] && st.pieces[st.occ[i]].owner === side) { st.occ[i] = null; }
    }
    st.byOwner[side] = [];
    lay.forEach(function (it) {
      newPiece(st, side, it.k, it.node);
    });
    return true;
  }

  /* SECTION: describe
     战报文案按观察者可见信息生成 —— 暗棋不泄露对方军衔，但阵亡者一律翻开。 */
  function describe(st, evt, observer) {
    var side = D.SIDE[evt.side];
    var aDead = !st.pieces[evt.atk] || !st.pieces[evt.atk].alive;
    var aName = (isKnown(st, evt.atk, observer) || aDead) ? D.BY_KIND[evt.aK].name : '？';
    var dName = '';
    if (evt.def) {
      var dDead = !st.pieces[evt.def] || !st.pieces[evt.def].alive;
      dName = (isKnown(st, evt.def, observer) || dDead) ? D.BY_KIND[evt.dK].name : '？';
    }
    var r = evt.res, head = side.name + ' ' + aName;
    if (!evt.def) { return { head: head, tail: ' → ' + posLabel(evt.to), kind: 'move' }; }
    if (r.flag) { return { head: head, tail: ' 扛走军旗！', kind: 'flag' }; }
    if (r.dig) { return { head: head, tail: ' 挖掉地雷', kind: 'dig' }; }
    if (r.aDie && r.bDie) { return { head: head, tail: ' 与 ' + dName + ' 同归于尽', kind: 'boom' }; }
    if (r.bDie) { return { head: head, tail: ' 吃掉 ' + dName, kind: 'win' }; }
    return { head: head, tail: ' 撞 ' + dName + ' 阵亡', kind: 'lose' };
  }

  var COL_NAME = ['一', '二', '三', '四', '五'];
  function posLabel(nodeId) {
    var n = D.NODES[nodeId];
    var tag = n.kind === 'hq' ? '大本营' : (n.kind === 'camp' ? '行营' : '兵站');
    var half = n.side === 1 ? '蓝方' : '红方';
    return half + '第' + (D.localRow(n.side, n.r) + 1) + '排' + COL_NAME[n.c] + '（' + tag + '）';
  }

  /* SECTION: scoreOf
     赢 = 基础 × 难度倍率（暗棋再乘）+ 剩余子力 + 速胜；
     输/和按"打掉对方多少子"给安慰分，不至于白打。 */
  function scoreOf(st, side) {
    var S = D.SCORE;
    var mult = S.levelMult[Math.max(0, Math.min(S.levelMult.length - 1, st.level - 1))];
    if (st.hidden) { mult *= S.hiddenMult; }
    var foe = 1 - side;
    var killed = st.byOwner[foe].reduce(function (v, pid) {
      return v + (st.pieces[pid].alive ? 0 : D.BY_KIND[st.pieces[pid].k].val);
    }, 0);
    if (st.winner === side) {
      var speed = Math.max(0, S.speedPlies - st.plies) * S.speedBonus;
      return Math.round(S.base * mult + material(st, side) / S.materialDiv + speed);
    }
    if (st.winner === -1) { return Math.round(killed * S.drawRatio); }
    return Math.round(killed * S.loseRatio);
  }

  function statsOf(st) {
    return {
      turn: st.turn, plies: st.plies, quiet: st.quiet, over: st.over, phase: st.phase,
      winner: st.winner, reason: st.reason, hidden: st.hidden, level: st.level,
      alive: [aliveCount(st, 0), aliveCount(st, 1)],
      material: [material(st, 0), material(st, 1)],
      movable: [allMoves(st, 0).length, allMoves(st, 1).length],
      logs: st.log.length
    };
  }

  return {
    fight: fight, BEAT_AS: BEAT_AS, HOLD_AS: HOLD_AS,
    nodeAllows: nodeAllows, randomLayout: randomLayout, layoutValid: layoutValid,
    makeRng: makeRng, createGame: createGame, isKnown: isKnown, nameOf: nameOf,
    railNext: railNext, nodeMoves: nodeMoves, allMoves: allMoves,
    alivePids: alivePids, mobilePids: mobilePids,
    makeMove: makeMove, unmakeMove: unmakeMove, checkEnd: checkEnd,
    material: material, aliveCount: aliveCount,
    poolOf: poolOf, suspects: suspects, evValue: evValue, evClash: evClash,
    chooseMove: chooseMove, threatOf: threatOf,
    canSwap: canSwap, swap: swap, relayout: relayout,
    describe: describe, posLabel: posLabel, scoreOf: scoreOf, statsOf: statsOf,
    shuffle: shuffle, place: newPiece,
    stationNodes: stationNodes, mineNodes: mineNodes, bombNodes: bombNodes, hqNodes: hqNodes
  };
})();
