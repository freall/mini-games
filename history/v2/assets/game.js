/* ============================================================
   回转寿司大作战 · 渲染与交互主控
   SECTION: game-main
   ============================================================ */
window.SUSHI_APP = (function () {
  'use strict';

  var D = window.SUSHI_GAME;
  var S = window.SUSHI_SCENE;
  var Core = window.SUSHI_CORE;
  var L = D.LAYOUT;
  var B = D.BALANCE;
  var TIERS = D.TIERS;
  var W = L.W, H = L.H;

  /* SECTION: dom
     视图挂在单入口内，DOM 引用在 mount 时初始化；隐藏期间为 null。 */
  var $ = function (id) { return document.getElementById(id); };
  var canvas = null, ctx = null, stage = null, flashEl = null;
  var bannerEl = null, bannerTxt = null, bannerSub = null;
  var ovStart = null, ovPause = null, ovOver = null;
  var uiScore = null, uiBest = null, uiLevel = null,
    uiLife = null, uiCombo = null, uiAmmo = null,
    uiAmmoBar = null, uiComboBox = null, uiComboBarI = null,
    uiOrders = null;

  var game = new Core();
  var best = 0;
  var dpr = 1;
  var lastTs = 0;
  var pointerDown = false;
  var autoFire = false;
  var lastLifeRender = -1;
  var active = false;
  var mounted = false;

  /* SECTION: storage */
  function loadBest() {
    try {
      var stored = window.localStorage.getItem('kaiten-sushi-best');
      if (stored) { best = parseInt(stored, 10) || 0; }
    } catch (e) { /* 忽略隐私模式限制 */ }
  }
  loadBest();

  function saveBest() {
    try { window.localStorage.setItem('kaiten-sushi-best', String(best)); } catch (e) { /* 忽略隐私模式限制 */ }
  }

  /* SECTION: canvas-size
     backing store 固定按设计空间 900×640 × dpr，CSS 负责等比缩放显示
     （.stage 的 aspect-ratio 已锁定 900/640，故不会变形）。
     这样游戏内所有坐标恒等于设计坐标，与窗口实际大小无关。 */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var bw = Math.round(W * dpr);
    var bh = Math.round(H * dpr);
    if (canvas.width !== bw) { canvas.width = bw; }
    if (canvas.height !== bh) { canvas.height = bh; }
  }

  /* SECTION: pointer-coords
     把屏幕坐标换算为设计空间坐标，供瞄准使用 */
  function toGame(cx, cy) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (cx - rect.left) / rect.width * W,
      y: (cy - rect.top) / rect.height * H
    };
  }

  function onMove(cx, cy) {
    var p = toGame(cx, cy);
    game.setAim(p.x, p.y);
  }

  /* SECTION: input
     绑定在 mount 时完成；所有回调先判断视图是否激活，隐藏期间不响应。 */
  function bindCanvas() {
    canvas.addEventListener('mousemove', function (e) { if (active) { onMove(e.clientX, e.clientY); } });
    canvas.addEventListener('mousedown', function (e) {
      e.preventDefault();
      if (!active) { return; }
      D.Audio.resume();
      onMove(e.clientX, e.clientY);
      pointerDown = true;
      if (game.state === 'playing') { game.tryFire(); }
    });

    canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (!active) { return; }
      D.Audio.resume();
      var t0 = e.touches[0];
      onMove(t0.clientX, t0.clientY);
      pointerDown = true;
      autoFire = true;
      if (game.state === 'playing') { game.tryFire(); }
    }, { passive: false });

    canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (!active) { return; }
      var t0 = e.touches[0];
      onMove(t0.clientX, t0.clientY);
    }, { passive: false });

    canvas.addEventListener('touchend', function (e) {
      e.preventDefault();
      pointerDown = false;
      autoFire = false;
    }, { passive: false });

    canvas.addEventListener('touchcancel', function () { pointerDown = false; autoFire = false; });
  }

  function onKeyDown(e) {
    if (!active) { return; }
    var k = e.key;
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      D.Audio.resume();
      if (game.state === 'menu') { startGame(); }
      else if (game.state === 'over') { startGame(); }
      else if (game.state === 'playing') { game.tryFire(); }
      else if (game.state === 'paused') { resumeGame(); }
      return;
    }
    if (k === 'p' || k === 'P' || k === 'Escape') {
      if (k === 'Escape' && game.state === 'menu') {
        if (window.APP_ROUTER) { window.APP_ROUTER.go('portal'); }
        return;
      }
      e.preventDefault();
      if (game.state === 'playing') { pauseGame(); }
      else if (game.state === 'paused') { resumeGame(); }
      return;
    }
    if (k === 'm' || k === 'M') { toggleSound(); return; }
    if (k === 'r' || k === 'R') {
      if (game.state === 'over' || game.state === 'paused') { startGame(); }
      return;
    }
    /* 方向键微调瞄准 */
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      var step = 22;
      var ax = game.aimX, ay = game.aimY;
      if (k === 'ArrowLeft') { ax -= step; }
      if (k === 'ArrowRight') { ax += step; }
      if (k === 'ArrowUp') { ay -= step; }
      if (k === 'ArrowDown') { ay += step; }
      game.setAim(ax, ay);
    }
  }

  window.addEventListener('mouseup', function () { pointerDown = false; });
  window.addEventListener('keydown', onKeyDown);

  /* SECTION: buttons */
  function bindButtons() {
    $('btnStart').addEventListener('click', function () { D.Audio.resume(); startGame(); });
    $('btnAgain').addEventListener('click', function () { D.Audio.resume(); startGame(); });
    $('btnResume').addEventListener('click', function () { resumeGame(); });
    $('btnQuit').addEventListener('click', function () { quitToMenu(); });
    $('btnPause').addEventListener('click', function () {
      if (game.state === 'playing') { pauseGame(); }
      else if (game.state === 'paused') { resumeGame(); }
    });
    $('btnSound').addEventListener('click', toggleSound);
    /* 返回乐园按钮（btnHome）统一由门户路由的 data-back-home 接管：
       go('portal') 会调用本视图 deactivate，其中已处理暂停并回到开始界面。 */
  }

  function toggleSound() {
    D.Audio.enabled = !D.Audio.enabled;
    var b = $('btnSound');
    b.textContent = D.Audio.enabled ? '🔊' : '🔇';
    b.classList.toggle('off', !D.Audio.enabled);
    if (D.Audio.enabled) { D.Audio.resume(); D.Audio.tone({ type: 'sine', f0: 880, f1: 880, dur: 0.08, vol: 0.22 }); }
  }

  /* SECTION: flow */
  function show(el, on) { el.classList.toggle('show', !!on); }

  function startGame() {
    game.start();
    show(ovStart, false);
    show(ovPause, false);
    show(ovOver, false);
    lastLifeRender = -1;
    renderOrders(true);
  }

  function pauseGame() {
    if (game.pause()) { show(ovPause, true); }
  }
  function resumeGame() {
    if (game.resume()) { show(ovPause, false); lastTs = 0; }
  }
  function quitToMenu() {
    show(ovPause, false);
    game.state = 'menu';
    game.reset();
    show(ovStart, true);
    renderOrders(true);
  }

  function endGame() {
    var isRecord = game.score > best;
    if (isRecord) { best = game.score; saveBest(); }
    $('rScore').textContent = game.score.toLocaleString('zh-CN');
    $('rBest').textContent = best.toLocaleString('zh-CN');
    $('rLevel').textContent = game.level;
    $('rHits').textContent = game.hits;
    $('rCombo').textContent = '×' + game.maxCombo;
    $('rOrders').textContent = game.ordersDone;
    $('rRecord').classList.toggle('show', isRecord);

    var acc = game.shots ? Math.round(game.hits / game.shots * 100) : 0;
    var title, kana, art, tip;
    if (isRecord) {
      title = '新纪录诞生'; kana = 'しんきろく'; art = '🏆';
    } else if (game.score >= 6000) {
      title = '板前名人'; kana = 'めいじん'; art = '👨‍🍳';
    } else if (game.score >= 2500) {
      title = '熟练枪手'; kana = 'うでまえ'; art = '🎯';
    } else {
      title = '打烊了'; kana = 'ほんじつはしめい'; art = '🏮';
    }
    var tipPool = D.TIPS.slice();
    tip = '命中率 ' + acc + '% · ' + tipPool[Math.floor(Math.random() * tipPool.length)];
    $('overTitle').textContent = title;
    $('overKana').textContent = kana;
    $('overArt').textContent = art;
    $('rTip').textContent = tip;

    show(ovOver, true);
  }

  /* SECTION: events */
  function handleEvents() {
    var evs = game.drainEvents();
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.type === 'sfx') {
        var A = D.Audio;
        if (e.name === 'shoot') { A.shoot(); }
        else if (e.name === 'hit') { A.hit(e.tier); }
        else if (e.name === 'tea') { A.tea(); }
        else if (e.name === 'deliver') { A.deliver(); }
        else if (e.name === 'complete') { A.complete(); }
        else if (e.name === 'wasabi') { A.wasabi(); }
        else if (e.name === 'angry') { A.angry(); }
        else if (e.name === 'levelup') { A.levelup(); }
        else if (e.name === 'over') { A.over(); }
        else if (e.name === 'empty') { A.empty(); }
        else if (e.name === 'start') { A.start(); }
        else if (e.name === 'combo') { A.tone({ type: 'square', f0: 640 + e.mult * 90, f1: 900 + e.mult * 90, dur: 0.09, vol: 0.18 }); }
        else if (e.name === 'comboBreak') { A.tone({ type: 'sine', f0: 420, f1: 200, dur: 0.16, vol: 0.16 }); }
      } else if (e.type === 'flash') {
        flashEl.classList.remove('bad', 'good');
        void flashEl.offsetWidth;
        flashEl.classList.add(e.kind);
        /* CSS 过渡为 .34s，需保留足够时长才能看到峰值闪光 */
        setTimeout(function () { flashEl.classList.remove('bad', 'good'); }, 240);
      } else if (e.type === 'shake') {
        stage.classList.remove('shake');
        void stage.offsetWidth;
        stage.classList.add('shake');
        setTimeout(function () { stage.classList.remove('shake'); }, 320);
      } else if (e.type === 'gameover') {
        endGame();
      }
    }
    if (game.banner && game.bannerTimer > 0 && bannerTxt.textContent !== game.banner.main) {
      bannerTxt.textContent = game.banner.main;
      bannerSub.textContent = game.banner.sub;
      bannerEl.classList.remove('show');
      void bannerEl.offsetWidth;
      bannerEl.classList.add('show');
    }
  }

  /* SECTION: hud */
  function renderHud() {
    uiScore.textContent = game.score.toLocaleString('zh-CN');
    uiBest.textContent = Math.max(best, game.score).toLocaleString('zh-CN');
    uiLevel.textContent = game.level;

    if (game.lives !== lastLifeRender) {
      var hearts = '';
      for (var i = 0; i < Math.max(0, game.lives); i++) { hearts += '❤'; }
      for (var j = game.lives; j < B.startLives; j++) { hearts += '🖤'; }
      uiLife.textContent = hearts || '—';
      lastLifeRender = game.lives;
    }

    var multTxt = '×' + game.comboMult;
    if (uiCombo.textContent !== multTxt) {
      uiCombo.textContent = multTxt;
      uiComboBox.classList.remove('pulse');
      void uiComboBox.offsetWidth;
      uiComboBox.classList.add('pulse');
    }
    uiComboBox.classList.toggle('hot', game.comboMult > 1);
    uiComboBarI.style.width = (game.comboRatio() * 100).toFixed(1) + '%';

    var ammoTxt = String(Math.floor(game.ammo));
    if (uiAmmo.textContent !== ammoTxt) { uiAmmo.textContent = ammoTxt; }
    uiAmmoBar.style.width = (game.ammo / B.maxAmmo * 100).toFixed(1) + '%';
  }

  /* SECTION: orders-ui
     增量更新：每位客人一张卡，耐心条与完成状态原地改，不整栏重建 */
  var orderCards = new Map();   // uid -> {el, face, row, em, bar, items}
  var emptyTip = null;

  function activeCustomers() {
    var list = [];
    for (var i = 0; i < game.seats.length; i++) {
      var c = game.seats[i].cust;
      if (c && (c.state === 'idle' || c.state === 'entering' || c.state === 'happy')) { list.push(c); }
    }
    return list;
  }

  function buildCard(cu) {
    var el = document.createElement('div');
    el.className = 'order';
    var face = document.createElement('div');
    face.className = 'face';
    var body = document.createElement('div');
    body.className = 'body';
    var row = document.createElement('div');
    row.className = 'row';
    var items = [];
    for (var j = 0; j < cu.order.length; j++) {
      var sp = document.createElement('span');
      sp.textContent = cu.order[j].emoji;
      row.appendChild(sp);
      items.push(sp);
    }
    var em = document.createElement('em');
    row.appendChild(em);
    var pat = document.createElement('div');
    pat.className = 'pat';
    var bar = document.createElement('i');
    pat.appendChild(bar);
    body.appendChild(row);
    body.appendChild(pat);
    el.appendChild(face);
    el.appendChild(body);
    return { el: el, face: face, row: row, em: em, pat: pat, bar: bar, items: items, sig: '' };
  }

  function updateCard(cd, cu) {
    var ratio = cu.patienceMax ? cu.patience / cu.patienceMax : 1;
    var urgent = ratio < 0.3 && cu.state !== 'happy';
    var done = 0;
    for (var d = 0; d < cu.order.length; d++) {
      var it = cu.order[d];
      if (it.done) { done++; }
      var sp = cd.items[d];
      if (sp) {
        var on = it.done;
        if (sp.style.opacity !== (on ? '.42' : '')) {
          sp.style.opacity = on ? '.42' : '';
          sp.style.textDecoration = on ? 'line-through' : '';
        }
      }
    }
    var cls = 'order' + (cu.state === 'happy' ? ' done' : urgent ? ' urgent' : '');
    if (cd.el.className !== cls) { cd.el.className = cls; }
    var wantFace = cu.state === 'happy' ? cu.happyFace : urgent ? cu.angryFace : cu.face;
    if (cd.face.textContent !== wantFace) { cd.face.textContent = wantFace; }
    var txt = done + '/' + cu.order.length + ' · +' + cu.reward;
    if (cd.em.textContent !== txt) { cd.em.textContent = txt; }
    var w = (ratio * 100).toFixed(1) + '%';
    if (cd.bar.style.width !== w) { cd.bar.style.width = w; }
    var lowCls = 'pat' + (ratio < 0.3 ? ' low' : '');
    if (cd.pat.className !== lowCls) { cd.pat.className = lowCls; }
  }

  function renderOrders(force) {
    var list = activeCustomers();

    if (force) {
      uiOrders.innerHTML = '';
      orderCards.clear();
      emptyTip = null;
    }

    if (!list.length) {
      var tipTxt = game.state === 'playing' ? '暂无客人等待，稍候即来…' : '点击「开始营业」迎接客人';
      if (!emptyTip) {
        emptyTip = document.createElement('div');
        emptyTip.className = 'orders-empty';
        emptyTip.textContent = tipTxt;
        uiOrders.innerHTML = '';
        uiOrders.appendChild(emptyTip);
      } else if (emptyTip.textContent !== tipTxt) {
        emptyTip.textContent = tipTxt;
      }
      return;
    }

    /* 有客人时移除空状态提示 */
    if (emptyTip) {
      if (emptyTip.parentNode) { emptyTip.parentNode.removeChild(emptyTip); }
      emptyTip = null;
    }

    var seen = new Set();
    for (var i = 0; i < list.length; i++) {
      var cu = list[i];
      seen.add(cu.uid);
      var cd = orderCards.get(cu.uid);
      if (!cd) {
        cd = buildCard(cu);
        orderCards.set(cu.uid, cd);
        uiOrders.appendChild(cd.el);
      } else if (cd.el.parentNode !== uiOrders) {
        uiOrders.appendChild(cd.el);
      }
      updateCard(cd, cu);
    }
    /* 移除已离席客人的卡片 */
    var stale = [];
    orderCards.forEach(function (cd, uid) { if (!seen.has(uid)) { stale.push(uid); } });
    for (var s = 0; s < stale.length; s++) {
      var c2 = orderCards.get(stale[s]);
      if (c2 && c2.el.parentNode) { c2.el.parentNode.removeChild(c2.el); }
      orderCards.delete(stale[s]);
    }
  }

  /* SECTION: render */
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var sx = 0, sy = 0;
    if (game.shake > 0) {
      sx = (Math.random() - 0.5) * 15 * game.shake;
      sy = (Math.random() - 0.5) * 15 * game.shake;
    }
    ctx.save();
    ctx.translate(sx, sy);

    /* 背景 */
    var bg = S.buildBackground(dpr);
    ctx.drawImage(bg, 0, 0, W, H);

    S.drawSteam(ctx, game.t);

    /* 环境光点 */
    for (var mi = 0; mi < game.motes.length; mi++) {
      S.drawPetal(ctx, game.motes[mi]);
    }

    /* 顾客（坐在吧台后方） */
    for (var ci = 0; ci < game.customers.length; ci++) {
      S.drawCustomer(ctx, game.customers[ci], game.t);
    }

    /* 顾客前方的吧台台面，遮住下半身 */
    S.drawSeatLedge(ctx);

    /* 传送带 */
    S.drawBelt(ctx, game.scroll, game.farScroll);

    /* 回送轨上的小盘（远处，向右回收） */
    for (var fi = 0; fi < game.farPlates.length; fi++) {
      S.drawFarPlate(ctx, game.farPlates[fi], game.t);
    }

    /* 主轨寿司盘 */
    for (var pi = 0; pi < game.plates.length; pi++) {
      S.drawPlate(ctx, game.plates[pi], game.t);
    }

    /* 飞行的寿司 */
    for (var fy = 0; fy < game.flyers.length; fy++) {
      S.drawFlyer(ctx, game.flyers[fy], game.t);
    }

    /* 子弹 */
    for (var bi = 0; bi < game.bullets.length; bi++) {
      drawBullet(ctx, game.bullets[bi]);
    }

    /* 炮台 */
    S.drawTurret(ctx, game.aimX, game.aimY, game.recoil, game.ammo / B.maxAmmo, game.t);

    /* 粒子 */
    for (var pa = 0; pa < game.particles.length; pa++) {
      S.drawParticle(ctx, game.particles[pa]);
    }

    /* 飘字 */
    for (var fl = 0; fl < game.floaters.length; fl++) {
      S.drawFloater(ctx, game.floaters[fl]);
    }

    S.drawVignette(ctx);

    /* 低血量红边 */
    if (game.state === 'playing' && game.lives === 1) {
      var pulse = 0.5 + 0.5 * Math.sin(game.t * 4.2);
      var vg = ctx.createRadialGradient(W / 2, H * 0.5, H * 0.3, W / 2, H * 0.5, H * 0.86);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(224,60,45,' + (0.16 + pulse * 0.24).toFixed(3) + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }

    /* 连击光边 */
    if (game.comboMult > 2 && game.state === 'playing') {
      var cp = 0.5 + 0.5 * Math.sin(game.t * 6);
      var cg = ctx.createRadialGradient(W / 2, H * 0.5, H * 0.34, W / 2, H * 0.5, H * 0.88);
      cg.addColorStop(0, 'rgba(0,0,0,0)');
      cg.addColorStop(1, 'rgba(242,197,97,' + (0.08 + cp * 0.16 * Math.min(game.comboMult / 8, 1)).toFixed(3) + ')');
      ctx.fillStyle = cg;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();
  }

  function drawBullet(ctx, b) {
    /* 拖尾 */
    for (var i = 0; i < b.trail.length; i++) {
      var p = b.trail[i];
      var a = (i + 1) / b.trail.length;
      ctx.save();
      ctx.globalAlpha = a * 0.4;
      ctx.fillStyle = '#8a5a2b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6 + a * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.ang + Math.PI / 2);
    /* 光晕 */
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 13);
    g.addColorStop(0, 'rgba(255,226,170,.85)');
    g.addColorStop(0.4, 'rgba(200,140,70,.4)');
    g.addColorStop(1, 'rgba(120,70,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill();
    /* 弹体（酱油滴） */
    var bg2 = ctx.createLinearGradient(-4, -8, 4, 8);
    bg2.addColorStop(0, '#7a4a22');
    bg2.addColorStop(0.5, '#3b2413');
    bg2.addColorStop(1, '#1a0f08');
    ctx.fillStyle = bg2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.quadraticCurveTo(5.4, -1, 4.2, 4);
    ctx.quadraticCurveTo(2.6, 9, 0, 9);
    ctx.quadraticCurveTo(-2.6, 9, -4.2, 4);
    ctx.quadraticCurveTo(-5.4, -1, 0, -9);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,232,190,.6)';
    ctx.beginPath(); ctx.ellipse(-1.6, -2, 1.5, 3, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* SECTION: loop */
  var rafId = 0;
  function frame(ts) {
    if (!active) { rafId = 0; return; }
    if (!lastTs) { lastTs = ts; }
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.25) { dt = 0.016; }

    /* 移动端按住自动连射 */
    if (autoFire && pointerDown && game.state === 'playing') { game.tryFire(); }

    game.update(dt);
    handleEvents();
    render();
    renderHud();
    renderOrders(false);

    rafId = window.requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    lastTs = 0;
  }

  /* SECTION: boot
     DOM 引用与事件绑定在 mount 时完成，视图隐藏期间不渲染、不响应输入。 */
  function cacheDom() {
    canvas = $('game');
    ctx = canvas.getContext('2d');
    stage = $('stage');
    flashEl = $('flash');
    bannerEl = $('banner');
    bannerTxt = $('bannerTxt');
    bannerSub = $('bannerSub');
    ovStart = $('ovStart');
    ovPause = $('ovPause');
    ovOver = $('ovOver');
    uiScore = $('uiScore'); uiBest = $('uiBest'); uiLevel = $('uiLevel');
    uiLife = $('uiLife'); uiCombo = $('uiCombo'); uiAmmo = $('uiAmmo');
    uiAmmoBar = $('uiAmmoBar'); uiComboBox = $('uiComboBox');
    uiComboBarI = $('uiComboBar').firstElementChild;
    uiOrders = $('uiOrders');
  }

  return {
    mount: function () {
      if (mounted) { return; }
      mounted = true;
      cacheDom();
      bindCanvas();
      bindButtons();
      window.addEventListener('resize', resize);
      if (window.ResizeObserver) {
        try { new ResizeObserver(resize).observe(stage); } catch (e) { /* 忽略 */ }
      }
      resize();
      renderOrders(true);
      uiBest.textContent = best.toLocaleString('zh-CN');
      uiLife.textContent = '❤❤❤';
      /* 视图隐藏时 canvas 宽度为 0，先渲染一帧保证回到前台时画面正确 */
      render();
    },
    activate: function () {
      active = true;
      loadBest();
      if (uiBest) { uiBest.textContent = Math.max(best, game.score).toLocaleString('zh-CN'); }
      /* 从 display:none 恢复后需要重新量取画布尺寸 */
      requestAnimationFrame(function () {
        resize();
        if (!rafId) { lastTs = 0; rafId = window.requestAnimationFrame(frame); }
      });
    },
    deactivate: function () {
      active = false;
      pointerDown = false;
      autoFire = false;
      stopLoop();
      /* 回到门户时统一收在开始界面，避免残留半局状态 */
      if (game.state === 'playing' || game.state === 'paused') { quitToMenu(); }
    },
    isActive: function () { return active; },
    stats: function () { return { best: best, level: game.level }; }
  };
})();
