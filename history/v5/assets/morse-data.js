/* ============================================================
   深夜电台 · 摩尔斯电码 · 数据 / 关卡 / 音效
   SECTION: morse-data
   ------------------------------------------------------------
   码表为标准 ITU 摩尔斯：'.' 为点、'-' 为划。
   教学顺序（group）按"先学最容易分辨的、再学最常用的"排，
   不是按字母表 —— 这样第一关就能发通真实的短电文，
   成就感来得快，也不至于一上来被 36 个码表吓退。

   数字的规律单独记忆更省力：n 个点 + 补划到 5 位（0 是五个划）。
   ============================================================ */
window.MORSE_DATA = (function () {
  'use strict';

  /* SECTION: table
     g = 教学分组（1 最先学）；tip = 记忆口诀，界面上答错/查看时给出 */
  var CHARS = [
    /* g1 · 最短的两个，先建立"点=短、划=长"的手感 */
    { ch: 'E', code: '.', g: 1, tip: '最短的码：一个点。它也是英文里出现最多的字母。' },
    { ch: 'T', code: '-', g: 1, tip: '一个划。和 E 一起记：点短划长。' },

    /* g2 · 高频字母，凑齐后已经能发 SOS / TEAM / NOTE 这类真词 */
    { ch: 'A', code: '.-', g: 2, tip: '点划。字母表第一个，先点后划，很好记。' },
    { ch: 'I', code: '..', g: 2, tip: '两个点。' },
    { ch: 'N', code: '-.', g: 2, tip: '划点，No 的开头。' },
    { ch: 'M', code: '--', g: 2, tip: '两个划。' },
    { ch: 'S', code: '...', g: 2, tip: '三个点 —— SOS 的头。' },
    { ch: 'O', code: '---', g: 2, tip: '三个划 —— SOS 的尾。' },

    /* g3 */
    { ch: 'R', code: '.-.', g: 3, tip: '点划点，左右对称，很好认。' },
    { ch: 'K', code: '-.-', g: 3, tip: '划点划，同样对称。' },
    { ch: 'D', code: '-..', g: 3, tip: '划点点。' },
    { ch: 'U', code: '..-', g: 3, tip: '点点划。' },
    { ch: 'W', code: '.--', g: 3, tip: '点划划。' },
    { ch: 'H', code: '....', g: 3, tip: '四个点，最"密"的字母。' },

    /* g4 */
    { ch: 'L', code: '.-..', g: 4, tip: '点划点点。' },
    { ch: 'G', code: '--.', g: 4, tip: '划划点。' },
    { ch: 'C', code: '-.-.', g: 4, tip: '划点划点，CQ 呼叫的开头。' },
    { ch: 'F', code: '..-.', g: 4, tip: '点点划点。' },
    { ch: 'P', code: '.--.', g: 4, tip: '点划划点，回文一样的对称结构。' },
    { ch: 'B', code: '-...', g: 4, tip: '划点点点。' },

    /* g5 · 剩下的字母 */
    { ch: 'V', code: '...-', g: 5, tip: '点点点划，V 是胜利的手势。' },
    { ch: 'J', code: '.---', g: 5, tip: '点划划划。' },
    { ch: 'Q', code: '--.-', g: 5, tip: '划划点划。' },
    { ch: 'X', code: '-..-', g: 5, tip: '划点点划，左右对称。' },
    { ch: 'Y', code: '-.--', g: 5, tip: '划点划划。' },
    { ch: 'Z', code: '--..', g: 5, tip: '划划点点。' },

    /* g6 · 数字：n 个点 + 补划到 5 位 */
    { ch: '0', code: '-----', g: 6, tip: '五个划，唯一的例外。' },
    { ch: '1', code: '.----', g: 6, tip: '1 个点 + 4 个划。' },
    { ch: '2', code: '..---', g: 6, tip: '2 个点 + 3 个划。' },
    { ch: '3', code: '...--', g: 6, tip: '3 个点 + 2 个划。' },
    { ch: '4', code: '....-', g: 6, tip: '4 个点 + 1 个划。' },
    { ch: '5', code: '.....', g: 6, tip: '5 个点。' },
    { ch: '6', code: '-....', g: 6, tip: '1 个划 + 4 个点，从 5 开始反过来。' },
    { ch: '7', code: '--...', g: 6, tip: '2 个划 + 3 个点。' },
    { ch: '8', code: '---..', g: 6, tip: '3 个划 + 2 个点。' },
    { ch: '9', code: '----.', g: 6, tip: '4 个划 + 1 个点。' }
  ];

  var BY_CHAR = {};
  var BY_CODE = {};
  for (var i = 0; i < CHARS.length; i++) {
    BY_CHAR[CHARS[i].ch] = CHARS[i];
    BY_CODE[CHARS[i].code] = CHARS[i];
  }

  /* SECTION: groups · 教学分组说明（面板上展示"本关新学"用） */
  var GROUPS = {
    1: { name: '起手式', desc: '点短、划长 —— 先把这个手感练进手指' },
    2: { name: '高频字母', desc: 'A I N M S O：凑齐就能发 SOS 和常见短词' },
    3: { name: '对称好认', desc: 'R K D U W H：形状对称，记起来省力' },
    4: { name: '进阶字母', desc: 'L G C F P B' },
    5: { name: '补齐字母', desc: 'V J Q X Y Z' },
    6: { name: '数字', desc: 'n 个点 + 补划到 5 位，0 是全划' }
  };

  /* SECTION: words · 电文候选词（发报内容用真词，比随机字母有趣也好记） */
  var WORDS = ('SOS TEA SEA SAINT MOON STONE MOTION ITEM MAIN NAME TIME NOTE MEAT SEAT MEAN TEAM SOON MIST ' +
    'AT IT NO ON SO TO ME IS IN AN AS ONES SAME SAID SITE MINE TONE STEM TAKE TALE TIDE TILE TINT ' +
    'IRON NEAR SEAT SORT RAIN ROAD READ REAL REST ROSE NAME NOSE NEAT NEST NINE MORE MOON ' +
    'HELLO WORLD RADIO MORSE SIGNAL KEY PORT SHIP TOWER LIGHT NORTH SOUTH EAST WEST ' +
    'CODE TEST HAM RELAY BEACON MARINE RESCUE ORBIT ROCKET SILENT STORM NIGHT VIGIL ' +
    'WAKE KEEP CLEAR COAST FLEET CREW ANCHOR HARBOR MESSAGE STATION LOUD CLEAR COPY ROGER ' +
    'JAZZ QUARTZ ZEPHYR VIXEN YACHT WALTZ FJORD GLYPH BREEZE CYCLE PIXEL VECTOR MATRIX').split(/\s+/);

  var NUM_WORDS = ['12', '24', '49', '73', '88', '99', '10', '36', '57', '21'];

  /* SECTION: levelConfig
     关卡推进：每关解锁一组新字符；电文条数与长度缓慢增加，生命固定 3。
     msgLen 上限 6，避免一关太长让人烦。 */
  function levelConfig(level) {
    var lv = Math.max(1, level | 0);
    var groups = Math.min(6, lv + 1);                 // lv1 → g1~g2
    return {
      level: lv,
      groups: groups,
      newGroup: lv + 1 <= 6 ? lv + 1 : 0,             // 本关新解锁的组（用于"本关新学"提示）
      messages: Math.min(5, 3 + Math.floor((lv - 1) / 2)),
      msgLen: Math.min(6, 3 + Math.floor((lv - 1) / 3)),
      lives: 3,
      /* 每个字符的"标准用时"，用来算速度奖励 */
      paceMs: Math.max(2200, 4200 - (lv - 1) * 260)
    };
  }

  /* 某关可用字符（按教学分组累加） */
  function charsForGroups(groups) {
    var out = [];
    for (var i = 0; i < CHARS.length; i++) {
      if (CHARS[i].g <= groups) { out.push(CHARS[i].ch); }
    }
    return out;
  }

  /* SECTION: recvConfig · 抄收（听/看码解码）关卡
     选项数从 3 涨到 4；速度按标准 WPM 递进（点长 = 1.2s / WPM）。
     一开始给 6 WPM（点 200ms）—— 慢到能听清；到第 9 关 14 WPM（点 86ms）。 */
  function recvConfig(level) {
    var lv = Math.max(1, level | 0);
    return {
      level: lv,
      groups: Math.min(6, lv + 1),
      newGroup: lv + 1 <= 6 ? lv + 1 : 0,
      rounds: Math.min(8, 5 + Math.floor((lv - 1) / 3)),
      options: lv >= 3 ? 4 : 3,
      wpm: Math.min(14, 6 + (lv - 1)),
      lives: 3,
      /* 每题给多少时间（含播放时长），超了就没有速度奖励 */
      budgetMs: Math.max(3200, 6500 - (lv - 1) * 320)
    };
  }

  /* SECTION: digitConfig · 数字专项（编码 + 解码交替）
     数字只有 10 个、规律性强（n 个点补划到 5 位），所以单独练。 */
  function digitConfig(level) {
    var lv = Math.max(1, level | 0);
    return {
      level: lv,
      rounds: 6,
      wpm: Math.min(12, 5 + (lv - 1)),
      lives: 3,
      budgetMs: Math.max(3400, 7000 - (lv - 1) * 380)
    };
  }

  var TIPS = [
    '短按出点、按住不放出划；松手后停顿一下，就是一个字符结束 —— 这正是真实的发报节奏。',
    '拿不准的时候按「收听」，先让耳朵记住节奏，比死看码表管用。',
    '点划时长比是 1:3，划要明显拖长，别让收报方听混。',
    '数字有规律：n 个点补划到 5 位，只有 0 是五个划。',
    '答错的字符电台会记下来，后面几轮会再考你一次。'
  ];

  /* SECTION: 抄收 / 数字 两个模式的文案与提示 */
  var RECV_TIPS = [
    '先听「节奏形状」再想字母：A 是「短-长」，N 是「长-短」，别一个点一个点地数。',
    '字母越长越难，但它前面几位能猜到后面 —— 比如听到「划划」先想 M / O / G。',
    '看不清就切「看码」模式读点划条；听不清就按 L 再放一次（本字得分减半）。',
    '真实报务员是整词成组地抄，练到后面试试连着听两个字符。'
  ];

  var DIGIT_TIPS = [
    '数字规律：1 是「1 个点 + 4 个划」，2 是「2 点 + 3 划」…… 5 是五个点；6~9 反过来，划在前。',
    '0 是唯一的例外：五个划。',
    '数字码都很长（5 位），听的时候抓住「点划分界」的位置就能定位。',
    '发数字时手要拖够长 —— 划发短了，5 位码很容易被听成别的数字。'
  ];

  /* 数字「律」的图示说明（数字模式面板上常驻展示） */
  var DIGIT_LAW = [
    { n: '0', code: '-----', note: '五个划（唯一例外）' },
    { n: '1~5', code: '·→再补划', note: 'n 个点，后面补划到 5 位' },
    { n: '6~9', code: '划→再补点', note: '反过来：划在前，点补到 5 位' }
  ];

  /* SECTION: audio（Web Audio 合成，无外部音频文件）
     电键按下时是"持续音"（真实电台的侧音 sidetone），松手才停 —— 手感靠它。 */
  var Audio = (function () {
    var ctx = null, enabled = true, live = null;
    function ac() {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
      }
      if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* 忽略 */ } }
      return ctx;
    }
    function tone(opt) {
      if (!enabled) { return; }
      var c = ac(); if (!c) { return; }
      var dur = opt.dur || 0.12;
      var o = c.createOscillator(), g = c.createGain();
      o.type = opt.type || 'sine';
      o.frequency.setValueAtTime(opt.f0, c.currentTime);
      if (opt.f1) { o.frequency.exponentialRampToValueAtTime(Math.max(1, opt.f1), c.currentTime + dur); }
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(opt.vol || 0.18, c.currentTime + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + dur + 0.02);
    }
    function noise(dur, vol) {
      if (!enabled) { return; }
      var c = ac(); if (!c) { return; }
      var n = Math.floor(c.sampleRate * dur);
      var buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) { data[i] = (Math.random() * 2 - 1) * (1 - i / n); }
      var src = c.createBufferSource(), g = c.createGain();
      src.buffer = buf;
      g.gain.setValueAtTime(vol || 0.09, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      src.connect(g); g.connect(c.destination);
      src.start();
    }
    return {
      get enabled() { return enabled; },
      set enabled(v) { enabled = !!v; if (!enabled) { this.keyOff(); } },
      resume: function () { ac(); },
      /* 电键按住 → 持续侧音；松开 → 停 */
      keyOn: function () {
        if (!enabled) { return; }
        var c = ac(); if (!c || live) { return; }
        var o = c.createOscillator(), g = c.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(700, c.currentTime);
        g.gain.setValueAtTime(0.0001, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.16, c.currentTime + 0.008);
        o.connect(g); g.connect(c.destination);
        o.start();
        live = { o: o, g: g };
      },
      keyOff: function () {
        if (!live) { return; }
        var c = ctx, o = live.o, g = live.g;
        live = null;
        try {
          g.gain.cancelScheduledValues(c.currentTime);
          g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), c.currentTime);
          g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.01);
          o.stop(c.currentTime + 0.03);
        } catch (e) { /* 忽略 */ }
      },
      /* 回放一个码（点 90ms、划 260ms，间隔 90ms） */
      play: function (code, opt) {
        if (!enabled) { return 0; }
        var c = ac(); if (!c) { return 0; }
        var dot = (opt && opt.unit) || 0.09;
        var t = c.currentTime + 0.04;
        for (var i = 0; i < code.length; i++) {
          var d = code[i] === '.' ? dot : dot * 3;
          var o = c.createOscillator(), g = c.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime((opt && opt.freq) || 700, t);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.16, t + 0.008);
          g.gain.setValueAtTime(0.16, t + d - 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + d);
          o.connect(g); g.connect(c.destination);
          o.start(t); o.stop(t + d + 0.02);
          t += d + dot;
        }
        return (t - c.currentTime) * 1000;   // 返回这段码的播放时长（ms）
      },
      good: function (combo) {
        var n = Math.min(combo || 1, 6);
        tone({ type: 'sine', f0: 660 + n * 60, f1: 1180 + n * 90, dur: 0.13, vol: 0.16 });
      },
      bad: function () { tone({ type: 'sawtooth', f0: 240, f1: 90, dur: 0.26, vol: 0.13 }); noise(0.22, 0.1); },
      levelup: function () {
        tone({ type: 'triangle', f0: 620, f1: 900, dur: 0.12, vol: 0.18 });
        tone({ type: 'triangle', f0: 930, f1: 1320, dur: 0.16, vol: 0.18 });
      },
      over: function () { tone({ type: 'sine', f0: 460, f1: 140, dur: 0.5, vol: 0.18 }); },
      tick: function () { tone({ type: 'square', f0: 1400, dur: 0.02, vol: 0.05 }); }
    };
  })();

  return {
    CHARS: CHARS, BY_CHAR: BY_CHAR, BY_CODE: BY_CODE, GROUPS: GROUPS,
    WORDS: WORDS, NUM_WORDS: NUM_WORDS,
    levelConfig: levelConfig, recvConfig: recvConfig, digitConfig: digitConfig,
    charsForGroups: charsForGroups,
    TIPS: TIPS, RECV_TIPS: RECV_TIPS, DIGIT_TIPS: DIGIT_TIPS, DIGIT_LAW: DIGIT_LAW,
    Audio: Audio
  };
})();
