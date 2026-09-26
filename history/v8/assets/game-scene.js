/* ============================================================
   回转寿司大作战 · 场景绘制模块
   SECTION: game-scene
   ============================================================ */
(function (global) {
  'use strict';

  var D = global.SUSHI_GAME;
  var L = D.LAYOUT;
  var TIERS = D.TIERS;

  var W = L.W, H = L.H;

  /* SECTION: util */
  function rr(ctx, x, y, w, h, r) {
    var rad = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }
  function emoji(ctx, ch, x, y, size, alpha) {
    ctx.save();
    if (alpha != null) { ctx.globalAlpha = alpha; }
    ctx.font = size + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Android Emoji",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y);
    ctx.restore();
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function shade(hex, amt) {
    var c = String(hex).replace('#', '');
    if (c.length === 3) { c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]; }
    var num = parseInt(c, 16);
    var r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    if (amt < 0) {
      r = Math.round(r * (1 + amt)); g = Math.round(g * (1 + amt)); b = Math.round(b * (1 + amt));
    } else {
      r = Math.round(r + (255 - r) * amt); g = Math.round(g + (255 - g) * amt); b = Math.round(b + (255 - b) * amt);
    }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* ============================================================
     SECTION: background-cache — 静态背景一次性绘制后缓存
     ============================================================ */
  var bgCache = null;
  var bgKey = '';

  function buildBackground(dpr) {
    var key = W + 'x' + H + '@' + dpr;
    if (bgCache && bgKey === key) { return bgCache; }

    var c = document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* --- 后墙 --- */
    var wall = g.createLinearGradient(0, 0, 0, L.counterTopY);
    wall.addColorStop(0, '#1c1529');
    wall.addColorStop(0.4, '#2a1f36');
    wall.addColorStop(0.75, '#3d2a1c');
    wall.addColorStop(1, '#241610');
    g.fillStyle = wall;
    g.fillRect(0, 0, W, L.counterTopY + 2);

    /* --- 木板墙纹理 --- */
    g.save();
    g.globalAlpha = 0.14;
    for (var x = 0; x < W; x += 62) {
      g.strokeStyle = x % 124 === 0 ? '#000' : '#6a4829';
      g.lineWidth = x % 124 === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(x + 0.5, L.norenBottom); g.lineTo(x + 0.5, L.counterBackY + 4); g.stroke();
    }
    g.globalAlpha = 0.05;
    for (var yy = L.norenBottom; yy < L.counterBackY; yy += 11) {
      g.strokeStyle = '#ffd9a0';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, yy + 0.5); g.lineTo(W, yy + 0.5); g.stroke();
    }
    g.restore();

    /* --- 暖色壁光 --- */
    var glow = g.createRadialGradient(W / 2, L.beltY, 40, W / 2, L.beltY, 540);
    glow.addColorStop(0, 'rgba(255,186,110,.2)');
    glow.addColorStop(0.55, 'rgba(255,150,80,.07)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, L.counterTopY);

    /* --- 后墙置物架 + 酒瓶 + 挂轴 --- */
    drawBackWall(g);

    /* --- 顶部横梁 --- */
    var beam = g.createLinearGradient(0, 0, 0, L.beamBottom);
    beam.addColorStop(0, '#4a3220');
    beam.addColorStop(0.5, '#6b4a2e');
    beam.addColorStop(1, '#33220f');
    g.fillStyle = beam;
    g.fillRect(0, 0, W, L.beamBottom);
    g.fillStyle = 'rgba(0,0,0,.4)';
    g.fillRect(0, L.beamBottom - 3, W, 3);
    g.fillStyle = 'rgba(255,220,170,.14)';
    g.fillRect(0, 1, W, 1.5);

    /* --- 暖帘 --- */
    drawNoren(g);

    /* --- 灯笼 --- */
    drawLantern(g, 60, L.beamBottom + 14, 1);
    drawLantern(g, W - 60, L.beamBottom + 14, 1);

    /* --- 顾客身后的吧台台座底色（台面高光由 drawSeatLedge 动态覆盖顾客下半身） --- */
    var cb = g.createLinearGradient(0, L.counterBackY - 18, 0, L.farLaneY);
    cb.addColorStop(0, '#8a5c38');
    cb.addColorStop(0.45, '#6d4529');
    cb.addColorStop(1, '#4a2e1c');
    g.fillStyle = cb;
    g.fillRect(0, L.counterBackY - 18, W, L.farLaneY - L.counterBackY + 18);

    /* --- 传送带外壳（回送轨与主轨之间的金属框体） --- */
    var hg2 = g.createLinearGradient(0, L.farLaneY - L.farLaneH / 2, 0, L.counterTopY);
    hg2.addColorStop(0, '#3a4150');
    hg2.addColorStop(0.18, '#4d5566');
    hg2.addColorStop(0.55, '#2c323e');
    hg2.addColorStop(1, '#1b1f27');
    g.fillStyle = hg2;
    g.fillRect(0, L.farLaneY - L.farLaneH / 2, W, L.counterTopY - L.farLaneY + L.farLaneH / 2);
    /* 外壳铆钉 */
    g.save();
    g.globalAlpha = 0.4;
    for (var rx = 26; rx < W; rx += 96) {
      g.fillStyle = 'rgba(255,235,200,.35)';
      g.beginPath(); g.arc(rx, L.beltBottom + 11, 2.6, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(0,0,0,.4)';
      g.beginPath(); g.arc(rx, L.beltBottom + 12.4, 2.6, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    /* 外壳下方阴影 */
    g.fillStyle = 'rgba(0,0,0,.42)';
    g.fillRect(0, L.counterTopY - 7, W, 7);

    /* --- 吧台前沿（玩家侧） --- */
    var ct = g.createLinearGradient(0, L.counterTopY, 0, L.counterFrontY);
    ct.addColorStop(0, '#b9855c');
    ct.addColorStop(0.1, '#96673f');
    ct.addColorStop(0.5, '#6b452c');
    ct.addColorStop(1, '#3d2517');
    g.fillStyle = ct;
    g.fillRect(0, L.counterTopY, W, L.counterFrontY - L.counterTopY);
    g.fillStyle = 'rgba(255,225,175,.2)';
    g.fillRect(0, L.counterTopY, W, 3);
    g.save();
    g.globalAlpha = 0.13;
    g.strokeStyle = '#2a1a10';
    g.lineWidth = 1;
    for (var t = 0; t < 26; t++) {
      var ty = L.counterTopY + 6 + t * ((L.counterFrontY - L.counterTopY - 8) / 26);
      g.beginPath();
      g.moveTo(0, ty);
      for (var tx = 0; tx <= W; tx += 40) { g.lineTo(tx, ty + Math.sin(tx * 0.02 + t) * 1.6); }
      g.stroke();
    }
    g.restore();
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(0, L.counterFrontY - 4, W, 4);
    g.fillStyle = 'rgba(242,197,97,.22)';
    g.fillRect(0, L.counterFrontY, W, 2);

    /* --- 地板 --- */
    var fl = g.createLinearGradient(0, L.counterFrontY, 0, H);
    fl.addColorStop(0, '#26191f');
    fl.addColorStop(0.5, '#1a1319');
    fl.addColorStop(1, '#0d0910');
    g.fillStyle = fl;
    g.fillRect(0, L.counterFrontY, W, H - L.counterFrontY);
    g.save();
    g.globalAlpha = 0.1;
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    for (var fy = L.counterFrontY + 18; fy < H; fy += 24) {
      g.beginPath(); g.moveTo(0, fy); g.lineTo(W, fy); g.stroke();
    }
    for (var fx = -60; fx < W + 60; fx += 74) {
      g.beginPath(); g.moveTo(fx, L.counterFrontY); g.lineTo(fx - 34, H); g.stroke();
    }
    g.restore();
    var rfl = g.createRadialGradient(W / 2, L.turretY + 20, 20, W / 2, L.turretY + 20, 330);
    rfl.addColorStop(0, 'rgba(255,180,100,.12)');
    rfl.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rfl;
    g.fillRect(0, L.counterFrontY, W, H - L.counterFrontY);

    /* --- 台面装饰 --- */
    emoji(g, '🏮', 46, L.counterTopY + 40, 34, 0.9);
    emoji(g, '🎋', 116, L.counterTopY + 46, 30, 0.62);
    emoji(g, '🍶', W - 176, L.counterTopY + 46, 26, 0.72);
    emoji(g, '🪭', W - 60, L.counterTopY + 42, 26, 0.55);

    /* --- 菜单板 --- */
    g.save();
    g.translate(W - 152, L.counterTopY + 16);
    g.rotate(-0.05);
    rr(g, 0, 0, 96, 54, 5);
    g.fillStyle = '#1a1410';
    g.fill();
    g.strokeStyle = 'rgba(242,197,97,.5)';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = 'rgba(242,197,97,.88)';
    g.font = 'bold 11px "Yu Mincho","Songti SC",serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('本日のおすすめ', 48, 18);
    g.font = '12px sans-serif';
    g.fillStyle = 'rgba(247,239,226,.55)';
    g.fillText('🍣 🍤 🐟 🦀', 48, 38);
    g.restore();

    /* --- 炮台两侧小物 --- */
    emoji(g, '🧂', 96, L.turretY + 30, 22, 0.6);
    emoji(g, '🥢', W - 100, L.turretY + 30, 22, 0.55);

    bgCache = c;
    bgKey = key;
    return c;
  }

  /* SECTION: backwall — 后墙青海波纹理与架饰
     顾客头部占据 y≈128~172、身体占据 y≈168~218，
     因此装饰只画在头部之间的空隙与整墙底纹上，避免遮挡。 */
  function drawBackWall(g) {
    var top = L.norenBottom + 2;
    var bottom = L.counterBackY - 14;

    /* --- 青海波（seigaiha）底纹 --- */
    g.save();
    g.beginPath();
    g.rect(0, top, W, bottom - top);
    g.clip();
    g.strokeStyle = 'rgba(255,214,160,.075)';
    g.lineWidth = 1.4;
    var rad = 19;
    for (var row = 0, y = bottom; y > top - rad; y -= rad * 0.86, row++) {
      var off = row % 2 ? rad : 0;
      for (var x = -rad + off; x < W + rad; x += rad * 2) {
        for (var k = 3; k >= 1; k--) {
          g.beginPath();
          g.arc(x, y, rad * (k / 3), Math.PI, Math.PI * 2);
          g.stroke();
        }
      }
    }
    /* 顶部渐隐，让底纹不压过暖帘 */
    var fade = g.createLinearGradient(0, top, 0, top + 54);
    fade.addColorStop(0, 'rgba(28,21,41,.95)');
    fade.addColorStop(1, 'rgba(28,21,41,0)');
    g.fillStyle = fade;
    g.fillRect(0, top, W, 54);
    g.restore();

    /* --- 横向木条 --- */
    g.fillStyle = '#4a3120';
    g.fillRect(0, bottom - 6, W, 6);
    g.fillStyle = 'rgba(255,220,170,.2)';
    g.fillRect(0, bottom - 6, W, 1.6);
    g.fillStyle = 'rgba(0,0,0,.38)';
    g.fillRect(0, bottom - 1.4, W, 1.4);

    /* --- 空隙位（顾客之间的墙面）挂饰 --- */
    var gaps = [70, 225, 375, 525, 675, 830];
    var items = [
      { t: 'ema', c: '#e8dcc4' },
      { t: 'fan', c: '#c25b4e' },
      { t: 'bottle', c: '#3f6b52' },
      { t: 'ema', c: '#e8dcc4' },
      { t: 'bottle', c: '#8a3b32' },
      { t: 'fan', c: '#4a7fb5' }
    ];
    for (var i = 0; i < gaps.length; i++) {
      var gx = gaps[i], it = items[i];
      var gy = bottom - 6;
      if (it.t === 'bottle') {
        /* 酒瓶 */
        var bh = 30;
        g.fillStyle = it.c;
        g.globalAlpha = 0.8;
        rr(g, gx - 6, gy - bh, 12, bh, 3.4); g.fill();
        rr(g, gx - 3, gy - bh - 9, 6, 10, 2); g.fill();
        g.globalAlpha = 0.32;
        g.fillStyle = '#fff';
        rr(g, gx - 4, gy - bh + 4, 2.4, bh - 10, 1.2); g.fill();
        g.globalAlpha = 0.92;
        g.fillStyle = '#f2ead6';
        rr(g, gx - 6, gy - bh + 9, 12, 11, 1.6); g.fill();
        g.fillStyle = '#8f1f18';
        g.font = 'bold 9px "Yu Mincho","Songti SC",serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('酒', gx, gy - bh + 15);
        g.globalAlpha = 1;
      } else if (it.t === 'fan') {
        /* 折扇挂饰 */
        g.save();
        g.translate(gx, gy - 34);
        g.rotate(i % 2 ? 0.16 : -0.16);
        g.strokeStyle = '#2a2018';
        g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(0, -14); g.lineTo(0, 0); g.stroke();
        var fg2 = g.createLinearGradient(-20, 0, 20, 0);
        fg2.addColorStop(0, it.c);
        fg2.addColorStop(0.5, S_shade(it.c, 0.22));
        fg2.addColorStop(1, it.c);
        g.fillStyle = fg2;
        g.beginPath();
        g.moveTo(0, 2);
        g.arc(0, 2, 22, Math.PI * 1.14, Math.PI * 1.86);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(255,240,210,.5)';
        g.lineWidth = 1;
        for (var r2 = 0; r2 < 5; r2++) {
          var a2 = Math.PI * 1.14 + (Math.PI * 0.72 / 4) * r2;
          g.beginPath();
          g.moveTo(0, 2);
          g.lineTo(Math.cos(a2) * 22, 2 + Math.sin(a2) * 22);
          g.stroke();
        }
        g.fillStyle = '#f2c561';
        g.beginPath(); g.arc(0, 2, 3.4, 0, Math.PI * 2); g.fill();
        g.restore();
      } else {
        /* 绘马木牌 */
        g.save();
        g.translate(gx, gy - 30);
        g.strokeStyle = '#2a2018';
        g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(0, -18); g.lineTo(0, -8); g.stroke();
        g.fillStyle = 'rgba(0,0,0,.3)';
        g.beginPath();
        g.moveTo(-16 + 2, 2); g.lineTo(0 + 2, -12); g.lineTo(16 + 2, 2);
        g.lineTo(14 + 2, 22); g.lineTo(-14 + 2, 22); g.closePath(); g.fill();
        g.fillStyle = it.c;
        g.beginPath();
        g.moveTo(-16, 0); g.lineTo(0, -14); g.lineTo(16, 0);
        g.lineTo(14, 20); g.lineTo(-14, 20); g.closePath(); g.fill();
        g.strokeStyle = '#8a6a44';
        g.lineWidth = 1.4;
        g.stroke();
        g.fillStyle = 'rgba(140,26,18,.9)';
        g.font = 'bold 13px "Yu Mincho","Songti SC","SimSun",serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(['福', '寿', '喜', '楽', '吉', '幸'][i], 0, 8);
        g.restore();
      }
    }
  }

  function S_shade(hex, amt) {
    var c = String(hex).replace('#', '');
    if (c.length === 3) { c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]; }
    var num = parseInt(c, 16);
    var r = (num >> 16) & 255, gg = (num >> 8) & 255, b = num & 255;
    r = Math.round(r + (255 - r) * amt); gg = Math.round(gg + (255 - gg) * amt); b = Math.round(b + (255 - b) * amt);
    return 'rgb(' + r + ',' + gg + ',' + b + ')';
  }

  /* SECTION: noren */
  function drawNoren(g) {
    var norenTop = L.beamBottom, norenH = L.norenBottom - norenTop;
    var panelW = W / 7;
    var kanjis = ['寿', '司', '回', '転', '美', '味', '匠'];
    for (var i2 = 0; i2 < 7; i2++) {
      var px = i2 * panelW;
      var ng = g.createLinearGradient(px, norenTop, px, norenTop + norenH);
      ng.addColorStop(0, '#2f4a86');
      ng.addColorStop(0.55, '#26406f');
      ng.addColorStop(1, '#1b2d51');
      g.fillStyle = ng;
      g.beginPath();
      g.moveTo(px + 2, norenTop);
      g.lineTo(px + panelW - 2, norenTop);
      g.lineTo(px + panelW - 5, norenTop + norenH - 4);
      g.quadraticCurveTo(px + panelW / 2, norenTop + norenH + 7, px + 5, norenTop + norenH - 4);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,.05)';
      g.lineWidth = 1;
      for (var s = 6; s < panelW - 6; s += 7) {
        g.beginPath(); g.moveTo(px + s, norenTop + 2); g.lineTo(px + s - 1, norenTop + norenH - 6); g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,.34)';
      g.fillRect(px + panelW - 2.5, norenTop, 2.5, norenH);
      g.fillStyle = 'rgba(248,244,235,.92)';
      g.font = 'bold ' + Math.round(panelW * 0.44) + 'px "Yu Mincho","Songti SC","SimSun",serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(kanjis[i2], px + panelW / 2, norenTop + norenH * 0.5);
    }
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(0, norenTop, W, 3);
  }

  /* SECTION: lantern */
  function drawLantern(g, cx, topY, scale) {
    g.save();
    g.translate(cx, topY);
    g.scale(scale, scale);
    g.strokeStyle = '#2a2018';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -16); g.lineTo(0, 4); g.stroke();

    var bodyH = 58, bodyW = 40;
    var gl = g.createRadialGradient(0, 34, 4, 0, 34, 68);
    gl.addColorStop(0, 'rgba(255,140,70,.3)');
    gl.addColorStop(1, 'rgba(255,120,50,0)');
    g.fillStyle = gl;
    g.beginPath(); g.arc(0, 34, 68, 0, Math.PI * 2); g.fill();

    var bg2 = g.createRadialGradient(-8, 24, 4, 0, 34, 34);
    bg2.addColorStop(0, '#ff8a6a');
    bg2.addColorStop(0.5, '#e0483c');
    bg2.addColorStop(1, '#8f1f18');
    g.fillStyle = bg2;
    g.beginPath();
    g.ellipse(0, 34, bodyW / 2, bodyH / 2, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(90,20,15,.5)';
    g.lineWidth = 1.2;
    for (var i = 1; i < 6; i++) {
      var py = 34 - bodyH / 2 + (bodyH / 6) * i;
      var hw = Math.sqrt(Math.max(0, 1 - Math.pow((py - 34) / (bodyH / 2), 2))) * (bodyW / 2);
      g.beginPath(); g.moveTo(-hw, py); g.lineTo(hw, py); g.stroke();
    }
    g.fillStyle = '#2a1d16';
    rr(g, -13, 2, 26, 8, 3); g.fill();
    rr(g, -13, 58, 26, 8, 3); g.fill();
    g.fillStyle = 'rgba(40,16,12,.88)';
    g.font = 'bold 17px "Yu Mincho","Songti SC","SimSun",serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('寿', 0, 27);
    g.fillText('司', 0, 45);
    g.restore();
  }

  /* ============================================================
     SECTION: seatledge — 顾客前方的吧台台面
     在顾客绘制之后调用，遮住下半身，形成"坐在吧台后方"的层次
     ============================================================ */
  function drawSeatLedge(ctx) {
    var top = L.counterBackY - 10;
    var bot = L.farLaneY - L.farLaneH / 2 + 2;
    var g2 = ctx.createLinearGradient(0, top, 0, bot);
    g2.addColorStop(0, '#a5714a');
    g2.addColorStop(0.16, '#8a5c38');
    g2.addColorStop(0.7, '#5f3c24');
    g2.addColorStop(1, '#3d2718');
    ctx.fillStyle = g2;
    ctx.fillRect(0, top, W, bot - top);
    ctx.fillStyle = 'rgba(255,225,175,.26)';
    ctx.fillRect(0, top, W, 2.6);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.fillRect(0, top + 3, W, 2.4);
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = '#2a1a10';
    ctx.lineWidth = 1;
    for (var i = 0; i < 3; i++) {
      var yy = top + 7 + i * ((bot - top - 8) / 3);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      for (var xx = 0; xx <= W; xx += 46) { ctx.lineTo(xx, yy + Math.sin(xx * 0.026 + i) * 1.4); }
      ctx.stroke();
    }
    ctx.restore();

    var midY = top + (bot - top) * 0.52;
    for (var s = 0; s < L.seatCount; s++) {
      var sx = Math.round(W * (s + 1) / (L.seatCount + 1));
      ctx.fillStyle = 'rgba(24,18,26,.4)';
      rr(ctx, sx - 30, top + 6, 60, bot - top - 11, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,225,180,.14)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      /* 酱油碟 */
      ctx.fillStyle = '#d8d2c4';
      ctx.beginPath(); ctx.ellipse(sx + 20, midY, 8, 3.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3b2413';
      ctx.beginPath(); ctx.ellipse(sx + 20, midY - 0.8, 6, 2.4, 0, 0, Math.PI * 2); ctx.fill();
      /* 筷子 */
      ctx.strokeStyle = '#c8a878';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(sx - 25, midY - 4); ctx.lineTo(sx - 7, midY + 3);
      ctx.moveTo(sx - 25, midY + 2); ctx.lineTo(sx - 7, midY + 9);
      ctx.stroke();
    }
  }

  /* ============================================================
     SECTION: farplate — 回送轨上的小盘（远处，向右回收）
     ============================================================ */
  function drawFarPlate(ctx, fp, t) {
    var tier = TIERS[fp.tier] || TIERS.red;
    var s = fp.scale;
    var x = fp.x;
    var y = fp.y + Math.sin(t * 2.6 + fp.phase) * 1.1;
    var pw = 30 * s, ph = 8 * s;

    ctx.save();
    ctx.globalAlpha = 0.62;

    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.beginPath();
    ctx.ellipse(x, y + ph * 0.8, pw * 0.9, ph * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();

    var pg = ctx.createLinearGradient(0, y - ph, 0, y + ph);
    pg.addColorStop(0, tier.rim);
    pg.addColorStop(0.45, tier.plate);
    pg.addColorStop(1, tier.inner);
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.ellipse(x, y, pw, ph, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath();
    ctx.ellipse(x, y - 1.2 * s, pw * 0.76, ph * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,.42)';
    ctx.lineWidth = 1.1 * s;
    ctx.beginPath();
    ctx.ellipse(x, y - 0.6 * s, pw * 0.94, ph * 0.88, 0, Math.PI * 1.06, Math.PI * 1.94);
    ctx.stroke();

    /* 非空盘上残留的一点食物 */
    if (!fp.empty) {
      ctx.globalAlpha = 0.5;
      emoji(ctx, fp.emoji, x, y - 12 * s, 24 * s);
    } else {
      /* 空盘上的酱油渍 */
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#3b2413';
      ctx.beginPath();
      ctx.ellipse(x + 3 * s, y - 1 * s, 7 * s, 2.6 * s, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ============================================================
     SECTION: belt — 传送带（含回送轨与主轨）
     ============================================================ */
  function drawBelt(ctx, scroll, farScroll) {
    /* 回送轨 */
    var fy = L.farLaneY, fh = L.farLaneH;
    var fg = ctx.createLinearGradient(0, fy - fh / 2, 0, fy + fh / 2);
    fg.addColorStop(0, '#22262f');
    fg.addColorStop(0.5, '#363d50');
    fg.addColorStop(1, '#1a1d25');
    ctx.fillStyle = fg;
    ctx.fillRect(0, fy - fh / 2, W, fh);
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#8592ad';
    ctx.lineWidth = 2;
    var fs = ((farScroll % 46) + 46) % 46;
    for (var x2 = -46 + fs; x2 < W + 46; x2 += 46) {
      ctx.beginPath();
      ctx.moveTo(x2, fy + fh / 2 - 4);
      ctx.lineTo(x2 + 11, fy);
      ctx.lineTo(x2, fy - fh / 2 + 4);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fillRect(0, fy + fh / 2 - 2, W, 2);

    /* 主传送带 */
    var bt = L.beltTop, bb = L.beltBottom;
    var bg3 = ctx.createLinearGradient(0, bt, 0, bb);
    bg3.addColorStop(0, '#4d5566');
    bg3.addColorStop(0.08, '#939db3');
    bg3.addColorStop(0.22, '#5a6376');
    bg3.addColorStop(0.78, '#3a4150');
    bg3.addColorStop(1, '#20242d');
    ctx.fillStyle = bg3;
    ctx.fillRect(0, bt, W, bb - bt);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, bt, W, bb - bt); ctx.clip();
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = '#dde5f5';
    ctx.lineWidth = 3;
    var s2 = ((scroll % 44) + 44) % 44;
    for (var x = -44 + s2; x < W + 44; x += 44) {
      ctx.beginPath();
      ctx.moveTo(x, bb);
      ctx.lineTo(x - 20, bt);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    for (var x3 = -44 + s2; x3 < W + 44; x3 += 44) {
      ctx.beginPath();
      ctx.moveTo(x3 + 7, bb);
      ctx.lineTo(x3 - 13, bt);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(255,255,255,.3)';
    ctx.fillRect(0, bt, W, 2);
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fillRect(0, bt + 2, W, 3);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, bb - 5, W, 5);
    ctx.fillStyle = 'rgba(242,197,97,.3)';
    ctx.fillRect(0, bb, W, 2);

    /* 两端滚筒罩 */
    var ends = [[0, 1], [W, -1]];
    ends.forEach(function (p) {
      ctx.save();
      ctx.translate(p[0], (bt + bb) / 2);
      ctx.scale(p[1], 1);
      var mg = ctx.createLinearGradient(0, 0, 36, 0);
      mg.addColorStop(0, 'rgba(18,14,24,.97)');
      mg.addColorStop(1, 'rgba(18,14,24,0)');
      ctx.fillStyle = mg;
      ctx.fillRect(0, -(bb - bt) / 2, 36, bb - bt);
      ctx.restore();
    });
  }

  /* ============================================================
     SECTION: plate — 寿司盘
     ============================================================ */
  function drawPlate(ctx, p, t) {
    var tier = p.kind === 'wasabi'
      ? { plate: '#8ec63f', rim: '#d6f5a0', inner: '#5f8f22', glow: 'rgba(142,198,63,.6)' }
      : p.kind === 'tea'
        ? { plate: '#4ea870', rim: '#a8f0c4', inner: '#2f7a4d', glow: 'rgba(78,168,112,.55)' }
        : TIERS[p.tier];

    var s = p.scale;
    var bob = Math.sin(t * 3.4 + p.phase) * 2.2 * s;
    var x = p.x, y = p.y + bob;
    var pw = 33 * s, ph = 9 * s;

    ctx.save();

    /* 影子 */
    ctx.fillStyle = 'rgba(0,0,0,.42)';
    ctx.beginPath();
    ctx.ellipse(x, L.beltBottom - 11 * s, pw * 0.92, ph * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    /* 盘身辉光 */
    ctx.globalAlpha = 0.5;
    var hg = ctx.createRadialGradient(x, y, 2, x, y, pw * 1.55);
    hg.addColorStop(0, tier.glow);
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(x, y, pw * 1.55, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    /* 盘底 */
    var pg = ctx.createLinearGradient(0, y - ph, 0, y + ph);
    pg.addColorStop(0, tier.rim);
    pg.addColorStop(0.45, tier.plate);
    pg.addColorStop(1, tier.inner);
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.ellipse(x, y, pw, ph, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.ellipse(x, y - 1.5 * s, pw * 0.78, ph * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 1.4 * s;
    ctx.beginPath();
    ctx.ellipse(x, y - 0.8 * s, pw * 0.95, ph * 0.9, 0, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();

    /* 食物 */
    var fy = y - 15 * s;
    if (p.kind === 'wasabi') {
      ctx.fillStyle = '#7fb52f';
      ctx.beginPath();
      ctx.moveTo(x - 13 * s, fy + 9 * s);
      ctx.quadraticCurveTo(x - 5 * s, fy - 15 * s, x + 1 * s, fy - 2 * s);
      ctx.quadraticCurveTo(x + 7 * s, fy - 17 * s, x + 13 * s, fy + 9 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#a8dc5a';
      ctx.beginPath();
      ctx.moveTo(x - 8 * s, fy + 8 * s);
      ctx.quadraticCurveTo(x - 3 * s, fy - 9 * s, x + 1 * s, fy - 1 * s);
      ctx.lineTo(x - 2 * s, fy + 8 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.3)';
      ctx.beginPath(); ctx.ellipse(x - 4 * s, fy - 1 * s, 4 * s, 2 * s, -0.4, 0, Math.PI * 2); ctx.fill();
      emoji(ctx, '💀', x, fy - 24 * s, 17 * s);
      var pulse = 0.5 + 0.5 * Math.sin(t * 7 + p.phase);
      ctx.strokeStyle = 'rgba(190,255,110,' + (0.26 + pulse * 0.44).toFixed(3) + ')';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.ellipse(x, y, pw * (1.12 + pulse * 0.16), ph * (1.5 + pulse * 0.4), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.kind === 'tea') {
      ctx.fillStyle = '#f2ede2';
      ctx.beginPath();
      ctx.moveTo(x - 10 * s, fy - 8 * s);
      ctx.lineTo(x + 10 * s, fy - 8 * s);
      ctx.lineTo(x + 7 * s, fy + 9 * s);
      ctx.lineTo(x - 7 * s, fy + 9 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#d8d0c0';
      ctx.beginPath();
      ctx.moveTo(x + 4 * s, fy - 8 * s);
      ctx.lineTo(x + 10 * s, fy - 8 * s);
      ctx.lineTo(x + 7 * s, fy + 9 * s);
      ctx.lineTo(x + 3 * s, fy + 9 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#4ea870';
      ctx.beginPath(); ctx.ellipse(x, fy - 8 * s, 10 * s, 3.4 * s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#cfc7b6';
      ctx.lineWidth = 2.4 * s;
      ctx.beginPath(); ctx.arc(x + 13 * s, fy, 4.6 * s, -1.1, 1.1); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.lineWidth = 1.6 * s;
      for (var i = 0; i < 2; i++) {
        var sx = x - 4 * s + i * 8 * s;
        var ph2 = t * 2.2 + i * 1.6 + p.phase;
        ctx.beginPath();
        ctx.moveTo(sx, fy - 11 * s);
        ctx.quadraticCurveTo(sx + Math.sin(ph2) * 5 * s, fy - 19 * s, sx + Math.sin(ph2 + 1) * 3 * s, fy - 28 * s);
        ctx.stroke();
      }
      emoji(ctx, '🍵', x, fy - 35 * s, 13 * s, 0.92);
    } else {
      emoji(ctx, p.emoji, x, fy - 3 * s, 33 * s);
    }

    /* 点单标记 */
    if (p.wanted) {
      var wp = 0.5 + 0.5 * Math.sin(t * 6 + p.phase * 2);
      ctx.save();
      ctx.translate(x, y - 42 * s);
      ctx.globalAlpha = 0.6 + wp * 0.4;
      emoji(ctx, '✨', -12 * s, 0, (10 + wp * 3) * s);
      emoji(ctx, '✨', 12 * s, -5 * s, (8 + wp * 2.4) * s);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,226,150,.96)';
      ctx.strokeStyle = 'rgba(60,30,10,.8)';
      ctx.lineWidth = 3;
      ctx.font = 'bold ' + Math.round(10 * s) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeText('点单', 0, -2 * s);
      ctx.fillText('点单', 0, -2 * s);
      ctx.restore();
    }

    ctx.restore();
  }

  /* ============================================================
     SECTION: customer — 吧台顾客与订单气泡
     ============================================================ */
  function drawCustomer(ctx, c, t) {
    var bodyTop = L.counterBackY - 46;
    var bodyBot = L.counterBackY + 4;
    var mood = c.state === 'leaving' ? 'angry' : c.state === 'happy' ? 'happy' : 'idle';
    var pat = c.patience / c.patienceMax;
    var urgent = mood === 'idle' && pat < 0.3;

    ctx.save();
    ctx.globalAlpha = c.alpha == null ? 1 : c.alpha;

    var off = 0;
    if (c.state === 'entering') { off = lerp(52, 0, c.anim); ctx.globalAlpha *= clamp(c.anim * 1.5, 0, 1); }
    if (c.state === 'leaving') { off = lerp(0, 64, c.anim); ctx.globalAlpha *= clamp(1 - c.anim, 0, 1); }
    if (c.state === 'happy') { off = lerp(0, 48, c.anim); ctx.globalAlpha *= clamp(1 - c.anim * 1.15, 0, 1); }
    /* 记录实际透明度供订单气泡同步淡出 */
    c.renderAlpha = ctx.globalAlpha;

    ctx.translate(c.x, off);

    /* 身体 */
    var shirt = c.color;
    var bg4 = ctx.createLinearGradient(0, bodyTop, 0, bodyBot);
    bg4.addColorStop(0, shirt);
    bg4.addColorStop(1, shade(shirt, -0.45));
    ctx.fillStyle = bg4;
    ctx.beginPath();
    ctx.moveTo(-27, bodyBot);
    ctx.quadraticCurveTo(-25, bodyTop + 6, -12, bodyTop);
    ctx.lineTo(12, bodyTop);
    ctx.quadraticCurveTo(25, bodyTop + 6, 27, bodyBot);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath();
    ctx.moveTo(-9, bodyTop); ctx.quadraticCurveTo(0, bodyTop + 14, 9, bodyTop); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.13)';
    ctx.beginPath();
    ctx.moveTo(-21, bodyBot); ctx.quadraticCurveTo(-20, bodyTop + 8, -10, bodyTop + 1);
    ctx.lineTo(-4, bodyTop + 1); ctx.quadraticCurveTo(-13, bodyTop + 12, -13, bodyBot);
    ctx.closePath(); ctx.fill();
    /* 手臂搭在台面前缘（略高于台面顶边，故不被 drawSeatLedge 遮住） */
    var armY = L.counterBackY - 14;
    ctx.fillStyle = shade(shirt, -0.16);
    rr(ctx, -30, armY, 16, 9, 4.5); ctx.fill();
    rr(ctx, 14, armY, 16, 9, 4.5); ctx.fill();
    ctx.fillStyle = 'rgba(255,225,190,.5)';
    rr(ctx, -18, armY + 1, 5, 7, 2.4); ctx.fill();
    rr(ctx, 13, armY + 1, 5, 7, 2.4); ctx.fill();

    /* 头 */
    var headY = bodyTop - 21;
    var face = c.face;
    if (mood === 'happy') { face = c.happyFace; }
    else if (mood === 'angry' || urgent) { face = c.angryFace; }

    var bob2 = Math.sin(t * 2 + c.phase) * 1.6;
    ctx.fillStyle = 'rgba(0,0,0,.32)';
    ctx.beginPath(); ctx.arc(0, headY + bob2, 20, 0, Math.PI * 2); ctx.fill();
    emoji(ctx, face, 0, headY + bob2, 35);

    if (urgent && c.state === 'idle') {
      var ap = 0.5 + 0.5 * Math.sin(t * 9 + c.phase);
      emoji(ctx, '💢', 21, headY - 19 + ap * 3, 15 + ap * 3);
      ctx.strokeStyle = 'rgba(255,90,70,' + (0.28 + ap * 0.5).toFixed(2) + ')';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, headY + bob2, 25 + ap * 3, 0, Math.PI * 2); ctx.stroke();
    }
    if (mood === 'happy') {
      for (var hi = 0; hi < 3; hi++) {
        var hp = (t * 1.6 + hi * 0.33 + c.phase) % 1;
        emoji(ctx, '💛', -20 + hi * 20, headY - 26 - hp * 26, 13 * (1 - hp * 0.4), 0.9 * (1 - hp));
      }
    }

    /* 耐心环 */
    if (c.state === 'idle' || c.state === 'entering') {
      var r = 26;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.arc(0, headY + bob2, r, 0, Math.PI * 2); ctx.stroke();
      var col = pat > 0.55 ? '#7ee08a' : pat > 0.28 ? '#f2c561' : '#ff6a4d';
      ctx.strokeStyle = col;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, headY + bob2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(pat, 0, 1));
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    ctx.restore();

    if ((c.state === 'idle' || c.state === 'entering' || c.state === 'happy') && c.order.length) {
      drawBubble(ctx, c, t, off);
    }
  }

  /* SECTION: bubble — 订单气泡 */
  function drawBubble(ctx, c, t, off) {
    var n = c.order.length;
    var cellW = 30;
    var bw = 22 + n * cellW;
    var bh = 42;
    var x = clamp(c.x, bw / 2 + 6, W - bw / 2 - 6);
    var y = L.bubbleY + off * 0.42;
    var pat = c.patience / c.patienceMax;
    var urgent = pat < 0.3 && c.state === 'idle';
    var shake = urgent ? Math.sin(t * 22 + c.phase) * 2.4 : 0;
    var pop = c.state === 'entering' ? clamp(c.anim * 1.7, 0, 1) : 1;

    ctx.save();
    ctx.globalAlpha = (c.renderAlpha == null ? (c.alpha == null ? 1 : c.alpha) : c.renderAlpha) * pop;
    ctx.translate(x + shake, y);
    ctx.scale(lerp(0.6, 1, pop), lerp(0.6, 1, pop));

    /* 尾巴 */
    ctx.fillStyle = urgent ? '#ffe6df' : '#fdf7ea';
    ctx.beginPath();
    ctx.moveTo(-7, bh / 2 - 3);
    ctx.lineTo(7, bh / 2 - 3);
    ctx.lineTo(clamp(c.x - x, -bw / 2 + 12, bw / 2 - 12), bh / 2 + 17);
    ctx.closePath();
    ctx.fill();

    /* 气泡体 */
    rr(ctx, -bw / 2, -bh / 2, bw, bh, 14);
    var bgg = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
    if (urgent) { bgg.addColorStop(0, '#fff1ec'); bgg.addColorStop(1, '#ffd6cb'); }
    else { bgg.addColorStop(0, '#fffdf6'); bgg.addColorStop(1, '#efe4d0'); }
    ctx.fillStyle = bgg;
    ctx.fill();
    ctx.strokeStyle = urgent ? 'rgba(224,72,60,.8)' : 'rgba(120,90,60,.36)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    rr(ctx, -bw / 2 + 6, -bh / 2 + 3, bw - 12, 8, 6);
    ctx.fill();

    /* 订单项 */
    for (var i = 0; i < n; i++) {
      var it = c.order[i];
      var ix = -bw / 2 + 11 + i * cellW + cellW / 2;
      if (it.done) {
        ctx.fillStyle = 'rgba(90,180,110,.24)';
        ctx.beginPath(); ctx.arc(ix, 0, 14, 0, Math.PI * 2); ctx.fill();
        emoji(ctx, it.emoji, ix, 1, 21, 0.3);
        ctx.strokeStyle = '#3fa84f';
        ctx.lineWidth = 3.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(ix - 6, 0); ctx.lineTo(ix - 1.5, 5); ctx.lineTo(ix + 7, -5);
        ctx.stroke();
        ctx.lineCap = 'butt';
      } else {
        emoji(ctx, it.emoji, ix, 1, 23);
        if (i === c.nextIdx) {
          var pp = 0.5 + 0.5 * Math.sin(t * 5 + c.phase);
          ctx.strokeStyle = 'rgba(242,160,60,' + (0.45 + pp * 0.55).toFixed(2) + ')';
          ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.arc(ix, 0, 15 + pp * 1.8, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    /* 奖励提示 */
    if (c.state === 'idle') {
      ctx.fillStyle = 'rgba(120,80,40,.75)';
      ctx.font = 'bold 10px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+' + c.reward, 0, bh / 2 - 7);
    }
    ctx.restore();
  }

  /* ============================================================
     SECTION: turret — 酱油炮台
     ============================================================ */
  function drawTurret(ctx, aimX, aimY, recoil, ammoRatio, t) {
    var bx = W / 2, by = L.turretY;
    var ang = Math.atan2(aimY - by, aimX - bx);
    ang = clamp(ang, -Math.PI + 0.34, -0.34);

    ctx.save();

    /* 地面阴影 */
    ctx.fillStyle = 'rgba(0,0,0,.48)';
    ctx.beginPath(); ctx.ellipse(bx, by + 34, 64, 13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,180,100,.1)';
    ctx.beginPath(); ctx.ellipse(bx, by + 32, 82, 18, 0, 0, Math.PI * 2); ctx.fill();

    /* 木质底座 */
    var wg = ctx.createLinearGradient(0, by + 4, 0, by + 36);
    wg.addColorStop(0, '#a97a52');
    wg.addColorStop(0.5, '#7a5236');
    wg.addColorStop(1, '#4a3120');
    ctx.fillStyle = wg;
    rr(ctx, bx - 54, by + 4, 108, 32, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(242,197,97,.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,225,175,.2)';
    rr(ctx, bx - 50, by + 7, 100, 4, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(28,18,12,.88)';
    rr(ctx, bx - 27, by + 17, 54, 15, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(242,197,97,.92)';
    ctx.font = 'bold 9.5px "Yu Mincho","Songti SC",serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('醤 油 砲', bx, by + 25);

    /* 转台 + 炮管 */
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(ang + Math.PI / 2);
    ctx.translate(0, recoil);

    var lg = ctx.createLinearGradient(-14, 0, 14, 0);
    lg.addColorStop(0, '#16110d');
    lg.addColorStop(0.35, '#4d3c2e');
    lg.addColorStop(0.58, '#2a2018');
    lg.addColorStop(1, '#0f0b08');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(-14, 6);
    ctx.quadraticCurveTo(-16, -26, -9, -40);
    ctx.lineTo(-5, -52);
    ctx.lineTo(5, -52);
    ctx.lineTo(9, -40);
    ctx.quadraticCurveTo(16, -26, 14, 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,220,170,.2)';
    ctx.beginPath();
    ctx.moveTo(-9, 2); ctx.quadraticCurveTo(-11, -24, -5, -38); ctx.lineTo(-2, -38);
    ctx.quadraticCurveTo(-7, -22, -5, 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e8dcc4';
    rr(ctx, -11, -25, 22, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#8f1f18';
    ctx.font = 'bold 12px "Yu Mincho","Songti SC",serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('醤', 0, -15);
    ctx.fillStyle = '#c9302c';
    rr(ctx, -6.5, -61, 13, 10, 2.5);
    ctx.fill();
    ctx.fillStyle = '#ee6a5e';
    rr(ctx, -6.5, -61, 13, 3.4, 1.5);
    ctx.fill();
    ctx.fillStyle = '#2a2018';
    rr(ctx, -2.8, -69, 5.6, 9, 2);
    ctx.fill();
    if (recoil < -1) {
      ctx.fillStyle = 'rgba(255,210,140,' + clamp(-recoil / 9, 0, 0.85).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(0, -71, 7 + (-recoil), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    /* 弹药环 */
    ctx.save();
    ctx.translate(bx, by);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.beginPath(); ctx.arc(0, 0, 46, Math.PI * 0.78, Math.PI * 2.22); ctx.stroke();
    var arcSpan = Math.PI * 1.44;
    ctx.strokeStyle = ammoRatio < 0.25 ? '#ff6a4d' : ammoRatio < 0.55 ? '#f2c561' : '#ffd7a8';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, 46, Math.PI * 0.78, Math.PI * 0.78 + arcSpan * clamp(ammoRatio, 0, 1));
    ctx.stroke();
    if (ammoRatio < 0.25) {
      var p2 = 0.5 + 0.5 * Math.sin(t * 10);
      ctx.strokeStyle = 'rgba(255,106,77,' + (p2 * 0.65).toFixed(2) + ')';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(0, 0, 46, Math.PI * 0.78, Math.PI * 0.78 + arcSpan * clamp(ammoRatio, 0, 1));
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.restore();

    ctx.restore();

    drawReticle(ctx, aimX, aimY, t, ammoRatio <= 0);
  }

  /* SECTION: reticle */
  function drawReticle(ctx, x, y, t, empty) {
    ctx.save();
    ctx.translate(x, y);
    var col = empty ? 'rgba(255,106,77,' : 'rgba(255,222,150,';
    ctx.rotate(t * 0.9);
    ctx.strokeStyle = col + '0.55)';
    ctx.lineWidth = 2;
    for (var i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, 17, i * Math.PI / 2 + 0.24, i * Math.PI / 2 + Math.PI / 2 - 0.24);
      ctx.stroke();
    }
    ctx.rotate(-t * 0.9);
    ctx.strokeStyle = col + '0.92)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-14, 0); ctx.lineTo(-4, 0);
    ctx.moveTo(14, 0); ctx.lineTo(4, 0);
    ctx.moveTo(0, -14); ctx.lineTo(0, -4);
    ctx.moveTo(0, 14); ctx.lineTo(0, 4);
    ctx.stroke();
    ctx.fillStyle = col + '1)';
    ctx.beginPath(); ctx.arc(0, 0, 1.9, 0, Math.PI * 2); ctx.fill();
    if (empty) {
      ctx.fillStyle = 'rgba(255,106,77,.95)';
      ctx.strokeStyle = 'rgba(20,10,6,.9)';
      ctx.lineWidth = 3;
      ctx.font = 'bold 11px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeText('酱油不足', 0, 30);
      ctx.fillText('酱油不足', 0, 30);
    }
    ctx.restore();
  }

  /* ============================================================
     SECTION: fx — 粒子 / 飘字 / 飞行寿司 / 花瓣
     ============================================================ */
  function drawParticle(ctx, p) {
    var a = clamp(p.life / p.max, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    if (p.type === 'emoji') {
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      emoji(ctx, p.emoji, 0, 0, p.size);
    } else if (p.type === 'ring') {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3.4 * a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1.75 - a), 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.type === 'shard') {
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(-p.size, p.size * 0.6);
      ctx.lineTo(p.size, 0);
      ctx.lineTo(-p.size * 0.5, -p.size * 0.8);
      ctx.closePath();
      ctx.fill();
    } else if (p.type === 'drop') {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.size * a * 0.66, p.size * a * 1.25, p.rot, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFloater(ctx, f) {
    var a = clamp(f.life / f.max, 0, 1);
    var rise = 1 - a;
    ctx.save();
    ctx.globalAlpha = a > 0.78 ? (1 - a) * 4.5 : a;
    ctx.translate(f.x, f.y - rise * 50);
    var sc = 1 + (1 - a) * 0.16;
    ctx.scale(sc, sc);
    ctx.font = '800 ' + f.size + 'px system-ui,-apple-system,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = 'rgba(0,0,0,.78)';
    ctx.lineJoin = 'round';
    ctx.strokeText(f.text, 0, 0);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, 0, 0);
    if (f.sub) {
      ctx.font = '700 ' + Math.round(f.size * 0.62) + 'px system-ui,sans-serif';
      ctx.lineWidth = 3.4;
      ctx.strokeText(f.sub, 0, f.size * 0.86);
      ctx.fillStyle = f.subColor || '#ffe6b8';
      ctx.fillText(f.sub, 0, f.size * 0.86);
    }
    ctx.restore();
  }

  function drawFlyer(ctx, f) {
    var k = clamp(f.t, 0, 1);
    var x = lerp(f.x0, f.x1, k);
    var y = lerp(f.y0, f.y1, k) - Math.sin(k * Math.PI) * f.arc;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(k * Math.PI * 3) * 0.35);
    for (var i = 1; i <= 3; i++) {
      var kk = clamp(k - i * 0.06, 0, 1);
      var tx = lerp(f.x0, f.x1, kk) - x;
      var ty = lerp(f.y0, f.y1, kk) - Math.sin(kk * Math.PI) * f.arc - y;
      emoji(ctx, f.emoji, tx, ty, f.size * (1 - i * 0.17), 0.2);
    }
    ctx.shadowColor = 'rgba(255,220,140,.92)';
    ctx.shadowBlur = 20;
    emoji(ctx, f.emoji, 0, 0, f.size);
    ctx.restore();
  }

  function drawPetal(ctx, p) {
    ctx.save();
    ctx.globalAlpha = p.a;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(0, -p.s);
    ctx.quadraticCurveTo(p.s * 1.15, -p.s * 0.25, 0, p.s);
    ctx.quadraticCurveTo(-p.s * 1.15, -p.s * 0.25, 0, -p.s);
    ctx.fill();
    ctx.restore();
  }

  /* SECTION: ambience — 蒸汽与暗角 */
  function drawSteam(ctx, t) {
    ctx.save();
    for (var i = 0; i < 5; i++) {
      var px = 110 + i * 175;
      var ph = (t * 0.22 + i * 0.37) % 1;
      var y = L.counterBackY - 8 - ph * 44;
      var r = 9 + ph * 28;
      ctx.globalAlpha = 0.085 * (1 - ph);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(px + Math.sin(ph * 7 + i) * 13, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawVignette(ctx) {
    var v = ctx.createRadialGradient(W / 2, H * 0.46, H * 0.3, W / 2, H * 0.5, H * 0.94);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,.6)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  global.SUSHI_SCENE = {
    rr: rr,
    emoji: emoji,
    lerp: lerp,
    clamp: clamp,
    shade: shade,
    buildBackground: buildBackground,
    drawSeatLedge: drawSeatLedge,
    drawFarPlate: drawFarPlate,
    drawBelt: drawBelt,
    drawPlate: drawPlate,
    drawCustomer: drawCustomer,
    drawTurret: drawTurret,
    drawParticle: drawParticle,
    drawFloater: drawFloater,
    drawFlyer: drawFlyer,
    drawPetal: drawPetal,
    drawSteam: drawSteam,
    drawVignette: drawVignette
  };
})(window);
