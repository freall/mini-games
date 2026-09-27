/* ============================================================
   靶场神枪手 · 纯逻辑核心
   SECTION: shooter-core
   ------------------------------------------------------------
   这里不碰任何 DOM、不碰 canvas：靶子生成与弹道运动、弹着点判定与环数计分、
   连击倍率、弹药/换弹状态机、散布与屏息、关卡目标结算全在这，
   可以脱离浏览器直接用 node 跑断言（tools/test-shooter-core.mjs）。

   坐标系（设计空间，与窗口像素无关）：
     x → 横向，0 在左边界，LAYOUT.W 在右；靶心允许区间 = padX ~ W-padX
     y → 纵向，0 在上，LAYOUT.H 在下；三段纵深（远靶在上、近靶在下）
     准星与弹着点都用这套坐标，渲染层负责 pointer → 设计坐标的换算。

   三条设计口径（改动前先读）：

     1. **轨迹解析式而非逐帧积分**：靶心位置由 (spawn 参数, age) 直接算出。
        于是判定不受帧率影响（掉帧不会让靶子"穿过"准星），
        单测可以精确断言"第 t 秒这个靶在哪"。

     2. **一靶一命，位置决定收益**：打中即结算，弹着点离靶心多远决定 4/6/8/10/内十环。
        所以"瞄哪儿"永远比"打几发"重要 —— 连射型枪的优势是续连击，不是单发分。

     3. **公平性地板 HIT_FLOOR**：每个靶"可被打中"的时间不得短于 rules.HIT_FLOOR 秒，
        生成时按解析式反推速度上限；同屏靶心互不重叠，炸雷靶与计分靶额外避让。
        理由：本作唯一会让人"明明瞄对了却被打脸"的就是重叠与瞬隐，
        那是设计缺陷不是难度。守门断言见单测的"全关卡可通关 + 窗口地板"两组。
   ============================================================ */
window.SHOOTER_CORE = (function () {
  'use strict';

  var TAU = Math.PI * 2;

  /* SECTION: 计分与倍率
     环数表按「弹着点距离 / 当前靶半径」的比例定档。
     内十单列：它比 10 环更严（0.07R），给 20 分 + 固定奖励，
     这样"神准一枪"在数值上真的能区别于"擦到正中区域"。 */
  function ringOf(D, dist, r) {
    if (r <= 0) { return null; }
    var f = dist / r;
    if (f <= D.SCORE.BULL.f) { return { pts: D.SCORE.BULL.pts, label: D.SCORE.BULL.label, bull: true, frac: f }; }
    for (var i = 0; i < D.SCORE.RINGS.length; i++) {
      var rg = D.SCORE.RINGS[i];
      if (f <= rg.f) { return { pts: rg.pts, label: rg.label, bull: false, frac: f }; }
    }
    return null;
  }

  /* 连段 → 倍率：取"已达到的最高档" */
  function multFor(D, streak) {
    var tiers = D.RULES.STREAK_TIERS, m = 1;
    for (var i = 0; i < tiers.length; i++) { if (streak >= tiers[i].n) { m = tiers[i].x; } }
    return m;
  }

  function gradeOf(D, accuracy) {
    for (var i = 0; i < D.SCORE.GRADES.length; i++) {
      if (accuracy >= D.SCORE.GRADES[i].min) { return D.SCORE.GRADES[i]; }
    }
    return D.SCORE.GRADES[D.SCORE.GRADES.length - 1];
  }

  /* SECTION: 枪参数
     data 层的 GUNS 表合成这一局的有效参数。判定与渲染都读这个对象，
     所以字段必须齐全（踩过的坑见 README 坑 12：漏视觉字段会让渲染层每帧报错）。 */
  function gunParams(D, gunId) {
    var g = D.gunById(gunId);
    return {
      id: g.id, name: g.name, art: g.art, en: g.en, desc: g.desc,
      body: g.body, accent: g.accent,
      rps: g.rps, mag: g.mag, reload: g.reload,
      spread0: g.spread0, kick: g.kick, decay: g.decay,
      pellets: g.pellets, mult: g.mult, steady: g.steady, price: g.price, pace: g.pace,
      /* 散布上限直接来自 data 层：每把枪的"泼满一梭子"都刻意压在靶半径之内 ——
         一旦超过靶半径，命中就只能靠运气，手感的"瞄"字就没了。 */
      maxBloom: g.maxBloom,
      /* 两发之间的最小间隔（秒） */
      interval: 1 / g.rps
    };
  }

  /* SECTION: 靶心运动解析式
     返回 {x, y, r, vis}：vis=false 表示这一瞬间"打不中"（闪隐靶隐身的瞬间）。
     motion 各分支都只依赖 spawn 参数 + age，不含任何累加状态。 */
  function poseOf(t, age) {
    var m = t.motion, x = t.x0, y = t.y0, r = t.r, vis = true;
    if (m === 'linear' || m === 'drift') {
      x = t.x0 + t.vx * age;
      y = t.y0 + (t.vy ? t.vy * age : 0);
    } else if (m === 'sine') {
      x = t.x0 + t.vx * age;
      y = t.y0 + t.amp * Math.sin(TAU * t.freq * age);
    } else if (m === 'arc') {
      /* 抛物线：向上抛出再落下，顶点高度 = rise（设计像素） */
      var p = Math.min(1, age / t.airT);
      x = t.x0 + t.vx * age;
      y = t.y0 - t.rise * Math.sin(Math.PI * p);
    } else if (m === 'pulse') {
      /* 收缩靶：半径在 r 与 r*(1-pulse) 之间余弦往复 —— 瞄小的一瞬间才划算 */
      r = t.r * (1 - t.pulse * (0.5 - 0.5 * Math.cos(TAU * age / t.pulseT)));
    } else if (m === 'blink') {
      x = t.x0 + t.vx * age;
      /* 相位偏移只挪"闪与不闪"的时点，不挪位置：
         早期版本是直接把 age 往前推来打乱相位，结果出生点与第一次绘制的位置
         差出上百像素 —— 生成时的避让检查当场作废，闪隐靶会跟别的靶叠在一起。 */
      vis = (((age + (t.phase || 0)) % (t.on + t.off)) < t.on);
    } else if (m === 'pop') {
      /* 起靶：RISE 秒内从挡板后升起，升完才可打 —— 所以入场不是白送的 */
      if (age < t.riseT) { vis = false; }
      y = t.y0 + (age < t.riseT ? t.riseDist * (1 - age / t.riseT) : 0);
    }
    return { x: x, y: y, r: r, vis: vis };
  }

  var RISE_T = 0.28, RISE_DIST = 46;

  /* SECTION: 可打窗口
     一个靶从出生到消失之间，"在场内 && 可被打中"的总时长（秒）。
     用解析式算，不用逐步模拟：单测要能钉死这个数。
       - 横穿类：min(剩余寿命, 场内横穿时间)
       - 起靶：再减去升起那 0.28 秒
       - 闪隐：乘占空比 on/(on+off) */
  function hitWindow(D, t) {
    var W = D.LAYOUT.W, pad = D.RANGE.padX;
    var onScreen = Math.max(0, t.life);
    if (t.vx) {
      var toEdge = t.vx > 0 ? (W - pad - t.x0) : (t.x0 - pad);
      onScreen = Math.min(onScreen, Math.max(0, toEdge) / Math.abs(t.vx));
    }
    if (t.motion === 'pop') { onScreen = Math.max(0, onScreen - t.riseT); }
    if (t.motion === 'blink') { onScreen = onScreen * (t.on / (t.on + t.off)); }
    return onScreen;
  }

  /* 折算后的过关要求：至少 4 个，避免低关卡出现 0/1 这种没有节奏感的数字 */
  function needOf(cfg, gun) {
    return Math.max(4, Math.round(cfg.downs * (gun && gun.pace ? gun.pace : 1)));
  }

  /* SECTION: 世界
     World(D, level, opts) —— opts: {rng, gunId, seed}。
     rng 必须由调用方注入（默认 Math.random），否则单测无法复现随机局面。 */
  function World(D, level, opts) {
    opts = opts || {};
    this.D = D;
    this.rng = opts.rng || Math.random;
    this.seed = opts.seed || 0;
    this.level = Math.max(1, level | 0);
    this.cfg = D.levelConfig(this.level);
    this.gun = gunParams(D, opts.gunId || 'pistol');

    this.t = 0;
    this.timeLeft = this.cfg.time;
    this.score = 0;
    /* 过关条件 = 击落数（不是分数，理由见 data 层 LEVELS 上方注释）。
       要求量按枪的 pace 折算：扳机慢的枪在同一关下打得完，快枪则要多打几个。 */
    this.need = needOf(this.cfg, this.gun);
    this.downs = 0;
    this.streak = 0; this.maxStreak = 0; this.comboTimer = 0;
    this.mult = 1;

    this.ammo = this.gun.mag;
    this.cool = 0;                 // 距下一发可击发的剩余时间
    this.pending = null;           // 冷却期内到达的那一枪（等冷却结束自动补射，不丢输入）
    this.dryCool = 0;              // 空枪提示音的节流（与射速冷却分开，否则会互相吞）
    this.reloadT = 0;              // >0 表示正在换弹（剩余秒）
    this.reloadTotal = 0;
    this.autoReload = 0;           // >0 表示空仓后待自动换弹的倒计时

    this.bloom = this.gun.spread0;
    this.bloomHold = 0;            // 开火后短暂不回落，让连射真的"越打越飘"
    this.breath = D.RULES.STEADY.max;
    this.steady = false;
    this.steadyWait = 0;

    this.targets = [];
    this.nextId = 1;
    this.spawnIn = 0.55;           // 开局第一发靶的进场延迟
    this.phase = 'play';
    this.outcome = '';
    this.result = null;            // 结算数据（过关/失败时填）

    this.stats = {
      fired: 0, pellets: 0, hits: 0, misses: 0, bulls: 0, tens: 0,
      bombs: 0, coins: 0, expired: 0, dropped: 0, goldHits: 0, clockHits: 0
    };
  }

  /* SECTION: 取随机数（封装一层，便于断言"没偷看"） */
  function rnd(w) { return w.rng(); }
  function rrange(w, a, b) { return a + rnd(w) * (b - a); }

  function pickType(w) {
    var ws = w.cfg.weights, keys = [], tot = 0, k;
    for (k in ws) {
      if (Object.prototype.hasOwnProperty.call(ws, k) && ws[k] > 0) { keys.push(k); tot += ws[k]; }
    }
    if (!keys.length) { return 'ring'; }
    var r = rnd(w) * tot;
    for (var i = 0; i < keys.length; i++) {
      r -= ws[keys[i]];
      if (r <= 0) { return keys[i]; }
    }
    return keys[keys.length - 1];
  }

  /* 靶心是否落在场内（含半径余量） */
  function insideField(D, x, y, r) {
    return x - r >= 4 && x + r <= D.LAYOUT.W - 4 && y - r >= D.RANGE.wallTop + D.RANGE.wallH && y + r <= D.RANGE.benchY;
  }

  /* 与场上已有靶的避让检查：
       计分靶之间：半径和 + SPAWN_PAD
       涉及炸雷靶：再加 BOMB_AVOID —— 这是"不可能误伤"承诺的实现
     ignoreBounds=true 时只查重叠、不查场内边界：
       起靶(pop)的动画是从挡板下沿升起来的，出生那一帧它其实还在 y0+riseDist，
       所以"停稳位置"和"起点位置"两个圆都得查过，否则半路上会与已有的靶（含炸雷靶）叠在一起。 */
  function placementFree(w, x, y, r, bad, ignoreBounds) {
    var D = w.D;
    if (!ignoreBounds && !insideField(D, x, y, r)) { return false; }
    for (var i = 0; i < w.targets.length; i++) {
      var t = w.targets[i];
      if (!t.alive) { continue; }
      var p = poseOf(t, t.age);
      var need = p.r + r + D.RULES.SPAWN_PAD + ((bad || t.bad) ? D.RULES.BOMB_AVOID : 0);
      var dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy < need * need) { return false; }
    }
    return true;
  }

  /* SECTION: 生成一枚靶
     速度上限反推：横穿类必须保证 hitWindow ≥ HIT_FLOOR。
     做法是先算"以这个速度能在场上待多久"，不够就把速度压下来 ——
     压到最低速仍不满足时直接放弃这次生成（宁可少一个靶，也不给一个打不中的靶）。 */
  function spawnTarget(w, typeId, forced) {
    var D = w.D, T = D.TARGETS[typeId];
    if (!T) { return null; }
    var depthIds = w.cfg.depths;
    var depth = D.depthById(forced && forced.depth ? forced.depth : depthIds[Math.floor(rnd(w) * depthIds.length)]);
    var r = BASE_R(w, T, depth);
    var speedScale = w.cfg.speed;
    var vx = 0, vy = 0, x0, y0;
    var band0 = depth.y0 + r * 0.55, band1 = depth.y1 - r * 0.55;
    if (band1 < band0) { band1 = band0; }

    var mover = (T.motion === 'linear' || T.motion === 'sine' || T.motion === 'arc' || T.motion === 'blink' || T.motion === 'drift');
    var life = T.life;
    var tries = 0, placed = null;

    while (tries++ < 26) {
      var cand = { x0: 0, y0: 0, vx: 0, vy: 0 };
      if (mover) {
        var dir = rnd(w) < 0.5 ? -1 : 1;
        var sp = T.speed * speedScale * (0.86 + rnd(w) * 0.3);
        /* 反推速度上限：场内可打时间 ≥ HIT_FLOOR（闪隐靶还要除占空比） */
        var need = D.RULES.HIT_FLOOR;
        if (T.motion === 'blink') { need = need * (T.on + T.off) / T.on; }
        var spanX = D.LAYOUT.W - 2 * D.RANGE.padX;
        sp = Math.min(sp, spanX / need);
        cand.vx = dir * sp;
        cand.x0 = dir > 0 ? D.RANGE.padX : D.LAYOUT.W - D.RANGE.padX;
        if (T.motion === 'drift') { cand.vy = (rnd(w) < 0.5 ? -1 : 1) * 22 * speedScale; }
        /* 起点随机挑一个场内位置：避免每次都从同一侧进场（看起来机械） */
        cand.x0 += Math.floor(rnd(w) * 3) * (spanX / 6) * (dir > 0 ? 1 : -1);
      } else {
        cand.x0 = rrange(w, D.RANGE.padX + r, D.LAYOUT.W - D.RANGE.padX - r);
      }
      cand.y0 = rrange(w, band0, band1);
      if (!placementFree(w, cand.x0, cand.y0, r, !!T.bad)) { continue; }
      /* 起靶还要按"还没升出水下"的那个出生位置查一遍：
         升起来之前它虽然打不中，但画在那儿 —— 玩家会照着它瞄，
         这时若与炸雷靶重叠，判定就会把雷判给这一枪（等于凭空挨一罚）。 */
      if (T.motion === 'pop'
        && !placementFree(w, cand.x0, cand.y0 + RISE_DIST, r, !!T.bad, true)) { continue; }
      placed = cand; break;
    }
    if (!placed) { return null; }

    x0 = placed.x0; y0 = placed.y0; vx = placed.vx; vy = placed.vy;
    /* 横穿/寿命取长：让移动靶至少有机会走完一段，而不是半路消失 */
    if (vx) {
      var toEdge = vx > 0 ? (D.LAYOUT.W - D.RANGE.padX - x0) : (x0 - D.RANGE.padX);
      life = Math.max(T.life * 0.55, Math.min(T.life + 3, Math.abs(toEdge) / Math.abs(vx)));
    }
    var t = {
      id: w.nextId++, type: typeId, bad: !!T.bad, name: T.name, art: T.art, label: T.label,
      motion: T.motion, depth: depth, value: T.value, coins: T.coins || 0,
      timeBonus: T.timeBonus || 0, splitCount: T.split || 0,
      x0: x0, y0: y0, vx: vx, vy: vy, r: r, baseR: r,
      amp: (T.amp || 0) * depth.scale, freq: T.freq || 1,
      rise: (T.rise || 0), airT: Math.max(0.6, life), pulse: T.pulse || 0,
      pulseT: 1.5, on: T.on || 1, off: T.off || 0, phase: 0,
      riseT: T.motion === 'pop' ? RISE_T : 0, riseDist: RISE_DIST,
      age: 0, life: life, alive: true
    };
    if (t.rise) { t.rise *= (0.7 + rnd(w) * 0.6); }
    /* 闪隐靶随机相位：不然所有闪隐靶同频闪烁，等于半个靶打不中 */
    if (T.motion === 'blink') { t.phase = rnd(w) * (t.on + t.off); }
    w.targets.push(t);
    return t;
  }

  function BASE_R(w, T, depth) {
    return w.D.BASE_R * T.r * (depth && depth.scale ? depth.scale : 1);
  }

  /* SECTION: 推进世界
     只做四件事：计时、靶龄与消失、散布回落与屏息、生成节奏与结算判定。
     命中判定只发生在 fire() 里 —— 分开写是为了让"时间推进"可被单测反复调用。 */
  function step(w, dt) {
    var ev = [];
    if (!(dt > 0) || w.phase !== 'play') { return ev; }
    var D = w.D;
    dt = Math.min(dt, 0.05);          // 掉帧夹住步长，避免一帧跳过大半个靶
    w.t += dt;
    w.timeLeft -= dt;

    /* 换弹状态机 */
    if (w.reloadT > 0) {
      w.reloadT -= dt;
      if (w.reloadT <= 0) {
        w.reloadT = 0; w.ammo = w.gun.mag;
        ev.push({ kind: 'reloaded', ammo: w.ammo });
      }
    } else if (w.autoReload > 0) {
      w.autoReload -= dt;
      if (w.autoReload <= 0) { w.autoReload = 0; startReload(w, false, ev); }
    }

    /* 射击间隔 */
    if (w.cool > 0) { w.cool = Math.max(0, w.cool - dt); }
    if (w.dryCool > 0) { w.dryCool = Math.max(0, w.dryCool - dt); }

    /* 冷却期内排到的那一枪：现在能打了就补上 —— 按住扳机即稳定按射速出枪 */
    if (w.pending && w.cool <= 1e-6 && w.reloadT <= 0 && w.ammo > 0) {
      var pd = w.pending;
      w.pending = null;
      ev = ev.concat(shoot(w, pd.x, pd.y));
    }

    /* 散布：开火后 BLOOM_HOLD 内不回落，之后线性回到 spread0 */
    if (w.bloomHold > 0) { w.bloomHold -= dt; }
    else if (w.bloom > w.gun.spread0) {
      w.bloom = Math.max(w.gun.spread0, w.bloom - w.gun.decay * dt * (holdingSteady(w) ? 1.5 : 1));
    }

    /* 屏息：按住才消耗，放掉/耗尽后进恢复期 */
    var S = D.RULES.STEADY;
    if (holdingSteady(w)) {
      w.breath -= S.drain * dt;
      if (w.breath <= 0) { w.breath = 0; w.steady = false; w.steadyWait = S.regenDelay; ev.push({ kind: 'breathout' }); }
    } else {
      if (w.steadyWait > 0) { w.steadyWait -= dt; }
      else if (w.breath < S.max) { w.breath = Math.min(S.max, w.breath + S.regen * dt); }
    }

    /* 连击窗口 */
    if (w.comboTimer > 0) {
      w.comboTimer -= dt;
      if (w.comboTimer <= 0) { w.comboTimer = 0; resetStreak(w, ev, 'timeout'); }
    }

    /* 靶：老化与离场 */
    for (var i = w.targets.length - 1; i >= 0; i--) {
      var t = w.targets[i];
      if (!t.alive) { w.targets.splice(i, 1); continue; }
      t.age += dt;
      var gone = t.age >= t.life;
      if (!gone && t.vx) {
        var x = t.x0 + t.vx * t.age;
        gone = (x < t.r || x > D.LAYOUT.W - t.r);
      }
      if (!gone && t.vy) {
        var p = poseOf(t, t.age);
        gone = p.y < D.RANGE.wallTop + D.RANGE.wallH + t.r * 0.5 || p.y > D.RANGE.benchY - t.r * 0.5;
      }
      if (gone) {
        t.alive = false;
        w.stats.expired++;
        ev.push({ kind: 'expire', id: t.id, type: t.type, bad: t.bad, x: poseOf(t, t.age).x, y: poseOf(t, t.age).y, r: t.r });
      }
    }
    w.targets = w.targets.filter(function (x2) { return x2.alive; });

    /* 生成节奏：同屏上限 + 关卡间隔 */
    w.spawnIn -= dt;
    var live = w.targets.length;
    if (w.spawnIn <= 0 && live < w.cfg.live) {
      var typeId = pickType(w);
      var made = spawnTarget(w, typeId);
      if (made) {
        ev.push({ kind: 'spawn', id: made.id, type: made.type, x: made.x0, y: made.y0, r: made.r, bad: made.bad });
      }
      /* 放不下（避让失败）也要排下一次，否则会卡死不生成 */
      w.spawnIn = rrange(w, w.cfg.gap[0], w.cfg.gap[1]);
    } else if (w.spawnIn <= 0) {
      w.spawnIn = 0.18;   // 满场：短轮询，等腾空位
    }

    /* 结算判定 */
    if (w.downs >= w.need) { finish(w, 'clear', ev); }
    else if (w.timeLeft <= 0) { w.timeLeft = 0; finish(w, 'over', ev); }
    return ev;
  }

  function holdingSteady(w) { return w.steady && w.breath > 0 && w.reloadT <= 0; }

  function resetStreak(w, ev, why) {
    if (w.streak === 0) { return; }
    var old = w.mult;
    w.streak = 0; w.comboTimer = 0; w.mult = multFor(w.D, 0);
    ev.push({ kind: 'streakbreak', from: old, why: why });
  }

  function startReload(w, manual, ev) {
    if (w.reloadT > 0) { return; }
    if (!manual && w.ammo === w.gun.mag) { return; }
    w.autoReload = 0;
    w.pending = null;              // 换弹一开始，排队的那一枪就作废（不能穿过换弹补射）
    w.reloadT = w.gun.reload * (manual ? 0.82 : 1);
    w.reloadTotal = w.reloadT;
    w.steady = false;
    ev.push({ kind: 'reload', manual: !!manual, dur: w.reloadT });
  }

  /* SECTION: 有效散布与弹着点
     弹着点 = 准星 + 半径为 bloomEff 的圆内均匀随机偏移。
     均匀分布用 sqrt(u) 取半径（直接 u 会让弹孔聚在中心，等于没有散布）。 */
  function bloomEff(w) {
    var b = holdingSteady(w) ? w.bloom * w.gun.steady : w.bloom;
    return Math.max(w.gun.spread0 * 0.5, b);
  }
  function impactOf(w, ax, ay) {
    var b = bloomEff(w);
    var a = rnd(w) * TAU, d = b * Math.sqrt(rnd(w));
    return { x: ax + Math.cos(a) * d, y: ay + Math.sin(a) * d, spread: b };
  }

  /* 找一个弹着点命中的靶。两条规则：
       1. 在所有"此刻可打"的靶里取**靶心最近**的那个 —— 结果与数组遍历顺序无关。
       2. 炸雷靶"宁可放过不可误伤"：只要弹着点同时落在某个计分靶里，这发就算打中计分靶。
          为什么：同屏的靶子会边走位边靠近，进场时避得再开也可能半路叠上；
          如果让雷去抢这种重叠判定，玩家会遇到"我明明瞄的是环靶却被扣了 120 分"，
          那是判定缺陷不是难度。单测里钉了这条规则。 */
  function targetAt(w, x, y) {
    var best = null, bestD = Infinity, bomb = null, bombD = Infinity;
    for (var i = 0; i < w.targets.length; i++) {
      var t = w.targets[i];
      if (!t.alive || t.hit) { continue; }
      var p = poseOf(t, t.age);
      if (!p.vis) { continue; }
      var dx = p.x - x, dy = p.y - y, dd = dx * dx + dy * dy;
      if (dd > p.r * p.r) { continue; }
      if (t.bad) { if (dd < bombD) { bombD = dd; bomb = { t: t, p: p, dist: Math.sqrt(dd) }; } continue; }
      if (dd < bestD) { bestD = dd; best = { t: t, p: p, dist: Math.sqrt(dd) }; }
    }
    return best || bomb;
  }

  /* SECTION: 击发
     fire(w, ax, ay) —— ax/ay 是准星（设计坐标）。
     返回事件数组，渲染层按事件放特效与飘字；不返回分数字符串（视图与逻辑分离）。
     一发 = 一次扣扳机（霰弹枪是多个弹丸，但只消耗 1 发弹药）。

     **射速冷却没到的那一枪不是丢掉，而是排队**（w.pending）：
     按住扳机/连点时必须恰好以 gun.rps 的速率出枪，最后 1ms 内的点击在下一帧
     自动补上。早先的版本直接 return，于是"卡在冷却边界上的那次点击"会凭空消失 ——
     与 README 坑 5 是同一类 bug（延后发生的状态重置吃掉玩家抢先的输入）。 */
  function fire(w, ax, ay) {
    if (w.phase !== 'play') { return []; }
    if (w.reloadT > 0) { return []; }              // 换弹中扣扳机：静默忽略，不打扰节奏
    if (w.ammo <= 0) {
      /* 空仓必须给"咔哒"：玩家对着空弹匣扣扳机时，最不该发生的事就是毫无反馈。
         这里不看 cool —— 否则快速连点会把提示音吞掉；改用 dryCool 自己做节流。 */
      if (w.dryCool <= 0) {
        w.dryCool = 0.3;
        w.pending = null;
        if (w.autoReload <= 0) { w.autoReload = w.D.RULES.AUTO_RELOAD_DELAY; }
        return [{ kind: 'dry' }];
      }
      return [];
    }
    if (w.cool > 1e-6) { w.pending = { x: ax, y: ay }; return []; }
    return shoot(w, ax, ay);
  }

  function shoot(w, ax, ay) {
    var ev = [];
    var D = w.D, gun = w.gun;
    w.pending = null;
    w.ammo--; w.stats.fired++; w.stats.pellets += gun.pellets;
    w.cool = gun.interval;
    w.bloom = Math.min(gun.maxBloom, w.bloom + gun.kick);
    w.bloomHold = 0.1;
    ev.push({ kind: 'shot', ax: ax, ay: ay, spread: bloomEff(w), ammo: w.ammo, gun: gun.id });
    if (w.ammo === 0) { w.autoReload = D.RULES.AUTO_RELOAD_DELAY; }

    var hitAny = false, gained = 0;
    for (var i = 0; i < gun.pellets; i++) {
      var imp = impactOf(w, ax, ay);
      var h = targetAt(w, imp.x, imp.y);
      if (!h) { continue; }
      var t = h.t;
      t.hit = true;                                // 一靶一命：本发剩余弹丸穿过它
      hitAny = true;
      if (t.bad) {
        /* 炸雷靶：扣分 + 扣时 + 断连击。分数不为负（不至于一次失误把这一局打没）。
           注意它**不减击落数**：过关进度只由"打掉多少个可打的靶"决定，
           雷罚的是分数与时间，不会把你已经打掉的靶抹掉。 */
        var pen = Math.min(w.score, D.SCORE.BOMB_PTS);
        w.score -= pen;
        w.timeLeft = Math.max(0, w.timeLeft - D.SCORE.BOMB_TIME);
        w.stats.bombs++;
        resetStreak(w, ev, 'bomb');
        ev.push({ kind: 'bomb', x: imp.x, y: imp.y, tx: h.p.x, ty: h.p.y, loss: pen, time: D.SCORE.BOMB_TIME, id: t.id });
        t.alive = false;
      } else {
        var ring = ringOf(D, h.dist, h.p.r);
        if (!ring) { ring = { pts: 4, label: '4 环', bull: false }; }
        var before = w.mult;
        w.streak++; w.comboTimer = D.RULES.COMBO_WINDOW;
        if (w.streak > w.maxStreak) { w.maxStreak = w.streak; }
        w.mult = multFor(D, w.streak);
        var pts = ring.pts * t.value * t.depth.mult * gun.mult * w.mult * w.cfg.scale;
        if (ring.bull) { pts += D.SCORE.PERFECT_RING_BONUS * gun.mult * w.mult; w.stats.bulls++; }
        if (ring.pts === 10) { w.stats.tens++; }
        var round = Math.round(pts);
        w.score += round; gained += round;
        w.stats.hits++;
        w.downs++;                               // 过关进度：只统计计分靶
        if (t.coins) { w.stats.coins += t.coins; w.stats.goldHits++; }
        if (t.timeBonus) { w.timeLeft += t.timeBonus; w.stats.clockHits++; }
        ev.push({
          kind: 'hit', id: t.id, type: t.type, x: imp.x, y: imp.y, tx: h.p.x, ty: h.p.y,
          r: h.p.r, ring: ring.label, pts: ring.pts, bull: ring.bull, gain: round,
          streak: w.streak, mult: w.mult, coins: t.coins || 0, timeBonus: t.timeBonus || 0,
          downs: w.downs, need: w.need
        });
        if (w.mult !== before && w.mult > before) { ev.push({ kind: 'combo', mult: w.mult, streak: w.streak }); }
        /* 分裂靶：打散成 N 枚小靶（小靶自己按 drift 走） */
        if (t.splitCount > 0) {
          for (var s = 0; s < t.splitCount; s++) {
            var mini = spawnTarget(w, 'mini', { depth: t.depth.id });
            if (mini) {
              mini.motion = 'drift';
              mini.x0 = Math.max(D.RANGE.padX, Math.min(D.LAYOUT.W - D.RANGE.padX, h.p.x));
              mini.y0 = h.p.y;
              mini.vx = (s === 0 ? -1 : 1) * (110 + rnd(w) * 60) * w.cfg.speed;
              mini.vy = (rnd(w) - 0.5) * 60;
              mini.age = 0;
              mini.life = D.TARGETS.mini.life;
              ev.push({ kind: 'spawn', id: mini.id, type: 'mini', x: mini.x0, y: mini.y0, r: mini.r, bad: false });
            }
          }
        }
        if (gained > 0 && w.mult !== before && w.mult < before) { /* 只会因炸弹归零，这里不会发生 */ }
      }
      t.alive = false;
    }
    if (!hitAny) {
      w.stats.misses++;
      resetStreak(w, ev, 'miss');
      ev.push({ kind: 'miss', x: ax, y: ay, gain: 0 });
    }
    /* 弹丸打空也要看到落点：渲染层靠这个画弹孔（玩家必须知道偏了多少） */
    return ev;
  }

  /* SECTION: 结算
     过关 = 配额分 + 通关奖励 + 剩余时间折分，全部乘评级系数；
     失败 = 当前分（已经拿到的分不回收）。 */
  function finish(w, kind, ev) {
    if (w.phase !== 'play') { return; }
    ev = ev || [];
    w.phase = kind;
    w.outcome = kind;
    var D = w.D;
    var acc = w.stats.fired > 0 ? w.stats.hits / w.stats.fired : 0;
    var g = gradeOf(D, acc);
    var out = {
      kind: kind, level: w.level, name: w.cfg.name, need: w.need, downs: w.downs,
      base: Math.round(w.score), timeLeft: Math.max(0, w.timeLeft),
      clearBonus: 0, timeBonus: 0, grade: g.name, gradeBonus: g.bonus,
      score: Math.round(w.score), coins: w.stats.coins,
      accuracy: acc, hits: w.stats.hits, fired: w.stats.fired, misses: w.stats.misses,
      bulls: w.stats.bulls, tens: w.stats.tens, bombs: w.stats.bombs, maxStreak: w.maxStreak
    };
    if (kind === 'clear') {
      out.clearBonus = D.SCORE.CLEAR_BONUS + w.level * D.SCORE.CLEAR_PER_LEVEL;
      out.timeBonus = Math.floor(out.timeLeft) * D.SCORE.TIME_BONUS_PER_SEC;
      out.coins += D.SCORE.COINS_CLEAR_BASE + (D.SCORE.COINS_GRADE[g.name] || 0)
        + Math.floor(w.stats.hits / D.SCORE.COINS_PER_HITS);
      out.score = Math.round((w.score + out.clearBonus + out.timeBonus) * g.bonus);
    }
    w.result = out;
    ev.push({ kind: kind, result: out });
  }

  /* SECTION: 只读快照（HUD 与单测都读它，不共享引用） */
  function statsOf(w) {
    var acc = w.stats.fired > 0 ? w.stats.hits / w.stats.fired : 0;
    return {
      /* runPhase 不叫 phase：视图层自己有一个"界面阶段"（start/countdown/play/pause/clear/over），
         两者同名会在合并快照时互相覆盖 —— 冒烟实测过一次"明明已暂停、stats().phase 却仍是 play"。 */
      runPhase: w.phase, outcome: w.outcome, level: w.level, name: w.cfg.name, tag: w.cfg.tag,
      endless: w.cfg.endless, t: w.t, timeLeft: Math.max(0, w.timeLeft), timeMax: w.cfg.time,
      score: Math.round(w.score), downs: w.downs, need: w.need,
      progress: Math.max(0, Math.min(1, w.downs / w.need)),
      streak: w.streak, maxStreak: w.maxStreak, mult: w.mult, comboLeft: Math.max(0, w.comboTimer),
      ammo: w.ammo, mag: w.gun.mag, reloading: w.reloadT > 0,
      reloadLeft: w.reloadT, reloadFrac: w.reloadTotal > 0 ? 1 - w.reloadT / w.reloadTotal : 0,
      gun: w.gun.id, gunName: w.gun.name, pellets: w.gun.pellets,
      bloom: w.bloom, bloomEff: bloomEff(w),
      breath: w.breath, breathMax: w.D.RULES.STEADY.max, steady: holdingSteady(w),
      live: w.targets.length, stats: {
        fired: w.stats.fired, hits: w.stats.hits, misses: w.stats.misses,
        accuracy: acc, coins: w.stats.coins, bombs: w.stats.bombs,
        bulls: w.stats.bulls, tens: w.stats.tens, expired: w.stats.expired
      },
      result: w.result
    };
  }

  /* 当前场上"可打中的靶"列表（渲染画准星提示 + 单测的"脚本化神枪手"都用它） */
  function liveTargets(w) {
    var out = [];
    for (var i = 0; i < w.targets.length; i++) {
      var t = w.targets[i];
      if (!t.alive) { continue; }
      var p = poseOf(t, t.age);
      out.push({ id: t.id, type: t.type, bad: t.bad, x: p.x, y: p.y, r: p.r, vis: p.vis, age: t.age, life: t.life, value: t.value, depth: t.depth.id });
    }
    return out;
  }

  /* 手动换弹 / 屏息开关：输入层直接调，状态机在 step 与 fire 里跑 */
  function reload(w) { var ev = []; if (w.phase === 'play' && w.reloadT <= 0 && w.ammo < w.gun.mag) { startReload(w, true, ev); } return ev; }
  function setSteady(w, on) {
    if (on && w.breath <= 0) { w.steady = false; return false; }
    if (w.steady === !!on) { return !!on; }
    w.steady = !!on;
    if (!on) { w.steadyWait = w.D.RULES.STEADY.regenDelay * 0.5; }
    return w.steady;
  }

  return {
    World: World, step: step, fire: fire, reload: reload, setSteady: setSteady,
    /* finish 也对外：暂停面板里的"提前收工"要走同一套结算公式，不能另写一份 */
    finish: finish,
    needOf: needOf,
    statsOf: statsOf, liveTargets: liveTargets, poseOf: poseOf, hitWindow: hitWindow,
    ringOf: ringOf, multFor: multFor, gradeOf: gradeOf, gunParams: gunParams,
    bloomOf: bloomEff, targetAt: targetAt, spawnTarget: spawnTarget
  };
})();
