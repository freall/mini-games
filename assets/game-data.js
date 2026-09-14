/* ============================================================
   回转寿司大作战 · 数据与音效模块
   SECTION: game-data
   ============================================================ */
(function (global) {
  'use strict';

  /* SECTION: sushi-types */
  var SUSHI = [
    { id: 'salmon',  emoji: '🍣', name: '三文鱼',   tier: 'red',    base: 100 },
    { id: 'shrimp',  emoji: '🍤', name: '甜虾天妇罗', tier: 'red',    base: 120 },
    { id: 'tamago',  emoji: '🥚', name: '玉子烧',   tier: 'blue',   base: 160 },
    { id: 'naruto',  emoji: '🍥', name: '鸣门卷',   tier: 'blue',   base: 180 },
    { id: 'tako',    emoji: '🐙', name: '章鱼军舰', tier: 'silver', base: 240 },
    { id: 'ika',     emoji: '🦑', name: '鱿鱼紫苏', tier: 'silver', base: 260 },
    { id: 'maguro',  emoji: '🐟', name: '蓝鳍金枪鱼', tier: 'gold',  base: 400 },
    { id: 'kani',    emoji: '🦀', name: '松叶蟹',   tier: 'gold',   base: 460 }
  ];

  /* SECTION: tiers */
  var TIERS = {
    red:    { label: '红盘', plate: '#e0483c', rim: '#ff8d80', inner: '#b8332a', glow: 'rgba(224,72,60,.55)' },
    blue:   { label: '蓝盘', plate: '#3f7fd6', rim: '#93c6ff', inner: '#2b5da6', glow: 'rgba(63,127,214,.55)' },
    silver: { label: '银盘', plate: '#c9d2dd', rim: '#ffffff', inner: '#98a4b3', glow: 'rgba(201,210,221,.5)' },
    gold:   { label: '金盘', plate: '#f2c561', rim: '#fff0c0', inner: '#c99a2e', glow: 'rgba(242,197,97,.62)' }
  };

  /* SECTION: customers */
  var FACES = ['🧑', '👨', '👩', '👴', '👵', '🧒', '🧔', '👮', '🥷', '🧑‍🍳', '👨‍🎤', '👩‍💼', '🧙', '🦸'];
  var HAPPY = ['😋', '🤩', '😍', '🥰', '😄'];
  var ANGRY = ['😡', '💢', '😤'];

  /* SECTION: layout
     垂直空间层次（自上而下）：
     顶部横梁 → 暖帘 → 后墙青海波与挂饰 → 顾客(头/身) → 座位台面 →
     回送轨 → 主传送带 → 吧台前沿 → 地板 → 酱油炮台                  */
  var LAYOUT = {
    W: 900,
    H: 640,
    beamBottom: 26,
    norenBottom: 62,
    bubbleY: 88,
    counterBackY: 214,
    custHeadY: 150,
    farLaneY: 232,
    farLaneH: 16,
    beltTop: 244,
    beltBottom: 316,
    beltY: 280,
    counterTopY: 336,
    counterFrontY: 410,
    turretY: 520,
    seatCount: 5
  };

  /* SECTION: balance */
  var BALANCE = {
    maxAmmo: 15,
    ammoRegen: 1.5,        // 秒/发
    teaRefill: 6,
    fireCooldown: 0.12,
    bulletSpeed: 1020,
    startLives: 3,
    comboWindow: 2.2,
    comboStep: 2,          // 每 2 次命中提升一级倍率
    comboMax: 8,
    levelScore: 1000,
    beltSpeedBase: 46,
    beltSpeedPerLv: 7,
    beltSpeedMax: 152,
    spawnBase: 1.52,
    spawnPerLv: 0.09,
    spawnMin: 0.5,
    wasabiBase: 0.06,
    wasabiPerLv: 0.014,
    wasabiMax: 0.21,
    teaChance: 0.09,
    patienceBase: 36,
    patienceMin: 17,
    patiencePerLv: 1.6,
    deliverBonus: 150,
    orderBonusBase: 320,
    orderBonusPerPlate: 220
  };

  /* SECTION: tips */
  var TIPS = [
    '优先完成客人点单，送菜奖励远高于单打寿司。',
    '金盘寿司分值最高，但出现得更少——看到就别放过。',
    '酱油会慢慢回复，别在没人点单时乱开枪。',
    '连击倍率最高 ×8，连续命中比零散命中划算得多。',
    '绿色芥末盘上有个骷髅标记，打中会丢一条命。',
    '客人耐心见底时头像会发红，先救急再追高分。',
    '等级越高传送带越快、芥末越多，前期攒命很关键。',
    '绿茶 🍵 能立刻补 6 发酱油，弹药吃紧时优先打它。'
  ];

  /* ============================================================
     SECTION: audio — Web Audio 合成音效，无外部音频文件
     ============================================================ */
  var Audio_ = {
    ctx: null,
    enabled: true,
    master: null,

    ensure: function () {
      if (this.ctx) { return this.ctx; }
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { return null; }
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.32;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        this.ctx = null;
      }
      return this.ctx;
    },

    resume: function () {
      var c = this.ensure();
      if (c && c.state === 'suspended' && c.resume) { c.resume(); }
    },

    tone: function (opt) {
      if (!this.enabled) { return; }
      var c = this.ensure();
      if (!c) { return; }
      var t0 = c.currentTime + (opt.delay || 0);
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = opt.type || 'sine';
      osc.frequency.setValueAtTime(opt.f0, t0);
      if (opt.f1 && opt.f1 !== opt.f0) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(opt.f1, 1), t0 + (opt.dur || 0.14));
      }
      var vol = (opt.vol == null ? 0.5 : opt.vol);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (opt.dur || 0.14));
      osc.connect(g);
      g.connect(this.master);
      osc.start(t0);
      osc.stop(t0 + (opt.dur || 0.14) + 0.03);
    },

    noise: function (dur, vol, freq) {
      if (!this.enabled) { return; }
      var c = this.ensure();
      if (!c) { return; }
      var len = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, len, c.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) { d[i] = (Math.random() * 2 - 1) * (1 - i / len); }
      var src = c.createBufferSource();
      src.buffer = buf;
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq || 900;
      bp.Q.value = 0.9;
      var g = c.createGain();
      g.gain.value = vol == null ? 0.3 : vol;
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start();
    },

    shoot: function () {
      this.tone({ type: 'square', f0: 620, f1: 190, dur: 0.075, vol: 0.16 });
      this.noise(0.06, 0.1, 1500);
    },
    hit: function (tier) {
      var f = tier === 'gold' ? 1180 : tier === 'silver' ? 980 : tier === 'blue' ? 820 : 700;
      this.tone({ type: 'triangle', f0: f, f1: f * 1.5, dur: 0.11, vol: 0.3 });
      this.noise(0.05, 0.09, 2200);
    },
    tea: function () {
      this.tone({ type: 'sine', f0: 520, f1: 780, dur: 0.1, vol: 0.26 });
      this.tone({ type: 'sine', f0: 780, f1: 1040, dur: 0.12, vol: 0.22, delay: 0.08 });
    },
    deliver: function () {
      var self = this;
      [660, 880, 1100].forEach(function (f, i) {
        self.tone({ type: 'triangle', f0: f, f1: f, dur: 0.1, vol: 0.24, delay: i * 0.055 });
      });
    },
    complete: function () {
      var self = this;
      [523, 659, 784, 1046].forEach(function (f, i) {
        self.tone({ type: 'triangle', f0: f, f1: f, dur: 0.16, vol: 0.28, delay: i * 0.075 });
      });
    },
    wasabi: function () {
      this.tone({ type: 'sawtooth', f0: 220, f1: 60, dur: 0.42, vol: 0.3 });
      this.noise(0.3, 0.18, 380);
    },
    angry: function () {
      this.tone({ type: 'sawtooth', f0: 320, f1: 110, dur: 0.36, vol: 0.24 });
      this.tone({ type: 'square', f0: 150, f1: 70, dur: 0.3, vol: 0.16, delay: 0.06 });
    },
    levelup: function () {
      var self = this;
      [392, 523, 659, 784, 1046].forEach(function (f, i) {
        self.tone({ type: 'square', f0: f, f1: f, dur: 0.13, vol: 0.2, delay: i * 0.07 });
      });
    },
    over: function () {
      var self = this;
      [523, 440, 349, 262].forEach(function (f, i) {
        self.tone({ type: 'triangle', f0: f, f1: f * 0.98, dur: 0.32, vol: 0.28, delay: i * 0.16 });
      });
    },
    empty: function () {
      this.tone({ type: 'square', f0: 180, f1: 120, dur: 0.07, vol: 0.13 });
    },
    start: function () {
      var self = this;
      [523, 784, 1046].forEach(function (f, i) {
        self.tone({ type: 'triangle', f0: f, f1: f, dur: 0.14, vol: 0.26, delay: i * 0.08 });
      });
    }
  };

  global.SUSHI_GAME = {
    SUSHI: SUSHI,
    TIERS: TIERS,
    FACES: FACES,
    HAPPY: HAPPY,
    ANGRY: ANGRY,
    LAYOUT: LAYOUT,
    BALANCE: BALANCE,
    TIPS: TIPS,
    Audio: Audio_
  };
})(window);
