/* ============================================================
   靶场神枪手 · 渲染与交互层
   SECTION: shooter-view
   ------------------------------------------------------------
   职责边界（与另外几款游戏一致）：
     shooter-data.js  调参表（枪 / 靶型 / 关卡 / 计分 / 音效）
     shooter-core.js  玩法逻辑（生成、运动、判定、计分、结算）—— 纯函数，可 node 单测
     本文件           只管"画"和"收输入"：core 返回事件，这里换成音效、粒子、飘字

   三条实现约定：
     1. **设计坐标 900×600 固定**，backing store 按 dpr，CSS 等比缩放：
        于是准星换算(pointer→设计坐标)与判定几何永远一致，窗口怎么拉都不影响玩法。
     2. **准星必须把"散布"画出来**：内圈是弹着散布圆（bloomEff），
        外圈虚线是真实随机偏移的上限。看不到散布的射击游戏，玩家学不会"等准星回落"。
     3. **每帧只推进一次 world.step(dt)**，事件按顺序消化；
        飘字/粒子/弹孔都有自己的寿命，不写回 world（world 是逻辑层的资产）。
   ============================================================ */
window.SHOOTER_APP = (function () {
  'use strict';

  var D = window.SHOOTER_DATA, C = window.SHOOTER_CORE;
  if (!D || !C) { throw new Error('SHOOTER_DATA / SHOOTER_CORE 未加载'); }

  var DW = D.LAYOUT.W, DH = D.LAYOUT.H;

  /* SECTION: 存档 key */
  var K_BEST = 'shooter-best', K_LEVEL = 'shooter-level';
  var K_COINS = 'shooter-coins', K_OWNED = 'shooter-guns', K_GUN = 'shooter-gun';
  var K_MAXSTREAK = 'shooter-streak', K_CLEARS = 'shooter-clears';

  /* SECTION: state */
  var mounted = false, active = false;
  var world = null, phase = 'start';        // start | countdown | play | pause | over | clear
  var cv = null, ctx = null, dpr = 1;
  var raf = 0, lastT = 0;
  var aim = { x: DW / 2, y: DH * 0.6 };     // 准星（设计坐标）
  var firing = false, needAim = true;       // 按住连射 / 鼠标还没进过画面时不要贴死在中心
  var floaters = [], sparks = [], holes = [], shells = [];
  var shakeT = 0, flashT = 0, flashColor = '255,255,255', hitMarkT = 0, hitMark = null;
  var recoil = 0, muzzleT = 0, lowTimeBeep = -1;
  var best = 0, bestLevel = 1, coins = 0, owned = [], gunId = 'pistol';
  var maxStreakAll = 0, totalClears = 0;
  var soundOn = true;
  var el = {};
  var countTimer = null, toastTimer = null;
  var desiredLevel = 1;

  /* SECTION: helpers */
  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Math.round(n).toLocaleString('zh-CN'); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readStore(key, def) {
    try {
      var v = parseInt(window.localStorage.getItem(key) || '', 10);
      return isNaN(v) ? def : v;
    } catch (e) { return def; }
  }
  function writeStore(key, val) {
    try { window.localStorage.setItem(key, String(val)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function readRaw(key, def) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null || v === '' ? def : v;
    } catch (e) { return def; }
  }
  function writeRaw(key, val) {
    try { window.localStorage.setItem(key, String(val)); } catch (e) { /* 忽略 */ }
  }
  function loadArmory() {
    coins = readStore(K_COINS, 0);
    best = readStore(K_BEST, 0);
    bestLevel = readStore(K_LEVEL, 1);
    maxStreakAll = readStore(K_MAXSTREAK, 0);
    totalClears = readStore(K_CLEARS, 0);
    var raw = readRaw(K_OWNED, '');
    owned = raw ? raw.split(',').filter(function (id) { return !!D.gunById(id) && D.gunById(id).id === id; }) : [];
    if (owned.indexOf('pistol') < 0) { owned.push('pistol'); }
    var sel = readRaw(K_GUN, 'pistol');
    gunId = owned.indexOf(sel) >= 0 ? sel : 'pistol';
  }
  function saveArmory() {
    writeStore(K_COINS, coins);
    writeRaw(K_OWNED, owned.join(','));
    writeRaw(K_GUN, gunId);
  }

  /* SECTION: DOM 绑定 */
  var IDS = ['shBtnSound', 'shGunArt', 'shGunName', 'shGunEn', 'shReloadTxt', 'shReloadFill',
    'shBreathTxt', 'shBreathFill', 'shBreathTrack', 'shAmmoPips', 'shDowns', 'shScore', 'shCombo',
    'shTime', 'shAcc', 'shBest', 'shLevelName', 'shDots', 'shProgFill', 'shProgTxt', 'shStage',
    'shCanvas', 'shCountdown', 'shToast', 'shOvStart', 'shOvPause', 'shOvOver', 'shStartBest',
    'shStartCoins', 'shStartLevel', 'shChooserStart', 'shArmory', 'shArmoryMsg', 'shCoinsTop',
    'shBtnStart', 'shBtnResume', 'shBtnQuit', 'shPauseLive', 'shRArt', 'shRTitle', 'shREn',
    'shRGrade', 'shRWhy', 'shRScore', 'shRBest', 'shRLevel', 'shRDowns', 'shRAcc', 'shRBulls',
    'shRStreak', 'shRBombs', 'shRExpired', 'shRFired', 'shRClear', 'shRTime', 'shRCoins',
    'shRCoinsTotal', 'shRRecord', 'shChooserOver', 'shBtnNext', 'shBtnRetry', 'shRTip'];

  function bindDom() {
    for (var i = 0; i < IDS.length; i++) { el[IDS[i]] = $(IDS[i]); }
  }

  /* SECTION: 画布尺寸
     backing store 固定按设计尺寸 × dpr，CSS 负责等比缩放 ——
     这样无论窗口怎么变，游戏内几何都是常量，判定与画面永远一致。 */
  function setupCanvas() {
    if (!el.shCanvas) { return; }
    cv = el.shCanvas;
    ctx = cv.getContext('2d');
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(DW * dpr);
    cv.height = Math.round(DH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
  }

  /* ============================================================
     SECTION: 绘制
     ============================================================ */
  function draw(t) {
    if (!ctx) { return; }
    ctx.save();
    if (shakeT > 0) {
      var s = shakeT * 22;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    ctx.clearRect(-40, -40, DW + 80, DH + 80);
    drawRange(t);
    if (world) {
      drawTargets(t);
      drawHoles();
      drawSparks();
      drawFloaters();
      if (phase === 'play' || phase === 'pause' || phase === 'countdown') { drawBench(t); drawCrosshair(t); }
    } else {
      drawBench(t);
    }
    ctx.restore();
    if (flashT > 0) {
      ctx.fillStyle = 'rgba(' + flashColor + ',' + (flashT * 0.55).toFixed(3) + ')';
      ctx.fillRect(0, 0, DW, DH);
    }
    drawVignette();
  }

  /* 靶场背景：背板 + 三条靶道 + 距离标牌 + 顶部灯 */
  function drawRange(t) {
    var g = ctx.createLinearGradient(0, 0, 0, DH);
    g.addColorStop(0, '#131a28');
    g.addColorStop(0.42, '#0d131e');
    g.addColorStop(1, '#05070c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DW, DH);

    /* 顶部两盏灯：极低透明度，让静止画面"活着" */
    for (var i = 0; i < 2; i++) {
      var lx = i ? DW * 0.78 : DW * 0.22;
      var rg = ctx.createRadialGradient(lx, -40, 10, lx, -40, 300);
      rg.addColorStop(0, 'rgba(255,228,170,.20)');
      rg.addColorStop(1, 'rgba(255,228,170,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(lx - 300, 0, 600, 320);
    }

    /* 三条靶道：越远越暗越窄（纵深靠明度与色带表达） */
    for (var k = 0; k < D.RANGE.depths.length; k++) {
      var dep = D.RANGE.depths[k];
      var y0 = dep.y0 - 44, y1 = dep.y1 + 44;
      ctx.fillStyle = 'rgba(255,255,255,' + (0.018 + k * 0.014).toFixed(3) + ')';
      ctx.fillRect(0, y0, DW, y1 - y0);
      ctx.strokeStyle = 'rgba(160,190,235,.10)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(DW, y1); ctx.stroke();
      /* 左侧距离标牌 */
      ctx.fillStyle = 'rgba(200,215,240,.34)';
      ctx.font = '600 10px ui-monospace,Menlo,Consolas,monospace';
      ctx.textAlign = 'left';
      ctx.fillText(dep.name + ' ×' + dep.mult.toFixed(2), 10, (y0 + y1) / 2);
    }

    /* 背板横档（靶子挂在上面的视觉锚点） */
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.fillRect(0, D.RANGE.wallTop + D.RANGE.wallH - 6, DW, 6);
    ctx.fillStyle = 'rgba(255,196,92,.13)';
    ctx.font = '900 13px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign = 'left';
    ctx.fillText('RANGE  ·  25M / 50M / 100M', 12, D.RANGE.wallTop + 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(200,215,240,.28)';
    ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(world ? ('LANE ' + String(world.level).padStart(2, '0')) : 'STANDBY', DW - 12, D.RANGE.wallTop + 20);
  }

  /* 靶子：纸盘 + 环带 + 类型徽章 + 支架 */
  function drawTargets(t) {
    var list = C.liveTargets(world);
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      var src = null;
      for (var j = 0; j < world.targets.length; j++) { if (world.targets[j].id === o.id) { src = world.targets[j]; break; } }
      if (!src) { continue; }
      drawOneTarget(src, o, t);
    }
  }

  function drawOneTarget(s, o, t) {
    var p = { x: o.x, y: o.y, r: o.r };
    var alpha = 1;
    if (s.motion === 'blink' && !o.vis) { alpha = 0.14; }        // 隐身瞬间只留个影
    if (s.motion === 'pop' && !o.vis) { alpha = 0.55; }          // 正在升起

    ctx.save();
    ctx.globalAlpha = alpha;

    /* 运动靶的拖影：让玩家读出"它往哪儿走" */
    if (s.vx && !s.bad && alpha > 0.9) {
      for (var k = 1; k <= 2; k++) {
        var bx = p.x - s.vx * 0.035 * k;
        ctx.globalAlpha = alpha * (0.16 - k * 0.05);
        ctx.beginPath(); ctx.arc(bx, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = '#9fb6d8'; ctx.fill();
      }
      ctx.globalAlpha = alpha;
    }

    /* 支架：静态靶挂在立杆上，移动靶上方有导轨 */
    ctx.strokeStyle = 'rgba(150,170,200,.30)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (s.vx) { ctx.moveTo(p.x, p.y - p.r); ctx.lineTo(p.x, p.y - p.r - 16); }
    else { ctx.moveTo(p.x, p.y + p.r); ctx.lineTo(p.x, p.y + p.r + 22); }
    ctx.stroke();

    ctx.translate(p.x, p.y);
    if (s.bad) { drawBomb(s, p.r, t); }
    else if (s.type === 'clock') { drawClock(p.r, t); }
    else { drawPaper(s, p.r, t); }
    ctx.restore();
  }

  /* 标准环靶：奶油纸底 + 两道红环 + 金色内十 */
  function drawPaper(s, r, t) {
    var bands = [
      { to: 1.0, col: '#efe6d4' },
      { to: 0.74, col: '#e0564c' },
      { to: 0.46, col: '#efe6d4' },
      { to: 0.22, col: '#e0564c' },
      { to: 0.07, col: '#ffcf6a' }
    ];
    for (var i = 0; i < bands.length; i++) {
      ctx.beginPath(); ctx.arc(0, 0, r * bands[i].to, 0, Math.PI * 2);
      ctx.fillStyle = bands[i].col; ctx.fill();
    }
    /* 环带分界线 */
    ctx.strokeStyle = 'rgba(30,24,18,.30)';
    ctx.lineWidth = 1;
    for (var k = 1; k < bands.length; k++) {
      ctx.beginPath(); ctx.arc(0, 0, r * bands[k].to, 0, Math.PI * 2); ctx.stroke();
    }
    /* 靶心十字 */
    ctx.strokeStyle = 'rgba(40,30,20,.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-r * 0.05, 0); ctx.lineTo(r * 0.05, 0);
    ctx.moveTo(0, -r * 0.05); ctx.lineTo(0, r * 0.05);
    ctx.stroke();

    /* 外圈：靶型专属标记 */
    ctx.lineWidth = 2;
    if (s.type === 'shrinker') {
      /* 虚线圈标出"最大半径"，让玩家看出它正在缩 */
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(120,220,255,.75)';
      ctx.beginPath(); ctx.arc(0, 0, s.r + 1.5, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (s.type === 'splitter') {
      ctx.strokeStyle = 'rgba(40,30,20,.5)';
      ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
      badge('✚', r, '#5cf2a8');
    }
    if (s.type === 'gold') {
      ctx.strokeStyle = 'rgba(255,205,90,.95)';
      ctx.beginPath(); ctx.arc(0, 0, r + 2.5, 0, Math.PI * 2); ctx.stroke();
      badge('💰', r, '#ffd166');
    }
    if (s.type === 'mini') { ctx.strokeStyle = 'rgba(120,220,255,.8)'; ctx.beginPath(); ctx.arc(0, 0, r + 1, 0, Math.PI * 2); ctx.stroke(); }
    if (s.type === 'flyer') { badge('🛸', r, '#9fd6ff'); }
    if (s.type === 'blink') { badge('👻', r, '#cbb6ff'); }
    if (s.type === 'wave') { badge('🌊', r, '#8fd0ff'); }
    void t;
  }

  function badge(ch, r, col) {
    ctx.font = Math.max(9, r * 0.62).toFixed(0) + 'px serif';
    ctx.textAlign = 'center';
    ctx.fillText(ch, 0, -r - 7);
    ctx.font = '700 9px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.9;
    ctx.fillText('', 0, 0);
    ctx.globalAlpha = 1;
  }

  function drawBomb(s, r, t) {
    /* 炸雷靶刻意不画成纸靶：它是"绝对不许打"的东西，视觉上必须一眼可分 */
    var g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    g.addColorStop(0, '#4a5266');
    g.addColorStop(1, '#141822');
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(255,120,90,.85)';
    ctx.lineWidth = 2.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(0, 0, r + 4, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    /* 引信火花 */
    var fx = r * 0.45, fy = -r * 0.9;
    ctx.strokeStyle = '#8a6a4a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -r * 0.7); ctx.quadraticCurveTo(fx * 0.6, fy, fx, fy - 3); ctx.stroke();
    var pulse = 0.55 + 0.45 * Math.sin(t * 9);
    ctx.beginPath(); ctx.arc(fx, fy - 4, 3 + pulse * 2.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,' + (140 + pulse * 90 | 0) + ',80,' + (0.55 + pulse * 0.45).toFixed(2) + ')';
    ctx.fill();
    ctx.font = Math.max(11, r * 0.8).toFixed(0) + 'px serif';
    ctx.textAlign = 'center';
    ctx.fillText('💣', 0, 2);
  }

  function drawClock(r, t) {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f6efe0'; ctx.fill();
    ctx.strokeStyle = '#2c3242'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = '#2c3242';
    ctx.lineWidth = 1.6;
    for (var i = 0; i < 12; i++) {
      var a = i / 12 * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82);
      ctx.lineTo(Math.cos(a) * r * 0.94, Math.sin(a) * r * 0.94);
      ctx.stroke();
    }
    var a2 = (t * 1.6) % (Math.PI * 2);
    ctx.strokeStyle = '#e0564c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a2 - Math.PI / 2) * r * 0.7, Math.sin(a2 - Math.PI / 2) * r * 0.7);
    ctx.stroke();
    ctx.font = '700 10px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#5cf2a8';
    ctx.fillText('+' + D.TARGETS.clock.timeBonus + 's', 0, -r - 8);
  }

  /* 弹孔：世界坐标的小黑点，寿命到了自动清 */
  function drawHoles() {
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      var k = 1 - h.t / h.life;
      ctx.globalAlpha = 0.28 + k * 0.5;
      ctx.beginPath(); ctx.arc(h.x, h.y, 1.6 + k * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0d14'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.arc(h.x, h.y, 3.2, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawSparks() {
    for (var i = 0; i < sparks.length; i++) {
      var s = sparks[i];
      var k = 1 - s.t / s.life;
      ctx.globalAlpha = k * 0.95;
      ctx.fillStyle = s.col;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * k, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    /* 命中打叉（hit marker）：射击游戏的基本可读性 */
    if (hitMarkT > 0 && hitMark) {
      ctx.globalAlpha = Math.min(1, hitMarkT * 3.2);
      ctx.strokeStyle = hitMark.bad ? '#ff7a6e' : '#ffe9a8';
      ctx.lineWidth = 2.6;
      var rr = 9 + (1 - hitMarkT) * 8;
      for (var q = 0; q < 4; q++) {
        var a0 = Math.PI / 4 + q * Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(hitMark.x + Math.cos(a0) * rr * 0.45, hitMark.y + Math.sin(a0) * rr * 0.45);
        ctx.lineTo(hitMark.x + Math.cos(a0) * rr, hitMark.y + Math.sin(a0) * rr);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawFloaters() {
    ctx.textAlign = 'center';
    for (var i = 0; i < floaters.length; i++) {
      var f = floaters[i];
      var k = 1 - f.t / f.life;
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.font = '900 ' + f.size.toFixed(0) + 'px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(6,8,14,.75)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.col;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  /* 枪台 + 枪口 + 抛壳：给"开枪"一个身体感 */
  function drawBench(t) {
    var y = D.RANGE.benchY;
    var g = ctx.createLinearGradient(0, y - 10, 0, DH);
    g.addColorStop(0, 'rgba(255,255,255,.05)');
    g.addColorStop(0.18, '#0f1522');
    g.addColorStop(1, '#05070c');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 10, DW, DH - y + 10);
    ctx.strokeStyle = 'rgba(160,190,235,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y - 9); ctx.lineTo(DW, y - 9); ctx.stroke();

    /* 枪：跟着准星横向平移，后坐力用 recoil 衰减 */
    var gx = clamp(aim.x, 70, DW - 70);
    var gy = DH - 26 + recoil * 7;
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(clamp((aim.x - gx) / 900, -0.18, 0.18) - recoil * 0.09);
    var body = (world && world.gun.body) || '#5a6472';
    var accent = (world && world.gun.accent) || '#c8d2e0';
    ctx.fillStyle = body;
    roundRect(-46, -13, 92, 15, 4); ctx.fill();
    ctx.fillStyle = accent;
    roundRect(-14, -22, 26, 10, 3); ctx.fill();
    ctx.fillStyle = body;
    roundRect(28, -11, 34, 8, 3); ctx.fill();
    ctx.restore();

    /* 枪口闪光 */
    if (muzzleT > 0) {
      var mx = clamp(aim.x, 70, DW - 70), my = DH - 40 - recoil * 6;
      var rg = ctx.createRadialGradient(mx, my, 2, mx, my, 46 * muzzleT + 12);
      rg.addColorStop(0, 'rgba(255,244,196,' + (0.9 * muzzleT).toFixed(2) + ')');
      rg.addColorStop(0.4, 'rgba(255,170,70,' + (0.5 * muzzleT).toFixed(2) + ')');
      rg.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(mx, my, 52, 0, Math.PI * 2); ctx.fill();
    }
    /* 弹壳 */
    for (var i = 0; i < shells.length; i++) {
      var s = shells[i];
      ctx.save();
      ctx.translate(s.x, s.y); ctx.rotate(s.a);
      ctx.globalAlpha = Math.max(0, 1 - s.t / s.life);
      ctx.fillStyle = '#e0b566';
      roundRect(-3.5, -1.6, 7, 3.2, 1); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    void t;
  }

  /* 准星：内圈 = 弹着散布圆，外圈虚线 = 偏移上限。
     这是"看得懂散布"的关键 —— 看不见它的玩家永远学不会等准星回落。 */
  function drawCrosshair(t) {
    if (!world) { return; }
    var st = C.statsOf(world);
    var spread = st.bloomEff, core = Math.max(3, spread * 0.18);
    var cx = aim.x, cy = aim.y;
    var hot = st.steady;
    var col = hot ? '102,232,255' : (st.reloading ? '255,120,90' : '255,233,168');

    ctx.save();
    ctx.lineWidth = 1.4;
    /* 散布圈 */
    ctx.strokeStyle = 'rgba(' + col + ',.55)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(cx, cy, spread, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    /* 准星本体 */
    ctx.strokeStyle = 'rgba(' + col + ',.95)';
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(cx, cy, core + 4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    var gap = core + 8, len = 13;
    ctx.moveTo(cx - gap - len, cy); ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
    ctx.moveTo(cx, cy - gap - len); ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
    ctx.stroke();
    ctx.fillStyle = 'rgba(' + col + ',1)';
    ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, Math.PI * 2); ctx.fill();

    /* 屏息时给一圈瞄准镜式收束感 */
    if (hot) {
      ctx.strokeStyle = 'rgba(102,232,255,.28)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, 46, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 60, cy); ctx.lineTo(cx - 50, cy);
      ctx.moveTo(cx + 50, cy); ctx.lineTo(cx + 60, cy);
      ctx.moveTo(cx, cy - 60); ctx.lineTo(cx, cy - 50);
      ctx.moveTo(cx, cy + 50); ctx.lineTo(cx, cy + 60);
      ctx.stroke();
    }
    /* 换弹进度画在准星下沿：视线不用离开靶子 */
    if (st.reloading) {
      ctx.strokeStyle = 'rgba(255,120,90,.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * st.reloadFrac);
      ctx.stroke();
      ctx.font = '700 10px ui-monospace,Menlo,Consolas,monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,180,140,.95)';
      ctx.fillText('RELOAD', cx, cy + 40);
    }
    ctx.restore();
    void t;
  }

  /* 低时限红色暗角 + 狙击屏息暗角 */
  function drawVignette() {
    if (!world || (phase !== 'play' && phase !== 'countdown')) { return; }
    var st = C.statsOf(world);
    var urgent = st.timeLeft <= 10 ? (1 - st.timeLeft / 10) : 0;
    var steady = st.steady ? 0.5 : 0;
    if (urgent <= 0.02 && steady <= 0) { return; }
    var a = Math.max(urgent * (0.28 + 0.12 * Math.sin(world.t * 7)), 0);
    if (a > 0.01) {
      var rg = ctx.createRadialGradient(DW / 2, DH / 2, DH * 0.32, DW / 2, DH / 2, DH * 0.95);
      rg.addColorStop(0, 'rgba(255,60,60,0)');
      rg.addColorStop(1, 'rgba(255,50,50,' + a.toFixed(3) + ')');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, DW, DH);
    }
    if (steady > 0) {
      var rg2 = ctx.createRadialGradient(aim.x, aim.y, 60, aim.x, aim.y, DH * 0.85);
      rg2.addColorStop(0, 'rgba(0,0,0,0)');
      rg2.addColorStop(1, 'rgba(0,0,0,.42)');
      ctx.fillStyle = rg2; ctx.fillRect(0, 0, DW, DH);
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* SECTION: 粒子/飘字寿命推进 */
  function stepFx(dt) {
    var i;
    for (i = floaters.length - 1; i >= 0; i--) {
      var f = floaters[i]; f.t += dt; f.y += f.vy * dt; f.vy *= 0.985;
      if (f.t >= f.life) { floaters.splice(i, 1); }
    }
    for (i = sparks.length - 1; i >= 0; i--) {
      var s = sparks[i]; s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 340 * dt;
      if (s.t >= s.life) { sparks.splice(i, 1); }
    }
    for (i = holes.length - 1; i >= 0; i--) {
      holes[i].t += dt; if (holes[i].t >= holes[i].life) { holes.splice(i, 1); }
    }
    for (i = shells.length - 1; i >= 0; i--) {
      var b = shells[i]; b.t += dt; b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 620 * dt; b.a += b.va * dt;
      if (b.t >= b.life) { shells.splice(i, 1); }
    }
    if (shakeT > 0) { shakeT = Math.max(0, shakeT - dt * 2.4); }
    if (flashT > 0) { flashT = Math.max(0, flashT - dt * 3.1); }
    if (hitMarkT > 0) { hitMarkT = Math.max(0, hitMarkT - dt * 3.4); }
    if (muzzleT > 0) { muzzleT = Math.max(0, muzzleT - dt * 11); }
    recoil = Math.max(0, recoil - dt * 6.5);
  }

  function addFloater(x, y, text, col, size) {
    floaters.push({ x: x, y: y, text: text, col: col || '#ffe9a8', size: size || 15, t: 0, life: 0.95, vy: -46 });
  }
  function addSparks(x, y, n, col, power) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * (power || 190);
      sparks.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        r: 1.6 + Math.random() * 2.6, col: col, t: 0, life: 0.32 + Math.random() * 0.4 });
    }
  }

  /* ============================================================
     SECTION: 事件消化
     core 只返回事件对象；音效、震屏、粒子、飘字全在这里。
     ============================================================ */
  function handleEvents(evs) {
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      switch (e.kind) {
        case 'shot':
          D.Audio.shot(e.gun);
          muzzleT = 1; recoil = Math.min(1.6, recoil + 0.55);
          shakeT = Math.max(shakeT, 0.16);
          holes.push({ x: e.ax, y: e.ay, t: 0, life: 3.2 });
          if (holes.length > 90) { holes.shift(); }
          shells.push({ x: DW / 2 + 26, y: DH - 34, vx: 90 + Math.random() * 70, vy: -220 - Math.random() * 60,
            a: 0, va: 9 + Math.random() * 7, t: 0, life: 1.1 });
          break;
        case 'dry':
          D.Audio.dry();
          addFloater(aim.x, aim.y + 34, '空仓！按 R', '#ff9c8f', 13);
          break;
        case 'reload':
          D.Audio.reload();
          break;
        case 'reloaded':
          D.Audio.reloadDone();
          break;
        case 'hit':
          onHit(e);
          break;
        case 'miss':
          D.Audio.miss();
          addFloater(e.x, e.y - 16, '脱靶', '#9fb0cc', 13);
          break;
        case 'streakbreak':
          if (e.why !== 'bomb') { addFloater(aim.x, aim.y - 34, '连击断', '#ff9c8f', 13); }
          break;
        case 'combo':
          D.Audio.combo(e.mult);
          addFloater(DW / 2, DH * 0.30, '×' + e.mult + ' 连击', '#ffd166', 22);
          flashColor = '255,214,120'; flashT = Math.max(flashT, 0.14);
          break;
        case 'bomb':
          onBomb(e);
          break;
        case 'expire':
          if (!e.bad) {
            addFloater(e.x, e.y, '漏靶', 'rgba(180,196,224,.85)', 12);
            D.Audio.drop();
          }
          break;
        case 'breathout':
          addFloater(aim.x, aim.y + 40, '喘气！', '#9fd6ff', 13);
          break;
        case 'clear':
        case 'over':
          onSettle(e.result);
          break;
        default: break;
      }
    }
  }

  function onHit(e) {
    D.Audio.hit(e.pts);
    if (e.bull) { D.Audio.bull(); }
    hitMark = { x: e.tx, y: e.ty, bad: false }; hitMarkT = 1;
    addSparks(e.x, e.y, e.bull ? 16 : 9, e.bull ? '#fff0b8' : '#ffd9a0', e.bull ? 250 : 170);
    holes.push({ x: e.x, y: e.y, t: 0, life: 3.4 });
    if (holes.length > 90) { holes.shift(); }
    var txt = '+' + e.gain;
    addFloater(e.tx, e.ty - 12, txt, e.bull ? '#fff2b0' : '#ffe0a8', e.bull ? 21 : 16);
    addFloater(e.tx, e.ty + 12, e.bull ? '内十！' : e.ring, e.bull ? '#ffd166' : 'rgba(230,240,255,.85)', e.bull ? 15 : 12);
    if (e.coins) {
      D.Audio.gold();
      addFloater(e.tx + 26, e.ty - 30, '💰+' + e.coins, '#ffd166', 15);
    }
    if (e.timeBonus) {
      D.Audio.clock();
      addFloater(e.tx, e.ty - 34, '+' + e.timeBonus + ' 秒', '#5cf2a8', 16);
    }
    flashColor = e.bull ? '255,236,170' : '255,255,255';
    flashT = Math.max(flashT, e.bull ? 0.3 : 0.1);
    shakeT = Math.max(shakeT, e.bull ? 0.34 : 0.16);
  }

  function onBomb(e) {
    D.Audio.bomb();
    hitMark = { x: e.tx, y: e.ty, bad: true }; hitMarkT = 1;
    addSparks(e.tx, e.ty, 30, '#ffb056', 330);
    addFloater(e.tx, e.ty - 14, '💥 -' + e.loss, '#ff8b7a', 22);
    addFloater(e.tx, e.ty + 16, '-' + e.time + ' 秒', '#ff6f61', 15);
    flashColor = '255,150,70'; flashT = 0.85;
    shakeT = 1;
    toast('打中炸雷靶了 —— 雷要放着让它自己飘走');
  }

  /* ============================================================
     SECTION: HUD
     ============================================================ */
  function updateHud() {
    var g = D.gunById(gunId);
    /* 枪名/枪型先按"当前选中的枪"写：没开局时也要跟着军械库的选择走，
       否则玩家换完枪，顶栏还写着上一把（冒烟实测到过）。 */
    setTxt('shGunName', g.name);
    setTxt('shGunEn', g.en);
    setTxt('shGunArt', g.art);
    if (!world) {
      setTxt('shBest', fmt(best));
      setTxt('shDowns', '0 / ' + C.needOf(D.levelConfig(selectedLevel()), C.gunParams(D, gunId)));
      renderAmmo({ mag: g.mag, ammo: g.mag });
      setWidth('shReloadFill', 0);
      setTxt('shReloadTxt', '就绪');
      setWidth('shBreathFill', 100);
      setTxt('shBreathTxt', '满');
      return;
    }
    var st = C.statsOf(world);
    setTxt('shScore', fmt(st.score));
    setTxt('shDowns', st.downs + ' / ' + st.need);
    setTxt('shBest', fmt(best));
    setTxt('shTime', Math.ceil(st.timeLeft) + 's');
    setTxt('shAcc', st.stats.fired ? Math.round(st.stats.accuracy * 100) + '%' : '—');
    setTxt('shCombo', '×' + st.mult + (st.streak ? ' ·' + st.streak : ''));
    setTxt('shLevelName', st.level + ' · ' + st.name);
    setTxt('shProgTxt', st.downs + '/' + st.need);
    if (el.shCombo) { el.shCombo.parentNode.classList.toggle('hot', st.mult >= 2); }
    if (el.shTime) { el.shTime.parentNode.classList.toggle('urgent', st.timeLeft <= 10); }
    setWidth('shProgFill', st.progress * 100);
    setWidth('shReloadFill', st.reloading ? st.reloadFrac * 100 : 0);
    setTxt('shReloadTxt', st.reloading ? st.reloadLeft.toFixed(1) + 's' : (st.ammo === 0 ? '空仓' : '就绪'));
    setWidth('shBreathFill', (st.breath / st.breathMax) * 100);
    setTxt('shBreathTxt', st.steady ? '屏息中' : (st.breath >= st.breathMax - 0.01 ? '满' : '恢复'));
    if (el.shBreathTrack) { el.shBreathTrack.classList.toggle('low', st.breath < st.breathMax * 0.3); }
    renderAmmo(st);
    renderDots(st);
  }

  /* 弹药点：直接画出一匣子弹，比"9/12"这种数字更快读得懂 */
  function renderAmmo(st) {
    if (!el.shAmmoPips) { return; }
    var html = '';
    for (var i = 0; i < st.mag; i++) {
      var cls = 'sh-pip' + (i < st.ammo ? '' : ' spent') + (st.ammo === 1 && i === 0 ? ' last' : '');
      html += '<i class="' + cls + '"></i>';
    }
    if (el.shAmmoPips.innerHTML !== html) { el.shAmmoPips.innerHTML = html; }
  }

  /* 关口点：1~10 是设计关，无尽用一颗琥珀色"∞"点收尾 */
  function renderDots(st) {
    if (!el.shDots) { return; }
    var total = D.LEVELS.length, html = '';
    for (var i = 1; i <= total; i++) {
      var cls = 'sh-dot' + (i < st.level ? ' done' : (i === st.level ? ' now' : ''));
      html += '<i class="' + cls + '" title="第 ' + i + ' 关"></i>';
    }
    if (st.endless) { html += '<i class="sh-dot now" title="无尽模式"></i>'; }
    if (el.shDots.innerHTML !== html) { el.shDots.innerHTML = html; }
  }

  function setTxt(id, txt) { var n = el[id]; if (n && n.textContent !== String(txt)) { n.textContent = txt; } }
  function setWidth(id, pct) {
    var n = el[id];
    if (n) { n.style.width = clamp(pct, 0, 100).toFixed(1) + '%'; }
  }
  function toast(msg) {
    if (!el.shToast) { return; }
    el.shToast.textContent = msg;
    el.shToast.classList.add('show');
    if (toastTimer) { window.clearTimeout(toastTimer); }
    toastTimer = window.setTimeout(function () { el.shToast.classList.remove('show'); }, 2200);
  }

  /* ============================================================
     SECTION: 覆盖层
     开始/暂停/结算三块都是 fixed 覆盖层（README 坑 2/6）。
     ============================================================ */
  function showOv(node) {
    var all = [el.shOvStart, el.shOvPause, el.shOvOver];
    for (var i = 0; i < all.length; i++) { if (all[i]) { all[i].classList.remove('show'); } }
    if (node) { node.classList.add('show'); }
    if (el.shStage) { el.shStage.classList.toggle('idle', !!node); }
  }

  /* SECTION: 军械库
     四态：sel 使用中 / own 已拥有 / buy 钱够 / lock 钱不够。
     pace 折算的是"过关要求"，mult 折算的是"分数" —— 面板上两条都要给，
     否则玩家只能看到"倍率低"，看不到"要求的靶数也少"。 */
  function renderArmory() {
    if (!el.shArmory) { return; }
    var html = '';
    for (var i = 0; i < D.GUNS.length; i++) {
      var g = D.GUNS[i];
      var own = owned.indexOf(g.id) >= 0;
      var sel = gunId === g.id;
      var cls = 'sh-gun-btn' + (sel ? ' sel' : '') + (!own ? (coins >= g.price ? ' buy' : ' lock') : '');
      var sub = sel ? '使用中' : (own ? '×' + g.mult.toFixed(2) + ' 分' : (coins >= g.price ? '💰 ' + g.price : '🔒 ' + g.price));
      html += '<button type="button" class="' + cls + '" data-gun="' + g.id + '" aria-label="' + g.name + '">'
        + '<span class="a">' + g.art + '</span>'
        + '<span class="n">' + g.name + '</span>'
        + '<span class="s">' + sub + '</span>'
        + '<span class="s">' + g.mag + '发 · ' + g.rps.toFixed(1) + '/s</span>'
        + '</button>';
    }
    el.shArmory.innerHTML = html;
    setTxt('shCoinsTop', '💰 ' + fmt(coins));
    setTxt('shStartCoins', fmt(coins));
  }

  function armoryClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.sh-gun-btn') : null;
    if (!btn) { return; }
    var id = btn.getAttribute('data-gun');
    var g = D.gunById(id);
    if (!g || g.id !== id) { return; }
    if (owned.indexOf(id) >= 0) {
      if (gunId === id) { return; }
      gunId = id;
      setArmoryMsg(g.art + ' ' + g.name + ' 已上膛 —— ' + g.desc);
    } else if (coins >= g.price) {
      coins -= g.price;
      owned.push(id);
      gunId = id;
      setArmoryMsg('🎉 解锁 ' + g.art + ' ' + g.name + '！' + g.desc);
      D.Audio.gold();
    } else {
      setArmoryMsg('还差 💰 ' + (g.price - coins) + ' 解锁 ' + g.name + '（金靶给金币，跨局累计）');
      D.Audio.dry();
    }
    saveArmory();
    renderArmory();
    renderChoosers();
    updateHud();
  }
  function setArmoryMsg(t) { if (el.shArmoryMsg) { el.shArmoryMsg.textContent = t; } }

  /* SECTION: 关口选择器
     深链 ?level= 与面板上的芯片都走这里；超出已解锁关卡的会被夹回来。 */
  function selectedLevel() { return clamp(desiredLevel, 1, Math.max(1, bestLevel)); }

  function renderChoosers() {
    var cur = selectedLevel();
    var hosts = [el.shChooserStart, el.shChooserOver];
    for (var h = 0; h < hosts.length; h++) {
      var host = hosts[h];
      if (!host) { continue; }
      var g = D.gunById(gunId);
      var html = '<span class="lab">关口</span>';
      for (var i = 1; i <= D.LEVELS.length; i++) {
        var lock = i > bestLevel;
        html += '<button type="button" class="sh-chip' + (i === cur ? ' sel' : '') + (lock ? ' lock' : '')
          + '" data-shlevel="' + i + '"' + (lock ? ' disabled' : '') + '>' + i + '·' + D.LEVELS[i - 1].name + '</button>';
      }
      if (bestLevel > D.LEVELS.length) {
        html += '<button type="button" class="sh-chip' + (cur > D.LEVELS.length ? ' sel' : '') + '" data-shlevel="'
          + bestLevel + '">无尽</button>';
      }
      html += '<span class="lab" style="margin-left:8px">要求</span><b class="sh-chip" style="cursor:default">'
        + C.needOf(D.levelConfig(cur), C.gunParams(D, gunId)) + ' 靶 · ' + D.levelConfig(cur).time + 's ×' + g.mult.toFixed(2) + '</b>';
      host.innerHTML = html;
    }
    setTxt('shStartLevel', bestLevel > D.LEVELS.length ? '无尽第 ' + (bestLevel - D.LEVELS.length) + ' 轮' : bestLevel + ' 关');
    setTxt('shStartBest', fmt(best));
  }

  function chooserClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-shlevel]') : null;
    if (!btn || btn.hasAttribute('disabled')) { return; }
    var lv = parseInt(btn.getAttribute('data-shlevel'), 10);
    if (!lv) { return; }
    desiredLevel = clamp(lv, 1, Math.max(1, bestLevel));
    renderChoosers();
    if (phase === 'start' || phase === 'over' || phase === 'clear') {
      /* 面板上换关就直接开一局新的，避免"看着选了、进去还是老的" */
      newRun(selectedLevel());
    }
  }

  /* ============================================================
     SECTION: 生命周期
     ============================================================ */
  var COUNT_SECS = ['3', '2', '1', '开火'];

  function newRun(level) {
    var lv = clamp(level || 1, 1, 999);
    world = new C.World(D, lv, { rng: Math.random, gunId: gunId });
    floaters = []; sparks = []; holes = []; shells = [];
    shakeT = 0; flashT = 0; recoil = 0; muzzleT = 0; hitMarkT = 0; hitMark = null;
    lowTimeBeep = -1;
    phase = 'countdown';
    showOv(null);
    updateHud();
    /* 开局倒计时：给玩家把准星挪到靶道上的时间（core 里靶子有进场延迟，正好对上） */
    var idx = 0;
    if (countTimer) { window.clearTimeout(countTimer); countTimer = null; }
    setCountdown(COUNT_SECS[0]);
    var tick = function () {
      if (!active || phase !== 'countdown') { return; }
      idx++;
      if (idx < COUNT_SECS.length) {
        setCountdown(COUNT_SECS[idx]);
        D.Audio.countdown(idx === COUNT_SECS.length - 1);
        countTimer = window.setTimeout(tick, 460);
      } else {
        setCountdown(null);
        phase = 'play';
        D.Audio.resume();
      }
    };
    D.Audio.countdown(false);
    countTimer = window.setTimeout(tick, 460);
  }

  function setCountdown(txt) {
    if (!el.shCountdown) { return; }
    if (!txt) { el.shCountdown.classList.remove('show', 'go'); return; }
    el.shCountdown.textContent = txt;
    el.shCountdown.classList.toggle('go', txt === '开火');
    el.shCountdown.classList.add('show');
  }

  function pause() {
    if (phase !== 'play' && phase !== 'countdown') { return; }
    phase = 'pause';
    firing = false;
    C.setSteady(world, false);
    if (el.shPauseLive) { el.shPauseLive.textContent = world.targets.length; }
    showOv(el.shOvPause);
  }
  function resume() {
    if (phase !== 'pause') { return; }
    phase = 'play';
    showOv(null);
  }

  /* 结算：过关/失败都走 core 的同一份 result */
  function onSettle(res) {
    if (!res) { return; }
    phase = res.kind;
    firing = false;
    var st = C.statsOf(world);
    /* 最高分要记"结算后的总分"（含通关奖励与评级系数）—— 早先记的是未加成的裸分，
       于是结算面板写着 1773、门户与顶栏的最高分却写着 22，同一局两个成绩。 */
    var finalScore = Math.round(res.score);
    var isRecord = finalScore > best;
    if (isRecord) { best = finalScore; writeStore(K_BEST, best); }
    if (st.downs >= st.need && res.level >= bestLevel) {
      bestLevel = res.level + 1;
      writeStore(K_LEVEL, bestLevel);
      totalClears++; writeStore(K_CLEARS, totalClears);
    }
    if (st.maxStreak > maxStreakAll) { maxStreakAll = st.maxStreak; writeStore(K_MAXSTREAK, maxStreakAll); }
    coins += res.coins;
    saveArmory();

    setTxt('shRArt', res.kind === 'clear' ? '🏁' : (res.quit ? '🏳️' : '💨'));
    setTxt('shRTitle', res.kind === 'clear' ? '过关！' : (res.quit ? '已收工' : '时间到'));
    setTxt('shREn', res.kind === 'clear' ? 'LEVEL ' + res.level + ' CLEAR' : (res.quit ? 'CEASE FIRE' : 'TIME UP'));
    setTxt('shRGrade', res.grade);
    setTxt('shRScore', fmt(res.score));
    setTxt('shRBest', fmt(best));
    setTxt('shRLevel', res.level + (res.level > D.LEVELS.length ? ' 无尽' : ''));
    setTxt('shRDowns', res.downs + '/' + res.need);
    setTxt('shRAcc', Math.round(res.accuracy * 100) + '%');
    setTxt('shRBulls', res.bulls);
    setTxt('shRStreak', res.maxStreak);
    setTxt('shRBombs', res.bombs);
    setTxt('shRExpired', st.stats.expired);
    setTxt('shRFired', res.fired);
    setTxt('shRClear', fmt(res.clearBonus + res.timeBonus));
    setTxt('shRTime', Math.floor(res.timeLeft) + 's');
    setTxt('shRCoins', fmt(res.coins));
    setTxt('shRCoinsTotal', fmt(coins));
    if (el.shRRecord) { el.shRRecord.classList.toggle('show', isRecord); }
    if (el.shRWhy) {
      el.shRWhy.className = 'sh-why ' + (res.kind === 'clear' ? 'good' : 'bad');
      el.shRWhy.textContent = whyText(res, st);
    }
    if (el.shRTip) { el.shRTip.textContent = '提示：' + D.TIPS[(res.level + res.bombs) % D.TIPS.length]; }
    if (el.shBtnNext) {
      el.shBtnNext.textContent = res.kind === 'clear'
        ? ('进入第 ' + (res.level + 1) + ' 关' + (res.level + 1 > D.LEVELS.length ? '（无尽）' : '') + ' →')
        : '再打一次本关';
    }
    renderArmory();
    renderChoosers();
    if (res.kind === 'clear') { D.Audio.levelup(); } else { D.Audio.over(); }
    window.setTimeout(function () { showOv(el.shOvOver); }, res.kind === 'clear' ? 420 : 620);
  }

  /* 结算说明：把"为什么过/为什么没过"讲清楚，而不是只甩一个分数 */
  function whyText(res, st) {
    var bits = [];
    if (res.kind === 'clear') {
      bits.push('击落 ' + res.downs + '/' + res.need + ' 靶，剩 ' + Math.floor(res.timeLeft) + ' 秒 —— 时间折分 +' + fmt(res.timeBonus));
      bits.push('评级 ' + res.grade + '（命中率 ' + Math.round(res.accuracy * 100) + '%，×' + res.gradeBonus.toFixed(2) + ' 总分）');
      if (res.bombs) { bits.push('误炸 ' + res.bombs + ' 次：每次 -' + D.SCORE.BOMB_PTS + ' 分 -' + D.SCORE.BOMB_TIME + ' 秒'); }
      bits.push('内十 ' + res.bulls + ' 发，最高连击 ×' + C.multFor(D, res.maxStreak) + '（' + res.maxStreak + ' 连段）');
    } else {
      bits.push((res.quit ? '提前收工：' : '时间用尽：')
        + '只击落 ' + res.downs + '/' + res.need + ' 靶'
        + (st.stats.expired ? '，漏掉 ' + st.stats.expired + ' 个靶' : ''));
      if (res.bombs) { bits.push('误炸雷靶 ' + res.bombs + ' 次，一共赔掉 ' + fmt(res.bombs * D.SCORE.BOMB_PTS) + ' 分和 ' + (res.bombs * D.SCORE.BOMB_TIME).toFixed(1) + ' 秒'); }
      bits.push('漏靶会同时挤掉后面的靶位 —— 打不着的靶要尽快清，别让它占场');
    }
    return bits.join('　·　');
  }

  /* ============================================================
     SECTION: 主循环
     ============================================================ */
  function loop(now) {
    raf = window.requestAnimationFrame(loop);
    if (!lastT) { lastT = now; }
    var dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (!world) { draw(now / 1000); return; }

    if (phase === 'play') {
      /* 按住扳机 = 每帧都"扣一次"，排队机制会把它夹成稳定的 rps */
      if (firing) { C.fire(world, aim.x, aim.y); }
      var evs = C.step(world, dt);
      handleEvents(evs);
      /* 读秒提示：最后 10 秒每秒一响 */
      var whole = Math.ceil(world.timeLeft);
      if (whole <= 10 && whole !== lowTimeBeep && whole > 0) {
        lowTimeBeep = whole;
        D.Audio.countdown(whole <= 3);
      }
      updateHud();
    }
    stepFx(dt);
    draw(now / 1000);
  }

  /* ============================================================
     SECTION: 输入
     pointer → 设计坐标；左键开枪（可按住）、右键屏息、R 换弹、P/Esc 暂停。
     ============================================================ */
  function toDesign(clientX, clientY) {
    var r = cv.getBoundingClientRect();
    if (!r.width || !r.height) { return { x: aim.x, y: aim.y }; }
    return { x: clamp((clientX - r.left) / r.width * DW, 0, DW),
      y: clamp((clientY - r.top) / r.height * DH, 0, DH) };
  }
  function canShoot() { return !!world && phase === 'play'; }

  function bindInput() {
    if (!cv) { return; }
    cv.addEventListener('pointermove', function (e) {
      var p = toDesign(e.clientX, e.clientY);
      aim.x = p.x; aim.y = p.y; needAim = false;
    });
    cv.addEventListener('pointerdown', function (e) {
      var p = toDesign(e.clientX, e.clientY);
      aim.x = p.x; aim.y = p.y;
      if (e.button === 2) { C.setSteady(world, true); return; }
      if (!canShoot()) { return; }
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      firing = true;
      D.Audio.resume();
      C.fire(world, aim.x, aim.y);
      e.preventDefault();
    });
    var stop = function (e) {
      if (e.button === 2) { C.setSteady(world, false); return; }
      firing = false;
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', function () { firing = false; C.setSteady(world, false); });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    /* 手指移出画布外抬起时 pointerup 不一定落在 canvas 上 */
    window.addEventListener('pointerup', function () { firing = false; });

    document.addEventListener('keydown', keydown);
    document.addEventListener('keyup', keyup);

    if (el.shBtnStart) { el.shBtnStart.addEventListener('click', function () { D.Audio.resume(); newRun(selectedLevel()); }); }
    if (el.shBtnResume) { el.shBtnResume.addEventListener('click', resume); }
    if (el.shBtnQuit) { el.shBtnQuit.addEventListener('click', function () { quitToResult(); }); }
    if (el.shBtnRetry) { el.shBtnRetry.addEventListener('click', function () { newRun(selectedLevel()); }); }
    if (el.shBtnNext) {
      el.shBtnNext.addEventListener('click', function () {
        var lv = (phase === 'clear' ? (world.level + 1) : world.level);
        desiredLevel = clamp(lv, 1, 999);
        newRun(desiredLevel);
      });
    }
    if (el.shBtnSound) { el.shBtnSound.addEventListener('click', toggleSound); }
    if (el.shArmory) { el.shArmory.addEventListener('click', armoryClick); }
    if (el.shChooserStart) { el.shChooserStart.addEventListener('click', chooserClick); }
    if (el.shChooserOver) { el.shChooserOver.addEventListener('click', chooserClick); }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && phase === 'play') { pause(); }
    });
  }

  function quitToResult() {
    if (!world) { return; }
    if (phase === 'play' || phase === 'pause' || phase === 'countdown') {
      /* 中途收工也走 core 的结算公式，避免另写一份"半截分数" */
      C.finish(world, world.downs >= world.need ? 'clear' : 'over', []);
      var res = world.result;
      res.quit = true;              // 结算文案要区分"时间用尽"与"自己提前收工"
      phase = res.kind;
      showOv(null);
      onSettle(res);
    }
  }

  function keydown(e) {
    var k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (phase === 'play' || phase === 'countdown') { pause(); }
      else if (phase === 'pause') { resume(); }
      else if (window.APP_ROUTER) { window.APP_ROUTER.go('portal'); }
      return;
    }
    if (k === 'm' || k === 'M') { toggleSound(); return; }
    if (k === 'p' || k === 'P') { if (phase === 'play') { pause(); } else if (phase === 'pause') { resume(); } return; }
    if (k === 'r' || k === 'R') {
      if (canShoot()) { var evs = C.reload(world); handleEvents(evs); }
      return;
    }
    if (k === 'Shift') { if (canShoot()) { C.setSteady(world, true); } return; }
    if (k === ' ' || k === 'Enter') {
      if (phase === 'start' || phase === 'over') {
        if (phase === 'start') { D.Audio.resume(); newRun(selectedLevel()); }
        else if (el.shBtnRetry) { el.shBtnRetry.click(); }
        e.preventDefault();
        return;
      }
      if (canShoot()) {
        if (needAim) { aim.x = DW / 2; aim.y = DH * 0.55; needAim = false; }
        C.fire(world, aim.x, aim.y);
        e.preventDefault();
      }
      return;
    }
    /* 键盘微调准星：没有鼠标也能玩（无障碍与笔记本触控板场景） */
    var step = e.shiftKey ? 26 : 9;
    if (k === 'ArrowLeft') { aim.x = clamp(aim.x - step, 0, DW); e.preventDefault(); }
    if (k === 'ArrowRight') { aim.x = clamp(aim.x + step, 0, DW); e.preventDefault(); }
    if (k === 'ArrowUp') { aim.y = clamp(aim.y - step, 0, DH); e.preventDefault(); }
    if (k === 'ArrowDown') { aim.y = clamp(aim.y + step, 0, DH); e.preventDefault(); }
    if (k >= '1' && k <= '6') {
      var g = D.GUNS[parseInt(k, 10) - 1];
      if (g && owned.indexOf(g.id) >= 0 && g.id !== gunId) {
        gunId = g.id; saveArmory(); renderArmory(); renderChoosers();
        setArmoryMsg(g.art + ' ' + g.name + ' 已上膛 —— ' + g.desc);
        if (phase === 'play' || phase === 'countdown') { newRun(world.level); }
      } else if (g) {
        setArmoryMsg(g.art + ' ' + g.name + ' 还没解锁（💰 ' + g.price + '）—— 打金靶攒金币');
      }
    }
  }
  function keyup(e) { if (e.key === 'Shift') { C.setSteady(world, false); } }

  function toggleSound() {
    soundOn = !soundOn;
    D.Audio.enabled = soundOn;
    if (el.shBtnSound) {
      el.shBtnSound.textContent = soundOn ? '🔊' : '🔇';
      el.shBtnSound.classList.toggle('off', !soundOn);
    }
  }

  /* SECTION: 深链  /shooter/?level=4&gun=sniper */
  function applyDeepLink() {
    var q = window.location.search || '';
    var m = q.match(/[?&]level=(\d+)/);
    if (m) { desiredLevel = clamp(parseInt(m[1], 10) || 1, 1, Math.max(1, bestLevel)); }
    var g = q.match(/[?&]gun=([a-z]+)/);
    if (g && owned.indexOf(g[1]) >= 0) { gunId = g[1]; }
  }

  /* ============================================================
     SECTION: 对外接口（与其它游戏统一的应用契约）
     ============================================================ */
  function mount(root) {
    if (mounted) { return; }
    bindDom();
    loadArmory();
    applyDeepLink();
    setupCanvas();
    bindInput();
    renderArmory();
    renderChoosers();
    phase = 'start';
    active = false;
    mounted = true;
    if (el.shBest) { el.shBest.textContent = fmt(best); }
    if (el.shBtnSound) { el.shBtnSound.textContent = soundOn ? '🔊' : '🔇'; }
    draw(0);
    void root;
  }

  function activate() {
    active = true;
    lastT = 0;
    if (el.shBtnSound) { el.shBtnSound.textContent = soundOn ? '🔊' : '🔇'; }
    if (!raf) { raf = window.requestAnimationFrame(loop); }
  }

  function deactivate() {
    active = false;
    firing = false;
    if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
    if (countTimer) { window.clearTimeout(countTimer); countTimer = null; }
  }

  function resize() {
    /* backing store 固定，CSS 负责缩放 —— 重绘一次就够 */
    if (active) { draw(lastT / 1000); }
  }

  function stats() {
    /* phase = 界面阶段；合并进来的 runPhase/ammo/... 是这一局的状态（core 的只读快照）。
       两个 "phase" 重名会把界面态盖掉，所以 core 那边改叫 runPhase。 */
    var st = {
      phase: phase, best: best, bestLevel: bestLevel, coins: coins,
      gunId: gunId, owned: owned.slice(), allStreak: maxStreakAll, clears: totalClears
    };
    if (world) {
      var w = C.statsOf(world);
      for (var k in w) { if (Object.prototype.hasOwnProperty.call(w, k)) { st[k] = w[k]; } }
    }
    return st;
  }

  return {
    mount: mount, activate: activate, deactivate: deactivate,
    resize: resize, stats: stats,
    /* 给自动化冒烟用：不等倒计时直接起一局，并可以把准星"钉"在某个靶上开枪 */
    _debugStart: function (level, gun) {
      loadArmory();
      if (gun && (owned.indexOf(gun) >= 0 || gun === gunId)) { gunId = gun; }
      newRun(level || selectedLevel());
      D.Audio.enabled = false;
      if (countTimer) { window.clearTimeout(countTimer); countTimer = null; }
      setCountdown(null);
      phase = 'play';
      return stats();
    },
    _world: function () { return world; },
    /* 在指定点扣一扳机（冒烟脚本靠它精确命中某个靶，而不是猜鼠标位置） */
    _debugFire: function (x, y) {
      if (!world) { return []; }
      var evs = C.fire(world, x, y);
      D.Audio.enabled = false;
      handleEvents(evs);
      updateHud();
      return evs;
    },
    _debugAim: function (x, y) { aim.x = x; aim.y = y; needAim = false; return { x: x, y: y }; },
    _debugTargets: function () { return world ? C.liveTargets(world) : []; }
  };
})();
