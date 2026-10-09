/* =========================================================================
 * xiangqi-board.js —— 棋盘渲染与动画（Canvas 2D）
 * SECTION: xiangqi-board
 * （并入小游戏乐园时由源项目 js/board.js 改名而来，内容不变）
 *
 * 坐标系：棋盘逻辑格 9 列 x 10 行，格宽 CELL（含边距）。
 *   视觉坐标：红方在下（row 9 在底部），与 engine.js 的 row 一致。
 *   x = MARGIN + col * CELL
 *   y = MARGIN + row * CELL
 * ========================================================================= */
(function (root) {
  'use strict';

  const CELL = 62;          // 格间距
  const MARGIN = 56;        // 棋盘外缘留白（放得下棋子半径 26 + 纵线编号）
  const R = 26;             // 棋子半径

  const W = MARGIN * 2 + CELL * 8;
  const H = MARGIN * 2 + CELL * 9;

  const COLORS = {
    board:    '#f0d9a8',   // 木色棋盘
    boardEdge:'#b48a52',
    line:     '#6b4f2a',
    riverText:'#8a6a3c',
    red:      '#c62828',
    redBg:    '#fff6ee',
    black:    '#1f2937',
    blackBg:  '#f4f4f2',
    sel:      'rgba(214,158,46,0.55)',
    lastA:    'rgba(46,120,214,0.30)',
    lastB:    'rgba(46,120,214,0.30)',
    hint:     'rgba(46,160,90,0.35)'
  };

  // 名称映射（红黑两面）
  const GLYPH = {
    r: { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵' },
    b: { K: '将', A: '士', E: '象', H: '马', R: '车', C: '炮', P: '卒' }
  };
  // 红方用红字，黑方用黑字。传统做法：红方棋子写红字，黑方写黑字（用"将士象"区分）
  const GLYPH_FULL = {
    r: { K: '帥', A: '仕', E: '相', H: '傌', R: '俥', C: '炮', P: '兵' },
    b: { K: '將', A: '士', E: '象', H: '馬', R: '車', C: '砲', P: '卒' }
  };

  function px(col) { return MARGIN + col * CELL; }
  function py(row) { return MARGIN + row * CELL; }

  /** 屏幕/鼠标坐标 → 逻辑格；返回 {r,c} 或 null（不在盘内） */
  function toCell(mx, my) {
    const c = Math.round((mx - MARGIN) / CELL);
    const r = Math.round((my - MARGIN) / CELL);
    if (r < 0 || r > 9 || c < 0 || c > 8) return null;
    // 容差：离交点太远判定为未命中
    if (Math.abs(px(c) - mx) > CELL * 0.48 || Math.abs(py(r) - my) > CELL * 0.48) return null;
    return { r: r, c: c };
  }

  /* ---------------- 绘制 ---------------- */
  function drawBoardBase(ctx) {
    // 底色
    ctx.fillStyle = COLORS.board;
    ctx.fillRect(0, 0, W, H);

    // 木纹（细横线，低透明度）
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#5a3d1c';
    for (let i = 0; i < 60; i++) {
      const y = (i * 13.7) % H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y + (i % 3) - 1);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'square';

    // 10 条横线
    for (let r = 0; r < 10; r++) {
      ctx.beginPath();
      ctx.moveTo(px(0), py(r));
      ctx.lineTo(px(8), py(r));
      ctx.stroke();
    }
    // 9 条竖线：中间 7 条在河界处断开
    for (let c = 0; c < 9; c++) {
      if (c === 0 || c === 8) {
        ctx.beginPath();
        ctx.moveTo(px(c), py(0));
        ctx.lineTo(px(c), py(9));
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(px(c), py(0)); ctx.lineTo(px(c), py(4)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px(c), py(5)); ctx.lineTo(px(c), py(9)); ctx.stroke();
      }
    }
    // 九宫斜线
    [[0, 3, 2, 5], [0, 5, 2, 3], [7, 3, 9, 5], [7, 5, 9, 3]].forEach(([r1, c1, r2, c2]) => {
      ctx.beginPath();
      ctx.moveTo(px(c1), py(r1));
      ctx.lineTo(px(c2), py(r2));
      ctx.stroke();
    });

    // 外框加粗
    ctx.lineWidth = 3;
    ctx.strokeRect(px(0) - 8, py(0) - 8, CELL * 8 + 16, CELL * 9 + 16);
    ctx.strokeStyle = COLORS.boardEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(px(0) - 13, py(0) - 13, CELL * 8 + 26, CELL * 9 + 26);

    // 河界文字
    ctx.fillStyle = COLORS.riverText;
    ctx.font = '300 22px "KaiTi","STKaiti",serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ry = (py(4) + py(5)) / 2;
    ctx.save();
    ctx.translate(px(2) - CELL * 0.55, ry);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('楚 河', 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(px(6) + CELL * 0.55, ry);
    ctx.rotate(Math.PI / 2);
    ctx.fillText('汉 界', 0, 0);
    ctx.restore();

    // 兵/炮起始位的星位小折角（传统棋盘上的定位标记）
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1.3;
    const marks = [[2, 1], [2, 7], [7, 1], [7, 7],
                   [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
                   [6, 0], [6, 2], [6, 4], [6, 6], [6, 8]];
    marks.forEach(([r, c]) => {
      const x = px(c), y = py(r), d = 5, g = 4;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
        if (c === 0 && sx < 0) return;
        if (c === 8 && sx > 0) return;
        ctx.beginPath();
        ctx.moveTo(x + sx * g, y + sy * (g + d));
        ctx.lineTo(x + sx * g, y + sy * g);
        ctx.lineTo(x + sx * (g + d), y + sy * g);
        ctx.stroke();
      });
    });
  }

  function drawPiece(ctx, row, col, piece, opt) {
    opt = opt || {};
    const x = px(col), y = py(row);
    const isRed = piece.s === 'r';
    const rad = opt.rad || R;

    ctx.save();
    ctx.shadowColor = 'rgba(60,40,20,0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;

    // 棋子底（圆）
    const g = ctx.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.15, x, y, rad);
    g.addColorStop(0, isRed ? '#ffffff' : '#ffffff');
    g.addColorStop(1, isRed ? '#fbe6d6' : '#e9e9e6');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // 外圈
    ctx.strokeStyle = isRed ? COLORS.red : COLORS.black;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke();
    // 内圈
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, rad - 4, 0, Math.PI * 2); ctx.stroke();

    // 字
    ctx.fillStyle = isRed ? COLORS.red : COLORS.black;
    ctx.font = '700 ' + Math.round(rad * 1.16) + 'px "KaiTi","STKaiti","SimSun",serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPH_FULL[piece.s][piece.t], x, y + 1);
  }

  /** 整盘渲染
   *  opts = { selected:{r,c}, lastMove:{fr,fc,tr,tc}, hints:[{r,c}], check:{r,c},
   *           anim:{board, from:{r,c}, to:{r,c}, t:0..1, piece} }
   */
  function render(ctx, board, opts) {
    opts = opts || {};
    ctx.clearRect(0, 0, W, H);
    drawBoardBase(ctx);

    // 上一步痕迹
    if (opts.lastMove) {
      [[opts.lastMove.fr, opts.lastMove.fc], [opts.lastMove.tr, opts.lastMove.tc]].forEach(([r, c]) => {
        ctx.fillStyle = COLORS.lastA;
        ctx.beginPath(); ctx.arc(px(c), py(r), R + 3, 0, Math.PI * 2); ctx.fill();
      });
    }
    // 选中
    if (opts.selected) {
      ctx.fillStyle = COLORS.sel;
      ctx.beginPath(); ctx.arc(px(opts.selected.c), py(opts.selected.r), R + 4, 0, Math.PI * 2); ctx.fill();
    }
    // 可走点提示
    if (opts.hints && opts.hints.length) {
      opts.hints.forEach(h => {
        const occupied = !!(opts.hintTargets && opts.hintTargets.some(t => t.r === h.r && t.c === h.c));
        if (occupied) {
          ctx.strokeStyle = COLORS.hint.replace('0.35', '0.9');
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(px(h.c), py(h.r), R + 2, 0, Math.PI * 2); ctx.stroke();
        } else {
          ctx.fillStyle = COLORS.hint;
          ctx.beginPath(); ctx.arc(px(h.c), py(h.r), 9, 0, Math.PI * 2); ctx.fill();
        }
      });
    }

    // 棋子（动画中的那枚单独处理）
    const anim = opts.anim;
    const animFrom = anim ? anim.from : null;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = board[r][c];
        if (!p) continue;
        if (animFrom && animFrom.r === r && animFrom.c === c) continue;  // 稍后画
        drawPiece(ctx, r, c, p);
      }
    }

    // 被吃棋子淡出（动画中目标格的旧子）
    if (anim && anim.captured) {
      const caps = anim.captured;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - anim.t * 1.6);
      drawPiece(ctx, caps.r, caps.c, caps.p);
      ctx.restore();
    }

    // 动画中的棋子：走直线 + 抛物线抬起
    if (anim && animFrom) {
      const x0 = px(animFrom.c), y0 = py(animFrom.r);
      const x1 = px(anim.to.c), y1 = py(anim.to.r);
      const t = anim.t;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const lift = Math.sin(Math.PI * t) * 8;      // 抬起高度
      const piece = anim.piece || board[animFrom.r][animFrom.c];
      if (piece) drawPieceXY(ctx, x, y - lift, piece, R, Math.sin(Math.PI * t) * 0.10);
    }

    // 将军标记
    if (opts.check) {
      ctx.save();
      ctx.strokeStyle = 'rgba(220,40,40,0.85)';
      ctx.lineWidth = 3.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.arc(px(opts.check.c), py(opts.check.r), R + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawPieceXY(ctx, x, y, piece, rad, scaleExtra) {
    const isRed = piece.s === 'r';
    const rad2 = rad * (1 + (scaleExtra || 0));
    ctx.save();
    ctx.shadowColor = 'rgba(60,40,20,0.4)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    const g = ctx.createRadialGradient(x - rad2 * 0.35, y - rad2 * 0.35, rad2 * 0.15, x, y, rad2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, isRed ? '#fbe6d6' : '#e9e9e6');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rad2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.strokeStyle = isRed ? COLORS.red : COLORS.black;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, rad2, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, rad2 - 4, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = isRed ? COLORS.red : COLORS.black;
    ctx.font = '700 ' + Math.round(rad2 * 1.16) + 'px "KaiTi","STKaiti","SimSun",serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPH_FULL[piece.s][piece.t], x, y + 1);
  }

  root.XQBoard = {
    CELL: CELL, MARGIN: MARGIN, R: R, W: W, H: H,
    px: px, py: py, toCell: toCell, render: render,
    drawPiece: drawPiece, GLYPH: GLYPH
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
