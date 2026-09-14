/* ============================================================
   回转寿司大作战 · 游戏核心逻辑（纯状态与更新，不含 DOM）
   SECTION: game-core
   ============================================================ */
(function (global) {
  'use strict';

  var D = global.SUSHI_GAME;
  var L = D.LAYOUT;
  var B = D.BALANCE;
  var SUSHI = D.SUSHI;
  var TIERS = D.TIERS;
  var FACES = D.FACES;
  var HAPPY = D.HAPPY;
  var ANGRY = D.ANGRY;
  var W = L.W, H = L.H;
  var PLATE_Y = 296;

  var SHIRT_COLORS = ['#c25b4e', '#4a7fb5', '#6b9e5a', '#c9a13c', '#8a6bb5', '#d98a4a', '#4fb0a0', '#b5567e'];

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ============================================================
     SECTION: core-init
     ============================================================ */
  function Core() { this.reset(); }
  Core.uidSeq = 0;

  Core.prototype.reset = function () {
    this.t = 0;
    this.state = 'menu';
    this.score = 0;
    this.level = 1;
    this.lives = B.startLives;
    this.combo = 0;
    this.comboMult = 1;
    this.comboTimer = 0;
    this.ammo = B.maxAmmo;
    this.ammoAcc = 0;
    this.hits = 0;
    this.shots = 0;
    this.maxCombo = 0;
    this.ordersDone = 0;
    this.bestPlate = 0;

    this.plates = [];
    this.farPlates = [];
    this.bullets = [];
    this.particles = [];
    this.floaters = [];
    this.flyers = [];
    this.motes = [];
    this.customers = [];

    this.seats = [];
    for (var i = 0; i < L.seatCount; i++) {
      this.seats.push({ x: Math.round(W * (i + 1) / (L.seatCount + 1)), cust: null });
    }

    this.scroll = 0;
    this.farScroll = 0;
    this.spawnTimer = 0.5;
    this.farSpawnTimer = 1.1;
    this.custTimer = 0.8;

    this.aimX = W / 2;
    this.aimY = L.beltY;
    this.recoil = 0;
    this.fireCd = 0;
    this.shake = 0;

    this.events = [];
    this.banner = null;
    this.bannerTimer = 0;

    for (var m = 0; m < 26; m++) { this.motes.push(this.makeMote(true)); }
  };

  Core.prototype.makeMote = function (anywhere) {
    return {
      x: rnd(0, W),
      y: anywhere ? rnd(L.norenBottom, H - 20) : rnd(H - 30, H + 10),
      vx: rnd(-9, 9),
      vy: rnd(-26, -9),
      s: rnd(1.6, 4.2),
      a: rnd(0.1, 0.34),
      rot: rnd(0, Math.PI * 2),
      vr: rnd(-1.4, 1.4),
      color: Math.random() < 0.72 ? 'rgba(255,206,140,1)' : 'rgba(255,238,205,1)'
    };
  };

  Core.prototype.push = function (ev) { this.events.push(ev); };

  /* ============================================================
     SECTION: difficulty
     ============================================================ */
  Core.prototype.beltSpeed = function () {
    return Math.min(B.beltSpeedBase + (this.level - 1) * B.beltSpeedPerLv, B.beltSpeedMax);
  };
  Core.prototype.spawnGap = function () {
    return Math.max(B.spawnBase - (this.level - 1) * B.spawnPerLv, B.spawnMin);
  };
  Core.prototype.wasabiRate = function () {
    return Math.min(B.wasabiBase + (this.level - 1) * B.wasabiPerLv, B.wasabiMax);
  };
  Core.prototype.patienceOf = function () {
    return Math.max(B.patienceBase - (this.level - 1) * B.patiencePerLv, B.patienceMin);
  };

  /* ============================================================
     SECTION: spawn
     ============================================================ */
  Core.prototype.spawnPlate = function () {
    var r = Math.random();
    var kind, tier = null, type = null, emojiCh = '';

    if (r < this.wasabiRate()) {
      kind = 'wasabi';
    } else if (r < this.wasabiRate() + B.teaChance) {
      kind = 'tea';
    } else {
      kind = 'sushi';
      /* 高价值盘出现概率更低 */
      var roll = Math.random();
      var pool;
      if (roll < 0.42) { pool = SUSHI.filter(function (s) { return s.tier === 'red'; }); }
      else if (roll < 0.72) { pool = SUSHI.filter(function (s) { return s.tier === 'blue'; }); }
      else if (roll < 0.92) { pool = SUSHI.filter(function (s) { return s.tier === 'silver'; }); }
      else { pool = SUSHI.filter(function (s) { return s.tier === 'gold'; }); }
      type = pick(pool);
      tier = type.tier;
      emojiCh = type.emoji;
    }

    /* 若客人正在等待某类寿司，提高该类出现概率，避免卡死 */
    if (kind === 'sushi') {
      var needed = this.neededTypes();
      if (needed.length && Math.random() < 0.55) {
        var want = pick(needed);
        type = want;
        tier = want.tier;
        emojiCh = want.emoji;
      }
    }

    var sc = rnd(0.93, 1.06);
    this.plates.push({
      kind: kind,
      type: type,
      tier: tier,
      emoji: emojiCh,
      x: W + 46,
      y: PLATE_Y + rnd(-3, 3),
      scale: sc,
      phase: rnd(0, Math.PI * 2),
      wanted: false,
      hitR: 33 * sc
    });
  };

  Core.prototype.spawnFarPlate = function () {
    this.farPlates.push({
      x: -40,
      y: L.farLaneY,
      scale: rnd(0.5, 0.62),
      phase: rnd(0, Math.PI * 2),
      tier: pick(['red', 'blue', 'silver', 'gold']),
      emoji: pick(SUSHI).emoji,
      empty: Math.random() < 0.42
    });
  };

  Core.prototype.neededTypes = function () {
    var out = [];
    var seen = {};
    for (var i = 0; i < this.customers.length; i++) {
      var c = this.customers[i];
      if (c.state !== 'idle' && c.state !== 'entering') { continue; }
      for (var j = 0; j < c.order.length; j++) {
        var it = c.order[j];
        if (it.done || it.flying) { continue; }
        if (!seen[it.id]) { seen[it.id] = true; out.push(it.ref); }
      }
    }
    return out;
  };

  Core.prototype.spawnCustomer = function () {
    var free = [];
    for (var i = 0; i < this.seats.length; i++) { if (!this.seats[i].cust) { free.push(this.seats[i]); } }
    if (!free.length) { return; }
    var seat = pick(free);

    /* 订单长度随等级增加 */
    var maxN = this.level <= 1 ? 2 : this.level <= 3 ? 3 : 4;
    var n = Math.max(1, Math.round(rnd(1, maxN + 0.4)));
    var order = [];
    for (var k = 0; k < n; k++) {
      var roll = Math.random();
      var pool;
      if (roll < 0.5) { pool = SUSHI.filter(function (s) { return s.tier === 'red' || s.tier === 'blue'; }); }
      else if (roll < 0.85) { pool = SUSHI.filter(function (s) { return s.tier === 'silver'; }); }
      else { pool = SUSHI.filter(function (s) { return s.tier === 'gold'; }); }
      var ref = pick(pool);
      order.push({ id: ref.id, emoji: ref.emoji, name: ref.name, ref: ref, done: false, flying: false });
    }

    var pat = this.patienceOf() + n * 6;
    var c = {
      uid: ++Core.uidSeq,
      seat: seat,
      x: seat.x,
      face: pick(FACES),
      happyFace: pick(HAPPY),
      angryFace: pick(ANGRY),
      color: pick(SHIRT_COLORS),
      order: order,
      nextIdx: 0,
      patience: pat,
      patienceMax: pat,
      state: 'entering',
      anim: 0,
      alpha: 1,
      phase: rnd(0, Math.PI * 2),
      reward: B.orderBonusBase + B.orderBonusPerPlate * n
    };
    seat.cust = c;
    this.customers.push(c);
  };

  /* ============================================================
     SECTION: shooting
     ============================================================ */
  Core.prototype.nozzle = function () {
    var bx = W / 2, by = L.turretY;
    var ang = Math.atan2(this.aimY - by, this.aimX - bx);
    ang = clamp(ang, -Math.PI + 0.34, -0.34);
    return { x: bx + Math.cos(ang) * 74, y: by + Math.sin(ang) * 74, ang: ang };
  };

  Core.prototype.tryFire = function () {
    if (this.state !== 'playing') { return; }
    if (this.fireCd > 0) { return; }
    if (this.ammo < 1) {
      this.push({ type: 'sfx', name: 'empty' });
      this.addFloater(W / 2, L.turretY - 74, '酱油用尽！', '#ff8a72', 17);
      return;
    }
    this.ammo--;
    this.shots++;
    this.fireCd = B.fireCooldown;
    this.recoil = -9;
    var n = this.nozzle();
    this.bullets.push({
      x: n.x, y: n.y,
      vx: Math.cos(n.ang) * B.bulletSpeed,
      vy: Math.sin(n.ang) * B.bulletSpeed,
      ang: n.ang,
      trail: []
    });
    /* 枪口飞溅 */
    for (var i = 0; i < 5; i++) {
      this.particles.push({
        type: 'drop', x: n.x, y: n.y,
        vx: Math.cos(n.ang) * rnd(40, 190) + rnd(-70, 70),
        vy: Math.sin(n.ang) * rnd(40, 190) + rnd(-70, 70),
        g: 420, size: rnd(1.6, 3.4), rot: n.ang,
        color: 'rgba(74,52,32,.9)', life: 0.3, max: 0.3
      });
    }
    this.push({ type: 'sfx', name: 'shoot' });
  };

  /* ============================================================
     SECTION: fx-helpers
     ============================================================ */
  Core.prototype.addFloater = function (x, y, text, color, size, sub, subColor) {
    this.floaters.push({
      x: x, y: y, text: text, color: color || '#ffe6b8',
      size: size || 20, sub: sub || '', subColor: subColor,
      life: 1.05, max: 1.05
    });
  };

  Core.prototype.burst = function (x, y, color, count, power, emojiCh) {
    for (var i = 0; i < count; i++) {
      var a = rnd(0, Math.PI * 2);
      var sp = rnd(power * 0.35, power);
      this.particles.push({
        type: Math.random() < 0.5 ? 'dot' : 'shard',
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        g: 700, size: rnd(2.4, 6), rot: a, vr: rnd(-9, 9),
        color: color, life: rnd(0.42, 0.86), max: 0.86
      });
    }
    this.particles.push({ type: 'ring', x: x, y: y, size: 20, color: color, life: 0.36, max: 0.36, vx: 0, vy: 0, g: 0, rot: 0 });
    if (emojiCh) {
      for (var j = 0; j < 3; j++) {
        var a2 = rnd(-Math.PI * 0.9, -Math.PI * 0.1);
        this.particles.push({
          type: 'emoji', x: x, y: y, emoji: emojiCh,
          vx: Math.cos(a2) * rnd(70, 210), vy: Math.sin(a2) * rnd(90, 230),
          g: 640, size: rnd(11, 19), rot: rnd(-1, 1), vr: rnd(-7, 7),
          life: rnd(0.6, 1), max: 1
        });
      }
    }
  };

  /* ============================================================
     SECTION: scoring
     ============================================================ */
  Core.prototype.bumpCombo = function () {
    this.combo++;
    this.comboTimer = B.comboWindow;
    var m = clamp(1 + Math.floor(this.combo / B.comboStep), 1, B.comboMax);
    if (m > this.comboMult) {
      this.comboMult = m;
      this.push({ type: 'sfx', name: 'combo', mult: m });
    }
    this.comboMult = m;
    if (this.combo > this.maxCombo) { this.maxCombo = this.combo; }
  };

  Core.prototype.resetCombo = function () {
    if (this.combo >= 4) { this.push({ type: 'sfx', name: 'comboBreak' }); }
    this.combo = 0;
    this.comboMult = 1;
    this.comboTimer = 0;
  };

  Core.prototype.addScore = function (n) {
    this.score += n;
    var target = this.level * B.levelScore;
    while (this.score >= target) {
      this.level++;
      this.banner = { main: '等级 ' + this.level, sub: 'LEVEL UP · 传送带加速' };
      this.bannerTimer = 1.5;
      this.push({ type: 'sfx', name: 'levelup' });
      this.push({ type: 'flash', kind: 'good' });
      this.burst(W / 2, L.beltY, 'rgba(242,197,97,.95)', 26, 260, '⭐');
      target = this.level * B.levelScore;
    }
  };

  Core.prototype.loseLife = function (reason, x, y) {
    this.lives--;
    this.resetCombo();
    this.shake = 1;
    this.push({ type: 'flash', kind: 'bad' });
    this.push({ type: 'sfx', name: reason === 'wasabi' ? 'wasabi' : 'angry' });
    this.push({ type: 'shake' });
    if (x != null) { this.addFloater(x, y, '-1 ❤', '#ff7a63', 24); }
    if (this.lives <= 0) { this.gameOver(); }
  };

  Core.prototype.gameOver = function () {
    if (this.state === 'over') { return; }
    this.state = 'over';
    this.lives = 0;
    this.push({ type: 'sfx', name: 'over' });
    this.push({ type: 'gameover' });
  };

  /* ============================================================
     SECTION: plate-hit
     ============================================================ */
  Core.prototype.hitPlate = function (p, bx, by) {
    var i = this.plates.indexOf(p);
    if (i < 0) { return; }
    this.plates.splice(i, 1);
    this.hits++;

    if (p.kind === 'wasabi') {
      this.burst(p.x, p.y, 'rgba(150,230,90,.95)', 34, 330, '💀');
      this.burst(p.x, p.y, 'rgba(210,255,160,.9)', 16, 210);
      this.addFloater(p.x, p.y - 20, '芥爆！', '#c8f58a', 26, '误击芥末盘', '#ffe6b8');
      this.loseLife('wasabi', p.x, p.y - 54);
      return;
    }

    if (p.kind === 'tea') {
      this.burst(p.x, p.y, 'rgba(120,230,170,.95)', 20, 240, '🍵');
      var add = Math.min(B.teaRefill, B.maxAmmo - this.ammo);
      this.ammo = Math.min(B.maxAmmo, this.ammo + B.teaRefill);
      this.ammoAcc = 0;
      this.addFloater(p.x, p.y - 18, '酱油 +' + (add > 0 ? add : B.teaRefill), '#a8f0c4', 21);
      this.bumpCombo();
      this.push({ type: 'sfx', name: 'tea' });
      return;
    }

    /* 普通寿司 */
    var tier = TIERS[p.tier];
    var gain = Math.round(p.type.base * this.comboMult);
    this.bumpCombo();
    this.burst(p.x, p.y, tier.glow, 20, 250, p.emoji);
    this.push({ type: 'sfx', name: 'hit', tier: p.tier });
    this.addScore(gain);
    if (gain > this.bestPlate) { this.bestPlate = gain; }
    this.addFloater(p.x, p.y - 16, '+' + gain, '#ffe6b8', 19 + Math.min(this.comboMult * 1.2, 11),
      this.comboMult > 1 ? '连击 ×' + this.comboMult : p.type.name, '#ffd79a');

    /* 送菜判定：找最急切的、需要这盘寿司的客人 */
    var target = null, targetItem = null, worst = Infinity;
    for (var c = 0; c < this.customers.length; c++) {
      var cu = this.customers[c];
      if (cu.state !== 'idle' && cu.state !== 'entering') { continue; }
      for (var j = 0; j < cu.order.length; j++) {
        var it = cu.order[j];
        if (it.done || it.flying || it.id !== p.type.id) { continue; }
        if (cu.patience < worst) { worst = cu.patience; target = cu; targetItem = it; }
        break;
      }
    }
    if (target && targetItem) {
      targetItem.flying = true;
      targetItem.flyIdx = this.flyers.length;
      this.flyers.push({
        emoji: p.emoji, size: 30,
        x0: p.x, y0: p.y - 14,
        x1: target.x, y1: L.custHeadY - 2,
        t: 0, dur: 0.62, arc: 86,
        cust: target, item: targetItem
      });
      /* 连线提示粒子 */
      for (var s = 0; s < 7; s++) {
        this.particles.push({
          type: 'dot', x: p.x, y: p.y - 12,
          vx: (target.x - p.x) * rnd(0.2, 0.5), vy: (L.custHeadY - 30 - p.y) * rnd(0.2, 0.5),
          g: 0, size: rnd(2, 4), rot: 0,
          color: 'rgba(255,226,150,.9)', life: 0.42, max: 0.42
        });
      }
      this.addFloater(target.x, L.bubbleY + 34, '上菜！', '#a8f0c4', 18);
    }
  };

  Core.prototype.deliver = function (f) {
    var c = f.cust, it = f.item;
    /* 客人可能已在飞行途中离席，此时不再计分 */
    if (this.customers.indexOf(c) < 0) { return; }
    it.done = true;
    it.flying = false;
    this.push({ type: 'sfx', name: 'deliver' });
    this.burst(f.x1, f.y1, 'rgba(160,240,180,.95)', 14, 190, '✨');
    var bonus = Math.round(B.deliverBonus * this.comboMult);
    this.addScore(bonus);
    this.addFloater(f.x1, f.y1 - 12, '+' + bonus, '#a8f0c4', 20, '送菜成功', '#e6ffe9');

    /* 重算 nextIdx */
    c.nextIdx = 0;
    for (var j = 0; j < c.order.length; j++) {
      if (!c.order[j].done) { c.nextIdx = j; break; }
      c.nextIdx = j + 1;
    }

    var allDone = true;
    for (var k = 0; k < c.order.length; k++) { if (!c.order[k].done) { allDone = false; break; } }
    if (allDone) { this.completeCustomer(c); }
    else { c.patience = Math.min(c.patienceMax, c.patience + 6); }
  };

  Core.prototype.completeCustomer = function (c) {
    c.state = 'happy';
    c.anim = 0;
    this.ordersDone++;
    var reward = Math.round(c.reward * this.comboMult);
    this.addScore(reward);
    this.push({ type: 'sfx', name: 'complete' });
    this.push({ type: 'flash', kind: 'good' });
    this.burst(c.x, L.custHeadY - 20, 'rgba(255,220,140,.95)', 30, 300, '🎉');
    this.addFloater(c.x, L.custHeadY - 56, '大满足！', '#ffe08a', 26, '+' + reward + ' 订单完成', '#fff6d8');
    /* 奖励一发弹药 */
    this.ammo = Math.min(B.maxAmmo, this.ammo + 2);
  };

  Core.prototype.angryCustomer = function (c) {
    c.state = 'leaving';
    c.anim = 0;
    this.burst(c.x, L.custHeadY - 10, 'rgba(255,110,90,.9)', 22, 240, '💢');
    this.addFloater(c.x, L.custHeadY - 52, '客人怒了！', '#ff8a72', 24, '耐心耗尽', '#ffd9cf');
    this.loseLife('angry', c.x, L.custHeadY - 88);
  };

  /* ============================================================
     SECTION: update
     ============================================================ */
  Core.prototype.update = function (rawDt) {
    var dt = Math.min(rawDt, 0.05);
    this.t += dt;

    /* 环境粒子（任何状态都在动） */
    this.updateMotes(dt);
    this.updateParticles(dt);
    this.updateFloaters(dt);

    /* 背景滚动 */
    var speed = this.beltSpeed();
    this.scroll -= speed * dt;
    this.farScroll += speed * 0.62 * dt;

    if (this.shake > 0) { this.shake = Math.max(0, this.shake - dt * 3.4); }
    if (this.bannerTimer > 0) { this.bannerTimer -= dt; if (this.bannerTimer <= 0) { this.banner = null; } }
    if (this.recoil < 0) { this.recoil = Math.min(0, this.recoil + dt * 90); }
    if (this.fireCd > 0) { this.fireCd -= dt; }

    if (this.state !== 'playing') {
      this.updateFlyers(dt);
      return;
    }

    /* 弹药回复 */
    if (this.ammo < B.maxAmmo) {
      this.ammoAcc += dt;
      while (this.ammoAcc >= B.ammoRegen && this.ammo < B.maxAmmo) {
        this.ammo++;
        this.ammoAcc -= B.ammoRegen;
      }
    } else { this.ammoAcc = 0; }

    /* 连击窗口 */
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) { this.resetCombo(); }
    }

    /* 生成寿司盘 */
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnPlate();
      this.spawnTimer = this.spawnGap() * rnd(0.78, 1.26);
    }
    /* 生成回送空盘 */
    this.farSpawnTimer -= dt;
    if (this.farSpawnTimer <= 0) {
      this.spawnFarPlate();
      this.farSpawnTimer = rnd(1.5, 3.1);
    }
    /* 生成顾客 */
    this.custTimer -= dt;
    if (this.custTimer <= 0) {
      this.spawnCustomer();
      this.custTimer = clamp(rnd(3.2, 5.6) - this.level * 0.16, 1.6, 6);
    }

    this.updatePlates(dt);
    this.updateFarPlates(dt);
    this.updateBullets(dt);
    this.updateCustomers(dt);
    this.updateFlyers(dt);
    this.markWanted();
  };

  Core.prototype.updateMotes = function (dt) {
    for (var i = 0; i < this.motes.length; i++) {
      var m = this.motes[i];
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.rot += m.vr * dt;
      if (m.y < L.norenBottom - 10 || m.x < -20 || m.x > W + 20) { this.motes[i] = this.makeMote(false); }
    }
  };

  Core.prototype.updateParticles = function (dt) {
    for (var i = this.particles.length - 1; i >= 0; i--) {
      var p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      if (p.vx != null) { p.x += p.vx * dt; }
      if (p.vy != null) { p.y += p.vy * dt; }
      if (p.g) { p.vy += p.g * dt; }
      if (p.vr) { p.rot += p.vr * dt; }
      if (p.type === 'shard' || p.type === 'drop') { p.vx *= 0.985; }
    }
  };

  Core.prototype.updateFloaters = function (dt) {
    for (var i = this.floaters.length - 1; i >= 0; i--) {
      this.floaters[i].life -= dt;
      if (this.floaters[i].life <= 0) { this.floaters.splice(i, 1); }
    }
  };

  Core.prototype.updatePlates = function (dt) {
    var sp = this.beltSpeed();
    for (var i = this.plates.length - 1; i >= 0; i--) {
      var p = this.plates[i];
      p.x -= sp * dt;
      if (p.x < -58) { this.plates.splice(i, 1); }
    }
  };

  Core.prototype.updateFarPlates = function (dt) {
    var sp = this.beltSpeed() * 0.62;
    for (var i = this.farPlates.length - 1; i >= 0; i--) {
      var p = this.farPlates[i];
      p.x += sp * dt;
      if (p.x > W + 48) { this.farPlates.splice(i, 1); }
    }
  };

  Core.prototype.updateBullets = function (dt) {
    for (var i = this.bullets.length - 1; i >= 0; i--) {
      var b = this.bullets[i];
      var steps = 2;
      var dead = false;
      for (var s = 0; s < steps && !dead; s++) {
        b.x += b.vx * dt / steps;
        b.y += b.vy * dt / steps;
        /* 命中检测 */
        for (var k = this.plates.length - 1; k >= 0; k--) {
          var p = this.plates[k];
          var dx = (b.x - p.x) / (p.hitR + 5);
          var dy = (b.y - (p.y - 12)) / (p.hitR * 0.86);
          if (dx * dx + dy * dy <= 1) {
            this.hitPlate(p, b.x, b.y);
            dead = true;
            break;
          }
        }
      }
      if (dead) { this.bullets.splice(i, 1); continue; }

      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 7) { b.trail.shift(); }

      if (b.x < -30 || b.x > W + 30 || b.y < -30 || b.y > H + 30) {
        /* 落地/出界溅射 */
        if (b.y < L.counterTopY + 6 && b.y > 0) {
          for (var q = 0; q < 5; q++) {
            this.particles.push({
              type: 'drop', x: b.x, y: b.y,
              vx: rnd(-90, 90), vy: rnd(-130, -20), g: 780,
              size: rnd(1.8, 3.6), rot: 0,
              color: 'rgba(64,44,26,.85)', life: 0.4, max: 0.4
            });
          }
        }
        this.bullets.splice(i, 1);
      }
    }
  };

  Core.prototype.updateCustomers = function (dt) {
    for (var i = this.customers.length - 1; i >= 0; i--) {
      var c = this.customers[i];
      if (c.state === 'entering') {
        c.anim += dt / 0.5;
        if (c.anim >= 1) { c.anim = 1; c.state = 'idle'; }
      } else if (c.state === 'idle') {
        c.patience -= dt;
        if (c.patience <= 0) { c.patience = 0; this.angryCustomer(c); }
      } else if (c.state === 'happy' || c.state === 'leaving') {
        c.anim += dt / 0.85;
        if (c.anim >= 1) {
          c.seat.cust = null;
          this.customers.splice(i, 1);
          continue;
        }
      }
    }
  };

  Core.prototype.updateFlyers = function (dt) {
    for (var i = this.flyers.length - 1; i >= 0; i--) {
      var f = this.flyers[i];
      f.t += dt / f.dur;
      if (f.t >= 1) {
        this.flyers.splice(i, 1);
        this.deliver(f);
      }
    }
  };

  Core.prototype.markWanted = function () {
    var need = {};
    var list = this.neededTypes();
    for (var i = 0; i < list.length; i++) { need[list[i].id] = true; }
    for (var j = 0; j < this.plates.length; j++) {
      var p = this.plates[j];
      p.wanted = p.kind === 'sushi' && !!need[p.type.id];
    }
  };

  /* ============================================================
     SECTION: input-api
     ============================================================ */
  Core.prototype.setAim = function (x, y) {
    this.aimX = clamp(x, 0, W);
    this.aimY = clamp(y, 0, H);
  };

  Core.prototype.start = function () {
    this.reset();
    this.state = 'playing';
    this.push({ type: 'sfx', name: 'start' });
  };

  Core.prototype.pause = function () {
    if (this.state === 'playing') { this.state = 'paused'; return true; }
    return false;
  };

  Core.prototype.resume = function () {
    if (this.state === 'paused') { this.state = 'playing'; return true; }
    return false;
  };

  Core.prototype.togglePause = function () {
    return this.pause() || this.resume();
  };

  Core.prototype.drainEvents = function () {
    var e = this.events;
    this.events = [];
    return e;
  };

  Core.prototype.comboRatio = function () {
    if (this.comboMult <= 1) { return 0; }
    return clamp(this.comboTimer / B.comboWindow, 0, 1);
  };

  global.SUSHI_CORE = Core;
})(window);
