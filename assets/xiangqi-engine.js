/* =========================================================================
 * xiangqi-engine.js —— 中国象棋规则引擎（无依赖，纯逻辑，可被 node 直接跑断言）
 * SECTION: xiangqi-engine
 * （并入小游戏乐园时由源项目 js/engine.js 改名而来，内容不变）
 *
 * 坐标：col 0..8（左→右，红方视角），row 0..9 / 0 在上（黑方底线）、9 在下（红方底线）
 * 棋盘用 10x9 二维数组：board[row][col] = 0 空，否则 {t:类型, s:方}
 *   类型 t: 'K'帅 'A'仕 'E'相 'H'马 'R'车 'C'炮 'P'兵卒
 *   方   s: 'r' 红（在下，行 5..9） | 'b' 黑（在上，行 0..4）
 *
 * 判负方式（本教学项目关心的是开局合法性，故以"吃将"作为终局判定，
 * 不实现长将/困毙/自然限着等竞赛细节——这些在开局阶段不会出现）。
 * ========================================================================= */
(function (root) {
  'use strict';

  /* ---------------- 初始局面 ---------------- */
  // 标准 FEN 起手式（黑在第 0 行，红在第 9 行）
  const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

  function parseFen(fen) {
    const board = [];
    for (let r = 0; r < 10; r++) board.push(new Array(9).fill(0));
    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split('/');
    const side = parts[1] === 'b' ? 'b' : 'r';
    const CODE = { k: 'K', a: 'A', b: 'E', n: 'H', r: 'R', c: 'C', p: 'P' };
    for (let r = 0; r < 10 && r < rows.length; r++) {
      let c = 0;
      for (const ch of rows[r]) {
        if (/[1-9]/.test(ch)) { c += +ch; continue; }
        const lo = ch.toLowerCase();
        if (!CODE[lo]) continue;
        if (c < 9) board[r][c] = { t: CODE[lo], s: ch === lo ? 'b' : 'r' };
        c++;
      }
    }
    return { board: board, side: side, moveNo: 1 };
  }

  /* ---------------- 基础工具 ---------------- */
  const inBoard = (r, c) => r >= 0 && r < 10 && c >= 0 && c < 9;

  // 九宫格范围：红 行 7..9，黑 行 0..2；列 3..5
  function inPalace(r, c, s) {
    if (c < 3 || c > 5) return false;
    return s === 'r' ? (r >= 7 && r <= 9) : (r >= 0 && r <= 2);
  }

  // 是否在本方河界内（相/象不能过河）
  function ownSideOfRiver(r, s) {
    return s === 'r' ? r >= 5 : r <= 4;
  }

  /* ---------------- 棋子走法生成 ---------------- */
  // 返回 {r, c} 目标格数组（不检查送将/自将）
  function pieceMoves(board, r, c) {
    const p = board[r][c];
    if (!p) return [];
    const out = [];
    const push = (rr, cc) => {
      if (!inBoard(rr, cc)) return false;
      const q = board[rr][cc];
      if (q && q.s === p.s) return false;   // 己方子挡住
      out.push({ r: rr, c: cc });
      return !q;                             // 空格可继续
    };

    switch (p.t) {
      case 'K': {
        [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
          const rr = r + dr, cc = c + dc;
          if (inPalace(rr, cc, p.s)) push(rr, cc);
        });
        // 将帅照面（飞将）：同列且中间无子，可直接吃对方将
        let rr = r + (p.s === 'r' ? -1 : 1);
        while (inBoard(rr, c)) {
          const q = board[rr][c];
          if (q) { if (q.t === 'K' && q.s !== p.s) out.push({ r: rr, c: c }); break; }
          rr += (p.s === 'r' ? -1 : 1);
        }
        break;
      }
      case 'A': {
        [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([dr, dc]) => {
          const rr = r + dr, cc = c + dc;
          if (inPalace(rr, cc, p.s)) push(rr, cc);
        });
        break;
      }
      case 'E': {
        // 象走田，塞象眼
        [[-2, -2], [-2, 2], [2, -2], [2, 2]].forEach(([dr, dc]) => {
          const rr = r + dr, cc = c + dc;
          if (!inBoard(rr, cc) || !ownSideOfRiver(rr, p.s)) return;
          if (board[r + dr / 2][c + dc / 2]) return;  // 象眼被堵
          push(rr, cc);
        });
        break;
      }
      case 'H': {
        // 马走日，蹩马腿：先直后斜，直向格有子则不可行
        [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]].forEach(([dr, dc]) => {
          const rr = r + dr, cc = c + dc;
          if (!inBoard(rr, cc)) return;
          const lr = Math.abs(dr) === 2 ? r + dr / 2 : r;
          const lc = Math.abs(dc) === 2 ? c + dc / 2 : c;
          if (board[lr][lc]) return;                  // 马腿被蹩
          push(rr, cc);
        });
        break;
      }
      case 'R': {
        [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
          let rr = r + dr, cc = c + dc;
          while (inBoard(rr, cc)) {
            const q = board[rr][cc];
            if (!q) { out.push({ r: rr, c: cc }); }
            else { if (q.s !== p.s) out.push({ r: rr, c: cc }); break; }
            rr += dr; cc += dc;
          }
        });
        break;
      }
      case 'C': {
        [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
          let rr = r + dr, cc = c + dc, jumped = false;
          while (inBoard(rr, cc)) {
            const q = board[rr][cc];
            if (!jumped) {
              if (!q) out.push({ r: rr, c: cc });
              else jumped = true;                     // 遇到炮架
            } else {
              if (q) { if (q.s !== p.s) out.push({ r: rr, c: cc }); break; }
            }
            rr += dr; cc += dc;
          }
        });
        break;
      }
      case 'P': {
        const fwd = p.s === 'r' ? -1 : 1;
        push(r + fwd, c);
        // 未过河只能向前；过河后可横走
        const crossed = p.s === 'r' ? r <= 4 : r >= 5;
        if (crossed) { push(r, c - 1); push(r, c + 1); }
        break;
      }
    }
    return out;
  }

  /* ---------------- 将军判定 / 合法性过滤 ---------------- */
  function findKing(board, s) {
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (p && p.t === 'K' && p.s === s) return { r: r, c: c };
    }
    return null;
  }

  // 某方是否正被将军（含将帅照面）
  function isInCheck(board, s) {
    const k = findKing(board, s);
    if (!k) return true;                       // 将被吃了
    const opp = s === 'r' ? 'b' : 'r';
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p || p.s !== opp) continue;
      const ms = pieceMoves(board, r, c);
      for (let i = 0; i < ms.length; i++) {
        if (ms[i].r === k.r && ms[i].c === k.c) return true;
      }
    }
    return false;
  }

  /* ---------------- 着法表示 ---------------- */
  // 内部着法格式：{fr, fc, tr, tc}（0..9 / 0..8）
  function boardApply(board, mv) {
    const nb = board.map(row => row.slice());
    nb[mv.tr][mv.tc] = nb[mv.fr][mv.fc];
    nb[mv.fr][mv.fc] = 0;
    return nb;
  }

  // 生成合法着法（过滤掉走完后自己被将军的，以及两个将照面的）
  function legalMoves(board, side) {
    const res = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p || p.s !== side) continue;
      const ms = pieceMoves(board, r, c);
      for (let i = 0; i < ms.length; i++) {
        const mv = { fr: r, fc: c, tr: ms[i].r, tc: ms[i].c };
        const nb = boardApply(board, mv);
        if (!isInCheck(nb, side)) res.push(mv);
      }
    }
    return res;
  }

  /* ---------------- 中文棋谱（纵线记谱法） ---------------- */
  // 红方用汉字数字，从右往左数 1..9；黑方用阿拉伯数字，从左往右数 1..9
  const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  // 红方 = 汉字，黑方 = 阿拉伯数字
  const sideFile = (col, side) => side === 'r' ? CN_NUM[9 - col] : String(col + 1);
  const sideNum  = (n, side)   => side === 'r' ? CN_NUM[n] : String(n);

  /**
   * 由「起始局面 + 着法」生成标准中文棋谱（纵线记谱法）。
   *
   * 规则（详见 README「记谱规则」）：
   *  1) 纵线编号：红方从右往左 一..九（汉字）；黑方从左往右 1..9（阿拉伯数字）。
   *  2) 格式 = 棋子名 + 起点纵线 + 动作 + 终点。
   *     - 平（横走）：终点纵线，如 炮二平五
   *     - 进/退（同线纵走）：红用汉字步数、黑用阿拉伯数字步数，如 车九进二 / 卒7进1
   *       ★ 特例：马/相/仕/士 无论进退都写「终点纵线」，如 马八进七、相三进五
   *  3) 进 / 退 的方向按「朝对方底线走」为进：
   *     红方在下（row 9 底、row 0 敌底）→ row 变小为进；
   *     黑方在上（row 0 底、row 9 敌底）→ row 变大为进。
   *  4) 同一纵线有两个同兵种棋子时，用「前/后」代替起点纵线：
   *     靠近对方底线的那个叫「前」。如 前马进七 / 后炮平四。
   *
   * 返回 {text, parts:{name, from, dir, to}, fromFile, toFile}
   */
  function moveToChinese(board, mv) {
    const p = board[mv.fr][mv.fc];
    if (!p) return { text: '？', parts: null };
    const s = p.s;
    const NAME = s === 'r'
      ? { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵' }
      : { K: '将', A: '士', E: '象', H: '马', R: '车', C: '炮', P: '卒' };
    const kindName = NAME[p.t];

    // ---- 1) 起点标识：默认起点纵线；同线同兵种则用 前/后 ----
    let fromTag = sideFile(mv.fc, s);
    let positional = false;
    const sameRow = [];
    for (let r = 0; r < 10; r++) {
      if (r === mv.fr) continue;
      const q = board[r][mv.fc];
      if (q && q.t === p.t && q.s === s) sameRow.push(r);
    }
    if (sameRow.length) {
      // 红方 row 越小越靠敌方底线（越"前"）；黑方反之
      const frontRow = s === 'r' ? Math.min(mv.fr, Math.min.apply(null, sameRow))
                                 : Math.max(mv.fr, Math.max.apply(null, sameRow));
      fromTag = (mv.fr === frontRow) ? '前' : '后';
      positional = true;
    }

    // ---- 2) 方向：以「朝敌方底线」为进 ----
    let dir;
    if (mv.tr === mv.fr) dir = '平';
    else {
      const forward = s === 'r' ? (mv.tr < mv.fr) : (mv.tr > mv.fr);
      dir = forward ? '进' : '退';
    }

    // ---- 3) 终点标识 ----
    let tail;
    if (dir === '平') {
      tail = sideFile(mv.tc, s);
    } else if (p.t === 'H' || p.t === 'E' || p.t === 'A') {
      // 马/相(象)/仕(士) 走斜线，一律写终点纵线
      tail = sideFile(mv.tc, s);
    } else {
      // 车/炮/兵(卒)/帅(将) 纵走 → 写步数
      tail = sideNum(Math.abs(mv.tr - mv.fr), s);
    }

    const text = positional ? (fromTag + kindName + dir + tail)
                            : (kindName + fromTag + dir + tail);
    return {
      text: text,
      parts: { name: kindName, from: fromTag, dir: dir, to: tail },
      fromFile: mv.fc,
      toFile: mv.tc,
      positional: positional
    };
  }

  /* ---------------- 导出 ---------------- */
  const API = {
    START_FEN: START_FEN,
    parseFen: parseFen,
    inBoard: inBoard,
    inPalace: inPalace,
    pieceMoves: pieceMoves,
    legalMoves: legalMoves,
    isInCheck: isInCheck,
    findKing: findKing,
    boardApply: boardApply,
    moveToChinese: moveToChinese,
    sideFile: sideFile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.XQEngine = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
