/* ============================================================
   开车不要压井盖儿 · 渲染与交互主控
   SECTION: manhole-main
   ------------------------------------------------------------
   分层：manhole-data.js（调参表 + 音效）
         manhole-core.js（纯逻辑，无 DOM，可被 node 直接跑断言）
         本文件（Canvas 绘制 + 输入 + 存档 + 覆盖层）
   本文件不参与任何判定 —— 判定全在 core 里，这里只是"把 core 的状态画出来"。
   ============================================================ */
window.MANHOLE_APP = (function () {
  'use strict';

  var D = window.MANHOLE_DATA;
  var C = window.MANHOLE_CORE;

  /* SECTION: 设计分辨率
     Canvas 的 backing store 固定按设计尺寸 × dpr 申请，
     游戏内坐标恒等于设计坐标（core 里的 900×640），
     所以绘制代码不需要任何缩放换算 —— 只在外层用 CSS 拉伸适配容器。 */
  var DW = D.LAYOUT.W, DH = D.LAYOUT.H;

  /* SECTION: state */
  var world = null;
  var active = false;
  var mounted = false;
  var raf = 0;
  var lastT = 0;
  var cv = null, ctx = null, dpr = 1;

  var el = {};                    // DOM 引用
  var soundOn = true;
  var paused = false;             // 切走标签页时暂停
  var phase = 'start';            // start | play | crash | win | over
  var shakeT = 0;                 // 撞击震屏剩余时间
  var flashT = 0;                 // 撞击白闪
  var floaters = [];              // 飘字（+50、近失奖励…）
  var crushMarks = [];            // 压碎的井盖碎片动画
  var engineTimer = null;

  var crashInfo = null;           // 本次撞击的现场（结算面板展示）
  var best = 0, bestLevel = 1;

  /* 存档：最高分与最远关卡（分模块与该项目其他游戏一致的 key 风格） */
  var K_BEST = 'manhole-best', K_LEVEL = 'manhole-level';

  function readStore(key, def) {
    try {
      var v = parseInt(window.localStorage.getItem(key) || '', 10);
      return isNaN(v) ? def : v;
    } catch (e) { return def; }
  }
  function writeStore(key, val) {
    try { window.localStorage.setItem(key, String(val)); } catch (e) { /* 隐私模式忽略 */ }
  }

  /* SECTION: DOM */
  function $(id) { return document.getElementById(id); }

  function bindDom() {
    el.root = $('viewManhole');
    el.canvas = $('mhCanvas');
    el.score = $('mhScore');
    el.level = $('mhLevel');
    el.combo = $('mhCombo');
    el.best = $('mhBest');
    el.speed = $('mhSpeed');
    el.bar = $('mhProgress');
    el.left = $('mhLeft');
    el.lives = $('mhLives');
    el.ovStart = $('mhOvStart');
    el.ovLevel = $('mhOvLevel');
    el.ovOver = $('mhOvOver');
    el.rLevel = $('mhRLevel');
    el.rScore = $('mhRScore');
    el.rMeters = $('mhRMeters');
    el.rBest = $('mhRBest');
    el.rRecord = $('mhRRecord');
    el.rTitle = $('mhROverTitle');
    el.rArt = $('mhROverArt');
    el.rTip = $('mhRTip');
    el.btnSound = $('mhBtnSound');
    el.lvName = $('mhLvName');
    el.countdown = $('mhCountdown');
    el.crashWhy = $('mhCrashWhy');
  }

  /* SECTION: 画布尺寸
     只用 CSS 决定显示尺寸（等比缩放），backing store 按设计尺寸 × dpr 固定 ——
     这样无论窗口怎么变，游戏内的几何都是常量，判定与画面永远一致。 */
  function setupCanvas() {
    if (!el.canvas) { return; }
    cv = el.canvas;
    ctx = cv.getContext('2d');
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(DW * dpr);
    cv.height = Math.round(DH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ============================================================
     SECTION: 绘制
     夜景公路 + 车道线 + 井盖 + 拾取物 + 车（带车轮）。
     所有绘制坐标都直接用设计坐标，ctx 已按 dpr 缩放。
     ============================================================ */
  function draw(t) {
    if (!ctx) { return; }
    ctx.save();
    /* 震屏：撞击瞬间给整帧一个随机平移 */
    if (shakeT > 0) {
      var s = shakeT * 26;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    ctx.clearRect(-40, -40, DW + 80, DH + 80);
    drawSky();
    drawRoad();
    if (world) {
      drawObs();
      drawCar(t);
      drawFloaters();
      drawCrush();
    }
    ctx.restore();
    /* 白闪叠在最上层，不跟随震屏 */
    if (flashT > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (flashT * 0.6).toFixed(3) + ')';
      ctx.fillRect(0, 0, DW, DH);
    }
  }

  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, DH);
    g.addColorStop(0, '#0a0f1e');
    g.addColorStop(0.45, '#101a30');
    g.addColorStop(1, '#070a14');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DW, DH);

    /* 远景城市的剪影 —— 用与时间相关的确定性噪声，避免每帧闪烁 */
    var seed = 7;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    ctx.fillStyle = 'rgba(28,40,68,.85)';
    var x = -20;
    while (x < DW + 20) {
      var w = 26 + rnd() * 54;
      var h = 40 + rnd() * 150;
      ctx.fillRect(x, DH * 0.30 - h, w, h);
      /* 零星亮着的窗户 */
      ctx.fillStyle = 'rgba(120,160,255,.16)';
      for (var wy = 0; wy < 4; wy++) {
        for (var wx = 0; wx < 3; wx++) {
          if (rnd() < 0.35) {
            ctx.fillRect(x + 6 + wx * (w - 12) / 3, DH * 0.30 - h + 10 + wy * 16, 5, 7);
          }
        }
      }
      ctx.fillStyle = 'rgba(28,40,68,.85)';
      x += w + 6 + rnd() * 14;
    }
  }

  function drawRoad() {
    var left = C.roadLeft(D), right = C.roadRight(D);
    /* 路肩 + 路面 */
    ctx.fillStyle = '#151a26';
    ctx.fillRect(left - 14, 0, (right - left) + 28, DH);
    var g = ctx.createLinearGradient(left, 0, right, 0);
    g.addColorStop(0, '#232a3a');
    g.addColorStop(0.5, '#2b3346');
    g.addColorStop(1, '#232a3a');
    ctx.fillStyle = g;
    ctx.fillRect(left, 0, right - left, DH);

    /* 车道分隔线：虚线，用世界滚动量做偏移，产生"路在动"的感觉 */
    var lw = C.laneWidth(D, world ? world.lanes : D.ROAD.lanes);
    var scroll = world ? (world.distance % 46) : 0;
    ctx.strokeStyle = 'rgba(210,225,255,.20)';
    ctx.lineWidth = 3;
    ctx.setLineDash([22, 24]);
    ctx.lineDashOffset = -scroll;
    for (var i = 1; i < (world ? world.lanes : D.ROAD.lanes); i++) {
      var x = left + lw * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, DH);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    /* 路缘实线 */
    ctx.strokeStyle = 'rgba(255,214,120,.34)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(left, 0); ctx.lineTo(left, DH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(right, 0); ctx.lineTo(right, DH); ctx.stroke();
  }

  /* SECTION: 井盖
     造型要点：铁灰色圆盘 + 同心环 + 放射格栅 + 高光。
     必须一眼能认出"这是井盖"，同时和金币（金色圆）区分开。 */
  function drawManhole(o) {
    var r = o.r;
    ctx.save();
    ctx.translate(o.x, o.y);

    /* 地面投影 */
    ctx.fillStyle = 'rgba(0,0,0,.42)';
    ctx.beginPath();
    ctx.ellipse(0, 3, r * 1.02, r * 0.96, 0, 0, Math.PI * 2);
    ctx.fill();

    /* 盘体 */
    var g = ctx.createRadialGradient(-r * 0.34, -r * 0.38, r * 0.15, 0, 0, r);
    g.addColorStop(0, '#8e99ad');
    g.addColorStop(0.55, '#5c6679');
    g.addColorStop(1, '#343d4e');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    /* 外圈 */
    ctx.strokeStyle = 'rgba(20,24,32,.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r - 1.5, 0, Math.PI * 2);
    ctx.stroke();

    /* 放射格栅 */
    ctx.strokeStyle = 'rgba(24,29,39,.62)';
    ctx.lineWidth = 2;
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.30, Math.sin(a) * r * 0.30);
      ctx.lineTo(Math.cos(a) * r * 0.80, Math.sin(a) * r * 0.80);
      ctx.stroke();
    }
    /* 同心环 */
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.56, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.30, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(24,29,39,.75)';
    ctx.stroke();

    /* 中心盖 + 高光 */
    ctx.fillStyle = 'rgba(150,162,182,.55)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.20)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.86, Math.PI * 1.06, Math.PI * 1.72);
    ctx.stroke();

    /* 被压到时涂成危险红，给玩家即时反馈 */
    if (o.hit) {
      ctx.fillStyle = 'rgba(255,70,70,.42)';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCoin(o) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.beginPath(); ctx.ellipse(0, 3, o.r * 0.85, o.r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    var g = ctx.createRadialGradient(-4, -5, 2, 0, 0, o.r);
    g.addColorStop(0, '#fff3b0');
    g.addColorStop(0.5, '#ffcf3d');
    g.addColorStop(1, '#c9860a');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, o.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,70,0,.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, o.r - 2, 0, Math.PI * 2); ctx.stroke();
    /* 小小的"¥" */
    ctx.fillStyle = 'rgba(120,70,0,.75)';
    ctx.font = 'bold 15px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('¥', 0, 1);
    ctx.restore();
  }

  function drawStar(o, t) {
    ctx.save();
    ctx.translate(o.x, o.y);
    var pulse = 1 + Math.sin(t * 5 + o.x) * 0.10;
    ctx.scale(pulse, pulse);
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.beginPath(); ctx.ellipse(0, 4, o.r * 0.8, o.r * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var rr = i % 2 ? o.r * 0.46 : o.r;
      var fn = i ? 'lineTo' : 'moveTo';
      ctx[fn](Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -o.r, 0, o.r);
    g.addColorStop(0, '#ffe9a3');
    g.addColorStop(1, '#ff9f2e');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(180,90,0,.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawNitro(o, t) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(t * 4 + o.x * 0.01);
    var r = o.r;
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.beginPath(); ctx.ellipse(0, 4, r * 0.8, r * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.72, -r * 0.32);
    ctx.lineTo(r * 0.5, r * 0.8); ctx.lineTo(-r * 0.5, r * 0.8);
    ctx.lineTo(-r * 0.72, -r * 0.32);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, '#b9f6ff');
    g.addColorStop(1, '#25b6e8');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,90,130,.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(10,60,90,.85)';
    ctx.font = 'bold 15px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('↑', 0, 2);
    ctx.restore();
  }

  function drawShieldPickup(o, t) {
    ctx.save();
    ctx.translate(o.x, o.y);
    var pulse = 1 + Math.sin(t * 4 + o.x) * 0.08;
    ctx.scale(pulse, pulse);
    ctx.beginPath();
    ctx.moveTo(0, -o.r);
    ctx.lineTo(o.r * 0.86, -o.r * 0.5);
    ctx.lineTo(o.r * 0.86, o.r * 0.24);
    ctx.quadraticCurveTo(0, o.r * 1.16, -o.r * 0.86, o.r * 0.24);
    ctx.lineTo(-o.r * 0.86, -o.r * 0.5);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, -o.r, 0, o.r);
    g.addColorStop(0, '#d8ffe9');
    g.addColorStop(1, '#31cf8b');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,110,70,.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawHazard(o) {
    ctx.save();
    ctx.translate(o.x, o.y);
    if (o.haz === 'cone') {
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      ctx.beginPath(); ctx.ellipse(0, o.r * 0.62, o.r * 0.95, o.r * 0.42, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -o.r); ctx.lineTo(o.r * 0.86, o.r * 0.62); ctx.lineTo(-o.r * 0.86, o.r * 0.62);
      ctx.closePath();
      ctx.fillStyle = '#f26a1b';
      ctx.fill();
      ctx.fillStyle = '#f7f0e4';
      ctx.fillRect(-o.r * 0.52, -o.r * 0.06, o.r * 1.04, o.r * 0.30);
      ctx.fillStyle = '#e2621a';
      ctx.beginPath();
      ctx.moveTo(0, -o.r); ctx.lineTo(o.r * 0.34, o.r * 0.16); ctx.lineTo(-o.r * 0.34, o.r * 0.16);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(20,40,60,.75)';
      ctx.beginPath(); ctx.ellipse(0, 0, o.r * 1.5, o.r * 0.82, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(90,160,220,.42)';
      ctx.beginPath(); ctx.ellipse(-o.r * 0.3, -o.r * 0.14, o.r * 0.7, o.r * 0.32, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawObs() {
    var obs = world.obs;
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      if (o.y < -80 || o.y > DH + 80) { continue; }
      switch (o.kind) {
        case 'manhole': drawManhole(o); break;
        case 'coin': drawCoin(o); break;
        case 'star': drawStar(o, lastT); break;
        case 'nitro': drawNitro(o, lastT); break;
        case 'shield': drawShieldPickup(o, lastT); break;
        case 'hazard': drawHazard(o); break;
      }
    }
  }

  /* SECTION: 车
     俯视轿车：车身 + 车窗 + 两个前轮（**车轮位置直接取自 core 的 wheels()**，
     保证画出来的轮子就是判定用的轮子 —— 视觉与判定永远一致）。 */
  function drawCar(t) {
    var cx = world.carX, cy = world.carY;
    var cw = C.carWidth(D, world.lanes);
    var ch = D.PLAYER.h;
    var ws = C.wheels(D, world.lanes, cx, cy);
    var shake = world.hitAt ? 1 : 0;

    ctx.save();
    ctx.translate(cx, cy);
    if (shake) { ctx.translate((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6); }
    ctx.rotate(world.tilt * 0.14);

    /* 车影 */
    ctx.fillStyle = 'rgba(0,0,0,.46)';
    roundRect(-cw / 2 + 3, -ch / 2 + 8, cw, ch, 12);
    ctx.fill();

    /* 车轮（先画，压在车身下面） */
    for (var i = 0; i < ws.length; i++) {
      var wx = ws[i].x - cx;
      ctx.fillStyle = '#12151c';
      roundRect(wx - 7, -ch / 2 + 6, 14, 22, 4);
      ctx.fill();
      roundRect(wx - 7, ch / 2 - 28, 14, 22, 4);
      ctx.fill();
    }

    /* 车身 */
    var g = ctx.createLinearGradient(-cw / 2, 0, cw / 2, 0);
    g.addColorStop(0, '#7b1230');
    g.addColorStop(0.42, '#e0344f');
    g.addColorStop(0.62, '#ff6a7d');
    g.addColorStop(1, '#a01632');
    ctx.fillStyle = g;
    roundRect(-cw / 2, -ch / 2, cw, ch, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,6,14,.7)';
    ctx.lineWidth = 2;
    ctx.stroke();

    /* 前挡风 + 后窗 */
    ctx.fillStyle = 'rgba(150,205,255,.72)';
    roundRect(-cw / 2 + 9, -ch / 2 + 12, cw - 18, 16, 5);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,205,255,.42)';
    roundRect(-cw / 2 + 10, ch / 2 - 27, cw - 20, 14, 5);
    ctx.fill();

    /* 车顶 */
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    roundRect(-cw / 2 + 8, -ch / 2 + 32, cw - 16, 24, 6);
    ctx.fill();

    /* 车灯 */
    ctx.fillStyle = 'rgba(255,248,200,.95)';
    ctx.beginPath(); ctx.ellipse(-cw / 2 + 9, -ch / 2 + 4, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cw / 2 - 9, -ch / 2 + 4, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,90,90,.9)';
    ctx.fillRect(-cw / 2 + 6, ch / 2 - 4, 12, 3);
    ctx.fillRect(cw / 2 - 18, ch / 2 - 4, 12, 3);

    ctx.restore();

    /* 护盾光环 */
    if (world.shieldMs > 0) {
      var a = 0.34 + Math.sin(t * 7) * 0.12;
      ctx.strokeStyle = 'rgba(60,235,150,' + a.toFixed(3) + ')';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, cw * 0.78, ch * 0.72, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(190,255,225,.30)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, cw * 0.90, ch * 0.84, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    /* 幸运星：车顶小星标 */
    if (world.lucky > 0) {
      for (var k = 0; k < world.lucky; k++) {
        ctx.save();
        ctx.translate(cx - 14 + k * 28, cy - ch / 2 - 18);
        ctx.fillStyle = '#ffd85e';
        ctx.beginPath();
        for (var s = 0; s < 10; s++) {
          var ang = -Math.PI / 2 + s * Math.PI / 5;
          var rr = s % 2 ? 4 : 9;
          var fn2 = s ? 'lineTo' : 'moveTo';
          ctx[fn2](Math.cos(ang) * rr, Math.sin(ang) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
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

  /* SECTION: 飘字与碎片 */
  function addFloater(x, y, text, color) {
    floaters.push({ x: x, y: y, text: text, color: color || '#ffffff', life: 0.9, max: 0.9 });
  }
  function drawFloaters() {
    for (var i = 0; i < floaters.length; i++) {
      var f = floaters[i];
      var k = f.life / f.max;
      ctx.save();
      ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = f.color;
      ctx.font = 'bold 22px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.strokeText(f.text, f.x, f.y - (1 - k) * 42);
      ctx.fillText(f.text, f.x, f.y - (1 - k) * 42);
      ctx.restore();
    }
  }
  function addCrush(x, y, r) {
    var pieces = 10;
    for (var i = 0; i < pieces; i++) {
      var a = (i / pieces) * Math.PI * 2 + Math.random() * 0.5;
      var sp = 90 + Math.random() * 190;
      crushMarks.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.9, max: 0.9, size: 4 + Math.random() * 7, rot: Math.random() * 6
      });
    }
    for (var j = 0; j < 14; j++) {
      var a2 = Math.random() * Math.PI * 2;
      crushMarks.push({
        x: x, y: y, vx: Math.cos(a2) * (40 + Math.random() * 120),
        vy: Math.sin(a2) * (40 + Math.random() * 120),
        life: 0.55, max: 0.55, size: 2 + Math.random() * 4, rot: 0, spark: true
      });
    }
  }
  function drawCrush() {
    for (var i = 0; i < crushMarks.length; i++) {
      var p = crushMarks[i];
      var k = p.life / p.max;
      ctx.save();
      ctx.globalAlpha = Math.max(0, k);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.spark ? '#ffd27a' : '#5f6a7d';
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    }
  }

  /* ============================================================
     SECTION: HUD / 覆盖层
     ============================================================ */
  function fmt(n) { return Math.round(n).toLocaleString('zh-CN'); }

  function updateHud() {
    if (!world) { return; }
    var st = C.statsOf(world);
    el.score.textContent = fmt(st.score);
    el.level.textContent = st.level;
    el.best.textContent = fmt(best);
    el.speed.textContent = Math.round(st.speed / 12 * 3.6 * 3) + ' km/h';
    el.combo.textContent = '×' + st.combo;
    el.combo.classList.toggle('hot', st.combo >= 3);
    var pct = Math.max(0, Math.min(100, st.progress * 100));
    el.bar.style.width = pct.toFixed(1) + '%';
    el.left.textContent = Math.max(0, st.distance - st.meters) + ' m';
    if (el.lvName) { el.lvName.textContent = world.cfg.name || ('第 ' + st.level + ' 关'); }
    /* 生命：本作只有 1 条命，用"心"的数量表达，被护盾/幸运星顶掉时给出视觉变化 */
    var lifeText = world.shieldMs > 0 ? '🛡' : (world.lucky > 0 ? '⭐×' + world.lucky : '❤');
    if (el.lives.textContent !== lifeText) { el.lives.textContent = lifeText; }
    el.lives.className = 'mh-life' + (world.shieldMs > 0 ? ' shield' : (world.lucky > 0 ? ' lucky' : ''));
  }

  function showOv(node) {
    var all = [el.ovStart, el.ovLevel, el.ovOver];
    for (var i = 0; i < all.length; i++) { if (all[i]) { all[i].classList.remove('show'); } }
    if (node) { node.classList.add('show'); }
  }

  function setCountdown(txt, cls) {
    if (!el.countdown) { return; }
    if (!txt) { el.countdown.classList.remove('show', 'go'); return; }
    el.countdown.textContent = txt;
    el.countdown.classList.toggle('go', !!cls);
    el.countdown.classList.add('show');
  }

  /* ============================================================
     SECTION: 生命周期
     ============================================================ */
  var COUNTDOWN = ['3', '2', '1', 'GO'];

  function newRun(level) {
    world = new C.World(D, level, Math.random).start();
    world.startGraceMs = D.RULES.startGraceMs;
    floaters = [];
    crushMarks = [];
    crashInfo = null;
    shakeT = 0;
    flashT = 0;
    paused = false;
    phase = 'countdown';
    updateHud();
    showOv(null);
    /* 开局倒计时：先给玩家看清路况的时间（保护期同步启动） */
    var idx = 0;
    setCountdown(COUNTDOWN[0], false);
    var tick = function () {
      if (!active) { return; }
      idx++;
      if (idx < COUNTDOWN.length) {
        setCountdown(COUNTDOWN[idx], false);
        D.Audio.countdown(idx === COUNTDOWN.length - 1);
        engineTimer = window.setTimeout(tick, 460);
      } else {
        setCountdown(null);
        phase = 'play';
        D.Audio.engineStart();
      }
    };
    D.Audio.countdown(false);
    engineTimer = window.setTimeout(tick, 460);
  }

  function levelUp() {
    var next = world.level + 1;
    if (next > D.LEVELS.length) {
      /* 全部关卡通关 —— 进无尽模式继续刷分 */
      next = world.level;
    }
    newRun(next);
  }

  /* 结算 */
  function finish(kind) {
    phase = kind;
    D.Audio.engineStop();
    D.Audio.over();
    updateHud();
    var st = C.statsOf(world);
    el.rLevel.textContent = st.level;
    el.rScore.textContent = fmt(st.score);
    el.rMeters.textContent = st.meters + ' m';
    if (kind === 'win') {
      el.rTitle.textContent = '过关！';
      el.rArt.textContent = '🏁';
      el.rTip.textContent = '提示：贴着井盖边缘擦过去有额外奖励分。';
    } else {
      el.rTitle.textContent = crashInfo && crashInfo.shieldBlocked ? '撞上井盖' : '压到井盖了！';
      el.rArt.textContent = '💥';
      el.rTip.textContent = '提示：留意车头前的井盖，提前一条车道并线比临门一脚更稳。';
    }
    var isRecord = false;
    if (st.score > best) { best = st.score; writeStore(K_BEST, best); isRecord = true; }
    if (st.level > bestLevel) { bestLevel = st.level; writeStore(K_LEVEL, bestLevel); }
    el.best.textContent = fmt(best);
    el.rBest.textContent = fmt(best);
    el.rRecord.classList.toggle('show', isRecord);
    if (el.crashWhy && crashInfo) {
      el.crashWhy.textContent = crashInfo.text || '';
    }
    window.setTimeout(function () { showOv(el.ovOver); }, kind === 'win' ? 320 : 520);
  }

  /* SECTION: 事件处理
     core 只返回事件对象，音效与特效都在这层播放（逻辑层不碰 DOM/音频） */
  function handleEvents(ev) {
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      switch (e.t) {
        case 'crash':
          D.Audio.engineStop();
          D.Audio.crash();
          shakeT = 0.55;
          flashT = 0.42;
          addCrush(e.x, e.y, 30);
          crashInfo = buildCrashInfo(e);
          finish('over');
          break;
        case 'coin':
          D.Audio.coin();
          addFloater(e.x, e.y, '+' + e.gain, '#ffd85e');
          break;
        case 'pickup':
          if (e.kind === 'star') { D.Audio.star(); addFloater(e.x, e.y, '幸运星！', '#ffd85e'); }
          else if (e.kind === 'nitro') { D.Audio.nitro(); addFloater(e.x, e.y, '氮气加速！', '#7fe4ff'); }
          else if (e.kind === 'shield') { D.Audio.shield(); addFloater(e.x, e.y, '护盾！', '#66f0a8'); }
          else { D.Audio.coin(); addFloater(e.x, e.y, '+' + (e.gain || 0), '#ffd85e'); }
          break;
        case 'shielded':
          D.Audio.shield();
          shakeT = 0.30;
          addCrush(e.x, e.y, 30);
          addFloater(e.x, e.y, '护盾挡下！', '#66f0a8');
          break;
        case 'lucky':
          D.Audio.star();
          shakeT = 0.26;
          addCrush(e.x, e.y, 30);
          addFloater(e.x, e.y, '幸运星抵消！', '#ffd85e');
          break;
        case 'nearMiss':
          D.Audio.nearMiss();
          addFloater(e.x, e.y - 18, '惊险 +' + e.gain, '#a9e6ff');
          break;
        case 'combo':
          D.Audio.coin();
          addFloater(D.LAYOUT.W / 2, 200, '连击 ×' + e.mult, '#ff9ec4');
          break;
        case 'bump':
          D.Audio.crash();
          shakeT = 0.18;
          break;
        case 'levelup':
          D.Audio.levelup();
          break;
        case 'win':
          finish('win');
          break;
      }
    }
  }

  /* 撞击现场说明：告诉玩家是怎么死的（自学比猜有用） */
  function buildCrashInfo(e) {
    var ws = C.wheels(D, world.lanes, world.carX, world.carY);
    var lane = C.occupiedLanes(D, world.lanes, world.carX);
    var aligned = C.alignedLane(D, world.lanes, world.carX);
    var t;
    if (aligned < 0) {
      t = '车正跨在两条车道之间 —— 并线没完成就撞上了井盖。';
    } else {
      t = '车道 ' + (aligned + 1) + ' 上有井盖，没能躲开。';
    }
    return { text: t, lane: lane, x: e.x, y: e.y, meter: e.meter };
  }

  /* ============================================================
     SECTION: 主循环
     ============================================================ */
  var FIXED = 1 / 60;

  function loop(now) {
    if (!active) { return; }
    raf = window.requestAnimationFrame(loop);
    if (!lastT) { lastT = now; }
    var dtms = now - lastT;
    lastT = now;
    /* 单帧最大步长 1/20 秒：切标签页回来不会"瞬移"，也不会因为卡顿而穿模 */
    var dt = Math.min(1 / 20, dtms / 1000);

    /* 特效计时 */
    if (shakeT > 0) { shakeT = Math.max(0, shakeT - dt); }
    if (flashT > 0) { flashT = Math.max(0, flashT - dt * 2.4); }
    for (var i = floaters.length - 1; i >= 0; i--) {
      floaters[i].life -= dt;
      if (floaters[i].life <= 0) { floaters.splice(i, 1); }
    }
    for (var j = crushMarks.length - 1; j >= 0; j--) {
      var p = crushMarks[j];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 620 * dt;
      p.rot += dt * 9;
      if (p.life <= 0) { crushMarks.splice(j, 1); }
    }

    if (world && phase === 'play' && !paused) {
      /* 固定步长推进：把这一帧的时间切成若干个 1/60 秒，保证不同帧率下手感一致 */
      var acc = dt;
      var guard = 0;
      while (acc > 0 && guard++ < 6 && !world.over && !world.won) {
        var step = Math.min(FIXED, acc);
        var ev = world.update(step);
        acc -= step;
        if (ev.length) { handleEvents(ev); }
      }
      updateHud();
      /* 引擎声的音高跟着车速走（engineSet 内部对 speed01 做平滑，不必每帧都改） */
      if (soundOn) { D.Audio.engineSet(world.curSpeed() / D.WORLD.maxSpeed); }
    } else if (world && phase !== 'countdown') {
      updateHud();
    }

    draw(now / 1000);
  }

  /* SECTION: 输入
     键盘：← → 长按连续横移（steer），或轻点一次换一条道（shiftLane）。
     触控/鼠标：直接拖到手指或指针所在位置（移动端最直观）。
     Esc 返回乐园，M 切换音效。 */
  function bindInput() {
    var down = {};

    function keydown(e) {
      if (!active) { return; }
      var k = e.key;
      if (k === 'Escape') { window.APP_ROUTER && window.APP_ROUTER.go('portal'); return; }
      if (k === 'm' || k === 'M') { toggleSound(); return; }
      if (phase !== 'play' || !world) {
        /* 结束/开局界面：空格或回车直接开始/重开 */
        if ((k === ' ' || k === 'Enter') && (phase === 'start' || phase === 'over' || phase === 'win')) {
          e.preventDefault();
          if (phase === 'start' || phase === 'over') { newRun(1); }
          else { levelUp(); }
        }
        return;
      }
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
        e.preventDefault();
        if (!down.left) {
          down.left = true;
          world.steer = -1;
          world.shiftLane(-1);       // 轻点一次 = 换一条道
        }
      } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
        e.preventDefault();
        if (!down.right) {
          down.right = true;
          world.steer = 1;
          world.shiftLane(1);
        }
      }
    }
    function keyup(e) {
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { down.left = false; if (world && !down.right) { world.steer = 0; } }
      if (k === 'ArrowRight' || k === 'd' || k === 'D') { down.right = false; if (world && !down.left) { world.steer = 0; } }
    }

    document.addEventListener('keydown', keydown);
    document.addEventListener('keyup', keyup);

    /* 指针拖动：把指针的 x 映射到设计坐标，直接设定车的位置 */
    var dragging = false;
    function toDesignX(clientX) {
      var rect = cv.getBoundingClientRect();
      if (!rect.width) { return null; }
      return (clientX - rect.left) / rect.width * DW;
    }
    function pointerDown(e) {
      if (!active || phase !== 'play' || !world) { return; }
      dragging = true;
      var x = toDesignX(e.clientX);
      if (x !== null) { world.steer = 0; world.setCarX(x); }
      if (cv.setPointerCapture && e.pointerId !== undefined) {
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
    }
    function pointerMove(e) {
      if (!dragging || !active || phase !== 'play' || !world) { return; }
      var x = toDesignX(e.clientX);
      if (x !== null) { world.setCarX(x); }
      e.preventDefault();
    }
    function pointerUp() { dragging = false; }

    if (cv) {
      cv.addEventListener('pointerdown', pointerDown);
      cv.addEventListener('pointermove', pointerMove);
      cv.addEventListener('pointerup', pointerUp);
      cv.addEventListener('pointercancel', pointerUp);
      cv.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    }

    /* 按钮 */
    var bs = $('mhBtnStart'), br = $('mhBtnRetry'), bl = $('mhBtnLevelUp'), bq = $('mhBtnQuit');
    if (bs) { bs.addEventListener('click', function () { newRun(1); }); }
    if (br) { br.addEventListener('click', function () { newRun(1); }); }
    if (bl) { bl.addEventListener('click', function () { levelUp(); }); }
    if (bq) { bq.addEventListener('click', function () { finish('over'); }); }
    if (el.btnSound) { el.btnSound.addEventListener('click', toggleSound); }

    /* 切走标签页时暂停（引擎音也要停），回来恢复 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        paused = true;
        D.Audio.engineStop();
      } else {
        paused = false;
        lastT = 0;
        if (active && phase === 'play') { D.Audio.engineStart(); }
      }
    });
  }

  function toggleSound() {
    soundOn = !soundOn;
    D.Audio.enabled = soundOn;
    if (el.btnSound) {
      el.btnSound.textContent = soundOn ? '🔊' : '🔇';
      el.btnSound.classList.toggle('off', !soundOn);
    }
    if (!soundOn) { D.Audio.engineStop(); }
  }

  /* ============================================================
     SECTION: 对外接口（与其它游戏统一的应用契约）
     ============================================================ */
  function mount(root) {
    if (mounted) { return; }
    bindDom();
    setupCanvas();
    bindInput();
    best = readStore(K_BEST, 0);
    bestLevel = readStore(K_LEVEL, 1);
    active = false;
    phase = 'start';
    mounted = true;
    if (el.best) { el.best.textContent = fmt(best); }
    draw(0);
  }

  function activate() {
    active = true;
    if (!world) { phase = 'start'; }
    if (el.btnSound) { el.btnSound.textContent = soundOn ? '🔊' : '🔇'; }
    lastT = 0;
    if (!raf) { raf = window.requestAnimationFrame(loop); }
  }

  function deactivate() {
    active = false;
    if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
    if (engineTimer) { window.clearTimeout(engineTimer); engineTimer = null; }
    D.Audio.engineStop();
    if (world) { world.steer = 0; }
  }

  function resize() {
    /* backing store 固定，CSS 负责缩放 —— 这里只需重绘一次 */
    if (active) { draw(lastT / 1000); }
  }

  function isActive() { return active; }

  function stats() {
    if (!world) { return { best: best, level: bestLevel, phase: phase }; }
    var st = C.statsOf(world);
    st.best = best;
    st.bestLevel = bestLevel;
    st.phase = phase;
    return st;
  }

  return {
    mount: mount, activate: activate, deactivate: deactivate,
    resize: resize, isActive: isActive, stats: stats,
    /* 给自动化 e2e 用：直接起一局并推进，不依赖倒计时 */
    _debugStart: function (level) {
      newRun(level || 1);
      D.Audio.enabled = false;
      if (engineTimer) { window.clearTimeout(engineTimer); engineTimer = null; }
      setCountdown(null);
      phase = 'play';
      return stats();
    },
    _world: function () { return world; }
  };
})();
