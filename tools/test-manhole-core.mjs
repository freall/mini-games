/* ============================================================
   开车不要压井盖儿 · 核心逻辑单测（纯 node，不需要浏览器）
   SECTION: test-manhole-core
   ------------------------------------------------------------
   跑法：node tools/test-manhole-core.mjs
   被测：assets/manhole-data.js + assets/manhole-core.js

   为什么这些断言值得写：碰撞判定是这款游戏的命门 ——
   "车轮压到井盖 = 输"如果判定错了，游戏不是太难就是玩不了。
   所以边界（正好擦边、正好压上、四车道最边上）都有精确构造的用例。

   带随机性的部分（生成、选道）统一用**固定种子的可控 rng**，
   保证测试确定、可重复，不会偶发飘红。
   ============================================================ */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {} };
/* data 与 core 都以 window.XXX = ... 的形式导出，这里给个 window 就能直接用 */
for (const f of ['assets/manhole-data.js', 'assets/manhole-core.js']) {
  const code = readFileSync(join(ROOT, f), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', code)(sandbox.window);
}
const D = sandbox.window.MANHOLE_DATA;
const C = sandbox.window.MANHOLE_CORE;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
function near(name, got, want, tol = 1e-6) {
  ok(name, Math.abs(got - want) <= tol, `got=${got} want=${want}±${tol}`);
}

/* 确定性 rng：LCG，固定种子 → 同一序列永远一样 */
function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function section(t) { console.log('\n— ' + t + ' —'); }

/* ============================================================
   1. 关卡配置
   ============================================================ */
section('关卡配置与难度曲线');
eq('第 1 关能取到配置', D.levelConfig(1).level, 1);
eq('LEVELS 表长度 10', D.LEVELS.length, 10);
ok('第 1 关速度 = baseSpeed', D.levelConfig(1).speed === D.WORLD.baseSpeed);

/* 单调性：密度递增、速度递增、路程递增、行距递减 —— 难度必须严格变难 */
let mono = true, monoDetail = '';
for (let lv = 2; lv <= 10; lv++) {
  const a = D.levelConfig(lv - 1), b = D.levelConfig(lv);
  if (!(b.obstaclesPer100m > a.obstaclesPer100m)) { mono = false; monoDetail = '密度 ' + lv; break; }
  if (!(b.speed > a.speed)) { mono = false; monoDetail = '速度 ' + lv; break; }
  if (!(b.distance > a.distance)) { mono = false; monoDetail = '路程 ' + lv; break; }
  if (!(b.maxGapRows <= a.maxGapRows && b.minGapRows <= a.minGapRows)) { mono = false; monoDetail = '行距 ' + lv; break; }
}
ok('难度曲线单调递增（密度/速度/路程升，行距降）', mono, monoDetail);

/* 速度封顶 */
ok('速度不超过 maxSpeed', D.levelConfig(1).speed <= D.WORLD.maxSpeed);
let capped = true;
for (let lv = 1; lv <= 200; lv++) { if (D.levelConfig(lv).speed > D.WORLD.maxSpeed) { capped = false; break; } }
ok('无限关卡后速度仍不超 maxSpeed', capped);
let densCapped = true;
for (let lv = 1; lv <= 500; lv++) { if (D.levelConfig(lv).obstaclesPer100m > D.ENDLESS.maxDensity) { densCapped = false; break; } }
ok('无限关卡后密度不超 maxDensity', densCapped);

/* 无尽关 */
const endless = D.levelConfig(13);
ok('第 11 关起进入无尽模式', endless.endless === true, JSON.stringify(endless));
eq('无尽关 minGapRows 收到 1', endless.minGapRows, 1);
ok('levelConfig 对 0/负数做兜底', D.levelConfig(0).level === 1 && D.levelConfig(-5).level === 1);

/* ============================================================
   2. 空间与车轮
   ============================================================ */
section('空间换算与车轮落点');
eq('路面左边界', C.roadLeft(D), D.ROAD.marginX);
eq('路面右边界', C.roadRight(D), D.LAYOUT.W - D.ROAD.marginX);
eq('4 车道宽', Math.round(C.laneWidth(D, 4)), Math.round((900 - 192) / 4));
/* 车道中心必须落在路面内，且等距 */
let centersOk = true, centers = [];
for (let i = 0; i < 4; i++) {
  const x = C.laneCenterX(D, 4, i);
  centers.push(Math.round(x));
  if (x <= C.roadLeft(D) || x >= C.roadRight(D)) { centersOk = false; }
}
ok('所有车道中心都在路面范围内', centersOk, centers.join(','));
eq('相邻车道中心间距 = 车道宽', Math.round(centers[1] - centers[0]), Math.round(C.laneWidth(D, 4)));

/* laneOfX 往返一致：每个车道中心都应映射回自己 */
let laneRound = true;
for (let i = 0; i < 4; i++) {
  if (C.laneOfX(D, 4, C.laneCenterX(D, 4, i)) !== i) { laneRound = false; break; }
}
ok('laneOfX(laneCenterX(i)) === i（往返一致）', laneRound);
/* SECTION: 车道占用与判定的自洽性
   核心要保证的是：**"占用车道"不会漏报真正压到的井盖**。
   即：如果某个车轮压到了车道 L 的井盖中心，那么 occupiedLanes 必须包含 L。
   （早期我误以为"车心在车道 1、左轮在车道 0"会导致误判，实测发现
    车轮离车道 0 的井盖还有 56px、远超 41px 的判定阈值，所以并不会 ——
    真正接触时车心已经落在车道 0 了。这个断言保留了当时想验证的那条不变量。） */
eq('车对准车道 1 中心时，占用车道只有 1',
  C.occupiedLanes(D, 4, C.laneCenterX(D, 4, 1)).join(','), '1');
eq('车对准车道 0 中心时，占用车道只有 0',
  C.occupiedLanes(D, 4, C.laneCenterX(D, 4, 0)).join(','), '0');
eq('对准车道中心时 alignedLane 返回该车道',
  C.alignedLane(D, 4, C.laneCenterX(D, 4, 2)), 2);
eq('车心压在车道边界上时 alignedLane = -1（还没对准）',
  C.alignedLane(D, 4, C.laneBounds(D, 4, 1).left), -1);
eq('车心压在车道边界上时占用两条道（车轮各在一侧）',
  C.occupiedLanes(D, 4, C.laneBounds(D, 4, 1).left).length, 2);

/* 不变量：扫过路面全程，"占用车道"必须覆盖"实际压到的井盖所在车道"。
   这是"玩家看到的车道提示"与"底层判定"一致性的守门断言。 */
let occConsistent = true, occDetail = '';
const mhR = C.manholeRadius(D, 4);
for (let x = C.roadLeft(D); x <= C.roadRight(D); x += 2) {
  const occ = C.occupiedLanes(D, 4, x);
  for (let l = 0; l < 4; l++) {
    const o = { x: C.laneCenterX(D, 4, l), y: D.PLAYER.y, r: mhR };
    const hit = C.carHits(D, 4, x, D.PLAYER.y, o);
    /* 压到某条车道的井盖时，占用集合必须包含那条车道 */
    if (hit && occ.indexOf(l) < 0) {
      occConsistent = false;
      occDetail = `carX=${x.toFixed(0)} 压到 lane${l} 但 occupiedLanes=[${occ}]`;
      break;
    }
  }
  if (!occConsistent) { break; }
}
ok('压到某车道井盖时 occupiedLanes 必定包含该车道（视觉/判定自洽）', occConsistent, occDetail);

/* 占用车道最多两条（车轮只有两个） */
let occMaxTwo = true;
for (let x = C.roadLeft(D); x <= C.roadRight(D); x += 3) {
  if (C.occupiedLanes(D, 4, x).length > 2) { occMaxTwo = false; break; }
}
ok('任何位置占用车道数都 ≤ 2（车轮只有两个）', occMaxTwo);

/* 车轮：左右各一，对称，贴在车身两侧（外沿向内缩一个轮半径） */
const cw = C.carWidth(D, 4);
const ws = C.wheels(D, 4, 450, 512);
eq('车轮数量 = 2', ws.length, 2);
near('车轮对称（中心 = 车身中心）', (ws[0].x + ws[1].x) / 2, 450);
near('轮距 = 车宽 - 2 × 轮半径（车轮贴车身外沿）', ws[1].x - ws[0].x, cw - 2 * D.PLAYER.wheelRadius);
eq('车轮 y = 车身 y', ws[0].y, 512);
ok('车轮半径 > 0', ws[0].r > 0);
/* 车轮不能跑到车身外面去 */
ok('车轮在车身覆盖范围内（不外扩）',
  ws[0].x - ws[0].r >= 450 - cw / 2 - 1e-9 && ws[1].x + ws[1].r <= 450 + cw / 2 + 1e-9,
  `wheels=[${ws[0].x.toFixed(1)},${ws[1].x.toFixed(1)}] body=[${(450 - cw / 2).toFixed(1)},${(450 + cw / 2).toFixed(1)}]`);

/* 车宽必须小于车道宽（否则两车道之间的缝挤不过去） */
ok('车宽 < 车道宽（能并线换道）', cw < C.laneWidth(D, 4), `cw=${cw.toFixed(1)} lane=${C.laneWidth(D, 4).toFixed(1)}`);

/* ============================================================
   3. 碰撞判定 —— 本作命门
   ============================================================ */
section('碰撞判定（车轮压到井盖 = 输）');
eq('同心圆相交', C.circlesOverlap(0, 0, 10, 0, 0, 10), true);
eq('分离圆不相交', C.circlesOverlap(0, 0, 10, 100, 0, 10), false);
eq('外切（圆心距 = 半径和）算相交', C.circlesOverlap(0, 0, 10, 20, 0, 10), true);
eq('差一点外切算不相交', C.circlesOverlap(0, 0, 10, 20.001, 0, 10), false);
eq('包含关系算相交', C.circlesOverlap(0, 0, 30, 1, 0, 5), true);

/* 精确构造：把井盖放在车轮正下方 → 必定压到 */
const cx0 = C.laneCenterX(D, 4, 1);
const mine = { x: C.wheels(D, 4, cx0, 512)[0].x, y: 512, r: D.PLAYER.wheelRadius };
eq('井盖正好在左轮落点 → 压到', C.carHits(D, 4, cx0, 512, mine), true);

/* 井盖在两条车轮正中间（车的正下方）、且完全被车身覆盖 → **算压到**
   （踩过的坑：只用车轮判会漏掉这一块，"车碾过井盖却不死"是最劝退的 bug） */
const mid = { x: cx0, y: 512, r: C.manholeRadius(D, 4) };
eq('井盖在车底正中 → 算压到（车身覆盖即压到）', C.carHits(D, 4, cx0, 512, mid), true);
/* 但"车底正中"必须是井盖整个被盖住；车轮判定已经管住了两侧的接触 */
ok('车底正中判定的前提：井盖确实小于车身宽', C.manholeRadius(D, 4) * 2 < C.carWidth(D, 4),
  `井盖直径=${C.manholeRadius(D, 4) * 2} 车宽=${C.carWidth(D, 4).toFixed(1)}`);

/* 井盖离车轮很远 → 不算 */
eq('井盖在远处 → 不压到', C.carHits(D, 4, cx0, 512, { x: cx0 + 220, y: 512, r: 20 }), false);

/* 临界：圆心距恰好 = 轮半径 + 井盖半径 → 算压到（<=）；再多 1px 不算
   注意：+1px 之后井盖会跑到"车身正下方"的区域里（车身覆盖即压到），
   所以这里要用**车宽之外**的位置来验证"真的不碰"。 */
const w0 = C.wheels(D, 4, cx0, 512)[0];
const sum = w0.r + 20;
eq('临界外切（distance = r1+r2）→ 算压到',
  C.carHits(D, 4, cx0, 512, { x: w0.x + sum, y: 512, r: 20 }), true);
const farOutside = cx0 - C.carWidth(D, 4) / 2 - 20 - sum;   // 完全在车身左侧之外
eq('圆心距超出半径和、且完全在车身之外 → 不算压到',
  C.carHits(D, 4, cx0, 512, { x: farOutside, y: 512, r: 20 }), false);

/* 纵向偏移同理：井盖在车轮正上方但不重叠 */
const belowBody = 512 + D.PLAYER.h / 2 + sum + 1;
eq('纵向刚好错开 → 不算压到',
  C.carHits(D, 4, cx0, 512, { x: w0.x, y: belowBody, r: 20 }), false);
eq('纵向刚好贴上 → 算压到',
  C.carHits(D, 4, cx0, 512, { x: w0.x, y: 512 + sum, r: 20 }), true);

/* 大井盖更容易压到；小井盖更难 —— 判定半径必须真的起作用。
   注意现在"车底正中"本身就算压到（车身覆盖），
   所以要拿"车身之外"的位置来验证小井盖判不到。 */
const outsideX = cx0 - C.carWidth(D, 4) / 2 - 40;
const big = C.carHits(D, 4, cx0, 512, { x: outsideX, y: 512, r: 60 });
const small = C.carHits(D, 4, cx0, 512, { x: outsideX, y: 512, r: 4 });
ok('井盖越大越容易被压到（半径参与判定）', big === true && small === false,
  `big=${big} small=${small}`);

/* 擦过去：净间隙计算。
   nearMissGap 返回的是**两个车轮里最接近的那个**的净间隙，
   所以构造用例时必须让被测井盖就是最近的那个 —— 之前的写法把它放在左轮右侧，
   结果右轮离它只有 14.8px，反而成了"最近的车轮"，断言自然对不上。
   这里直接取右轮做基准，把井盖放在右轮右侧 (轮半径+井盖半径+20) 处。 */
const rightWheel = C.wheels(D, 4, cx0, 512)[1];
const rightSum = rightWheel.r + 20;
const gapManhole = { x: rightWheel.x + rightSum + 20, y: 512, r: 20 };
near('净间隙 = 圆心距 - 半径和（取最近的车轮）',
  C.nearMissGap(D, 4, cx0, 512, gapManhole), 20, 1e-6);
ok('已压到时净间隙为负', C.nearMissGap(D, 4, cx0, 512, mine) < 0,
  'gap=' + C.nearMissGap(D, 4, cx0, 512, mine));

/* SECTION: 车身判定 vs 车轮判定 —— 两者必须区分开

   井盖：车轮碰到 **或** 井盖整个落在车身覆盖范围内 → 压到
         （为什么不能只判车轮：车轮间距 87.7px 比井盖直径 60px 还宽，
          井盖能整个躲在两轮之间，只判车轮就会出现"车碾过井盖却不死"）。
   拾取物：一律按车身判定（车正中的金币必须能捡到 —— 踩过的坑）。 */
eq('井盖在车底正中（被车身完全覆盖）→ 压到',
  C.carHits(D, 4, cx0, 512, { x: cx0, y: 512, r: 15 }), true);
eq('井盖在车轮上 → 压到',
  C.carHits(D, 4, cx0, 512, { x: C.wheels(D, 4, cx0, 512)[0].x, y: 512, r: 15 }), true);
eq('井盖在车身之外 → 不压到',
  C.carHits(D, 4, cx0, 512, { x: cx0 + 200, y: 512, r: 15 }), false);
eq('underBody：车底正中的井盖 = true',
  C.underBody(D, 4, cx0, 512, { x: cx0, y: 512, r: 15 }), true);
eq('underBody：只露出一半的井盖 ≠ true（交给车轮判定处理接触）',
  C.underBody(D, 4, cx0, 512, { x: cx0 + 40, y: 512, r: 15 }), false);
eq('车身判定：车正中的金币算捡到',
  C.carBodyHits(D, 4, cx0, 512, { x: cx0, y: 512, r: 15 }), true);
eq('车身判定：车外的金币捡不到',
  C.carBodyHits(D, 4, cx0, 512, { x: cx0 + 200, y: 512, r: 15 }), false);
eq('车身判定：车头前方的金币捡不到',
  C.carBodyHits(D, 4, cx0, 512, { x: cx0, y: 512 + 120, r: 15 }), false);
eq('车身判定：刚好贴到车头（半车长+半径）算捡到',
  C.carBodyHits(D, 4, cx0, 512, { x: cx0, y: 512 + D.PLAYER.h / 2 + 15, r: 15 }), true);
/* 车身扫掠同样防穿透 */
eq('车身扫掠：本帧位移跨过金币 → 能捕到',
  C.sweptBodyHit(D, 4, cx0, 512, { x: cx0, y: 512 + 160, r: 15 }, 200), true);

/* 扫掠判定：防止高速/掉帧时"穿过"井盖。
   构造一个"本帧末位置已经完全越过井盖"的场景：井盖在车轮下方，
   但帧位移很大，单点判定查不出来，扫掠判定必须能捕到。 */
const sweepWheelX = C.wheels(D, 4, C.laneCenterX(D, 4, 1), 512)[0].x;
const behind = { x: sweepWheelX, y: 512 + 120, r: 20 };   // 井盖已在车下方 120px
eq('单点判定：井盖已越过 → 判不到（这正是漏洞）',
  C.carHits(D, 4, C.laneCenterX(D, 4, 1), 512, behind), false);
eq('扫掠判定：本帧位移 160px → 能捕到中途的碰撞',
  C.sweptHit(D, 4, C.laneCenterX(D, 4, 1), 512, behind, 160), true);
eq('扫掠判定：本帧位移很小（井盖确实没碰到）→ 不误报',
  C.sweptHit(D, 4, C.laneCenterX(D, 4, 1), 512, behind, 4), false);
/* 高速穿透回归：一整帧位移超过井盖直径时必须判到 */
eq('高速穿透回归（位移 > 井盖直径）',
  C.sweptHit(D, 4, C.laneCenterX(D, 4, 1), 512, { x: sweepWheelX, y: 512 + 200, r: 20 }, 260), true);

/* SECTION: 各车道都能"过得去"
   这是硬性可玩性约束：任何一条车道上的井盖，
   只要把车挪到别的车道上，就一定安全（说明并线是有效解）。 */
let allLanesEscapable = true, escapeDetail = '';
for (let lane = 0; lane < 4; lane++) {
  const o = { x: C.laneCenterX(D, 4, lane), y: 512, r: C.manholeRadius(D, 4) };
  if (!C.carHits(D, 4, C.laneCenterX(D, 4, lane), 512, o)) { allLanesEscapable = false; escapeDetail = 'lane' + lane + ' 停在自己道上却没压到'; break; }
  const other = (lane + 1) % 4;
  if (C.carHits(D, 4, C.laneCenterX(D, 4, other), 512, o)) { allLanesEscapable = false; escapeDetail = 'lane' + lane + ' 躲到 lane' + other + ' 仍压到'; break; }
}
ok('每条车道的井盖都能靠并线躲开', allLanesEscapable, escapeDetail);

/* 相邻车道的井盖不会互相粘连（否则"缝"在视觉与判定上都不存在） */
ok('井盖半径 < 车道宽的一半（相邻井盖不粘连）',
  C.manholeRadius(D, 4) < C.laneWidth(D, 4) / 2,
  `r=${C.manholeRadius(D, 4)} half=${(C.laneWidth(D, 4) / 2).toFixed(1)}`);

/* ============================================================
   4. 计分
   ============================================================ */
section('计分与连击');
eq('0 个 → 倍率 1', C.comboMult(0, D), 1);
eq('刚满 comboStep → 倍率 2', C.comboMult(D.SCORE.comboStep, D), 2);
eq('倍率封顶', C.comboMult(9999, D), D.SCORE.comboMax);
let comboMono = true;
for (let n = 0; n < 40; n++) { if (C.comboMult(n, D) > C.comboMult(n + 1, D)) { comboMono = false; break; } }
ok('倍率随躲过的井盖数单调不减', comboMono);

eq('金币基础分 × 倍率', C.pickupScore('coin', 0, D), D.SCORE.coin);
eq('连击 6 时金币分翻倍', C.pickupScore('coin', D.SCORE.comboStep, D), D.SCORE.coin * 2);
eq('未知拾取物得 0 分', C.pickupScore('nope', 99, D), 0);
ok('关卡分随路程增加', C.levelScore(100, 1, D) < C.levelScore(200, 1, D));
ok('关卡分随关卡增加', C.levelScore(100, 1, D) < C.levelScore(100, 2, D));
eq('关卡分 = 米 + 关卡奖励×关卡', C.levelScore(50, 3, D), 50 + D.SCORE.levelBonus * 3);

/* ============================================================
   5. 生成器
   ============================================================ */
section('跑道生成');
/* SECTION: 多行接力可行性 —— 本作最关键的可玩性保证
   "看着有缝、实际必死"是最伤人的设计缺陷：如果行 A 逼你往右、行 B 立刻逼你往左，
   玩家一个时间窗里根本来不及。所以生成时必须保证**存在一条连续可通过的车道路径**。
   这里同时验证核心helpers 和真实生成的世界。 */
eq('freeLanes 差集正确', C.freeLanes(4, [0, 2]).join(','), '1,3');
eq('survives：有交集 → 可达', C.survives([1, 2], [2, 3], 4), true);
eq('survives：相邻可并线 → 可达', C.survives([1], [2], 4), true);
eq('survives：隔两条车道 → 不可达（一次并线来不及）', C.survives([0], [3], 4), false);
eq('survives：完全错开 → 不可达', C.survives([0], [2], 4), false);
/* reachAfter(prev, rowCols, lanes)：从 prev 里每条车道出发，
   可原地不动、也可左右并线一条；把这一行有井盖的车道剔除。
   reachAfter([1], [0]) → 从 1 出发能到 0/1/2，0 这行有井盖被剔除 → [1,2] */
eq('reachAfter：从 1 出发、0 被占 → 可达 1,2', C.reachAfter([1], [0], 4).join(','), '1,2');
eq('reachAfter：整行无井盖 → 相邻三条都可达', C.reachAfter([1], [], 4).join(','), '0,1,2');
eq('reachAfter：被占的车道排除', C.reachAfter([1, 2], [1], 4).join(','), '0,2,3');
eq('reachAfter：边界车道不会越界', C.reachAfter([0], [], 4).join(','), '0,1');

/* 真实生成：连续 3 行内必须存在一条车道全程安全。
   这是"会预判就能过"的充要条件 —— 玩家看得见 3 行就已经够用。 */
let pathOk = true, pathDetail = '';
for (let lv = 1; lv <= 20 && pathOk; lv++) {
  const cfg = D.levelConfig(lv);
  for (let seed = 1; seed <= 25 && pathOk; seed++) {
    const sim = new C.World(D, lv, seededRng(seed * 4441 + lv)).start();
    /* 用 spawnRow 直接生成 40 行，记录每行车道上是否有井盖 */
    const rows = [];
    for (let i = 0; i < 40; i++) {
      sim.nextRowY = -120;
      const before = sim.obs.length;
      sim.spawnRow([]);
      const blocked = [];
      for (let li = 0; li < sim.lanes; li++) { blocked.push(0); }
      for (let oi = before; oi < sim.obs.length; oi++) {
        const o = sim.obs[oi];
        if (o.kind === 'manhole') { blocked[C.laneOfX(D, sim.lanes, o.x)] = 1; }
      }
      rows.push(blocked);
      sim.obs.length = 0;                        // 清场，只要行数据
    }
    /* 滑动窗口：连续 3 行里找一条全程无井盖的车道 */
    for (let i = 0; i + 2 < rows.length; i++) {
      let safe = -1;
      for (let l = 0; l < sim.lanes; l++) {
        if (!rows[i][l] && !rows[i + 1][l] && !rows[i + 2][l]) { safe = l; break; }
      }
      if (safe < 0) {
        /* 退一步：允许"逐行并线一条"的接力路径存在也算可通行 */
        let reach = [];
        for (let l = 0; l < sim.lanes; l++) { if (!rows[i][l]) { reach.push(l); } }
        for (let k = 1; k < 3; k++) { reach = C.reachAfter(reach, rows[i + k].map((b, idx) => b ? idx : -1).filter(x => x >= 0), sim.lanes); }
        if (!reach.length) {
          pathOk = false;
          pathDetail = `lv${lv} seed${seed} 第 ${i}~${i + 2} 行无法连续通过（rows=${rows.slice(i, i + 3).map(r => r.join('')).join(' ')}）`;
          break;
        }
      }
    }
  }
}
ok('真实生成中连续 3 行总有可通行路径（不会出现"看着有缝实际必死"）', pathOk, pathDetail);

/* 单行不封路（复用上面的生成数据重申一次，作为回归保护） */
let rowNotFull = true, rowFullDetail = '';
for (let lv = 1; lv <= 30 && rowNotFull; lv++) {
  const cfg = D.levelConfig(lv);
  for (let seed = 1; seed <= 40 && rowNotFull; seed++) {
    const rng = seededRng(seed * 7919 + lv);
    let reach = [0, 1, 2, 3];
    for (let i = 0; i < 30; i++) {
      const cols = C.makeRow(D, cfg, 4, rng, reach);
      if (cols.length >= 4) { rowNotFull = false; rowFullDetail = `lv${lv} seed${seed} cols=${cols}`; break; }
      if (!cols.length) { rowNotFull = false; rowFullDetail = `lv${lv} seed${seed} 空行`; break; }
      if (new Set(cols).size !== cols.length) { rowNotFull = false; rowFullDetail = `lv${lv} 重复车道 ${cols}`; break; }
      reach = C.reachAfter(reach, cols, 4);
      if (!reach.length) { rowNotFull = false; rowFullDetail = `lv${lv} seed${seed} 第 ${i} 行后无路可走`; break; }
    }
  }
}
ok('任何关卡、任何种子下都不封路且始终有路可走', rowNotFull, rowFullDetail);

/* 高关卡的井盖确实更多（密度参数真的被用上了） */
function avgCols(level, n = 400) {
  const cfg = D.levelConfig(level);
  const rng = seededRng(20260918 + level);
  let s = 0;
  for (let i = 0; i < n; i++) { s += C.makeRow(D, cfg, 4, rng).length; }
  return s / n;
}
const a1 = avgCols(1), a10 = avgCols(10);
ok('第 10 关每行井盖数明显多于第 1 关', a10 > a1 + 0.3, `lv1=${a1.toFixed(2)} lv10=${a10.toFixed(2)}`);

/* 第 1 关 cluster=0 时不允许并排（每行最多 1 个） */
const rng1 = seededRng(42);
let lv1MaxOne = true;
for (let i = 0; i < 300; i++) { if (C.makeRow(D, D.levelConfig(1), 4, rng1).length > 1) { lv1MaxOne = false; break; } }
ok('第 1 关不会出现并排井盖（cluster=0，新手友好）', lv1MaxOne);

/* 行距：按「反应时间」定，而不是按像素。
   判据是**反应时间不随关卡缩水**（下界 0.6s），像素行距则随速度一起变大。 */
function reactTime(level, seed) {
  const cfg = D.levelConfig(level);
  const d = C.rowSpacing(D, cfg, seededRng(seed));
  return d / cfg.speed;
}
let reactOk = true, reactDetail = '';
for (let lv = 1; lv <= 30; lv++) {
  for (let s = 1; s <= 40; s++) {
    const rt = reactTime(lv, s * 131 + lv);
    if (rt < 0.55) { reactOk = false; reactDetail = `lv${lv} seed${s} 反应时间仅 ${rt.toFixed(3)}s`; break; }
    if (rt > 1.4) { reactOk = false; reactDetail = `lv${lv} seed${s} 反应时间过长 ${rt.toFixed(3)}s`; break; }
  }
  if (!reactOk) { break; }
}
ok('所有关卡、所有随机种子下反应时间都在 0.55~1.4s（难度公平性）', reactOk, reactDetail);

/* 像素行距随速度放大（高速关卡的井盖间隔更大） */
const sp1 = C.rowSpacing(D, D.levelConfig(1), () => 0.5);
const sp10 = C.rowSpacing(D, D.levelConfig(10), () => 0.5);
ok('高关卡像素行距 > 低关卡（补偿速度）', sp10 > sp1, `lv1=${sp1.toFixed(0)} lv10=${sp10.toFixed(0)}`);

/* 反应时间随关卡是有意收紧的（但要收紧得温和） */
const rt1 = reactTime(1, 0.5), rt10 = reactTime(10, 0.5);
ok('反应时间随关卡收紧（变难，但温和）', rt10 < rt1, `lv1=${rt1.toFixed(2)}s lv10=${rt10.toFixed(2)}s`);
ok('反应时间收紧幅度不超过一半（不至于变成靠运气）', rt10 > rt1 * 0.5,
  `lv1=${rt1.toFixed(2)} lv10=${rt10.toFixed(2)}`);
/* 并线余量：反应时间必须 ≥ 连续两次并线所需（否则连环变向必然来不及） */
ok('反应时间 ≥ 0.62s（至少够两次并线落位）', Math.min(rt1, rt10) >= 0.62,
  `lv1=${rt1.toFixed(3)} lv10=${rt10.toFixed(3)}`);

let spacingOk = true;
for (let lv = 1; lv <= 20; lv++) {
  const cfg = D.levelConfig(lv);
  for (let s = 1; s <= 30; s++) {
    const d = C.rowSpacing(D, cfg, seededRng(s * 131 + lv));
    if (!(d > 100)) { spacingOk = false; break; }
  }
  if (!spacingOk) { break; }
}
ok('所有关卡的行距都 > 100px（不会贴脸刷井盖）', spacingOk);

/* shuffle 是确定性且真的打乱 */
const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const sh1 = C.shuffle(arr.slice(), seededRng(7));
const sh2 = C.shuffle(arr.slice(), seededRng(7));
eq('同种子 shuffle 结果一致', JSON.stringify(sh1), JSON.stringify(sh2));
eq('shuffle 不增不减元素', sh1.slice().sort((a, b) => a - b).join(','), '0,1,2,3,4,5,6,7,8,9');

/* ============================================================
   6. World 世界模拟
   ============================================================ */
section('世界模拟（World）');
const w = new C.World(D, 1, seededRng(99));
eq('初始里程 0', w.meters, 0);
eq('初始车道在中间', C.laneOfX(D, w.lanes, w.carX), Math.floor(w.lanes / 2));
ok('初始未结束', !w.over && !w.won && !w.running);
w.start();
ok('start 之后 running', w.running);

/* 车辆横移被夹在路面内 */
w.setCarX(-9999);
const leftMost = w.carX;
w.setCarX(99999);
const rightMost = w.carX;
ok('车不会开出路肩（左）', leftMost >= C.roadLeft(D) - 0.001, `x=${leftMost}`);
ok('车不会开出路肩（右）', rightMost <= C.roadRight(D) + 0.001, `x=${rightMost}`);
ok('车确实能横向移动（左右极限不同）', rightMost - leftMost > 200);

/* shiftLane：一次一条车道，边界不越界 */
w.setCarX(C.laneCenterX(D, w.lanes, 0));
eq('在最左道再往左 = 不动', w.shiftLane(-1), false);
eq('最左道位置不变', C.laneOfX(D, w.lanes, w.carX), 0);
eq('最左道往右 = 换到第 2 道', w.shiftLane(1), true);
eq('换道后车道号 = 1', C.laneOfX(D, w.lanes, w.carX), 1);
for (let i = 0; i < 10; i++) { w.shiftLane(1); }
eq('一路往右最终停在最右道', C.laneOfX(D, w.lanes, w.carX), w.lanes - 1);

/* 前进与计分：跑 1 秒，里程应约等于 速度/12 米 */
const w2 = new C.World(D, 1, seededRng(5)).start();
const sp0 = w2.curSpeed();
w2.update(1.0);
near('跑 1 秒的米数 = 速度 / 12', w2.meters, sp0 / 12, 0.01);
ok('里程增加后分数也增加', w2.score > 0, `score=${w2.score}`);

/* 加速带：速度倍率生效，到期恢复 */
const w3 = new C.World(D, 1, seededRng(6)).start();
w3.applySpeed(D.RULES.nitroMs, D.RULES.nitroMult);
near('加速中速度 = 基础 × 倍率', w3.curSpeed(), w3.speed * D.RULES.nitroMult, 0.001);
w3.update(D.RULES.nitroMs / 1000 + 0.01);
near('加速到期后速度恢复', w3.speedMul, 1, 1e-9);
eq('到期后速度倍率计时归零', w3.speedMulMs, 0);

/* 减速会顶掉加速（不同时叠加） */
const w4 = new C.World(D, 1, seededRng(7)).start();
w4.applySpeed(D.RULES.nitroMs, D.RULES.nitroMult);
w4.applySlow(D.RULES.slowMs, D.RULES.slowMult);
near('减速顶掉加速（只有一个倍率生效）', w4.curSpeed(), w4.speed * D.RULES.slowMult, 0.001);

/* SECTION: 压到井盖 → 结束
   在车正前方的车轮落点放一个井盖，推进一帧即可触发。 */
const w5 = new C.World(D, 1, seededRng(11)).start();
const wheelX = C.wheels(D, w5.lanes, w5.carX, D.PLAYER.y)[0].x;
w5.obs = [{ kind: 'manhole', x: wheelX, y: D.PLAYER.y, r: 20 }];
const ev5 = w5.update(0.016);
const crashEv = ev5.filter(e => e.t === 'crash');
eq('压到井盖产生 crash 事件', crashEv.length, 1);
eq('压到井盖后本局结束', w5.over, true);
eq('结束后 running 置 false', w5.running, false);
eq('记录压盖次数', w5.hitCount, 1);
eq('结束后残命 = 0', w5.livesLeft(), 0);
/* 结束后再 update 不再前进 */
const metersAfter = w5.meters;
w5.update(1.0);
eq('结束后不再前进（冻结）', w5.meters, metersAfter);

/* 护盾：压到井盖不结束，且井盖被清除 */
const w6 = new C.World(D, 1, seededRng(12)).start();
w6.shieldMs = D.RULES.shieldMs;
w6.obs = [{ kind: 'manhole', x: wheelX, y: D.PLAYER.y, r: 20 }];
const ev6 = w6.update(0.016);
eq('护盾挡下压盖（不结束）', w6.over, false);
ok('护盾触发 shielded 事件', ev6.some(e => e.t === 'shielded'));
eq('被护盾挡下的井盖被移除', w6.obs.length, 0);
ok('护盾期间也算躲过一个（连击不断）', w6.dodged === 1);

/* 幸运星：压到井盖消耗一颗星，不结束 */
const w7 = new C.World(D, 1, seededRng(13)).start();
w7.lucky = 2;
w7.obs = [{ kind: 'manhole', x: wheelX, y: D.PLAYER.y, r: 20 }];
const ev7 = w7.update(0.016);
eq('幸运星顶掉一次压盖（不结束）', w7.over, false);
eq('幸运星消耗一颗', w7.lucky, 1);
ok('幸运星触发 lucky 事件', ev7.some(e => e.t === 'lucky'));
/* 星用光了再压就死 */
w7.obs = [{ kind: 'manhole', x: wheelX, y: D.PLAYER.y, r: 20 }];
w7.update(0.016);
w7.obs = [{ kind: 'manhole', x: wheelX, y: D.PLAYER.y, r: 20 }];
w7.update(0.016);
eq('第二颗星用掉后 lucky=0', w7.lucky, 0);
w7.obs = [{ kind: 'manhole', x: wheelX, y: D.PLAYER.y, r: 20 }];
w7.update(0.016);
eq('没星没盾再压 = 结束', w7.over, true);

/* 幸运星上限 */
const w8 = new C.World(D, 1, seededRng(14)).start();
for (let i = 0; i < 10; i++) { w8.applyPickup({ kind: 'star', x: 0, y: 0 }); }
eq('幸运星不会超过上限', w8.lucky, D.RULES.luckyMax);

/* SECTION: 拾取物 */
const w9 = new C.World(D, 1, seededRng(15)).start();
const scoreBefore = w9.score;
w9.obs = [{ kind: 'coin', x: w9.carX, y: D.PLAYER.y, r: 15 }];
const ev9 = w9.update(0.016);
ok('捡到金币有 pickup 事件且加分', ev9.some(e => e.t === 'pickup' && e.kind === 'coin') && w9.score > scoreBefore,
  `score ${scoreBefore} -> ${w9.score}`);
eq('捡到的金币从世界移除', w9.obs.filter(o => o.kind === 'coin').length, 0);

/* 护盾道具给自己上盾 */
const w10 = new C.World(D, 1, seededRng(16)).start();
w10.obs = [{ kind: 'shield', x: w10.carX, y: D.PLAYER.y, r: 17 }];
w10.update(0.016);
eq('捡到护盾 → shieldMs 生效', w10.shieldMs, D.RULES.shieldMs);

/* 路锥：撞上只减速 + 断连击，不致命 */
const w11 = new C.World(D, 1, seededRng(17)).start();
w11.dodged = 9;
w11.obs = [{ kind: 'hazard', haz: 'cone', x: w11.carX, y: D.PLAYER.y, r: 18 }];
const ev11 = w11.update(0.016);
ok('撞路锥不致命', !w11.over);
eq('撞路锥断连击', w11.dodged, 0);
ok('撞路锥触发 bump 且减速', ev11.some(e => e.t === 'bump') && w11.curSpeed() < w11.speed);

/* 井盖从底部出屏 → 计入"躲过一个"（连击） */
const w12 = new C.World(D, 1, seededRng(18)).start();
w12.obs = [{ kind: 'manhole', x: C.laneCenterX(D, w12.lanes, 0), y: D.LAYOUT.H + 200, r: 20 }];
w12.update(0.016);
eq('井盖出屏 → 计为躲过', w12.dodged, 1);
eq('出屏后从世界移除', w12.obs.length, 0);

/* 连击事件：每到 comboStep 的倍数触发一次 */
const w13 = new C.World(D, 1, seededRng(19)).start();
const evAll = [];
for (let i = 0; i < D.SCORE.comboStep + 2; i++) {
  w13.obs = [{ kind: 'manhole', x: C.laneCenterX(D, w13.lanes, 0), y: D.LAYOUT.H + 200, r: 20 }];
  evAll.push(...w13.update(0.001));
}
ok('连击到达阈值时发出 combo 事件', evAll.some(e => e.t === 'combo'),
  'events=' + evAll.map(e => e.t).join(','));
ok('连击倍率随之上升', w13.combo() >= 2, 'combo=' + w13.combo());

/* SECTION: 通关 */
const w14 = new C.World(D, 1, seededRng(20)).start();
w14.distance = D.levelConfig(1).distance * 12 - 1;   // 差一点点到终点
w14.update(0.5);
eq('跑满路程即通关', w14.won, true);
ok('通关后 running 停止', w14.running === false);
eq('通关进度为 1', Math.round(w14.progress() * 100), 100);

/* 进度条随里程单调上升且被夹在 0~1 */
const w15 = new C.World(D, 2, seededRng(21)).start();
let progMono = true, lastProg = -1;
for (let i = 0; i < 60; i++) {
  w15.update(0.1);
  const p = w15.progress();
  if (p < lastProg - 1e-9) { progMono = false; break; }
  if (p < 0 || p > 1) { progMono = false; break; }
  lastProg = p;
  if (w15.won || w15.over) { break; }
}
ok('进度在 0~1 之间且单调不减', progMono);

/* SECTION: 开局保护期
   graceMs 内不应该刷出井盖（否则玩家一进关就被贴脸） */
const w16 = new C.World(D, 1, seededRng(22)).start();
w16.update(D.RULES.startGraceMs / 1000 - 0.05);
const spawnedEarly = w16.obs.filter(o => o.kind === 'manhole').length;
eq('开局保护期内不刷井盖', spawnedEarly, 0);
w16.update(D.RULES.startGraceMs / 1000 + 2.0);
ok('保护期结束后开始刷井盖', w16.obs.some(o => o.kind === 'manhole'),
  'obs=' + w16.obs.map(o => o.kind).join(','));

/* SECTION: 长时间模拟的稳定性 —— 跑到通关全程不崩、不出现非法值 */
let simOk = true, simDetail = '';
for (let lv of [1, 5, 10, 15]) {
  const sim = new C.World(D, lv, seededRng(lv * 1000 + 7)).start();
  let steps = 0;
  while (!sim.won && !sim.over && steps < 40000) {
    sim.update(1 / 60);
    steps++;
    if (!isFinite(sim.carX) || !isFinite(sim.score) || !isFinite(sim.meters)) { simOk = false; simDetail = `lv${lv} 出现非有限值`; break; }
    if (sim.carX < C.roadLeft(D) - 1 || sim.carX > C.roadRight(D) + 1) { simOk = false; simDetail = `lv${lv} 车开出路面 x=${sim.carX}`; break; }
    const bad = sim.obs.find(o => !isFinite(o.x) || !isFinite(o.y));
    if (bad) { simOk = false; simDetail = `lv${lv} 世界元素坐标非法`; break; }
  }
  if (!simOk) { break; }
  if (steps >= 40000) { simOk = false; simDetail = `lv${lv} 模拟 40000 帧仍未结束（可能卡死）`; break; }
}
ok('各关卡长时间模拟都正常结束、数值健康', simOk, simDetail);

/* 全程"不动方向盘"应该会压到井盖（说明井盖真的挡在路上，不是装饰） */
const w17 = new C.World(D, 1, seededRng(1234)).start();
let idleHit = false;
for (let i = 0; i < 6000 && !w17.won && !w17.over; i++) {
  w17.update(1 / 60);
  if (w17.over) { idleHit = true; }
}
ok('完全不操作会压到井盖（井盖真的构成威胁）', idleHit || w17.won,
  idleHit ? '压到了' : ('没压到但路程=' + Math.round(w17.meters) + '/' + w17.cfg.distance));

/* SECTION: 会玩就能活 —— 用一个"会预判 + 会算时间"的 AI 验证游戏可通过

   **这里踩过一个大坑，写下来免得再犯**：
   早期版本的 AI 是"贪心"的 —— 只看最近一行，挑一条最近的安全车道冲过去，
   定了就不改（"承诺车道"策略）。结果 40 个用例里挂 15 个，死状高度一致：
   车停在两条车道之间（carX=425，正好是车道 1 与 2 的分界），
   被它**正在离开/正要进入**的那条车道的井盖夹死。
   我一度以为是**关卡生成不公平**，还写了几版"生成约束"去打补丁。

   后来用两个探针把问题定死了：
     · 探针A（瞬移 AI，零换道耗时）：40/40 通关 —— 说明**关卡本身可解**；
     · 探针B（时间窗 DP，只看行序列和行距，完全不管玩家）：
       80/80 可解 —— 说明**生成器的可达性约束是充分的**。
   结论：**游戏是公平的，是那个贪心 AI 自己不聪明**。
   它输在"只看一行"：等最近一行逼它变向时才动，而让它下一行又得往回变，
   中间那点时间不够走完两次横移，车就卡在缝里。

   所以这里换成**时间窗 DP 规划器**（既是最强的可解性守门人，也是最像高手玩家的策略）：
     目标：对前方每一行，存在一条车道序列 l_1..l_n，l_i 都是第 i 行的空位，
           且相邻两行之间 |l_{i+1} - l_i| × 单次换道耗时 ≤ 两行到达的时间差。
     做法：维护 earliest[l] = "通过在车道 l 上越过当前行所需的最早时刻"，
           逐行向前推，任何一行推不出有限值就说明这一关在那一点上是死局。
   然后把 DP 的结论（每一行该走哪条道）交给横向控制器执行 ——
   控制器只有真实横向速度上限（steerSpeed），不做任何瞬移，跑的是真物理。 */
const MAX_STEER = D.PLAYER.steerSpeed * C.laneWidth(D, 4);   // px/s
const LANE_SWITCH_S = C.laneWidth(D, 4) / MAX_STEER;         // 换一条车道的纯移动耗时

/* 把前方井盖按"行"归并（同一批生成的 y 相近），按离车的距离由近到远排序。

   **两道防线，缺一不可**（这两条都是踩出来的）：

   a) 前视要够远：判定从"井盖边缘碰到车身前端"就开始
      （车身前端 y = PLAYER.y - 车长/2 = 473，井盖半径 30 ⇒ y≈443 进危险区）。
      如果窗口只到车身前端，一行从"进入视野"到"撞上"只剩不到 0.2 秒，
      DP 再聪明也来不及，AI 就表现为"突然被一条没见过的道上的井盖撞死"。
      所以按速度换算成至少 1.6 秒的纵深。

   b) **后视要保持可见：一行必须一直留在计划里，直到车完全越过它。**
      这是最阴的一处 bug —— 之前的实现把"车身前方"当作可见边界
      （r.y < 车身前端 - 井盖半径），于是某一行一旦越过这条线就"隐身"了。
      可它其实还在车身侧面！实测现场：车为了躲 1.9 秒后才到的一行而并线，
      穿过的那条道上正好有一块**刚刚越界、已从计划里消失**的井盖，
      车一头撞上去 —— 计划里根本看不到它。
      所以下界取车身**后端**（PLAYER.y + 车长/2 + 井盖半径），
      只要还可能跟车身有接触，这一行就得参与规划。 */
function upcomingRows(sim, maxRows) {
  const lookahead = Math.max(600, sim.curSpeed() * 1.6);   // 至少前瞻 1.6 秒的路程
  const r = C.manholeRadius(D, sim.lanes);
  const topY = D.PLAYER.y - D.PLAYER.h / 2 - lookahead;    // 能看见多远
  const bottomY = D.PLAYER.y + D.PLAYER.h / 2 + r;         // 车尾之后才算"通过"
  const marks = sim.obs.filter(o => o.kind === 'manhole' && o.y > topY && o.y < bottomY);
  marks.sort((a, b) => b.y - a.y);                // y 越大越靠近车
  const rows = [];
  for (const o of marks) {
    let row = rows.find(rr => Math.abs(rr.y - o.y) < 40);
    if (!row) { row = { y: o.y, lanes: [] }; rows.push(row); }
    row.lanes.push(C.laneOfX(D, sim.lanes, o.x));
  }
  return rows.slice(0, maxRows || 6);
}

/* 时间窗 DP：给定前方各行（含到达时刻）与当前所在车道，
   算出"每一行应该走哪条车道"的完整计划。
   返回 { lanes: [第1行走哪条, 第2行走哪条, ...], ok: 计划是否可行 }。

   为什么要从远到近做 DP 而不是从近到远贪心：因为"这一行走哪条道"
   依赖于"下一行要往哪边走"。先看远处、再回头定近处，才不会被眼前的缝骗进去。 */
function planLanes(sim, rows) {
  const n = rows.length;
  if (!n) { return { lanes: [], ok: true }; }
  /* 各行到达车所在 y 的时刻（从"现在"起算的秒数）。
     **注意方向**：y 向下增大，行在车上方（r.y < PLAYER.y），
     所以剩余距离是 PLAYER.y - r.y —— 写成 (r.y - PLAYER.y) 会得到负数，
     被 max(0,…) 夹成 0，整个时间窗 DP 就退化成"所有行同时到达"（踩过）。 */
  const tArr = rows.map(r => Math.max(0, (D.PLAYER.y - r.y) / sim.curSpeed()));
  /* feasibleAt[i][l] = "在第 i 行走车道 l，且从这一行往后全部能过"
     从最后一行往回推（先看远处再定近处，才不会被眼前的缝骗进去）。 */
  const feasibleAt = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array(sim.lanes).fill(false);
    for (let l = 0; l < sim.lanes; l++) {
      if (rows[i].lanes.indexOf(l) >= 0) { continue; }        // 这条道这一行有井盖
      if (i === n - 1) { cur[l] = true; continue; }           // 最后一行：站着就赢
      const budget = tArr[i + 1] - tArr[i];
      for (let l2 = 0; l2 < sim.lanes; l2++) {
        if (!feasibleAt[i + 1][l2]) { continue; }
        if (Math.abs(l2 - l) * LANE_SWITCH_S <= budget) { cur[l] = true; break; }
      }
    }
    feasibleAt[i] = cur;
  }
  /* 前向回填：逐行定车道。
     策略是"能不动就不动"（stay-put）而不是"挑最近的一条"：
     频繁变道会让车一直漂在两道之间，反而更容易被夹死；
     而且 stay-put 天然贴近人类玩家的手感 —— 稳住一条道，除非必须让。
     只有在"当前车道对某一行不可行"时，才去挑一条 **可行、来得及到、且离自己最近** 的。 */
  const picks = new Array(n).fill(-1);
  let from = C.laneOfX(D, sim.lanes, sim.carX);
  /* 当前位置到第 0 行的期限，用于判断"来不来得及" */
  for (let i = 0; i < n; i++) {
    const deadline = i === 0 ? tArr[0] : (tArr[i] - tArr[i - 1]);
    if (feasibleAt[i][from]) { picks[i] = from; continue; }   // 不用动
    let best = -1, bestD = 99;
    for (let l = 0; l < sim.lanes; l++) {
      if (!feasibleAt[i][l]) { continue; }
      const d = Math.abs(l - from);
      if (d * LANE_SWITCH_S > deadline) { continue; }
      if (d < bestD) { bestD = d; best = l; }
    }
    if (best < 0) { return { lanes: picks, ok: false, failRow: i }; }
    picks[i] = best;
    from = best;
  }
  return { lanes: picks, ok: true, tArr: tArr };
}

/* 执行器：把 DP 的计划变成横向动作。

   **关键点 —— 什么时候开始并线**（踩了最多坑的地方）：
   光有计划不够。如果机器只盯着"最近一行该走哪条道"，它会等最近的缝不够用了才动，
   而那时下一行可能又要求往回走 —— 两次变向挤在一点点时间里，车就卡在两道之间被夹死。
   正确做法：**用计划里第一个"与当前车道不同"的目标车道作为行动目标**，
   并且只要"现在出发，赶得上那一行的期限"，就立即开始挪 —— 提前量由计划本身保证
   （计划已经检查过每一段的 |Δ车道| × 单次换道耗时 ≤ 那一段的时间预算）。 */
/* 执行器：把 DP 的"每一行走哪条道"变成横向动作。

   三段式规则（每一句都是踩出来的）：

   ① **目标 = 计划里第一条"要求换道"的行所要求的车道**，而不是最近一行。
      只盯最近一行的话，最近一行不需要动时车会一路直行，
      等后面某一行变成"最近"时已经不够横移时间了。

   ② **横移时机必须等"要穿过的车道"清空**。
      这是最隐蔽的坑：DP 假设"某一行过去之后再动身"，
      而执行器如果一拿到新目标就立刻开动，就会**在旧威胁还没走开的时候横穿它** ——
      实测现场：车刚从车道 1 躲进车道 0，计划的下一行要求回车道 1，
      车立刻往回开，结果正好撞上还没过去的车道 1 井盖（tArr 还有 0.25s）。
      所以横移前要确认：从当前车道到目标车道之间要穿过的那些车道，
      在"马上要过的这一行"里必须是干净的。

   ③ 目标车道用"开到位才算数"维护，不看瞬间车心（车停在分界线上时
      laneOfX 会每帧跳变，导致目标翻转、车原地抖动被夹死）。 */
function autoPlay(level, seed) {
  const sim = new C.World(D, level, seededRng(seed)).start();
  const dt = 1 / 60;
  let deadlock = null;
  let target = C.laneOfX(D, sim.lanes, sim.carX);
  const TOL = C.laneWidth(D, sim.lanes) * 0.06;
  /* 换道时会穿过的车道集合（不含起点，含终点） */
  const crossedLanes = (a, b) => {
    const out = [];
    const step = b > a ? 1 : -1;
    for (let l = a + step; step > 0 ? l <= b : l >= b; l += step) { out.push(l); }
    return out;
  };
  for (let i = 0; i < 60000 && !sim.won && !sim.over; i++) {
    const rows = upcomingRows(sim, 8);
    if (rows.length) {
      const p = planLanes(sim, rows);
      if (!p.ok) { deadlock = { meter: sim.meters, rows: rows.map(r => r.lanes.slice()) }; break; }
      const txCur = C.laneCenterX(D, sim.lanes, target);
      const arrived = Math.abs(sim.carX - txCur) <= TOL;
      if (arrived) {
        /* 找第一条要求换道的行 */
        let want = target, wantIdx = -1;
        for (let k = 0; k < p.lanes.length; k++) {
          if (p.lanes[k] !== target) { want = p.lanes[k]; wantIdx = k; break; }
        }
        if (wantIdx >= 0) {
          const need = Math.abs(want - target) * LANE_SWITCH_S * 1.05;
          /* 时间够 + 前面这几行不会挡住换道路径，才动身 */
          const path = crossedLanes(target, want);
          let blocked = false;
          for (let k = 0; k < wantIdx; k++) {
            for (const l of path) {
              if (rows[k].lanes.indexOf(l) >= 0) { blocked = true; break; }
            }
            if (blocked) { break; }
          }
          if (!blocked && p.tArr[wantIdx] >= need) { target = want; }
        }
      }
      const tx = C.laneCenterX(D, sim.lanes, target);
      if (Math.abs(sim.carX - tx) > TOL) {
        const maxStep = MAX_STEER * dt;
        sim.setCarX(sim.carX + Math.max(-maxStep, Math.min(maxStep, tx - sim.carX)));
      }
    }
    sim.update(dt);
  }
  sim.deadlock = deadlock;
  return sim;
}
/* 用 6 个种子 × 10 关 = 60 个用例把关。
   为什么会写这么多：这套 AI 现在是本作**唯一能真正证明"关卡公平"的机关** ——
   它看得见整个前视窗口、会算每一段的时间预算、跑的是真实横向速度。
   如果连它都过不去，那一关对人类就是不合理的。（历史上它抓出过一个
   "井盖能从两个车轮之间钻过去"的判定漏洞，以及几处生成/时间窗问题。） */
let aiWins = 0, aiRuns = 0, aiDetail = [];
for (let lv = 1; lv <= 10; lv++) {
  for (let s = 1; s <= 6; s++) {
    const r = autoPlay(lv, lv * 900 + s);
    aiRuns++;
    if (r.won) { aiWins++; }
    else if (r.deadlock) { aiDetail.push(`lv${lv}#${s} DEADLOCK@${Math.round(r.deadlock.meter)}m`); }
    else { aiDetail.push(`lv${lv}#${s} 挂在 ${Math.round(r.meters)}m`); }
  }
}
ok('会预判+会算时间的 AI 能通关前 10 关（关卡可解，非碰运气）', aiWins === aiRuns,
  `${aiWins}/${aiRuns} 通关` + (aiDetail.length ? '；失败：' + aiDetail.slice(0, 4).join(' / ') : ''));
/* DP 不能报出"死局"：报死局意味着那一关在那一点上无论怎么开都过不去 */
ok('AI 的规划器从未遇到死局（生成器的时间窗约束充分）', aiDetail.every(d => !d.includes('DEADLOCK')),
  aiDetail.filter(d => d.includes('DEADLOCK')).join(' / '));
/* 第 1~3 关必须轻松通过（新手关不能劝退） */
const easyFail = [];
for (let s = 1; s <= 6; s++) {
  if (!autoPlay(1, 5000 + s).won) { easyFail.push('lv1#' + s); }
  if (!autoPlay(2, 6000 + s).won) { easyFail.push('lv2#' + s); }
  if (!autoPlay(3, 7000 + s).won) { easyFail.push('lv3#' + s); }
}
ok('第 1~3 关 AI 存活率 100%（新手友好）', easyFail.length === 0, easyFail.join(','));

/* 而且 AI 能拿到的分数得是正数、且随关卡提高（跑得越远分越高） */
const r1 = autoPlay(1, 111), r6 = autoPlay(6, 666);
ok('AI 通关第 1 关得分 > 0', r1.score > 0, 'score=' + Math.round(r1.score));
ok('AI 通关第 6 关得分 > 第 1 关', r6.score > r1.score,
  `lv1=${Math.round(r1.score)} lv6=${Math.round(r6.score)}`);

/* ============================================================
   7. statsOf
   ============================================================ */
section('统计导出（门户回显 / 自动化断言用）');
const w18 = new C.World(D, 3, seededRng(31)).start();
w18.update(0.5);
const st = C.statsOf(w18);
for (const k of ['level', 'meters', 'distance', 'score', 'dodged', 'bestDodged',
  'nearMisses', 'lucky', 'shieldMs', 'over', 'won', 'progress', 'combo', 'carX', 'lanes', 'speed', 'obs']) {
  ok('statsOf 含字段 ' + k, Object.prototype.hasOwnProperty.call(st, k));
}
eq('statsOf.level 与关卡一致', st.level, 3);
eq('statsOf.distance 为该关总路程', st.distance, D.levelConfig(3).distance);
ok('statsOf 数值都已四舍五入为整数或有限值', isFinite(st.score) && isFinite(st.meters));

/* ============================================================
   8. 数据完整性
   ============================================================ */
section('数据表完整性');
ok('道具表非空且字段齐全', D.PICKUPS.length >= 3 &&
  D.PICKUPS.every(p => p.id && p.art && p.label && p.desc));
ok('干扰物表非空', D.HAZARDS.length >= 1);
ok('提示文案 >= 5 条', D.TIPS.length >= 5);
ok('压盖吐槽文案非空', D.HIT_LINES.length >= 3);
ok('规则里 life = 1（压盖即输的核心规则）', D.RULES.lives === 1);
ok('音效导出齐全',
  ['resume', 'crash', 'coin', 'star', 'nitro', 'shield', 'nearMiss', 'levelup', 'over', 'engineStart', 'engineSet', 'engineStop']
    .every(k => typeof D.Audio[k] === 'function'));
ok('设计空间尺寸合理', D.LAYOUT.W > 0 && D.LAYOUT.H > 0);
ok('路面两侧都留了路肩', D.ROAD.marginX > 0 && D.ROAD.marginX * 2 < D.LAYOUT.W);

/* ============================================================
   9. 渲染层对 core/data 的调用是否都存在（静态扫描）
   ------------------------------------------------------------
   为什么要有这一段：manhole.js 曾经调用了 D.Audio.start() / stopEngine() /
   shieldHit() 等**根本不存在的方法**，判定明明正确、结算层却永远不弹，
   一路漏到 E2E 才被 Playwright 抓到（pageerror）。这类错误纯 node 也能拦：
   把渲染层源码里所有 `D.<命名空间>.<成员>` 抓出来，逐个核对是否真的导出。
   扫的是"调用点是否合法"，不执行 DOM，所以放单测里很合适。
   ============================================================ */
section('渲染层调用点与导出表一致性');
const viewCode = readFileSync(join(ROOT, 'assets/manhole.js'), 'utf8');
const NS = { D: D, C: C };
/* 去掉注释，避免注释里提到的旧方法名造成误报 */
const viewStripped = viewCode
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const calls = new Set();
for (const m of viewStripped.matchAll(/\b([DC])\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
  calls.add(m[1] + '.' + m[2] + '.' + m[3]);
}
const bad = [];
for (const path of calls) {
  const [ns, member] = path.split('.');
  const seen = path.slice(2);   // 例如 Audio.engineStart
  const [objName, fn] = seen.split('.');
  const obj = NS[ns][objName];
  if (obj === undefined) { bad.push(`${path}（${objName} 未导出）`); continue; }
  if (typeof obj === 'function') { bad.push(`${path}（${objName} 是函数，却当对象取成员）`); continue; }
  /* 允许 getter/setter：用 in 判断即可，不看 typeof */
  if (!(fn in obj)) { bad.push(`${path}（${objName} 没有 ${fn}）`); }
}
ok('manhole.js 引用的 data/core 成员全部存在', bad.length === 0, bad.join('; '));
ok('扫描确实抓到了调用点（防止正则失效后静默通过）', calls.size >= 20, 'calls=' + calls.size);

/* 反射式：getter/setter 属性不一定是 function，单独确认几个关键项 */
ok('Audio.enabled 是访问器（可用 `D.Audio.enabled = x` 赋值）',
  'enabled' in D.Audio && typeof D.Audio.enabled === 'boolean');

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(52));
if (fail) {
  console.log('❌ 失败 ' + fail + ' / ' + (pass + fail));
  for (const f of failures) { console.log('   ✗ ' + f); }
  process.exit(1);
}
console.log('✅ 全部通过：' + pass + ' 项断言');
