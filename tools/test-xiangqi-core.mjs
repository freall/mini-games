/* ============================================================
   tools/test-xiangqi-core.mjs · 象棋规则引擎 + 开局库断言
   SECTION: test-xiangqi-core
   ------------------------------------------------------------
   xiangqi-engine.js / xiangqi-openings.js 只依赖一个全局对象（root），
   给个假的 root 就能在 node 里直接跑，不需要浏览器。
   （并入乐园时从源项目 test/engine.test.js 迁移过来，改成 ESM + 乐园的断言风格。）

   为什么值得写这么多：象棋的规则面很碎（马的蹩腿、象的塞眼与不过河、
   炮的隔子吃、将帅九宫与飞将、走完自检不送将、兵卒过河才能横走），
   以及最容易出错的一环 —— **中文记谱**（纵线编号红黑相反、
   "平"必须带起点纵线、马相仕写终点纵线、进退方向红黑相反、
   同线同兵种用"前/后"且置于棋子名之前）。
   这些在 UI 里都很难一眼看出走样，只能靠断言钉住。

   最后两节是守门用例：
     · 开局库 10 个开局的每一手都必须能从当前局面复现（记谱往返一致）
       —— 任何一条谱着写错，这里立刻红；
     · 开局库结构完整性（每个开局带够讲解字段，否则右栏会空一块）。

   用法：node tools/test-xiangqi-core.mjs
   ============================================================ */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const g = {};
for (const f of ['assets/xiangqi-engine.js', 'assets/xiangqi-openings.js']) {
  new Function('globalThis', readFileSync(join(ROOT, f), 'utf8'))(g);
}
const E = g.XQEngine, G = g.XQOpenings;

let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; out.push('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
function group(title) { out.push(''); out.push('=== ' + title + ' ==='); }

const P = E.parseFen;
const at = (b, r, c) => { const p = b[r][c]; return p ? p.s + p.t : '.'; };
/* pieceMoves 返回 {r,c}；测试里统一用 {tr,tc} 断言，与引擎的着法格式对齐 */
const pm = (b, r, c) => E.pieceMoves(b, r, c).map(m => ({ tr: m.r, tc: m.c }));
const mv = (fr, fc, tr, tc) => ({ fr, fc, tr, tc });
const has = (list, tr, tc) => list.some(m => m.tr === tr && m.tc === tc);

/* ============================================================
   1 · 初始局面
   ============================================================ */
group('1. 初始局面');
let st = P(E.START_FEN);
ok('黑将(0,4)', at(st.board, 0, 4) === 'bK', at(st.board, 0, 4));
ok('红帅(9,4)', at(st.board, 9, 4) === 'rK', at(st.board, 9, 4));
ok('红车(9,0)/(9,8)', at(st.board, 9, 0) === 'rR' && at(st.board, 9, 8) === 'rR');
ok('红马(9,1)/(9,7)', at(st.board, 9, 1) === 'rH' && at(st.board, 9, 7) === 'rH');
ok('红炮(7,1)/(7,7)', at(st.board, 7, 1) === 'rC' && at(st.board, 7, 7) === 'rC');
ok('红兵 5 枚', st.board[6].filter(p => p && p.t === 'P').length === 5);
ok('黑卒 5 枚', st.board[3].filter(p => p && p.t === 'P').length === 5);
ok('红先行', st.side === 'r');
/* FEN 字母表是最容易写错的一处：象棋 FEN 用 rnbakabnr（马=n、象=b）。
   写成 h/e 不会报错，只会静默解析成空盘 —— 源项目 README 记过这个坑。 */
ok('FEN 字母表用 rnbakabnr（马 n、象 b），写成 h/e 会静默变空盘',
  E.parseFen('9/9/9/9/9/9/9/9/9/4n4 w').board[9][4] !== 0 &&
  E.parseFen('9/9/9/9/9/9/9/9/9/4h4 w').board[9][4] === 0);

/* ============================================================
   2 · 兵 / 卒
   ============================================================ */
group('2. 兵/卒：过河才能横走');
{
  const b = st.board;
  const m = pm(b, 6, 0);          /* 红兵 row6 col0 */
  ok('红兵未过河只能直进 1 格', m.length === 1 && has(m, 5, 0), JSON.stringify(m));
  const b2 = P('9/9/9/9/9/9/9/P8/9/9 w').board;   /* 兵在(7,0) 未过河 */
  ok('兵(7,0) 只能到 (6,0)', pm(b2, 7, 0).length === 1);
  b2[4][0] = { t: 'P', s: 'r' };                  /* row4 = 已过河（河界在 row4/5 之间） */
  b2[7][0] = 0;
  const m3 = pm(b2, 4, 0);
  ok('过河兵可横走 (4,0)→(4,1)', has(m3, 4, 1), JSON.stringify(m3));
  ok('过河兵仍可直进 (4,0)→(3,0)', has(m3, 3, 0));
  ok('过河兵不可倒退到 (5,0)', !has(m3, 5, 0));
  b2[5][0] = { t: 'P', s: 'r' }; b2[4][0] = 0;
  ok('兵在 row5 未过河，不可横走', !has(pm(b2, 5, 0), 5, 1), JSON.stringify(pm(b2, 5, 0)));
}

/* ============================================================
   3 · 马：蹩马腿
   ============================================================ */
group('3. 马：蹩马腿');
{
  const b = P('9/9/9/9/9/9/9/9/9/9 w').board;
  b[4][4] = { t: 'H', s: 'r' };
  ok('空盘马(4,4) 8 个落点', pm(b, 4, 4).length === 8, String(pm(b, 4, 4).length));
  b[3][4] = { t: 'P', s: 'r' };                   /* 正上方有子 → 蹩掉 2 个 */
  const m = pm(b, 4, 4);
  ok('上方被蹩后只剩 6 个', m.length === 6, String(m.length));
  ok('(2,3) 不可走', !has(m, 2, 3));
  ok('(2,5) 不可走', !has(m, 2, 5));
  ok('(3,2) 仍可走', has(m, 3, 2));
  const b2 = P('9/9/9/9/9/9/9/9/4n4/9 w').board;
  ok('马在(8,4) 只有 6 落点（其余越界）', pm(b2, 8, 4).length === 6, String(pm(b2, 8, 4).length));
}

/* ============================================================
   4 · 象 / 相：塞象眼 + 不过河
   ============================================================ */
group('4. 象/相：塞象眼 + 不过河');
{
  const b = P('9/9/9/9/9/9/9/9/9/9 w').board;
  b[2][0] = { t: 'E', s: 'b' };
  const m = pm(b, 2, 0);
  ok('黑象(2,0)→(0,2)(4,2)', has(m, 0, 2) && has(m, 4, 2) && m.length === 2, JSON.stringify(m));
  ok('黑象不过河（不出现 row>=5）', !m.some(x => x.tr >= 5));
  b[1][1] = { t: 'P', s: 'r' };
  ok('象眼被塞后 (0,2) 不可走', !has(pm(b, 2, 0), 0, 2));
  ok('另一路 (4,2) 仍可走', has(pm(b, 2, 0), 4, 2));
  const b3 = P('9/9/9/9/9/9/9/9/9/9 w').board;
  b3[9][2] = { t: 'E', s: 'r' };
  const m3 = pm(b3, 9, 2);
  ok('红相(9,2)→(7,0)(7,4)', has(m3, 7, 0) && has(m3, 7, 4) && m3.length === 2, JSON.stringify(m3));
  ok('红相不过河（不出现 row<5）', !m3.some(x => x.tr < 5));
}

/* ============================================================
   5 · 炮：隔子吃
   ============================================================ */
group('5. 炮：隔子吃');
{
  const b = P('9/9/9/9/9/9/9/9/9/4C4 w').board;    /* 炮(9,4) */
  ok('空盘炮横走到底 (9,0)', has(pm(b, 9, 4), 9, 0));
  b[6][4] = { t: 'P', s: 'b' };                    /* 正前方 (6,4) 黑卒 */
  let m = pm(b, 9, 4);
  ok('前方紧邻有子→不吃', !has(m, 6, 4) && has(m, 8, 4));
  b[2][4] = { t: 'P', s: 'b' };                    /* 再加一个 (2,4) */
  m = pm(b, 9, 4);
  ok('隔一子可吃 (2,4)', has(m, 2, 4));
  ok('中间 (5,4)(4,4)(3,4) 不可走', !has(m, 5, 4) && !has(m, 4, 4) && !has(m, 3, 4));
  b[2][4] = 0; b[2][3] = { t: 'P', s: 'r' };       /* 炮架后是己方子 */
  ok('炮架后己方子不可吃', !has(pm(b, 9, 4), 2, 3));
}

/* ============================================================
   6 · 将 / 帅：九宫 + 飞将
   ============================================================ */
group('6. 将/帅：九宫 + 飞将');
{
  const b = P('9/9/9/9/9/9/9/9/9/4K4 w').board;
  const m = pm(b, 9, 4);
  ok('帅在底线中路 3 个落点', m.length === 3, JSON.stringify(m));
  ok('帅不出九宫（(9,2) 不可走）', !has(m, 9, 2));
  const b2 = P('4k4/9/9/9/9/9/9/9/9/4K4 w').board;
  ok('同列无遮挡→可飞将吃将', has(pm(b2, 9, 4), 0, 4));
  b2[5][4] = { t: 'P', s: 'r' };
  ok('中间有子→不可飞将', !has(pm(b2, 9, 4), 0, 4));
}

/* ============================================================
   7 · 合法性：不能送将 / 不能照面
   ============================================================ */
group('7. 合法性：不能送将 / 不能照面');
{
  const b = P('4r4/9/9/9/9/9/9/9/9/4K4 w').board;   /* 红帅(9,4)，黑车(0,4) */
  ok('红方被将军', E.isInCheck(b, 'r'));
  ok('黑车可吃帅', has(pm(b, 0, 4), 9, 4));
  const lm = E.legalMoves(b, 'r');
  ok('合法着法均不送将', lm.every(m => !E.isInCheck(E.boardApply(b, m), 'r')));
  ok('帅可避到 (9,3)', has(lm, 9, 3));
  ok('合法性过滤也剔掉"照面"着法（走完将被飞）',
    E.legalMoves(P('4k4/9/9/9/9/9/9/9/9/4K4 w').board, 'r')
      .every(m => !E.isInCheck(E.boardApply(P('4k4/9/9/9/9/9/9/9/9/4K4 w').board, m), 'r')));
}

/* ============================================================
   8 · 终局：吃将
   ============================================================ */
group('8. 终局：吃将');
{
  const b = P('4k4/9/9/9/9/9/9/9/4R4/4K4 w').board;   /* 红车(8,4) 黑将(0,4) */
  ok('红车可吃黑将', has(pm(b, 8, 4), 0, 4));
  const nb = E.boardApply(b, mv(8, 4, 0, 4));
  ok('吃将后黑方无将 → isInCheck = true', E.isInCheck(nb, 'b'));
  ok('吃将后 findKing = null', E.findKing(nb, 'b') === null);
}

/* ============================================================
   9 · 中文记谱（本项目实现的标准）
   ============================================================ */
group('9. 中文记谱');
{
  const b = st.board;
  let r = E.moveToChinese(b, mv(7, 7, 7, 4));
  ok('红 炮(7,7)→(7,4) = 炮二平五', r.text === '炮二平五', r.text);
  r = E.moveToChinese(b, mv(0, 7, 2, 6));
  ok('黑 马(0,7)→(2,6) = 马8进7', r.text === '马8进7', r.text);
  r = E.moveToChinese(b, mv(6, 2, 5, 2));
  ok('红 兵(6,2)→(5,2) = 兵七进一', r.text === '兵七进一', r.text);
  r = E.moveToChinese(b, mv(9, 8, 9, 7));
  ok('红 车(9,8)→(9,7) = 车一平二', r.text === '车一平二', r.text);
  r = E.moveToChinese(b, mv(9, 0, 9, 1));
  ok('红 车(9,0)→(9,1) = 车九平八', r.text === '车九平八', r.text);
  r = E.moveToChinese(b, mv(3, 6, 4, 6));
  ok('黑 卒(3,6)→(4,6) = 卒7进1（黑方 row 变大才是进）', r.text === '卒7进1', r.text);
  const b3 = P('9/9/9/9/9/9/9/9/9/4K4 w').board;
  r = E.moveToChinese(b3, mv(9, 4, 8, 4));
  ok('帅(9,4)→(8,4) = 帅五进一', r.text === '帅五进一', r.text);
  const b4 = P('9/9/9/9/9/9/9/9/9/9 w').board;
  b4[9][6] = { t: 'E', s: 'r' };
  r = E.moveToChinese(b4, mv(9, 6, 7, 4));
  ok('相(9,6)→(7,4) = 相三进五（斜走写终点纵线）', r.text === '相三进五', r.text);
  /* 纵线编号：红方从右往左一..九，黑方从左往右 1..9 */
  ok('红方纵线 = 9-col（汉字）', E.sideFile(8, 'r') === '一' && E.sideFile(0, 'r') === '九');
  ok('黑方纵线 = col+1（阿拉伯数字）', E.sideFile(0, 'b') === '1' && E.sideFile(8, 'b') === '9');
  /* 黑方退：row 变小才是退 */
  const b5 = P('9/9/9/9/9/9/9/9/9/9 w').board;
  b5[2][4] = { t: 'C', s: 'b' };
  r = E.moveToChinese(b5, mv(2, 4, 3, 4));
  ok('黑 炮(2,4)→(3,4) = 炮5进1（黑方 row 变大是进）', r.text === '炮5进1', r.text);
  r = E.moveToChinese(b5, mv(2, 4, 1, 4));
  ok('黑 炮(2,4)→(1,4) = 炮5退1', r.text === '炮5退1', r.text);
}

/* ============================================================
   10 · 前 / 后 区分
   ============================================================ */
group('10. 前/后 区分（且置于棋子名之前）');
{
  const b = P('9/9/9/9/9/9/P1P6/9/9/9 w').board;    /* (6,0)(6,2) 两兵不同线 */
  let r = E.moveToChinese(b, mv(6, 0, 5, 0));
  ok('单兵直进 = 兵九进一', r.text === '兵九进一', r.text);
  const b2 = P('9/9/9/9/P8/9/P8/9/9/9 w').board;    /* 同线两兵 (4,0)(6,0) */
  r = E.moveToChinese(b2, mv(4, 0, 3, 0));
  ok('同线两兵：红方 row 小者在「前」→ 前兵进一', r.text === '前兵进一', r.text);
  r = E.moveToChinese(b2, mv(6, 0, 5, 0));
  ok('同线两兵：后兵进一', r.text === '后兵进一', r.text);
  ok('「前/后」必须在棋子名之前（兵前进一 是错的）',
    !/^兵(前|后)/.test(r.text) && /^(前|后)/.test(r.text), r.text);
  const b3 = P('9/9/9/9/9/9/9/9/9/R3R4 w').board;
  r = E.moveToChinese(b3, mv(9, 0, 8, 0));
  ok('双车不同纵线 → 车九进一（不加前/后）', r.text === '车九进一', r.text);
  const b5 = P('9/9/9/9/9/9/9/9/9/9 w').board;
  b5[9][0] = { t: 'R', s: 'r' };
  b5[8][0] = { t: 'R', s: 'r' };
  r = E.moveToChinese(b5, mv(9, 0, 7, 0));
  ok('同线双车 (9,0) = 后车进二', r.text === '后车进二', r.text);
  r = E.moveToChinese(b5, mv(8, 0, 7, 0));
  ok('同线双车 (8,0) = 前车进一', r.text === '前车进一', r.text);
  /* 黑方：row 大者靠红方底线，才是"前" */
  const b6 = P('9/9/9/9/9/9/9/9/9/9 w').board;
  b6[0][0] = { t: 'R', s: 'b' };
  b6[3][0] = { t: 'R', s: 'b' };
  r = E.moveToChinese(b6, mv(3, 0, 4, 0));
  ok('黑方同线双车：靠红方底线者(3,0) 是「前」→ 前车进1', r.text === '前车进1', r.text);
}

/* ============================================================
   11 · parts 结构（讲解层靠它拼"为什么这么记"）
   ============================================================ */
group('11. 记谱 parts 结构');
{
  const r = E.moveToChinese(st.board, mv(7, 7, 7, 4));
  ok('parts.name/from/dir/to 齐全',
    !!r.parts && r.parts.name === '炮' && r.parts.from === '二' &&
    r.parts.dir === '平' && r.parts.to === '五', JSON.stringify(r.parts));
  ok('fromFile/toFile 给的是逻辑列号', r.fromFile === 7 && r.toFile === 4,
    r.fromFile + '→' + r.toFile);
  const r2 = E.moveToChinese(P('9/9/9/9/P8/9/P8/9/9/9 w').board, mv(4, 0, 3, 0));
  ok('前/后走法 positional = true', r2.positional === true);
  const r3 = E.moveToChinese(st.board, mv(9, 8, 9, 7));
  ok('非前后走法 positional = false', r3.positional === false);
  ok('空格起手返回占位文本而不是抛异常',
    E.moveToChinese(P(E.START_FEN).board, mv(5, 5, 5, 4)).text === '？');
}

/* ============================================================
   12 · 开局库：逐手合法性 + 记谱往返一致（守门用例）
   ============================================================ */
group('12. 开局库：逐手合法性 + 记谱往返');
{
  ok('开局库已加载（10 个开局）', Array.isArray(G.OPENINGS) && G.OPENINGS.length === 10,
    'n=' + (G.OPENINGS ? G.OPENINGS.length : 0));
  const bad = [];
  G.OPENINGS.forEach(op => {
    let b = E.parseFen(E.START_FEN).board, side = 'r';
    op.moves.forEach((m, i) => {
      const lm = E.legalMoves(b, side);
      const hit = lm.find(x => E.moveToChinese(b, x).text === m.text);
      if (!hit) { bad.push(op.id + ' 第' + (i + 1) + '手 "' + m.text + '" 不合法或记谱不符'); }
      else { b = E.boardApply(b, hit); }
      side = side === 'r' ? 'b' : 'r';
    });
  });
  ok('全部开局的每一手都合法且与记谱一致', bad.length === 0, bad.slice(0, 6).join(' | '));

  /* 主变长度一致（右栏棋谱按回合成对排版，奇数手会留空格） */
  const odd = G.OPENINGS.filter(op => op.moves.length % 2 !== 0).map(op => op.id);
  ok('每个开局主变都是偶数手（棋谱成对）', odd.length === 0, odd.join(','));

  /* 结构完整性：右栏会逐字段渲染，缺一个就是一块空白 */
  const miss = [];
  G.OPENINGS.forEach(op => {
    if (!op.id || !op.name) { miss.push(op.id + ':id/name'); }
    if (!op.intro) { miss.push(op.id + ':intro'); }
    if (!Array.isArray(op.idea) || op.idea.length < 2) { miss.push(op.id + ':idea'); }
    if (!Array.isArray(op.keys) || !op.keys.length) { miss.push(op.id + ':keys'); }
    if (!Array.isArray(op.tag) || !op.tag.length) { miss.push(op.id + ':tag'); }
    if (op.side !== 'r' && op.side !== 'b') { miss.push(op.id + ':side'); }
    if (!(op.level >= 1 && op.level <= 3)) { miss.push(op.id + ':level'); }
    (op.keys || []).forEach(k => {
      if (!(k.at >= 0 && k.at < op.moves.length)) { miss.push(op.id + ':key.at=' + k.at); }
    });
  });
  ok('每个开局字段齐全（intro/idea/keys/tag/side/level 且 key.at 落在主变内）',
    miss.length === 0, miss.slice(0, 6).join(' | '));

  /* 讲解里不许出现 undefined/NaN（源项目真实踩过：undefined. 红方 马二进三） */
  const junk = [];
  G.OPENINGS.forEach(op => {
    const blob = JSON.stringify(op.moves) + JSON.stringify(op.keys) + JSON.stringify(op.idea);
    if (/undefined|NaN/.test(blob)) { junk.push(op.id); }
  });
  ok('开局库数据里没有 undefined/NaN', junk.length === 0, junk.join(','));

  /* 红/黑两侧都要有开局 —— 左侧列表按 side 分组，缺一边就是空标题 */
  ok('红方先手开局 6 个 / 黑方应对 4 个',
    G.OPENINGS.filter(o => o.side === 'r').length === 6 &&
    G.OPENINGS.filter(o => o.side === 'b').length === 4);
}

/* ============================================================
   13 · 守门：开局库 → 特殊局面（吃子 / 将军标记）
   ============================================================ */
group('13. 开局库里的将军与吃子');
{
  /* 中炮对屏风马那局全程不该出现吃子（6 手都是出动大子）；这是数据侧的合理性断言 */
  let b = E.parseFen(E.START_FEN).board, side = 'r', captures = 0;
  const op = G.OPENINGS.find(o => o.id === 'zhongpao');
  op.moves.forEach(m => {
    const lm = E.legalMoves(b, side);
    const hit = lm.find(x => E.moveToChinese(b, x).text === m.text);
    if (hit) { if (b[hit.tr][hit.tc]) { captures++; } b = E.boardApply(b, hit); }
    side = side === 'r' ? 'b' : 'r';
  });
  ok('中炮开局 6 手内不吃子（谱着只出动大子）', captures === 0, 'captures=' + captures);
  /* 走完那一局，红方没有被将军（开局库不该走出自己被将的谱） */
  ok('中炮开局走完后红方未被将军', E.isInCheck(b, 'r') === false);
  /* 每一手走完，都不能出现"己方走完后轮到的一方无将" */
  ok('吃将不会在合法着法里出现（legalMoves 已过滤送将）',
    E.legalMoves(E.parseFen(E.START_FEN).board, 'r')
      .every(m => E.findKing(E.boardApply(E.parseFen(E.START_FEN).board, m), 'r') !== null));
}

out.push('');
out.push(`断言：${pass} 通过 / ${fail} 失败`);
console.log(out.join('\n'));
process.exit(fail ? 1 : 0);
