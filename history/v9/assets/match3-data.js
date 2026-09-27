/* ============================================================
   AI图标消消乐 · 数据、图标与音效模块
   SECTION: match3-data
   ============================================================ */
window.MATCH3_DATA = (function () {
  'use strict';

  /* SECTION: icons
     img 为公开网络检索得到的图标地址，运行时以 img.src 赋值加载；
     加载失败（onerror）时由渲染层回退到品牌配色徽章（letter + 渐变），
     网络恢复后真实图标自动生效，玩法不受影响。 */
  var ICONS = [
    { id: 'chatgpt',    name: 'ChatGPT',    letter: 'GPT', c1: '#19c37d', c2: '#0a6b4a', img: 'https://agent.qianwen.com/service/44946423-0d9a-45/e99252294a0012a05370f7cbcbe5e100' },
    { id: 'gemini',     name: 'Gemini',     letter: '✦',  c1: '#a78bfa', c2: '#4285f4', img: 'https://agent.qianwen.com/service/7401748d-3769-48/11c2ecd149f83e56c759647d0bc2ad1e' },
    { id: 'qwen',       name: '通义千问',    letter: 'Q',  c1: '#8b7bff', c2: '#4a3ad6', img: 'https://agent.qianwen.com/service/14767481-9d86-44/9c16c279660b988217b7fa140cbf5c35' },
    { id: 'deepseek',   name: 'DeepSeek',   letter: 'DS', c1: '#5b8def', c2: '#2f5fc0', img: 'https://agent.qianwen.com/service/95fc30d0-36d7-4c/405d0bfb960ac009709c8475a866b38c' },
    { id: 'copilot',    name: 'Copilot',    letter: 'Co', c1: '#4aa3f0', c2: '#e0a52e', img: 'https://agent.qianwen.com/service/01acfb7a-134a-46/2b05d5055c892d09891624f7373e6c14' },
    { id: 'perplexity', name: 'Perplexity', letter: 'Px', c1: '#20b8cd', c2: '#0e7d8c', img: 'https://agent.qianwen.com/service/027c108a-f8cf-4b/4576227d5df34756907b8989c8300d93' },
    { id: 'doubao',     name: '豆包',        letter: '豆', c1: '#8a6cff', c2: '#5a3fd6', img: 'https://agent.qianwen.com/service/2b3016c8-50dd-4d/a8bfff26fa3a58058c5e168a1b50fc7d' },
    { id: 'ernie',      name: '文心一言',    letter: '文', c1: '#5560e8', c2: '#2932a1', img: 'https://agent.qianwen.com/service/143ad906-c6df-4e/86a8130280df65aabfa8a2eaf3480e00' },
    { id: 'kimi',       name: 'Kimi',       letter: 'K',  c1: '#2b8cff', c2: '#0e4fb3', img: 'https://agent.qianwen.com/service/11ce4c78-d232-4b/ea7081ef37238f782547ef3224ef3093' },
    { id: 'grok',       name: 'Grok',       letter: 'X',  c1: '#4a4a4a', c2: '#0a0a0a', img: 'https://agent.qianwen.com/service/958fdff5-bc86-49/5852a0664edf46d7ebb8b14cb84638ef' }
  ];

  /* SECTION: levels */
  function levelConfig(level) {
    var lv = Math.max(1, level | 0);
    return {
      target: 800 + (lv - 1) * 500,
      moves: Math.max(14, 22 - Math.floor((lv - 1) / 2))
    };
  }

  var TIPS = [
    '四连生成横向清除，五连生成全色清除，点击即可引爆。',
    '连锁消除倍率递增，优先制造能连消的局面。',
    '没有可消除组合时棋盘会自动重排，不会卡死。',
    '在棋盘底部消除，能引发更大范围的连锁下落。'
  ];

  /* SECTION: audio (Web Audio 合成，无外部音频文件) */
  var Audio = (function () {
    var ctx = null, enabled = true;
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
    return {
      get enabled() { return enabled; },
      set enabled(v) { enabled = !!v; },
      resume: function () { ac(); },
      swap:     function () { tone({ type: 'triangle', f0: 420, f1: 600, dur: 0.07, vol: 0.13 }); },
      bad:      function () { tone({ type: 'sawtooth', f0: 200, f1: 110, dur: 0.13, vol: 0.10 }); },
      pop:      function (chain) { var n = Math.min(chain, 6); tone({ type: 'sine', f0: 520 + n * 110, f1: 900 + n * 150, dur: 0.1, vol: 0.17 }); },
      special:  function () { tone({ type: 'square', f0: 700, f1: 1250, dur: 0.16, vol: 0.15 }); },
      boom:     function () { tone({ type: 'sawtooth', f0: 320, f1: 60, dur: 0.3, vol: 0.2 }); },
      levelup:  function () { tone({ type: 'triangle', f0: 620, f1: 1240, dur: 0.24, vol: 0.2 }); },
      win:      function () { tone({ type: 'sine', f0: 880, f1: 1320, dur: 0.3, vol: 0.22 }); },
      lose:     function () { tone({ type: 'sine', f0: 400, f1: 150, dur: 0.4, vol: 0.18 }); },
      shuffle:  function () { tone({ type: 'triangle', f0: 300, f1: 720, dur: 0.2, vol: 0.14 }); }
    };
  })();

  return { ICONS: ICONS, levelConfig: levelConfig, TIPS: TIPS, Audio: Audio };
})();
