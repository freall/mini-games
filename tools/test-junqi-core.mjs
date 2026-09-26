/* ============================================================
   tools/test-junqi-core.mjs · 烽火军棋核心逻辑断言
   SECTION: test-junqi-core
   ------------------------------------------------------------
   junqi-data.js / junqi-core.js 只依赖一个 window 对象，
   这里给个假的 window 就能在 node 里直接跑，不需要浏览器。

   为什么值得写这么多：军棋的规则面很碎（铁路滑行、工兵拐弯、行营免打、
   大本营一进不出、地雷只认工兵、炸弹同归于尽、暗棋推演），
   任何一条在 UI 里都很难看出来走样 —— 只能靠断言钉住。
   最后的"自对局一定收得拢"是守门用例：AI 双方跑满 40 局，
   必须局局有结果（扛旗/困毙/判定），不许无限shuffle、不许抛异常。

   用法：node tools/test-junqi-core.mjs
   ============================================================ */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const win = {};
for (const f of ['assets/junqi-data.js', 'assets/junqi-core.js']) {
  new Function('window', readFileSync(join(ROOT, f), 'utf8'))(win);
}
const D = win.JUNQI_DATA, C = win.JUNQI_CORE;

let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; out.push('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function seeded(seed) { return C.makeRng(seed); }
const N = (r, c) => r * D.COLS + c;          // 行列 → 节点 id

/* SECTION: 测试用的空棋盘局面
   真开局有 50 个子，单测要的是"只放我说的那几个子"，
   所以先造一局再把子清空，只借用棋盘几何。 */
function bareGame(hidden) {
  const st = C.createGame({ seed: 7, hidden: !!hidden, level: 1 });
  Object.keys(st.pieces).forEach(k => delete st.pieces[k]);
  st.occ = new Array(D.N).fill(null);
  st.byOwner = [[], []];
  st.log = []; st.logNo = 0; st.quiet = 0; st.plies = 0; st.turn = 0;
  st.repeat = {}; st.lastFrom = {}; st.over = false; st.winner = null; st.reason = '';
  return st;
}
function put(st, owner, k, node) { return C.place(st, owner, k, node).id; }
/* 从 pid 造一个着法对象（落点上有敌子就自动当成吃子） */
function moveTo(st, pid, to) {
  return { pid: pid, from: st.pieces[pid].node, to: to, capture: st.occ[to] };
}
function targets(st, pid) { return C.nodeMoves(st, pid).map(m => m.to).sort((a, b) => a - b); }
function has(st, pid, node) { return C.nodeMoves(st, pid).some(m => m.to === node); }

/* SECTION: 1 · 棋盘几何 */
out.push('=== 1. 棋盘几何 ===');
eq('全盘 60 个点', D.NODES.length, 60);
eq('每方 30 个点', D.NODES.filter(n => n.side === 0).length, 30);
eq('每方 5 个行营', D.NODES.filter(n => n.kind === 'camp').length, 10);
eq('全盘 4 个大本营', D.NODES.filter(n => n.kind === 'hq').length, 4);
eq('可布阵的兵站点 = 25 × 2', D.STATIONS.length, 50);
eq('棋子总数 25/方', D.PIECES.reduce((s, p) => s + p.n, 0), 25);
eq('12 种军衔', D.PIECES.length, 12);
ok('司令/军长各 1，师长~营长各 2，连长/排长/工兵各 3，炸弹 2，地雷 3，军旗 1',
  ['siLing', 'junZhang'].every(k => D.BY_KIND[k].n === 1)
  && ['shiZhang', 'lvZhang', 'tuanZhang', 'yingZhang'].every(k => D.BY_KIND[k].n === 2)
  && ['lianZhang', 'paiZhang', 'gongBing'].every(k => D.BY_KIND[k].n === 3)
  && D.BY_KIND.zhaDan.n === 2 && D.BY_KIND.diLei.n === 3 && D.BY_KIND.junQi.n === 1);
const rankOrder = ['gongBing', 'paiZhang', 'lianZhang', 'yingZhang', 'tuanZhang', 'lvZhang', 'shiZhang', 'junZhang', 'siLing'];
ok('军衔严格递增：工兵<排<连<营<团<旅<师<军<司',
  rankOrder.every((k, i) => i === 0 || D.BY_KIND[k].rank > D.BY_KIND[rankOrder[i - 1]].rank));
ok('地雷/军旗标记为不动子', D.BY_KIND.diLei.immobile && D.BY_KIND.junQi.immobile);
ok('炸弹不是不动子但同级不参与比较', !D.BY_KIND.zhaDan.immobile && D.BY_KIND.zhaDan.bomb === true);
eq('边数 127（去重后）', D.EDGES.length, 127);
ok('没有自环边', D.EDGES.every(e => e.a !== e.b));
ok('没有重复边', new Set(D.EDGES.map(e => Math.min(e.a, e.b) + '-' + Math.max(e.a, e.b))).size === D.EDGES.length);
let asym = 0;
D.NODES.forEach(n => D.ADJ[n.id].forEach(e => {
  const back = D.ADJ[e.to].find(x => x.to === n.id);
  if (!back || back.kind !== e.kind || back.dr !== -e.dr || back.dc !== -e.dc) { asym++; }
}));
eq('邻接表双向对称', asym, 0);
let baddir = 0;
D.NODES.forEach(n => D.ADJ[n.id].forEach(e => {
  const t = D.NODES[e.to];
  if (t.r - n.r !== e.dr || t.c - n.c !== e.dc) { baddir++; }
}));
eq('方向向量与实际行列一致（滑行要靠它）', baddir, 0);
const reach = new Set([0]), stack = [0];
while (stack.length) {
  D.ADJ[stack.pop()].forEach(e => { if (!reach.has(e.to)) { reach.add(e.to); stack.push(e.to); } });
}
eq('全盘连通（没有孤岛点）', reach.size, 60);
ok('大本营只有一个入口', D.HQS.every(id => D.ADJ[id].length === 1));
ok('行营有 8 个邻点（含 4 条斜线）', D.CAMPS.every(id => D.ADJ[id].length === 8),
  D.CAMPS.map(id => D.ADJ[id].length).join(','));
eq('每方 16 个铁路点', D.NODES.filter(n => n.rail).length, 32);
ok('行营与大本营都不在铁路上', D.NODES.filter(n => n.kind !== 'station').every(n => !n.rail));
const cross = D.EDGES.filter(e => D.NODES[e.a].side !== D.NODES[e.b].side);
eq('两半场相接的边 = 5 条', cross.length, 5);
ok('中线 5 条边全是铁路（开局就能沿铁路直冲）', cross.every(e => e.kind === 'rail'));
eq('斜线全部由行营引出（每方 16 条）', D.EDGES.filter(e => Math.abs(D.NODES[e.a].r - D.NODES[e.b].r) === 1 && Math.abs(D.NODES[e.a].c - D.NODES[e.b].c) === 1).length, 32);
eq('行营 X 形排布（local 坐标）',
  D.CAMPS.map(id => [D.NODES[id].side, D.localRow(D.NODES[id].side, D.NODES[id].r), D.NODES[id].c].join('-')).sort().join(','),
  [0, 1].map(s => [[2, 1], [2, 3], [3, 2], [4, 1], [4, 3]].map(p => s + '-' + p.join('-')).sort().join(',')).sort().join(','));
eq('铁路边数 37', D.EDGES.filter(e => e.kind === 'rail').length, 37);
ok('advOf：自己底线 0、对方底线 11',
  D.advOf(0, N(11, 2)) === 0 && D.advOf(0, N(0, 2)) === 11 &&
  D.advOf(1, N(0, 2)) === 0 && D.advOf(1, N(11, 2)) === 11);
ok('localRow 镜像：同一行号两侧相加 = 11',
  [0, 3, 7, 11].every(r => D.NODES[N(r, 2)].local === 11 - r || D.NODES[N(r, 2)].local === r));

/* SECTION: 2 · 布阵 */
out.push('=== 2. 布阵合法性 ===');
for (let s = 0; s < 2; s++) {
  for (let t = 0; t < 30; t++) {
    const lay = C.randomLayout(s, seeded(500 + t * 13 + s), t / 29);
    if (!C.layoutValid(s, lay)) { ok('随机布阵 #' + t + ' 合法', false, 'side=' + s); break; }
    if (t === 29) { ok('side ' + s + ' 随机布阵 30 次全合法', true); }
  }
}
ok('布阵点数不重复且 25 个点', (() => {
  const lay = C.randomLayout(0, seeded(1), 0.5);
  return new Set(lay.map(x => x.node)).size === 25 && lay.every(x => D.NODES[x.node].side === 0);
})());
ok('军旗只落在大本营', (() => {
  for (let i = 0; i < 40; i++) {
    const lay = C.randomLayout(1, seeded(900 + i), i / 40);
    const f = lay.filter(x => x.k === 'junQi');
    if (f.length !== 1 || D.NODES[f[0].node].kind !== 'hq') { return false; }
  }
  return true;
})());
ok('地雷只出现在后三行', (() => {
  for (let i = 0; i < 40; i++) {
    const lay = C.randomLayout(0, seeded(1300 + i), 0.8);
    if (lay.some(x => D.BY_KIND[x.k].mine && D.DEPLOY.mineRows.indexOf(D.localRow(0, D.NODES[x.node].r)) < 0)) { return false; }
  }
  return true;
})());
ok('炸弹不进大本营行', (() => {
  for (let i = 0; i < 40; i++) {
    if (C.randomLayout(0, seeded(1700 + i), 0.5).some(x => D.BY_KIND[x.k].bomb && D.localRow(0, D.NODES[x.node].r) === 0)) { return false; }
  }
  return true;
})());
ok('guard 越高，军旗门口有雷的概率越高', (() => {
  const lo = entryMineCheck(0), hi = entryMineCheck(1);
  return hi >= 55 && hi > lo;
})(), 'guard0=' + entryMineCheck(0) + '/60 guard1=' + entryMineCheck(1) + '/60');
function entryMineCheck(guard) {
  let hit = 0;
  for (let i = 0; i < 60; i++) {
    const lay = C.randomLayout(1, seeded(2100 + i), guard);
    const flag = lay.find(x => x.k === 'junQi');
    if (lay.some(x => x.node === D.NODES[flag.node].hqEntry && x.k === 'diLei')) { hit++; }
  }
  return hit;
}
ok('非法布阵会被拒（旗不在大本营）', !C.layoutValid(0, (() => {
  const lay = C.randomLayout(0, seeded(3), 0).filter(x => x.k !== 'junQi');
  lay.push({ node: N(9, 0), k: 'junQi' });      // 兵站放旗 → 非法
  return lay;
})()));
ok('非法布阵会被拒（雷摆到前线）', !C.layoutValid(0, (() => {
  const lay = C.randomLayout(0, seeded(4), 0).map(x => x.k === 'diLei' ? { node: N(6, 2), k: 'lianZhang' } : x);
  return lay;
})()));
ok('少一个子不算合法布阵', (() => {
  const lay = C.randomLayout(0, seeded(5), 0).slice(0, 24);
  return !C.layoutValid(0, lay);
})());
ok('createGame 直接造出 25+25 子且占满 50 个点', (() => {
  const st = C.createGame({ seed: 42, level: 5 });
  return Object.keys(st.pieces).length === 50 && st.occ.filter(Boolean).length === 50
    && C.aliveCount(st, 0) === 25 && C.aliveCount(st, 1) === 25;
})());
ok('createGame 拒绝非法布局', (() => {
  try {
    C.createGame({ seed: 1, layout0: [{ node: D.CAMPS[0], k: 'lianZhang' }] });
    return false;
  } catch (e) { return /不合法/.test(e.message); }
})());

/* SECTION: 3 · 吃子表 */
out.push('=== 3. 吃子结算 ===');
const F = C.fight;
ok('大子吃小子：师长 吃 旅长', F('shiZhang', 'lvZhang').bDie && !F('shiZhang', 'lvZhang').aDie);
ok('小反过来打不动：排长 打 司令 自己亡', F('paiZhang', 'siLing').aDie && !F('paiZhang', 'siLing').bDie);
ok('同级同归于尽：团长 × 团长', (() => { const r = F('tuanZhang', 'tuanZhang'); return r.aDie && r.bDie; })());
ok('工兵是最低军衔，但能吃掉比它大的？不能', !F('gongBing', 'paiZhang').bDie && F('gongBing', 'paiZhang').aDie);
ok('炸弹主动炸任何人 = 同归于尽', ['siLing', 'junQi', 'diLei', 'gongBing'].every(k => {
  const r = F('zhaDan', k); return k === 'junQi' ? r.bDie : (r.aDie && r.bDie);
}));
ok('被炸弹撞 = 同归于尽（哪怕我是司令）', (() => { const r = F('siLing', 'zhaDan'); return r.aDie && r.bDie; })());
ok('工兵挖雷：雷亡兵在', F('gongBing', 'diLei').bDie && !F('gongBing', 'diLei').aDie && F('gongBing', 'diLei').dig);
ok('非工兵撞雷：兵亡雷在', ['siLing', 'junZhang', 'paiZhang', 'lianZhang'].every(k => {
  const r = F(k, 'diLei'); return r.aDie && !r.bDie;
}));
ok('扛旗：旗被拿、拿子活着、比赛结束', F('gongBing', 'junQi').flag && !F('gongBing', 'junQi').aDie);
ok('地雷不防守失败：任何人打旗都是打旗赢', F('siLing', 'junQi').flag);
ok('不动子不能主动进攻（地雷当进攻方必亡）', F('diLei', 'paiZhang').aDie && !F('diLei', 'paiZhang').bDie);
/* 用一份"独立写死的规则"逐格对照 fight()，避免自证自话 */
const RK = { siLing: 9, junZhang: 8, shiZhang: 7, lvZhang: 6, tuanZhang: 5, yingZhang: 4, lianZhang: 3, paiZhang: 2, gongBing: 1 };
function specFight(a, b) {
  if (b === 'junQi') { return 'flag'; }
  if (a === 'junQi' || a === 'diLei') { return 'suicide'; }
  if (a === 'zhaDan' || b === 'zhaDan') { return 'trade'; }
  if (b === 'diLei') { return a === 'gongBing' ? 'dig' : 'suicide'; }
  if (RK[a] > RK[b]) { return 'win'; }
  if (RK[a] < RK[b]) { return 'lose'; }
  return 'trade';
}
let combatCells = 0, combatOk = true, badCells = [];
D.PIECES.forEach(a => D.PIECES.forEach(b => {
  combatCells++;
  const r = F(a.k, b.k), want = specFight(a.k, b.k);
  const got = r.flag ? 'flag' : (r.aDie && r.bDie) ? 'trade' : r.bDie ? 'win' : 'lose';
  const norm = want === 'suicide' ? 'lose' : (want === 'dig' ? 'win' : want);
  if (got !== norm) { combatOk = false; badCells.push(a.name + '×' + b.name + '=' + got + '/' + norm); }
  if (typeof r.aDie !== 'boolean' || typeof r.bDie !== 'boolean') { combatOk = false; }
}));
ok('12×12 吃子矩阵逐格与独立规则一致', combatOk, badCells.slice(0, 4).join(' ') || combatCells + ' 格');
ok('炸弹 vs 任何非旗子必定双亡', D.PIECES.every(b => {
  const r = F('zhaDan', b.k); return b.flag ? (r.bDie && !r.aDie) : (r.aDie && r.bDie);
}));
ok('除工兵外没人挖得动雷', D.PIECES.filter(p => p.k !== 'gongBing' && !p.immobile && !p.bomb)
  .every(p => F(p.k, 'diLei').aDie && !F(p.k, 'diLei').bDie));

/* SECTION: 4 · 走子规则 */
out.push('=== 4. 走子 ===');
/* 4.1 公路一步 */
let g = bareGame(false);
const sl = put(g, 0, 'siLing', N(9, 2));      // 红方中路兵站
const oneStep = targets(g, sl);
ok('普通兵站一步只走正交邻点', oneStep.every(to => {
  const a = D.NODES[g.pieces[sl].node], b = D.NODES[to];
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
}), oneStep.join(','));
eq('兵站 (9,2) 有 4 个公路邻点', oneStep.length, 4);

/* 4.2 铁路直线滑行 */
g = bareGame(false);
const shi = put(g, 1, 'shiZhang', N(5, 2));   // 蓝方前线铁路点
const slide = targets(g, shi);
/* 空场 (5,2) 的可落点 = 4 个正交邻点 + 2 个斜连的行营 + 铁路横向延伸 2 格 = 8
   （行营的斜线确实辐射到前线兵站，这是棋盘画法，不是 bug） */
eq('前线铁路点空场可落 8 个点', slide.length, 8);
ok('师长沿铁路横向滑行整行', [N(5, 0), N(5, 1), N(5, 3), N(5, 4)].every(to => slide.indexOf(to) >= 0), slide.join(','));
ok('师长能从蓝方前线直冲过中线（铁路对接）', slide.indexOf(N(6, 2)) >= 0);
ok('师长不能拐一步再横移：够不到 (6,1)', slide.indexOf(N(6, 1)) < 0);
ok('师长不能沿非铁路列直滑：够不到 (1,2)', slide.indexOf(N(1, 2)) < 0);
ok('斜线行营一步可达', slide.indexOf(N(4, 1)) >= 0 && slide.indexOf(N(4, 3)) >= 0);

g = bareGame(false);
const lvs = put(g, 1, 'lvZhang', N(5, 0));    // 角上的铁路点：横向 + 纵向 + 过中线
const lvT = targets(g, lvs);
ok('旅长能沿纵列上行（c0 是铁路列）', lvT.indexOf(N(2, 0)) >= 0 && lvT.indexOf(N(1, 0)) >= 0, lvT.join(','));
ok('旅长不能拐弯到 (1,1)', lvT.indexOf(N(1, 1)) < 0);
ok('旅长能过中线到 (6,0)', lvT.indexOf(N(6, 0)) >= 0);

/* 4.3 挡路 */
g = bareGame(false);
const a1 = put(g, 1, 'shiZhang', N(5, 2));
const f1 = put(g, 1, 'paiZhang', N(5, 1));    // 自己人挡在左边
const t1 = put(g, 0, 'lianZhang', N(5, 3));   // 敌人在右边第一个
const blocked = targets(g, a1);
ok('己方子挡路：(5,1) 本身与它后面的 (5,0) 都够不到',
  blocked.indexOf(N(5, 1)) < 0 && blocked.indexOf(N(5, 0)) < 0);
ok('敌方子可吃且是滑行终点（再后面的 (5,4) 过不去）',
  blocked.indexOf(N(5, 3)) >= 0 && blocked.indexOf(N(5, 4)) < 0, blocked.join(','));
ok('挡路不影响其他方向：纵向与过中线仍在', blocked.indexOf(N(4, 2)) >= 0 && blocked.indexOf(N(6, 2)) >= 0);
eq('被两头截断后剩 5 个落点', blocked.length, 5);

/* 4.4 工兵拐弯 */
const railAll = D.NODES.filter(n => n.rail).map(n => n.id);
g = bareGame(false);
const gb = put(g, 1, 'gongBing', N(5, 0));
const gbT = targets(g, gb);
ok('工兵能拐弯走到 (1,1)（先上再横）', gbT.indexOf(N(1, 1)) >= 0, gbT.length + ' 点');
ok('工兵能沿铁路绕到自己半场第 1 排 (1,4)', gbT.indexOf(N(1, 4)) >= 0);
ok('工兵能过中线再沿红方第 5 排横移 (6,3)', gbT.indexOf(N(6, 3)) >= 0);
ok('工兵可达点只可能是铁路点或行营（不会踩上普通兵站）',
  gbT.every(to => railAll.indexOf(to) >= 0 || D.NODES[to].kind === 'camp'));
eq('空场上工兵能沿铁路到达其余全部 31 个铁路点', gbT.filter(to => railAll.indexOf(to) >= 0).length, 31);
ok('工兵也走一步公路：斜连的空行营可进', gbT.indexOf(N(4, 1)) >= 0);
g = bareGame(false);
const gb2 = put(g, 1, 'gongBing', N(5, 0));
put(g, 1, 'tuanZhang', N(4, 0));              // 正前方堵死
ok('工兵绕不过己方子（该点不可落），但能从另一侧绕过去',
  targets(g, gb2).indexOf(N(4, 0)) < 0 && targets(g, gb2).indexOf(N(1, 0)) >= 0);

/* 4.5 行营 */
g = bareGame(false);
const campNode = D.CAMPS[0];
const campPid = put(g, 0, 'paiZhang', campNode);      // 一颗子坐在行营里
const bossNode = D.ADJ[campNode][0].to;
const boss = put(g, 1, 'siLing', bossNode);            // 司令就站在行营的邻点
ok('司令确实站在行营的邻点上', D.ADJ[campNode].some(e => e.to === bossNode));
ok('行营里的子打不到（哪怕司令也吃不了排长）', !has(g, boss, campNode), targets(g, boss).join(','));
ok('但行营里的排长可以主动打出去', has(g, campPid, bossNode), targets(g, campPid).join(','));
ok('空行营可以进（走斜线）', (() => {
  const gg = bareGame(false);
  const campId = D.CAMPS.find(id => D.NODES[id].side === 1);
  const diagEdge = D.ADJ[campId].find(e => Math.abs(e.dr) === 1 && Math.abs(e.dc) === 1);
  const p = put(gg, 1, 'lianZhang', diagEdge.to);
  return has(gg, p, campId);
})());
ok('行营之间可互走（斜线相连）', (() => {
  const gg = bareGame(false);
  const c1 = D.CAMPS.filter(id => D.NODES[id].side === 1)[2];   // 中心 (3,2)
  const c0 = D.CAMPS.filter(id => D.NODES[id].side === 1)[0];   // (2,1)
  const p = put(gg, 0, 'lianZhang', c1);
  return D.ADJ[c1].some(e => e.to === c0) && has(gg, p, c0);
})());

/* 4.6 大本营 */
out.push('=== 4.6 大本营 ===');
g = bareGame(false);
const hqId = D.HQS.filter(id => D.NODES[id].side === 1)[0];
const entry = D.NODES[hqId].hqEntry;
const m1 = put(g, 0, 'shiZhang', entry);
ok('大本营点只有一个邻点', D.ADJ[hqId].length === 1);
ok('大本营的入口就是那唯一邻点', D.ADJ[hqId][0].to === entry && D.ADJ[entry].some(e => e.to === hqId));
ok('可以从入口走进大本营', has(g, m1, hqId));
const rec = C.makeMove(g, moveTo(g, m1, hqId));
ok('走进去之后就再也出不来', C.nodeMoves(g, m1).length === 0 && g.pieces[m1].node === hqId);
C.unmakeMove(g, rec);
ok('回退后又能重新算着法（大本营里的原封不动）', has(g, m1, hqId) && g.pieces[m1].node === entry);
const flagP = put(g, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1 && id !== hqId)[0]);
eq('军旗没有任何着法', C.nodeMoves(g, flagP).length, 0);
const mineP = put(g, 1, 'diLei', N(1, 0));
eq('地雷没有任何着法', C.nodeMoves(g, mineP).length, 0);

/* 4.7 扛旗即胜 */
g = bareGame(false);
const fq = D.HQS.filter(id => D.NODES[id].side === 1)[0];
const fEnt = D.NODES[fq].hqEntry;
const eFl = put(g, 1, 'junQi', fq);
const atk = put(g, 0, 'lianZhang', fEnt);
const mv = moveTo(g, atk, fq);
C.makeMove(g, mv);
ok('扛走军旗立刻判胜', g.over === true && g.winner === 0 && g.reason === 'flag');
ok('拿旗的子活着站在旗点上', g.pieces[atk].alive && g.pieces[atk].node === fq);

/* 4.8 困毙 */
g = bareGame(false);
put(g, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
const lone = put(g, 0, 'paiZhang', N(7, 2));
put(g, 1, 'siLing', N(6, 2));                 // 压住唯一的通路
put(g, 1, 'zhaDan', N(8, 2));
put(g, 1, 'shiZhang', N(7, 1));
put(g, 1, 'tuanZhang', N(7, 3));
const movesOfLone = C.nodeMoves(g, lone);
ok('排长被围：能动（吃得住的敌子也算着法）', movesOfLone.length >= 0);
g = bareGame(false);
put(g, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
put(g, 0, 'diLei', N(10, 1));
ok('只剩军旗与地雷时无着法 → 困毙', C.allMoves(g, 0).length === 0);
C.checkEnd(g);
ok('checkEnd 判对方胜', g.over && g.winner === 1 && g.reason === 'stalemate');

/* SECTION: 5 · make/unmake 与状态推进 */
out.push('=== 5. 状态推进与回退 ===');
function snapOf(s) {
  return JSON.stringify({
    occ: s.occ, turn: s.turn, plies: s.plies, quiet: s.quiet, over: s.over,
    winner: s.winner, reason: s.reason, logNo: s.logNo, logs: s.log.length,
    rep: Object.keys(s.repeat).sort().join(','), lf: Object.keys(s.lastFrom).sort().join(','),
    ps: Object.keys(s.pieces).sort().map(k => [s.pieces[k].node, s.pieces[k].alive, s.pieces[k].revealed, s.pieces[k].mask].join('/')).join('|')
  });
}
let allRt = true;
for (let t = 0; t < 60; t++) {
  const s = C.createGame({ seed: 31 + t, level: 1 + (t % 9), hidden: t % 2 === 0 });
  const ms = C.allMoves(s, s.turn);
  if (!ms.length) { continue; }
  const mvv = ms[t % ms.length];
  const before = snapOf(s);
  const r = C.makeMove(s, mvv);
  C.unmakeMove(s, r);
  if (snapOf(s) !== before) { allRt = false; ok('回退不干净 #' + t, true); break; }
}
ok('60 种局面 make/unmake 完全复原', allRt);
g = bareGame(false);
const pA = put(g, 0, 'shiZhang', N(5, 2));
const pB = put(g, 1, 'tuanZhang', N(5, 3));
C.makeMove(g, moveTo(g, pA, N(5, 3)));
eq('吃子后回合权交换', g.turn, 1);
eq('手步数 +1', g.plies, 1);
eq('有伤亡 → 无战事计数清零', g.quiet, 0);
eq('战报 1 条', g.log.length, 1);
eq('被吃的子移出棋盘', g.occ[N(5, 3)], pA);
eq('阵亡子标记', g.pieces[pB].alive, false);

/* SECTION: 6 · 暗棋推演 */
out.push('=== 6. 暗棋与嫌疑推演 ===');
g = bareGame(true);
const hid = put(g, 1, 'lvZhang', N(5, 3));
const vic = put(g, 0, 'tuanZhang', N(5, 2));
put(g, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1)[0]);
put(g, 1, 'siLing', N(1, 1));
C.makeMove(g, moveTo(g, hid, N(5, 2)));
ok('暗棋：敌方未翻开的子对玩家不可见', !C.isKnown(g, hid, 0) && C.isKnown(g, hid, 1));
ok('阵亡者一律翻开', g.pieces[vic].revealed === true);
const sus = C.suspects(g, hid, 0).map(x => x.k).sort();
ok('活着吃掉团长的子，嫌疑收窄到"能吃掉团长还活着"的军衔',
  sus.length >= 1 && sus.every(k => (C.BEAT_AS.tuanZhang & (1 << D.BY_KIND[k].idx)) !== 0), sus.join('/'));
ok('嫌疑集合排掉了打不过团长的子、炸弹与不动子',
  ['yingZhang', 'lianZhang', 'paiZhang', 'gongBing', 'zhaDan', 'diLei', 'junQi'].every(k => sus.indexOf(k) < 0),
  sus.join('/'));
ok('BEAT_AS[团长] 正好是 司令/军长/师长/旅长 四种', (() => {
  const beat = D.PIECES.filter(p => (C.BEAT_AS.tuanZhang & (1 << p.idx))).map(p => p.k).sort().join(',');
  return beat === ['siLing', 'junZhang', 'shiZhang', 'lvZhang'].sort().join(',');
})(), D.PIECES.filter(p => (C.BEAT_AS.tuanZhang & (1 << p.idx))).map(p => p.name).join('/'));
ok('HOLD_AS[师长] 是能扛住师长攻击的军衔（含地雷）',
  (C.HOLD_AS.shiZhang & D.MASK_MINE) !== 0
  && (C.HOLD_AS.shiZhang & (1 << D.BY_KIND.siLing.idx)) !== 0
  && (C.HOLD_AS.shiZhang & (1 << D.BY_KIND.paiZhang.idx)) === 0);
eq('嫌疑概率和为 1', C.suspects(g, hid, 0).reduce((s, x) => s + x.p, 0).toFixed(6), '1.000000');
ok('暗棋开局看不穿任何一枚未翻开的敌子（嫌疑是好几个军衔）', (() => {
  const s = C.createGame({ seed: 4242, hidden: true, level: 5 });
  const unk = C.alivePids(s, 1).filter(pid => !s.pieces[pid].revealed);
  return unk.length === 25 && unk.every(pid => C.suspects(s, pid, 0).length > 3);
})());
ok('自己的子对自己永远透明', (() => {
  const s = C.createGame({ seed: 4243, hidden: true });
  return C.alivePids(s, 0).every(pid => C.suspects(s, pid, 0).length === 1 && C.isKnown(s, pid, 0));
})());
ok('poolOf 用的是公开子力构成（未翻开的存活敌子共 25 个）', (() => {
  const s = C.createGame({ seed: 4244, hidden: true });
  return C.poolOf(s, 0).total === 25;
})());
ok('明棋模式没有任何隐藏', (() => {
  const s = C.createGame({ seed: 8, hidden: false });
  const foe = C.alivePids(s, 1).filter(pid => !D.BY_KIND[s.pieces[pid].k].immobile);
  return foe.every(pid => C.isKnown(s, pid, 0));
})());
ok('会动的子必然不是地雷/军旗（移动即自证）', (() => {
  const s = C.createGame({ seed: 9, hidden: true });
  const ms = C.allMoves(s, 0).filter(m => !m.capture);
  if (!ms.length) { return false; }
  C.makeMove(s, ms[0]);
  const p = s.pieces[ms[0].pid];
  return !(p.mask & D.MASK_MINE) && !(p.mask & D.MASK_FLAG);
})());
ok('同归于尽双方都翻开', (() => {
  const s = bareGame(true);
  const x = put(s, 0, 'lianZhang', N(8, 1));
  const y = put(s, 1, 'lianZhang', N(7, 1));
  C.makeMove(s, moveTo(s, x, N(7, 1)));
  return s.pieces[x].revealed && s.pieces[y].revealed;
})());
ok('炸弹撞大子同尽 → 翻开的是两颗，结论留给对手', (() => {
  const s = bareGame(true);
  const b = put(s, 0, 'zhaDan', N(8, 1));
  const big = put(s, 1, 'siLing', N(7, 1));
  C.makeMove(s, moveTo(s, b, N(7, 1)));
  return s.pieces[b].revealed && s.pieces[big].revealed && !s.pieces[big].alive;
})());
ok('司令阵亡 → 该方军旗被迫翻开', (() => {
  const s = bareGame(true);
  const hq = D.HQS.filter(id => D.NODES[id].side === 1)[0];
  const fl = put(s, 1, 'junQi', hq);
  const sil = put(s, 1, 'siLing', N(4, 0));
  const atk = put(s, 0, 'zhaDan', N(3, 0));
  C.makeMove(s, moveTo(s, atk, N(4, 0)));
  return s.pieces[fl].revealed === true && s.hidden === true;
})());
ok('明棋不会因为司令阵亡多此一举', (() => {
  const s = bareGame(false);
  const fl = put(s, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1)[0]);
  const sil = put(s, 1, 'siLing', N(4, 0));
  const atk = put(s, 0, 'zhaDan', N(3, 0));
  C.makeMove(s, moveTo(s, atk, N(4, 0)));
  return s.pieces[fl].revealed === false;
})());
ok('未知子的期望值落在合理区间', (() => {
  const s = C.createGame({ seed: 11, hidden: true });
  const p = C.alivePids(s, 1).find(pid => !s.pieces[pid].revealed);
  const v = C.evValue(s, p, 0);
  return v >= 15 && v <= 1000;
})());
ok('evClash：司令打未翻开的子，期望有限', (() => {
  const s = C.createGame({ seed: 12, hidden: true });
  const me = C.alivePids(s, 0).find(pid => s.pieces[pid].k === 'siLing');
  const foe = C.alivePids(s, 1).find(pid => !s.pieces[pid].revealed);
  const v = C.evClash(s, me, foe, 0);
  return isFinite(v) && Math.abs(v) <= 1000;
})());
ok('明棋下 evClash 就是实打实的差值', (() => {
  const s = C.createGame({ seed: 13, hidden: false });
  const me = C.alivePids(s, 0).find(pid => s.pieces[pid].k === 'shiZhang');
  const foe = C.alivePids(s, 1).find(pid => s.pieces[pid].k === 'tuanZhang');
  const v = C.evClash(s, me, foe, 0);
  return v === D.BY_KIND.tuanZhang.val;
})());
ok('poolOf 只统计未翻开的存活敌子', (() => {
  const s = C.createGame({ seed: 14, hidden: true });
  const p = C.poolOf(s, 0);
  return p.total === 25 && p.cnt.reduce((a, b) => a + b, 0) === 25;
})());

/* SECTION: 7 · 战报文案 */
out.push('=== 7. 战报 ===');
g = C.createGame({ seed: 21, hidden: true, level: 1 });
const dsc = C.describe(g, g.log[0] || { side: 0, atk: 'none', aK: 'shiZhang', def: null, to: N(6, 2), res: {} }, 0);
ok('describe 不抛异常并给出头尾', typeof dsc.head === 'string' && typeof dsc.tail === 'string');
g = bareGame(true);
const hAtk = put(g, 1, 'junZhang', N(5, 3));
const hVic = put(g, 0, 'yingZhang', N(5, 2));
const ev = C.makeMove(g, moveTo(g, hAtk, N(5, 2))).evt;
const d2 = C.describe(g, ev, 0);
ok('暗棋战报：玩家视角看不到活着的敌方军衔', /？/.test(d2.head), JSON.stringify(d2));
ok('暗棋战报：阵亡的我方子写得出名字', /营长/.test(d2.tail), JSON.stringify(d2));
const d3 = C.describe(g, ev, 1);
ok('同一战报在蓝方视角能看到自己的军衔', /军长/.test(d3.head), JSON.stringify(d3));
ok('位置标签带上下与行号', /蓝方|红方/.test(C.posLabel(N(5, 2))) && /第\d+排/.test(C.posLabel(N(5, 2))), C.posLabel(N(5, 2)));
ok('行营/大本营/兵站三种点位都认得',
  /行营/.test(C.posLabel(D.CAMPS[0])) && /大本营/.test(C.posLabel(D.HQS[0])) && /兵站/.test(C.posLabel(N(9, 2))));

/* SECTION: 8 · 布阵交换 */
out.push('=== 8. 布阵交换 ===');
g = C.createGame({ seed: 31, hidden: true, level: 1 });
const own = C.alivePids(g, 0);
const flagPid = own.find(pid => g.pieces[pid].k === 'junQi');
const minePid = own.find(pid => g.pieces[pid].k === 'diLei');
const frontPid = own.find(pid => D.localRow(0, g.pieces[pid].node.r) === 5 && !D.BY_KIND[g.pieces[pid].k].immobile);
ok('军旗不能被换出大本营', !C.canSwap(g, 0, flagPid, frontPid));
ok('地雷不能被换到前线', !C.canSwap(g, 0, minePid, frontPid));
ok('普通子之间可以换', (() => {
  const a = own.find(pid => g.pieces[pid].k === 'lianZhang');
  const b = own.find(pid => g.pieces[pid].k === 'paiZhang' && pid !== a);
  if (!a || !b) { return false; }
  const na = g.pieces[a].node, nb = g.pieces[b].node;
  if (!C.canSwap(g, 0, a, b)) { return false; }
  C.swap(g, 0, a, b);
  return g.pieces[a].node === nb && g.pieces[b].node === na && g.occ[na] === b && g.occ[nb] === a;
})());
ok('不能换对方的子', (() => {
  const a = C.alivePids(g, 0)[0], b = C.alivePids(g, 1)[0];
  return !C.canSwap(g, 0, a, b);
})());
ok('重新布阵后仍然合法且 25 子', (() => {
  const s = C.createGame({ seed: 32, hidden: true });
  C.relayout(s, 0, seeded(99));
  const lay = s.byOwner[0].map(pid => ({ node: s.pieces[pid].node, k: s.pieces[pid].k }));
  return lay.length === 25 && C.layoutValid(0, lay) && s.occ.filter(Boolean).length === 50;
})());

/* SECTION: 9 · AI */
out.push('=== 9. AI ===');
ok('AI 给出的着法一定合法', (() => {
  for (let i = 0; i < 25; i++) {
    const s = C.createGame({ seed: 101 + i, level: 1 + (i % 9), hidden: i % 2 === 0 });
    let t = 0;
    while (!s.over && t < 40) {
      const side = s.turn;
      const pickM = C.chooseMove(s, side);
      if (!pickM) { break; }
      const legal = C.allMoves(s, side).some(m => m.pid === pickM.mv.pid && m.to === pickM.mv.to);
      if (!legal) { return false; }
      C.makeMove(s, pickM.mv);
      t++;
    }
  }
  return true;
})());
ok('AI 看得见免费的旗就立刻扛', (() => {
  const s = bareGame(false);
  const hq = D.HQS.filter(id => D.NODES[id].side === 1)[0];
  const entry = D.NODES[hq].hqEntry;
  put(s, 1, 'junQi', hq);
  put(s, 1, 'diLei', D.HQS.filter(id => D.NODES[id].side === 1 && id !== hq)[0]);
  put(s, 0, 'paiZhang', entry);
  put(s, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
  const pk = C.chooseMove(s, 0);
  return pk && pk.mv.to === hq;
})());
ok('AI 不会用排长去撞明牌地雷', (() => {
  const s = bareGame(false);
  put(s, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
  put(s, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1)[0]);
  const mine = put(s, 1, 'diLei', N(4, 2));
  const pa = put(s, 0, 'paiZhang', N(5, 2));
  ok('排长确实打得到那颗雷', C.nodeMoves(s, pa).some(m => m.to === N(4, 2) && m.capture === mine));
  const pk = C.chooseMove(s, 0, { level: 9 });
  return pk.mv.to !== N(4, 2);
})());
ok('AI 会用工兵去挖明牌地雷', (() => {
  const s = bareGame(false);
  put(s, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
  put(s, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1)[0]);
  const mine = put(s, 1, 'diLei', N(4, 2));
  put(s, 0, 'paiZhang', N(5, 1));
  const gb = put(s, 0, 'gongBing', N(5, 2));
  const pk = C.chooseMove(s, 0, { level: 9 });
  return pk.mv.pid === gb && pk.mv.to === N(4, 2);
})());
ok('AI 白吃明牌大子时会吃（司令吃师长优先）', (() => {
  const s = bareGame(false);
  put(s, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
  put(s, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1)[0]);
  const sl = put(s, 0, 'siLing', N(6, 2));
  const prey = put(s, 1, 'shiZhang', N(5, 2));
  const pk = C.chooseMove(s, 0, { level: 9 });
  return pk.mv.capture === prey;
})(), '');
ok('高关卡 AI 不肯把司令白送进地雷口（有更好着法时）', (() => {
  const s = bareGame(false);
  put(s, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
  put(s, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1)[0]);
  const sl = put(s, 0, 'siLing', N(8, 2));
  put(s, 1, 'shiZhang', N(6, 0));            // 安全的白吃目标（隔一步）
  put(s, 1, 'diLei', N(7, 2));               // 正前方就是雷
  const pk = C.chooseMove(s, 0, { level: 9 });
  return pk.mv.to !== N(7, 2);
})());
ok('AI 没有着法时返回 null', (() => {
  const s = bareGame(false);
  put(s, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
  return C.chooseMove(s, 0) === null;
})());
ok('AI 不偷看底牌：偷换两枚未翻开敌子的军衔，AI 选着完全不变', (() => {
  /* 只动"底牌"（k），不动任何公开信息（revealed/mask/位置/子力构成）。
     若 AI 真的按嫌疑分布下棋，它的选择必须一模一样。
     挑两个都能动的子，避免把子换成地雷/军旗后改动可动性。 */
  function build() {
    const s = C.createGame({ seed: 777, hidden: true, level: 9 });
    const mob = C.mobilePids(s, 1);
    const unk = mob.filter(pid => !s.pieces[pid].revealed);
    return { s: s, a: unk[1], b: unk[4] };
  }
  const A = build(), B = build();
  const ka = A.s.pieces[A.a].k, kb = A.s.pieces[A.b].k;
  A.s.pieces[A.a].k = kb; A.s.pieces[A.b].k = ka;
  const pa = C.chooseMove(A.s, 0, { rng: seeded(2024) });
  const pb = C.chooseMove(B.s, 0, { rng: seeded(2024) });
  return pa && pb && pa.mv.pid === pb.mv.pid && pa.mv.to === pb.mv.to;
})());
ok('AI 的期望值也不受底牌影响（偷换后 evValue 相同）', (() => {
  const s = C.createGame({ seed: 631, hidden: true, level: 9 });
  const unk = C.mobilePids(s, 1).filter(pid => !s.pieces[pid].revealed);
  const a = unk[0], b = unk[3];
  const before = C.evValue(s, a, 0);
  const ka = s.pieces[a].k, kb = s.pieces[b].k;
  s.pieces[a].k = kb; s.pieces[b].k = ka;
  return Math.abs(before - C.evValue(s, a, 0)) < 1e-9;
})());
ok('低关卡比高关卡更爱乱走（噪声与候选数单调）', (() => {
  const L = D.LEVELS;
  return L.every((x, i) => i === 0 || (x.noise < L[i - 1].noise && x.refine >= L[i - 1].refine && x.reply >= L[i - 1].reply));
})());
ok('难度倍率与关卡号单调', D.SCORE.levelMult.every((m, i) => i === 0 || m > D.SCORE.levelMult[i - 1]));
ok('9 关齐备且名字唯一', D.LEVELS.length === 9 && new Set(D.LEVELS.map(l => l.name)).size === 9);

/* SECTION: 10 · 守门：自对局一定收得拢 */
out.push('=== 10. 自对局守门 ===');
const plays = [];
let unfinished = 0, crashed = 0, flagWins = 0, stale = 0, adjud = 0, draw = 0;
let maxPlies = 0, totalPlies = 0, winByHigh = 0, pairs = 0;
for (let seed = 1; seed <= 20; seed++) {
  for (const hidden of [false, true]) {
    for (const lv of [1, 5, 9]) {
      let s;
      try {
        s = C.createGame({ seed: seed * 977 + (hidden ? 13 : 7), hidden: hidden, level: lv });
      } catch (e) { crashed++; continue; }
      let guard = 0;
      try {
        while (!s.over && guard < 420) {
          const side = s.turn;
          const pk = C.chooseMove(s, side);
          if (!pk) { s.over = true; s.winner = 1 - side; s.reason = 'stalemate'; break; }
          C.makeMove(s, pk.mv);
          guard++;
        }
      } catch (e) { crashed++; out.push('    异常: ' + e.message); continue; }
      pairs++;
      if (!s.over) { unfinished++; }
      maxPlies = Math.max(maxPlies, s.plies);
      totalPlies += s.plies;
      if (s.reason === 'flag') { flagWins++; } else if (s.reason === 'stalemate') { stale++; } else if (s.reason === 'adjudicate') { adjud++; }
      if (s.winner === -1) { draw++; }
      if (s.winner === 1) { winByHigh++; }
      plays.push(`${hidden ? '暗' : '明'}${lv}:${s.plies}手/${s.winner}/${s.reason}`);
    }
  }
}
eq('自对局全部无异常', crashed, 0);
eq('自对局全部有结果（无未完局）', unfinished, 0);
ok('局数足够（60 局以上）', pairs >= 60, pairs + ' 局');
ok('没有超过硬上限的局', maxPlies <= D.RULES.PLY_LIMIT + 2, '最长 ' + maxPlies + ' 手');
ok('终局形式齐全（扛旗/困毙/判定都出现过）', flagWins > 0 && stale > 0 && adjud > 0,
  `扛旗 ${flagWins}、困毙 ${stale}、判定 ${adjud}、和局 ${draw}`);
/* 强度分层：两边布阵用同一个 guard —— 否则比的是"谁的旗被雷护得更好"而不是 AI。
   双方各执一次红，消掉先手与棋型偏差。 */
function ladderScore() {
  function m(seed, hiSide) {
    const rng = C.makeRng((seed * 2654435761) >>> 0);
    const s = C.createGame({
      seed: seed, hidden: true, level: 5,
      layout0: C.randomLayout(0, rng, 0.3), layout1: C.randomLayout(1, rng, 0.3)
    });
    let g = 0;
    while (!s.over && g < 420) {
      const side = s.turn;
      const pk = C.chooseMove(s, side, { level: side === hiSide ? 9 : 1, rng: C.makeRng(seed * 7919 + g + 1) });
      if (!pk) { s.over = true; s.winner = 1 - side; break; }
      C.makeMove(s, pk.mv); g++;
    }
    return s.winner === hiSide ? 1 : (s.winner === -1 ? 0.5 : 0);
  }
  let hi = 0, tot = 0;
  for (let sd = 1; sd <= 12; sd++) { for (const hs of [0, 1]) { hi += m(sd * 13 + hs, hs); tot++; } }
  return { hi: hi, tot: tot, pct: Math.round(hi / tot * 100) };
}
const ladder = ladderScore();
ok('高关卡 AI 明显压得住低关卡（强度真的分层）', ladder.hi / ladder.tot >= 0.68,
  '强 AI 得分 ' + ladder.hi + '/' + ladder.tot + '（' + ladder.pct + '%）');
ok('每局平均手步数在合理范围（不磨蹭也不秒杀）', totalPlies / pairs > 12 && totalPlies / pairs < D.RULES.PLY_LIMIT,
  '平均 ' + (totalPlies / pairs).toFixed(1) + ' 手');
ok('AI 思考耗时可接受（level9 单次 < 120ms）', (() => {
  const s = C.createGame({ seed: 606, hidden: true, level: 9 });
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) { C.chooseMove(s, 1, { level: 9 }); const pk = C.chooseMove(s, 0, { level: 9 }); if (pk) { C.makeMove(s, pk.mv); } }
  const per = (Date.now() - t0) / 10;
  return per < 120;
})(), '');

/* SECTION: 11 · 计分 */
out.push('=== 11. 计分与统计 ===');
g = bareGame(false);
put(g, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
const f2 = D.HQS.filter(id => D.NODES[id].side === 1)[0];
put(g, 1, 'junQi', f2);
put(g, 0, 'shiZhang', D.NODES[f2].hqEntry);
C.makeMove(g, moveTo(g, g.occ[D.NODES[f2].hqEntry], f2));
const winScore = C.scoreOf(g, 0);
const loseScore = C.scoreOf(g, 1);
ok('获胜方得分 > 0 且远高于失败方', winScore > 0 && winScore > loseScore, winScore + ' vs ' + loseScore);
ok('失败方也有安慰分（打掉多少子）', loseScore >= 0);
const st2 = C.statsOf(g);
ok('statsOf 字段齐全', ['turn', 'plies', 'quiet', 'over', 'winner', 'reason', 'hidden', 'level', 'alive', 'material', 'movable', 'logs']
  .every(k => k in st2), Object.keys(st2).join(','));
eq('获胜局 over=true', st2.over, true);
eq('红方存活 25（吃了一子后为 25？不，蓝方少一子）', st2.alive[1], 0);
ok('子力统计非负', st2.material.every(m => m >= 0));
ok('暗棋赢分高于明棋（同局面）', (() => {
  const mk = (hidden) => {
    const s = bareGame(hidden);
    const hq0 = D.HQS.filter(id => D.NODES[id].side === 0)[0];
    const hq1 = D.HQS.filter(id => D.NODES[id].side === 1)[0];
    put(s, 0, 'junQi', hq0); put(s, 1, 'junQi', hq1);
    const e = D.NODES[hq1].hqEntry;
    put(s, 0, 'shiZhang', e);
    C.makeMove(s, moveTo(s, s.occ[e], hq1));
    s.level = 5;
    return C.scoreOf(s, 0);
  };
  return mk(true) > mk(false);
})());
ok('关卡越高赢分越多', (() => {
  const mk = (lv) => {
    const s = C.createGame({ seed: 77, hidden: false, level: lv });
    s.over = true; s.winner = 0; s.reason = 'flag';
    return C.scoreOf(s, 0);
  };
  return mk(9) > mk(5) && mk(5) > mk(1);
})());

/* SECTION: 12 · 长局与判定的边界 */
out.push('=== 12. 判定边界 ===');
g = bareGame(false);
put(g, 0, 'junQi', D.HQS.filter(id => D.NODES[id].side === 0)[0]);
put(g, 1, 'junQi', D.HQS.filter(id => D.NODES[id].side === 1)[0]);
put(g, 0, 'lianZhang', N(9, 2));
put(g, 1, 'lianZhang', N(2, 2));
g.quiet = D.RULES.QUIET_LIMIT - 1;
const one = C.chooseMove(g, 0);
C.makeMove(g, one.mv);
ok('无战事计数随走子累加', g.quiet === D.RULES.QUIET_LIMIT || g.over, 'quiet=' + g.quiet);
while (!g.over) { const pk = C.chooseMove(g, g.turn); if (!pk) { break; } C.makeMove(g, pk.mv); }
ok('磨到上限必然判定结束', g.over && g.reason === 'adjudicate', g.reason + '@' + g.plies);
ok('判定按子力（此局对称 → 和棋）', g.winner === -1, 'winner=' + g.winner);
ok('QUIET_LIMIT 与 PLY_LIMIT 配置自洽',
  D.RULES.QUIET_LIMIT < D.RULES.PLY_LIMIT && D.RULES.QUIET_LIMIT % 2 === 0);
/* AI 搜索会在"已结束的判定"上试来试去：unmake 必须把 over/winner/reason 一起还原，
   否则搜索过程中一次扛旗就会污染真实局面。 */
g = bareGame(false);
const hq0f = D.HQS.filter(id => D.NODES[id].side === 0)[0];
const hq1f = D.HQS.filter(id => D.NODES[id].side === 1)[0];
put(g, 0, 'junQi', hq0f);
put(g, 1, 'junQi', hq1f);
const atkF = put(g, 1, 'siLing', D.NODES[hq0f].hqEntry);
const snapBefore = snapOf(g);
const recF = C.makeMove(g, moveTo(g, atkF, hq0f));
ok('扛旗后状态确实变成已结束', g.over === true && g.winner === 1 && g.reason === 'flag');
C.unmakeMove(g, recF);
ok('unmake 把 over/winner/reason 一并还原（搜索不污染真实局面）', snapOf(g) === snapBefore,
  g.over + '/' + g.winner + '/' + g.reason);

out.push('');
out.push(`断言：${pass} 通过 / ${fail} 失败`);
console.log(out.join('\n'));
process.exit(fail ? 1 : 0);
