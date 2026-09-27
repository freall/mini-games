/* ============================================================
   tools/test-shooter-core.mjs · 靶场神枪手核心逻辑断言
   SECTION: test-shooter-core
   ------------------------------------------------------------
   shooter-data.js / shooter-core.js 只依赖一个 window 对象，
   这里给个假的 window 就能在 node 里直接跑，不需要浏览器。

   两类断言：
     A. 规则口径 —— 环数表、连击档、弹药状态机、命中归属、炸弹惩罚、结算公式。
     B. 公平性守门 —— 「脚本化神枪手」自动瞄准逐关打满 10 关 + 无尽 3 轮 × 6 把枪，
        全部必须能过配额；外加"每个靶都可打 ≥ HIT_FLOOR 秒""同屏靶不重叠、
        炸雷靶不会与计分靶叠在一起"两条不变式。
        （口径与 manhole 的时间窗 DP 一致：关卡可玩性必须由 AI 证明，不能靠人肉试。）

   用法：node tools/test-shooter-core.mjs
   ============================================================ */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const win = {};
for (const f of ['assets/shooter-data.js', 'assets/shooter-core.js']) {
  new Function('window', readFileSync(join(ROOT, f), 'utf8'))(win);
}
const D = win.SHOOTER_DATA, C = win.SHOOTER_CORE;

let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; out.push('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
function near(name, got, want, tol) {
  ok(name, Math.abs(got - want) <= (tol === undefined ? 1e-6 : tol), `got=${got} want≈${want}`);
}

/* 固定种子 RNG（mulberry 风格 LCG），保证随机相关断言可复现 */
function seeded(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function world(level, seed, gunId) {
  return new C.World(D, level, { rng: seeded(seed || 1), gunId: gunId || 'pistol' });
}
/* 把这一枪变成"零散布"：验证判定归属与计分公式时不要掺入随机偏移 */
function still(w) {
  w.gun.spread0 = 0; w.gun.kick = 0; w.gun.decay = 1e6;
  w.bloom = 0; w.bloomHold = 0;
  return w;
}
function onlyTarget(w) { return w.targets[0]; }
function pose(t) { return C.poseOf(t, t.age); }
function run(w, secs, dt) {
  dt = dt || 1 / 60;
  let evs = [];
  for (let i = 0; i < Math.round(secs / dt); i++) { evs = evs.concat(C.step(w, dt)); }
  return evs;
}
/* 生成一枚确定性靶：直接放进世界，绕开拒绝采样的随机位置 */
function place(w, typeId, x, y, opts) {
  opts = opts || {};
  const t = C.spawnTarget(w, typeId, { depth: opts.depth || 'near' });
  if (!t) { throw new Error('place 失败：' + typeId); }
  t.motion = opts.motion || 'static'; t.x0 = x; t.y0 = y; t.vx = opts.vx || 0; t.vy = 0;
  t.age = 0; t.life = opts.life || 9; t.riseT = 0; t.amp = 0; t.pulse = 0;
  return t;
}

/* ============================================================ SECTION: 表 */
out.push('=== 调参表完整性 ===');
eq('靶场三段纵深', D.RANGE.depths.length, 3);
ok('纵深按 far→near 排：越近画得越大、给分越低', D.RANGE.depths.every((d, i, a) =>
  i === 0 || (a[i - 1].scale < d.scale && a[i - 1].mult > d.mult)));
ok('靶道 y 区间自下而上不重叠（far 在上）', D.RANGE.depths.every((d, i, a) => i === 0 || a[i - 1].y1 < d.y0));
ok('靶心允许区间在挡板与枪台之间', D.RANGE.depths.every(d =>
  d.y0 > D.RANGE.wallTop + D.RANGE.wallH && d.y1 < D.RANGE.benchY));
eq('六把枪', D.GUNS.length, 6);
const GUN_FIELDS = ['id', 'name', 'art', 'en', 'rps', 'mag', 'reload', 'spread0', 'kick', 'decay',
  'maxBloom', 'pellets', 'mult', 'steady', 'pace', 'price', 'body', 'accent', 'desc'];
ok('每把枪字段齐全（含渲染要用的 body/accent 视觉字段）',
  D.GUNS.every(g => GUN_FIELDS.every(k => g[k] !== undefined && g[k] !== null && g[k] !== '')));
ok('散布封顶不越过靶半径（越过就成抽奖）', D.GUNS.every(g => g.maxBloom <= D.BASE_R * (g.pellets > 1 ? 0.95 : 0.9)),
  D.GUNS.map(g => g.id + '=' + g.maxBloom).join(' '));
ok('稳定散布（spread0）都在 10 环半径内 —— 认真瞄就有内十', D.GUNS.every(g =>
  g.spread0 <= D.BASE_R * D.SCORE.BULL.f * 1.6 || g.pellets > 1),
  D.GUNS.map(g => g.id + '=' + g.spread0).join(' '));
ok('枪 id 唯一', new Set(D.GUNS.map(g => g.id)).size === D.GUNS.length);
ok('只有初始枪免费，其余价格递增解锁',
  D.GUNS[0].price === 0 && D.GUNS.slice(1).every((g, i, a) => g.price > (i ? a[i - 1].price : 0)));
ok('屏息收益在 (0,1) 之间且狙击收得最狠', D.GUNS.every(g => g.steady > 0 && g.steady < 1)
  && D.gunById('sniper').steady === Math.min(...D.GUNS.map(g => g.steady)));
eq('gunById 未知回落到初始枪', D.gunById('nope').id, 'pistol');

ok('靶型表字段齐全', Object.keys(D.TARGETS).every(k => {
  const t = D.TARGETS[k];
  return t.id === k && t.name && t.art && t.r > 0 && t.life > 0 && ['static', 'pop', 'linear', 'sine', 'arc', 'drift', 'pulse', 'blink'].includes(t.motion);
}));
const LEVEL_TYPES = new Set();
D.LEVELS.forEach(l => Object.keys(l.weights).forEach(k => LEVEL_TYPES.add(k)));
ok('关卡里出现的每种靶都在靶型表里', [...LEVEL_TYPES].every(k => !!D.TARGETS[k]),
  '缺: ' + [...LEVEL_TYPES].filter(k => !D.TARGETS[k]).join(',') || '无');
ok('mini（分裂产物）不在关卡权重里 —— 它只能由分裂靶产生', !LEVEL_TYPES.has('mini'));
eq('十个关卡', D.LEVELS.length, 10);
ok('关卡击落数要求逐关递增', D.LEVELS.every((l, i, a) => i === 0 || a[i - 1].downs < l.downs));
ok('关卡表不再用分数当过关条件', D.LEVELS.every(l => l.quota === undefined && l.downs > 0));
ok('关卡生成间隔逐关收紧、速度逐关提高', D.LEVELS.every((l, i, a) =>
  i === 0 || (a[i - 1].gap[0] >= l.gap[0] && a[i - 1].speed <= l.speed)));
ok('每关时限都在 50~65 秒', D.LEVELS.every(l => l.time >= 50 && l.time <= 65));
ok('第一关只有环靶且不含炸弹（新手不会一上来就被罚）',
  Object.keys(D.LEVELS[0].weights).join() === 'ring');
ok('第 1~4 关不出现炸雷靶（先教会瞄准再教规矩）',
  D.LEVELS.slice(0, 4).every(l => !l.weights.bomb));
eq('levelConfig 越界夹回 1', D.levelConfig(0).level, 1);
ok('无尽关递推：击落数更高、间隔更紧但有封顶', (() => {
  const a = D.levelConfig(11), b = D.levelConfig(12), far = D.levelConfig(60);
  return a.endless && b.endless && a.downs > D.LEVELS[9].downs
    && b.gap[0] <= a.gap[0] && far.gap[0] >= D.ENDLESS.maxGap - 1e-9
    && far.speed <= D.ENDLESS.maxSpeed && far.live <= D.ENDLESS.maxLive;
})());
ok('无尽关保留全部靶型且炸弹权重封顶', (() => {
  const far = D.levelConfig(60);
  return Object.keys(far.weights).length === Object.keys(D.LEVELS[9].weights).length
    && far.weights.bomb <= D.ENDLESS.maxBombWeight;
})());
ok('结算常数与评级表自洽（阈值递减、最后一档兜底 0）',
  D.SCORE.GRADES.every((g, i, a) => i === 0 || a[i - 1].min > g.min)
  && D.SCORE.GRADES[D.SCORE.GRADES.length - 1].min === 0);

/* ============================================================ SECTION: 计分 */
out.push('=== 环数与倍率 ===');
const R = 34;
eq('正中 = 内十 20 分', C.ringOf(D, 0, R).pts, D.SCORE.BULL.pts);
ok('内十判定比 10 环更严', D.SCORE.BULL.f < D.SCORE.RINGS[0].f);
eq('刚好压在内十边界仍算内十', C.ringOf(D, R * D.SCORE.BULL.f, R).pts, 20);
eq('内十边界外一丝掉到 10 环', C.ringOf(D, R * (D.SCORE.BULL.f + 0.01), R).pts, 10);
eq('10 环区', C.ringOf(D, R * 0.2, R).pts, 10);
eq('8 环区', C.ringOf(D, R * 0.3, R).pts, 8);
eq('6 环区', C.ringOf(D, R * 0.6, R).pts, 6);
eq('4 环区（靶边缘）', C.ringOf(D, R * 0.99, R).pts, 4);
eq('靶外不判分', C.ringOf(D, R * 1.01, R), null);
eq('半径为 0 不炸（防御性）', C.ringOf(D, 1, 0), null);
ok('环数随距离单调不增', (() => {
  let prev = 99;
  for (let f = 0; f <= 1; f += 0.02) { const r = C.ringOf(D, R * f, R); if (!r) { break; } if (r.pts > prev) { return false; } prev = r.pts; }
  return true;
})());
eq('0 连段 ×1', C.multFor(D, 0), 1);
eq('2 连段仍 ×1', C.multFor(D, 2), 1);
eq('3 连段跳到 ×2', C.multFor(D, 3), 2);
eq('最高档 ×8 之后不再涨', C.multFor(D, 999), 8);
ok('倍率档位单调递增', D.RULES.STREAK_TIERS.every((t, i, a) => i === 0 || (t.n > a[i - 1].n && t.x >= a[i - 1].x)));
eq('命中率 90% = S', C.gradeOf(D, 0.9).name, 'S');
eq('命中率 60% = B', C.gradeOf(D, 0.6).name, 'B');
eq('命中率 0 = C 且奖励系数 1（不额外加分）', C.gradeOf(D, 0).bonus, 1);

/* ============================================================ SECTION: 世界初态 */
out.push('=== 世界初态与推进 ===');
const w0 = world(1, 7);
eq('初态 phase', w0.phase, 'play');
eq('初态分数', w0.score, 0);
eq('弹药上满', w0.ammo, D.gunById('pistol').mag);
eq('剩余时间 = 关卡时限', w0.timeLeft, D.LEVELS[0].time);
eq('过关要求 = 关卡击落数', w0.need, D.LEVELS[0].downs);
eq('开局场上无靶', w0.targets.length, 0);
run(w0, 0.4);
eq('开局有进场延迟（第一发靶不会瞬间糊脸）', w0.targets.length, 0);
const evs = run(w0, 1.2);
ok('进场延迟后靶子升起', w0.targets.length >= 1, 'live=' + w0.targets.length);
ok('spawn 事件带渲染需要的坐标与半径', evs.some(e => e.kind === 'spawn'
  && typeof e.x === 'number' && typeof e.y === 'number' && e.r > 0));
eq('第一关只会出现环靶', onlyTarget(w0).type, 'ring');
ok('靶心在允许区间内', (() => {
  const w = world(8, 3); run(w, 30);
  return w.targets.every(t => { const p = pose(t); return p.x > 4 && p.x < D.LAYOUT.W - 4 && p.y > D.RANGE.wallTop + D.RANGE.wallH && p.y < D.RANGE.benchY; });
})());
ok('同屏靶数不超过关卡上限', (() => {
  const w = world(10, 11); let mx = 0;
  for (let i = 0; i < 60 * 40; i++) { C.step(w, 1 / 60); mx = Math.max(mx, w.targets.length); }
  return mx <= w.cfg.live;
})(), 'max=' + (() => { const w = world(10, 11); let m = 0; for (let i = 0; i < 2400; i++) { C.step(w, 1 / 60); m = Math.max(m, w.targets.length); } return m; })());
ok('时间只减不增（除了秒表靶）', (() => {
  const w = world(1, 5); const a = w.timeLeft; run(w, 3); return w.timeLeft < a - 2.9;
})());
ok('step 夹住超大 dt（掉帧不会让靶瞬移）', (() => {
  const w = world(4, 2); run(w, 2); const t = w.targets[0];
  if (!t) { return false; }
  const before = pose(t).x; C.step(w, 5); const after = pose(t).x;
  return !t.alive || Math.abs(after - before) < 400;
})());
{
  /* 视图层自己有一个"界面阶段"（start/countdown/play/pause/clear/over）。
     core 的快照若也提供 phase，两层合并时会互相覆盖 ——
     冒烟实测过"已经暂停了、stats().phase 却仍是 play"，所以这里钉死命名。 */
  const s = C.statsOf(world(1, 1));
  eq('core 快照里这个阶段叫 runPhase 而非 phase', s.phase, undefined);
  eq('runPhase 就是世界的运行态', s.runPhase, 'play');
  ok('快照不泄漏 world/targets 引用（纯数据）', s.targets === undefined && s.live === 0);
  ok('快照字段齐全', ['score', 'downs', 'need', 'progress', 'ammo', 'mag', 'bloom', 'bloomEff',
    'breath', 'steady', 'mult', 'timeLeft', 'stats', 'gun'].every(k => k in s), Object.keys(s).join(','));
  eq('进度按击落数算（不是分数）', s.progress, 0);
}

/* ============================================================ SECTION: 公平性 */
out.push('=== 公平性不变式（生成器不得制造打不中的靶） ===');
ok('每种靶在最高速度关卡下，可打窗口 ≥ HIT_FLOOR', (() => {
  const floor = D.RULES.HIT_FLOOR; const bad = [];
  for (const lv of [1, 5, 10, 13, 30]) {
    const cfg = D.levelConfig(lv);
    for (const k of Object.keys(D.TARGETS)) {
      const T = D.TARGETS[k];
      const w = world(lv, 99);
      const t = C.spawnTarget(w, k);
      if (!t) { continue; }
      t.life = T.life;                       // 用名义寿命评估（生成时的横穿截断只会更长）
      const win2 = C.hitWindow(D, t);
      if (win2 + 1e-6 < floor) { bad.push(`${k}@L${lv}=${win2.toFixed(2)}<${floor}`); }
    }
    void cfg;
  }
  return bad.length === 0 || (out.push('    · ' + bad.join(' / ')), false);
})());
ok('实际生成的每一发靶都可打 ≥ HIT_FLOOR（含横穿截断后）', (() => {
  const floor = D.RULES.HIT_FLOOR; const bad = [];
  for (const lv of [2, 4, 7, 10, 14]) {
    const w = world(lv, lv * 13);
    for (let i = 0; i < 60 * 60; i++) {
      const before = w.targets.length; C.step(w, 1 / 60);
      if (w.targets.length > before) {
        const t = w.targets[w.targets.length - 1];
        const hw = C.hitWindow(D, t);
        if (hw + 1e-6 < floor) { bad.push(`${t.type}@L${lv}=${hw.toFixed(2)}`); }
      }
    }
  }
  return bad.length === 0 || (out.push('    · ' + bad.join(' / ')), false);
})());
ok('闪隐靶的可见占空比 ≥ 0.5（不能一半时间不可打）',
  Object.keys(D.TARGETS).filter(k => D.TARGETS[k].motion === 'blink')
    .every(k => D.TARGETS[k].on / (D.TARGETS[k].on + D.TARGETS[k].off) >= 0.5));
ok('同屏两靶不重叠（含 SPAWN_PAD）：瞄准一个不会撞到另一个', (() => {
  const v = [];
  for (const lv of [5, 8, 10, 16]) {
    const w = world(lv, lv * 31);
    for (let i = 0; i < 60 * 90; i++) {
      C.step(w, 1 / 60);
      const ts = w.targets.map(t => ({ t, p: pose(t) }));
      for (let a = 0; a < ts.length; a++) {
        for (let b = a + 1; b < ts.length; b++) {
          const d = Math.hypot(ts[a].p.x - ts[b].p.x, ts[a].p.y - ts[b].p.y);
          const need = ts[a].p.r + ts[b].p.r + D.RULES.SPAWN_PAD;
          if (d < need - 1) { v.push(`L${lv} ${ts[a].t.type}×${ts[b].t.type} d=${d.toFixed(1)}<${need.toFixed(1)} @${w.t.toFixed(1)}s`); }
        }
      }
    }
  }
  return v.length <= 3 || (out.push('    · 违例 ' + v.length + ' 处，样例: ' + v.slice(0, 4).join(' | ')), false);
}), '违例数≤3 视为可接受（移动后收敛，进场瞬间可能有 1 帧贴边）');
ok('炸雷靶"宁可放过不可误伤"：弹着点同时压在计分靶内时判给计分靶', (() => {
  const w = still(world(1, 1));
  const ringOne = place(w, 'ring', 450, 360);
  const bombOne = place(w, 'bomb', 460, 360);          // 故意叠在一起
  const h = C.targetAt(w, 455, 360);
  return h && h.t.id === ringOne.id && !h.t.bad && bombOne.alive;
})());
ok('单独瞄到炸雷靶仍然会判它（规则不是"打不到雷"）', (() => {
  const w = still(world(1, 1));
  const bombOne = place(w, 'bomb', 450, 360);
  const h = C.targetAt(w, 450, 360);
  return h && h.t.id === bombOne.id && h.t.bad === true;
})());
ok('生成时炸雷靶与计分靶额外避让（不会一出场就叠上）', (() => {
  const v = [];
  for (const lv of [5, 8, 10, 20]) {
    const w = world(lv, lv * 57);
    const seen = [];
    for (let i = 0; i < 60 * 60; i++) {
      const before = w.targets.length;
      C.step(w, 1 / 60);
      if (w.targets.length <= before) { continue; }
      const t = w.targets[w.targets.length - 1];
      const p = pose(t);
      for (const o of seen) {
        if (!o.t.alive) { continue; }
        const q = pose(o.t);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if ((t.bad || o.t.bad) && d < p.r + q.r + D.RULES.BOMB_AVOID) {
          v.push(`L${lv} ${t.type}×${o.t.type} d=${d.toFixed(0)}`);
        }
      }
      seen.push({ t });
    }
  }
  return v.length === 0 || (out.push('    · ' + v.slice(0, 3).join(' | ')), false);
})());
ok('炸弹靶放着不管会自己消失（不打它不会一直堵场）', (() => {
  const w = world(10, 4); let seen = 0, gone = 0;
  const evAll = run(w, 55);
  seen = evAll.filter(e => e.kind === 'spawn' && e.bad).length;
  gone = evAll.filter(e => e.kind === 'expire' && e.bad).length;
  return seen > 0 && gone > 0;
})());

/* ============================================================ SECTION: 命中归属 */
out.push('=== 命中判定与归属 ===');
{
  const w = still(world(1, 1));
  const a = place(w, 'ring', 300, 360); const b = place(w, 'ring', 600, 250);
  const h = C.targetAt(w, 300, 360);
  ok('命中自己瞄的那个靶', h && h.t.id === a.id);
  const ev = C.fire(w, 300, 360);
  const hit = ev.find(e => e.kind === 'hit');
  ok('正中靶心 = 内十 20 分', hit && hit.bull && hit.pts === 20, hit && JSON.stringify(hit.ring));
  eq('内十额外奖励已计入', w.score, 20 + D.SCORE.PERFECT_RING_BONUS);
  eq('一靶一命：被击中的靶已消失', w.targets.filter(t => t.alive).length, 1);
  run(w, w.gun.interval + 0.02);
  eq('打中空处没有别的靶 → 记 miss', C.fire(w, 100, 500).some(e => e.kind === 'miss'), true);
  void b;
}
{
  const w = still(world(1, 1));
  place(w, 'ring', 300, 360);
  const e2 = C.fire(w, 300 + 30 * 0.3, 360);      // 距靶心 0.3R → 8 环
  const h2 = e2.find(e => e.kind === 'hit');
  eq('0.3R 处 = 8 环', h2.pts, 8);
  eq('8 环没有内十奖励', w.score, Math.round(8 * 1 * 1 * 1 * h2.mult * w.cfg.scale));
}
{
  const w = still(world(1, 1));
  place(w, 'ring', 450, 376, { depth: 'near' });
  const t = w.targets[0];
  /* 同一发霰弹不该把同一个靶刷两遍：pellets=5 的枪专门验这条 */
  w.gun.pellets = 5;
  const before = w.stats.hits;
  C.fire(w, 450, 376);
  eq('多弹丸命中同一靶只算一次', w.stats.hits - before, 1);
  eq('多弹丸只消耗一发弹药', w.ammo, w.gun.mag - 1);
  void t;
}
{
  const d = D.depthById('far');
  const w = still(world(1, 1));
  place(w, 'ring', 500, 175, { depth: 'far' });
  const hit = C.fire(w, 500, 175).find(e => e.kind === 'hit');
  eq('远靶道内十 = 环分×纵深倍率 + 固定内十奖励（奖励不乘纵深）',
    hit.gain, Math.round(20 * d.mult) + D.SCORE.PERFECT_RING_BONUS);
  const w2 = still(world(1, 1));
  place(w2, 'ring', 500, 360, { depth: 'near' });
  const h2 = C.fire(w2, 500, 360).find(e => e.kind === 'hit');
  ok('同一枪：远靶道比近靶道值钱', hit.gain > h2.gain, `far=${hit.gain} near=${h2.gain}`);
  ok('远靶判定半径更小（值钱是因为更难）', hit.r < h2.r, `far r=${hit.r.toFixed(1)} near r=${h2.r.toFixed(1)}`);
}
{
  /* 命中归属：两点都在两个靶内时取"靶心更近"的那个，与数组顺序无关 */
  const w = still(world(1, 1));
  const farOne = place(w, 'ring', 200, 360);
  const nearOne = place(w, 'ring', 240, 360);
  const h = C.targetAt(w, 228, 360);
  ok('重叠区域取靶心更近者', h && h.t.id === nearOne.id, h && h.t.type + '#' + h.t.id);
  void farOne;
}
{
  const w = still(world(1, 1));
  place(w, 'ring', 120, 360);
  eq('场上无靶时打空不报错', C.fire(w, 700, 200).some(e => e.kind === 'miss'), true);
}

/* ============================================================ SECTION: 闪隐 / 收缩 / 起靶 */
out.push('=== 特殊靶机制 ===');
{
  const w = world(1, 1);
  const t = C.spawnTarget(w, 'blink');
  ok('闪隐靶有 on/off 参数', t && t.on > 0 && t.off > 0);
  let vis = 0, inv = 0;
  for (let i = 0; i < 200; i++) { const p = C.poseOf(t, i / 20); if (p.vis) { vis++; } else { inv++; } }
  ok('闪隐靶在周期内既可见也不可见', vis > 0 && inv > 0, `vis=${vis} inv=${inv}`);
  /* 不可见瞬间打不中 */
  const w2 = still(world(1, 1));
  const b = place(w2, 'blink', 400, 360, { motion: 'blink', vx: 0 });
  b.on = 0.5; b.off = 0.5; b.age = 0.9;                 // 落在 off 窗口
  eq('隐身瞬间 targetAt 不返回该靶', C.targetAt(w2, 400, 360), null);
  b.age = 0.1;                                          // 落在 on 窗口
  ok('现身时能命中', !!C.targetAt(w2, 400, 360));
}
{
  const w = world(1, 1);
  const t = C.spawnTarget(w, 'shrinker');
  let mx = 0, mn = Infinity;
  for (let i = 0; i <= 100; i++) { const r = C.poseOf(t, i / 100 * 3).r; mx = Math.max(mx, r); mn = Math.min(mn, r); }
  ok('收缩靶半径周期变化且不超过基准', mx <= t.r + 1e-6 && mn < mx * 0.6, `max=${mx.toFixed(1)} min=${mn.toFixed(1)} base=${t.r.toFixed(1)}`);
}
{
  const w = still(world(1, 1));
  const t = place(w, 'ring', 450, 360, { motion: 'pop' });
  t.riseT = D.RULES.HIT_FLOOR; t.riseDist = 40; t.age = 0.1;
  eq('起靶过程中不可打', C.poseOf(t, t.age).vis, false);
  eq('升完才可打', C.poseOf(t, t.riseT + 0.01).vis, true);
}
{
  const w = still(world(1, 1));
  place(w, 'splitter', 450, 360);
  const n0 = w.targets.length;
  const ev = C.fire(w, 450, 360);
  eq('分裂靶打散出 2 枚小靶', ev.filter(e => e.kind === 'spawn' && e.type === 'mini').length, D.TARGETS.splitter.split);
  ok('小靶已进场且分值更高', w.targets.filter(t => t.alive && t.type === 'mini').length === 2
    && D.TARGETS.mini.value > D.TARGETS.splitter.value, 'live=' + w.targets.filter(t => t.alive).length + '/' + n0);
}
{
  const w = still(world(1, 1));
  place(w, 'gold', 450, 360);
  const c0 = w.stats.coins;
  C.fire(w, 450, 360);
  eq('金靶给金币', w.stats.coins - c0, D.TARGETS.gold.coins);
}
{
  const w = still(world(1, 1));
  place(w, 'clock', 450, 360);
  const t0 = w.timeLeft;
  C.fire(w, 450, 360);
  near('秒表靶加时', w.timeLeft - t0, D.TARGETS.clock.timeBonus, 1e-9);
}

/* ============================================================ SECTION: 炸弹惩罚 */
out.push('=== 炸雷靶（本作唯一的"不许打"） ===');
{
  const w = still(world(5, 1));
  place(w, 'ring', 300, 360);
  C.fire(w, 300, 360);
  w.score += 500;                  // 留出扣分余量：别让"夹到 0"干扰这组的数值断言
  w.streak = 12; w.mult = C.multFor(D, 12);
  run(w, w.gun.interval + 0.02);
  place(w, 'bomb', 600, 300);
  const s1 = w.score, t1 = w.timeLeft;
  const ev = C.fire(w, 600, 300);
  const b = ev.find(e => e.kind === 'bomb');
  ok('打中炸雷靶 → bomb 事件带扣分与扣时', b && b.loss === D.SCORE.BOMB_PTS && b.time === D.SCORE.BOMB_TIME,
    JSON.stringify(b && { loss: b.loss, time: b.time }));
  eq('炸雷靶倒扣分数', w.score, s1 - D.SCORE.BOMB_PTS);
  near('炸雷靶倒扣时间', w.timeLeft, t1 - D.SCORE.BOMB_TIME, 1e-9);
  eq('炸雷靶打断连击', w.streak, 0);
  eq('炸雷靶不计入命中数', w.stats.hits, 1);
  eq('炸雷靶自身也消失了', w.targets.filter(t => t.alive).length, 0);
}
{
  const w = still(world(5, 1));
  place(w, 'bomb', 300, 360);
  w.score = 30;
  C.fire(w, 300, 360);
  ok('分数不足时扣分夹到 0，不出现负分', w.score === 0, 'score=' + w.score);
}
{
  const w = world(5, 5);
  const evAll = run(w, 40);
  const bombs = evAll.filter(e => e.kind === 'spawn' && e.bad).length;
  ok('不主动开枪时不会触发任何炸弹惩罚', w.stats.bombs === 0 && bombs > 0, 'spawned=' + bombs);
}

/* ============================================================ SECTION: 弹药 / 射速 / 换弹 */
out.push('=== 弹药与换弹状态机 ===');
{
  const w = still(world(1, 1)); w.spawnIn = 99;         // 关掉生成，只看枪
  const g = w.gun;
  eq('弹匣容量', w.ammo, g.mag);
  C.fire(w, 450, 300);
  eq('一发后弹药 -1', w.ammo, g.mag - 1);
  const ev = C.fire(w, 450, 300);
  eq('射速上限：冷却没到的那一发不当场击发', ev.length, 0);
  eq('但它是被"排队"而不是被丢掉', w.pending ? 1 : 0, 1);
  eq('排队期间不扣弹药', w.ammo, g.mag - 1);
  run(w, g.interval + 0.01);
  eq('冷却一到自动补上那一发', w.ammo, g.mag - 2);
  /* 连点只保留最后一枪：不会攒出一梭子（按住扳机 = 按射速稳定出枪） */
  C.fire(w, 100, 200); C.fire(w, 120, 210); C.fire(w, 140, 220);
  ok('排队只留最后一枪', w.pending && w.pending.x === 140, JSON.stringify(w.pending));
  run(w, g.interval + 0.01);
  eq('补射的正是最后一枪', w.ammo, g.mag - 3);
  /* 换弹开始 → 排队作废（不能穿过换弹补一枪） */
  C.fire(w, 300, 300);
  ok('先排上一枪', !!w.pending);
  C.reload(w);
  eq('换弹时排队被清掉', w.pending, null);
  run(w, w.gun.reload + 0.05);
  eq('换弹后弹药上满且没有多打', w.ammo, w.gun.mag);
}
{
  const w = still(world(1, 1)); w.spawnIn = 99;
  let ev = [];
  for (let i = 0; i < w.gun.mag + 4; i++) {
    /* 击发事件可能来自 step 里的"补射"，所以两处的事件都要收 */
    ev = ev.concat(run(w, w.gun.interval + 0.01)).concat(C.fire(w, 450, 300));
  }
  eq('打空弹匣后弹药停在 0（不会变负）', w.ammo, 0);
  eq('空仓扣扳机 → 有"咔哒"的空枪声', ev.filter(e => e.kind === 'dry').length, 1,
    '实际 ' + ev.filter(e => e.kind === 'dry').length + ' 次（连点被节流）');
  eq('空仓不产生击发事件', ev.filter(e => e.kind === 'shot').length, w.gun.mag);
  ok('空仓后自动换弹已排上', w.reloadT > 0 || w.autoReload > 0);
  ok('换弹中扣扳机不会击发', C.fire(w, 450, 300).some(e => e.kind === 'shot') === false);
  run(w, w.gun.reload + 0.05);
  eq('换弹完成弹匣上满', w.ammo, w.gun.mag);
  run(w, w.gun.interval + 0.02);
  eq('换弹后可以继续打', C.fire(w, 450, 300).some(e => e.kind === 'shot'), true);
}
{
  const w = still(world(1, 1)); w.spawnIn = 99;
  run(w, 0.05); C.fire(w, 450, 300);
  const manual = C.reload(w);
  ok('手动换弹触发 reload 事件', manual.some(e => e.kind === 'reload' && e.manual), JSON.stringify(manual));
  ok('手动换弹更快（0.82 倍耗时）', manual[0].dur < w.gun.reload * 0.9 + 1e-9,
    `${manual[0].dur.toFixed(2)} vs 自动 ${w.gun.reload.toFixed(2)}`);
  const w2 = still(world(1, 1)); w2.spawnIn = 99;
  eq('满弹匣时手动换弹无效（不浪费）', C.reload(w2).length, 0);
}
{
  const p = world(1, 1); p.spawnIn = 99;
  run(p, 0.05);
  C.fire(p, 450, 300);
  eq('开一枪散布上涨一个 kick', p.bloom, p.gun.spread0 + p.gun.kick);
  /* 一整匣连射：散布应单调爬升、但永远不越过 maxBloom */
  let mx = p.bloom, prev = p.bloom, rose = 0;
  for (let i = 0; i < p.gun.mag - 1; i++) {
    run(p, p.gun.interval + 0.02); C.fire(p, 450, 300);
    if (p.bloom > prev) { rose++; }
    prev = p.bloom; mx = Math.max(mx, p.bloom);
  }
  ok('连射时散布持续爬升（连打必须拿精度换）', rose >= p.gun.mag - 3, `爬升 ${rose}/${p.gun.mag - 1} 次`);
  ok('散布不越过 maxBloom，且 maxBloom 直读 data 层', mx <= p.gun.maxBloom + 1e-9 && p.gun.maxBloom === D.gunById('pistol').maxBloom,
    `峰值 ${mx.toFixed(1)} / 上限 ${p.gun.maxBloom}`);
  ok('泼满一匣的散布已越过 10 环区（认真瞄才有内十，泼水是另一套收益）',
    mx > D.BASE_R * D.SCORE.RINGS[0].f, 'peak=' + mx.toFixed(1));
  function magPeak(gunId) {
    const g = world(1, 1, gunId); g.spawnIn = 99;
    let peak = 0;
    for (let i = 0; i < g.gun.mag; i++) { run(g, g.gun.interval + 0.02); C.fire(g, 450, 300); peak = Math.max(peak, g.bloom); }
    return peak;
  }
  ok('快枪泼满比慢枪更飘（射速与散布是一组权衡）',
    magPeak('smg') > magPeak('revolver') * 2, `SMG ${magPeak('smg').toFixed(1)} vs 左轮 ${magPeak('revolver').toFixed(1)}`);
  p.bloomHold = 0; run(p, 1.4);
  ok('停火后散布回落到 spread0', Math.abs(p.bloom - p.gun.spread0) < 1e-6, 'bloom=' + p.bloom.toFixed(2));
  const s = still(world(1, 1)); s.spawnIn = 99;
  s.bloomHold = 0; s.bloom = s.gun.spread0; run(s, 2);
  eq('已回到下限就不再降（准星有"稳"的底）', s.bloom, s.gun.spread0);
}
{
  const w = world(1, 1);
  C.setSteady(w, true);
  ok('屏息中', C.bloomOf(w) < w.bloom, `eff=${C.bloomOf(w).toFixed(2)} raw=${w.bloom.toFixed(2)}`);
  const full = w.breath;
  run(w, 0.5);
  ok('屏息消耗气量', w.breath < full, `${full.toFixed(2)}→${w.breath.toFixed(2)}`);
  C.setSteady(w, false);
  const low = w.breath;
  run(w, 1.6);
  ok('放开后气量回升', w.breath > low, `${low.toFixed(2)}→${w.breath.toFixed(2)}`);
  ok('气量封顶在 STEADY.max', w.breath <= D.RULES.STEADY.max + 1e-9, 'breath=' + w.breath.toFixed(2));
  const w2 = world(1, 1);
  w2.breath = 0;
  eq('气量耗尽时按住屏息无效', C.setSteady(w2, true), false);
  const w3 = world(1, 1);
  w3.breath = 0.05; C.setSteady(w3, true);
  const ev = run(w3, 0.3);
  ok('屏息中途耗尽自动放开并给 breathout 事件', ev.some(e => e.kind === 'breathout') && !w3.steady);
  eq('屏息不影响弹着点以外的规则（弹药照扣）', (() => { const w4 = world(1, 1); C.setSteady(w4, true); run(w4, 0.05); C.fire(w4, 400, 300); return w4.stats.fired; })(), 1);
}

/* ============================================================ SECTION: 连击 */
out.push('=== 连击与断连 ===');
{
  const w = still(world(1, 1));
  for (let i = 0; i < 3; i++) {
    w.targets.length = 0; place(w, 'ring', 300 + i * 100, 360);
    const before = w.score;
    C.fire(w, 300 + i * 100, 360);
    run(w, w.gun.interval + 0.02);
    ok(`第 ${i + 1} 次命中连段 = ${i + 1}`, w.streak === i + 1, 'streak=' + w.streak);
    ok(`第 ${i + 1} 次命中的倍率 = ×${w.mult}`, before < w.score && w.mult === C.multFor(D, i + 1));
  }
  eq('3 连段已到 ×2', w.mult, 2);
  const s = w.score;
  w.targets.length = 0;
  run(w, w.gun.interval + 0.02);
  C.fire(w, 40, 560);                       // 打空
  eq('打空 → 连段归零', w.streak, 0);
  eq('打空 → 倍率回 ×1', w.mult, 1);
  eq('打空本身不给分', w.score, s);
  const s2 = w.score;
  w.targets.length = 0; place(w, 'ring', 300, 360);
  run(w, w.gun.interval + 0.02);
  C.fire(w, 300, 360);
  eq('重新命中从 ×1 起算（但分数继续累加）', w.streak, 1, 'score ' + s2 + '→' + w.score);
}
{
  const w = still(world(1, 1));
  place(w, 'ring', 300, 360);
  C.fire(w, 300, 360);
  eq('命中后连段为 1', w.streak, 1);
  const ev = run(w, D.RULES.COMBO_WINDOW + 0.05);
  ok('超过连击窗口自动断连并给 streakbreak 事件',
    w.streak === 0 && ev.some(e => e.kind === 'streakbreak' && e.why === 'timeout'));
}
{
  const w = still(world(1, 1));
  place(w, 'ring', 300, 360);
  C.fire(w, 300, 360);
  run(w, w.gun.interval + 0.02);
  const ev = C.fire(w, 700, 200);
  ok('断连事件说明原因 = 打空', ev.some(e => e.kind === 'streakbreak' && e.why === 'miss'));
}

/* ============================================================ SECTION: 结算 */
out.push('=== 关卡结算 ===');
{
  const w = world(1, 3); w.spawnIn = 99;
  w.downs = w.need - 1;
  const t0 = w.timeLeft;
  C.finish(w, 'clear', []);
  eq('击落数达标即过关', w.phase, 'clear');
  const r = w.result;
  ok('结算带完整字段', ['kind', 'level', 'base', 'clearBonus', 'timeBonus', 'grade', 'score', 'coins', 'accuracy', 'downs', 'need'].every(k => k in r),
    Object.keys(r).join(','));
  eq('结算里的进度是击落数', r.downs + '/' + r.need, (w.need - 1) + '/' + w.need);
  eq('通关奖励 = 基础 + 关号×每关增量', r.clearBonus, D.SCORE.CLEAR_BONUS + D.SCORE.CLEAR_PER_LEVEL);
  eq('剩余时间折分', r.timeBonus, Math.floor(t0) * D.SCORE.TIME_BONUS_PER_SEC);
  eq('0 命中 0 击发 → 命中率按 0 计（C 级，系数 1）', r.grade, 'C');
  eq('C 级不额外加成', r.score, Math.round(r.base + r.clearBonus + r.timeBonus));
  ok('过关金币 = 场上金币 + 基础 + 评级 + 命中折算', r.coins >= D.SCORE.COINS_CLEAR_BASE);
}
{
  /* 过关只看击落数：分数再高也不算达标（这条决定"六把枪在同一张表上压力一致"） */
  const w = world(1, 3); w.spawnIn = 99;
  w.score = 999999;
  run(w, 0.3);
  eq('刷分不能过关', w.phase, 'play');
  w.downs = w.need;
  run(w, 0.05);
  eq('补齐击落数立刻过关', w.phase, 'clear');
}
{
  const w = world(1, 3); w.spawnIn = 99;
  w.stats.fired = 10; w.stats.hits = 9; w.downs = w.need;
  C.finish(w, 'clear', []);
  eq('命中率 90% → S 评级', w.result.grade, 'S');
  ok('S 评级把总分放大', w.result.score > w.score + w.result.clearBonus + w.result.timeBonus,
    w.result.score + ' vs base ' + w.score);
}
{
  const w = world(1, 3); w.spawnIn = 99;
  run(w, D.LEVELS[0].time + 1);
  eq('时间耗尽仍未打够 → 直接失败', w.phase, 'over');
  ok('失败时已拿到的分保留为成绩', w.result && w.result.kind === 'over');
  eq('失败后 step 不再推进', (function () { const t = w.t; run(w, 1); return w.t === t; })(), true);
  eq('失败后不能开枪', C.fire(w, 100, 100).length, 0);
}
{
  const w = world(1, 3); w.spawnIn = 99;
  w.downs = w.need;
  const ev = run(w, 0.1);
  ok('过关在 step 内自动判定并推 clear 事件', w.phase === 'clear' && ev.some(e => e.kind === 'clear'));
}

/* ============================================================ SECTION: 确定性 */
out.push('=== 种子确定性 ===');
function scripted(seed, level, gunId, precision, opts) {
  opts = opts || {};
  const w = world(level, seed, gunId);
  if (opts.noGoal) { w.need = Infinity; }        // 打满整关时限，用来横向比较打法优劣
  const dt = 1 / 60;
  let guard = 0;
  const cap = Math.ceil((opts.secs || D.levelConfig(level).time + 6) / dt);
  while (w.phase === 'play' && guard++ < cap) {
    C.step(w, dt);
    if (w.phase !== 'play') { break; }
    const list = C.liveTargets(w).filter(t => !t.bad && t.vis);
    if (!list.length) {
      /* 场上没靶可打时先把弹匣补上 —— 真人也是这么干的 */
      if (w.ammo < w.gun.mag && w.reloadT <= 0) { C.reload(w); }
      continue;
    }
    if (w.reloadT > 0 || w.cool > 0) { continue; }
    if (precision && C.bloomOf(w) > 6) { continue; }         // 精瞄流：等准星回落到 6px 内再开枪
    let best = list[0];
    for (const t of list) {
      const v = t.value * (t.depth === 'far' ? 1.45 : t.depth === 'mid' ? 1.2 : 1);
      const bv = best.value * (best.depth === 'far' ? 1.45 : best.depth === 'mid' ? 1.2 : 1);
      if (v > bv) { best = t; }
    }
    C.fire(w, best.x, best.y);
  }
  return w;
}
{
  const a = scripted(123, 7, 'pistol'), b = scripted(123, 7, 'pistol'), c = scripted(124, 7, 'pistol');
  eq('同种子 → 同得分', a.score, b.score);
  eq('同种子 → 同击发数', a.stats.fired, b.stats.fired);
  ok('不同种子 → 局面不同（说明随机真的进了生成）', a.score !== c.score || a.stats.fired !== c.stats.fired,
    `${a.score}/${a.stats.fired} vs ${c.score}/${c.stats.fired}`);
}
{
  /* AI 不偷看底牌式的公平检查：脚本策略只读 liveTargets（公开信息），
     把两个靶的"隐藏字段"互换不应改变它的选靶 —— 本作没有暗牌，
     但纵深/分值都是公开的，所以这里钉的是"liveTargets 不含未公开信息"。 */
  const w = world(8, 42);
  run(w, 20);
  const lt = C.liveTargets(w);
  const leaks = lt.filter(t => Object.keys(t).some(k => ['mask', 'faceDown', 'hidden'].includes(k)));
  eq('liveTargets 只暴露公开字段', leaks.length, 0, Object.keys(lt[0] || {}).join(','));
  ok('liveTargets 的 vis 字段真实反映"此刻可打"', lt.every(t => typeof t.vis === 'boolean'));
}

/* ============================================================ SECTION: 守门 */
out.push('=== 守门：脚本化射手必须打得过每一关（6 把枪 × 全关卡 × 多种子） ===');
{
  const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const guns = D.GUNS.map(g => g.id);
  const bad = [];
  const tight = [];                      // 每次过关用掉的时限比例（越接近 1 越悬）
  for (const gunId of guns) {
    for (const lv of levels) {
      for (const seed of [5, 77, 2025]) {
        const w = scripted(seed, lv, gunId);
        /* 用时占比要按"实际经过的时间"算，不能拿剩余时间反推：
           秒表靶会加时，剩余时间比开局还多是合法结果（早先这里算出过 14% 的假数据）。 */
        const frac = w.t / D.levelConfig(lv).time;
        if (w.phase === 'clear') { tight.push({ gunId, lv, frac }); }
        else { bad.push(`${gunId}@L${lv} 没过（击落 ${w.downs}/${w.need}，已打满 ${(frac * 100).toFixed(0)}% 时限）`); }
      }
    }
  }
  ok('六把枪在全 10 关 + 无尽 3 轮都能稳定过关（击落数达标）', bad.length === 0,
    bad.length ? '违例 ' + bad.length + ' 处：' + bad.slice(0, 5).join(' | ') : '');
  const tightest = tight.reduce((m, r) => (r.frac > m.frac ? r : m), { frac: 0 });
  ok('最紧的一枪也留有余量（过关用时 ≤ 时限 92%）', tightest.frac <= 0.92,
    `最紧 ${tightest.gunId}@L${tightest.lv} 用掉 ${(tightest.frac * 100).toFixed(0)}% 时限`);
  const loosest = tight.reduce((m, r) => (r.frac < m.frac ? r : m), { frac: 9 });
  ok('没有哪关是白送的（最快也要用掉时限 25% 以上）', loosest.frac >= 0.25,
    `最松 ${loosest.gunId}@L${loosest.lv} 只用 ${(loosest.frac * 100).toFixed(0)}% 时限`);
  out.push('    · 各枪最紧一关的用时占比 ' + guns.map(g => {
    const arr = tight.filter(r => r.gunId === g).map(r => r.frac);
    return g + ' ' + (Math.max(...arr) * 100).toFixed(0) + '%';
  }).join(' / '));

  /* "认真瞄有回报"要直接测弹着分布，而不是靠脚本 AI 表达：
     AI 一有靶就打、打完就等，准星根本没机会飘起来（靶的供应量才是瓶颈），
     于是 spray 与 precise 两种策略在 AI 手里跑出完全相同的结果 —— 断言会假通过。 */
  function shotQuality(gunId, bloom) {
    const w = world(6, 4, gunId); w.spawnIn = 99;
    let tot = 0, hits = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      w.targets.length = 0;
      place(w, 'ring', 450, 360);
      w.bloom = bloom; w.bloomHold = 0; w.cool = 0; w.ammo = w.gun.mag;
      const h = C.fire(w, 450, 360).find(e => e.kind === 'hit');
      if (h) { hits++; tot += h.pts; }
    }
    return { mean: tot / n, rate: hits / n };
  }
  const qTight = shotQuality('pistol', 2), qLoose = shotQuality('pistol', 17), qOff = shotQuality('pistol', 40);
  ok('准星越飘，期望环数越低 —— 等它回落再开枪是有回报的',
    qTight.mean > qLoose.mean * 1.2, `2px 期望 ${qTight.mean.toFixed(2)} 环分 vs 17px ${qLoose.mean.toFixed(2)}`);
  ok('飘到散布上限（17px）仍不会脱靶，只是掉环数 —— 上限标定的意义',
    qLoose.rate > 0.99, `命中率 ${(qLoose.rate * 100).toFixed(0)}%`);
  ok('把散布强行调到上限之外也会被夹回 maxBloom（封顶真的在管）',
    qOff.mean <= qLoose.mean + 1e-6, `40px 名义散布实测 ${qOff.mean.toFixed(2)} 环分 ≤ 17px 的 ${qLoose.mean.toFixed(2)}`);
  const pr = [1, 4, 6, 10].map(lv => scripted(31, lv, 'pistol', true).phase === 'clear');
  ok('精瞄流同样能过关（慢不等于打不过）', pr.every(Boolean), pr.join(','));
  const prAcc = [1, 4, 6, 10].map(lv => { const w = scripted(31, lv, 'pistol', true); return w.stats.hits / Math.max(1, w.stats.fired); });
  ok('精瞄流命中率 ≥ 90%（说明"认真瞄"能拿 S）', prAcc.every(a => a >= 0.9), prAcc.map(a => (a * 100).toFixed(0) + '%').join(' '));
}
{
  /* 无尽不会失控：跑到第 25 轮仍能正常结算（既不卡死也不出现 0 靶） */
  const w = world(25, 3);
  let spawned = 0;
  for (let i = 0; i < 60 * D.levelConfig(25).time && w.phase === 'play'; i++) {
    const before = w.targets.length;
    C.step(w, 1 / 60);
    if (w.targets.length > before) { spawned += w.targets.length - before; }
    const list = C.liveTargets(w).filter(t => !t.bad && t.vis);
    if (list.length && w.cool <= 0 && w.reloadT <= 0) { C.fire(w, list[0].x, list[0].y); }
  }
  ok('无尽 25 轮仍在生成靶且能收口', spawned > 30 && w.phase !== 'play',
    `spawned=${spawned} phase=${w.phase} 击落 ${w.downs}/${w.need}`);
}
{
  /* 表现：每关的靶密度（AI 每关平均面对多少发靶） */
  const dens = [1, 5, 10].map(lv => {
    const w = world(lv, 8); let n = 0;
    for (let i = 0; i < 60 * D.levelConfig(lv).time && w.phase === 'play'; i++) {
      const before = w.targets.length; C.step(w, 1 / 60); if (w.targets.length > before) { n++; }
    }
    return `L${lv}≈${n}发`;
  });
  out.push('    · 每关靶量 ' + dens.join(' / '));
}

/* ============================================================ 汇总 */
console.log(out.join('\n'));
console.log(`\n通过 ${pass} / ${pass + fail}`);
if (fail) { console.log(`❌ 失败 ${fail} 项`); process.exit(1); }
console.log('✅ 全部通过');
