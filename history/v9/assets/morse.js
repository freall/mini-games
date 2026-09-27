/* ============================================================
   深夜电台 · 摩尔斯电码 · 界面与玩法（三种模式）
   SECTION: morse
   ------------------------------------------------------------
   一个游戏、三种练法，共用电台面板 / 音效 / 生命 / 熟练度与掌握进度：

     📡 发报 send   给一条电文（真词），用电键把它发出去
                    —— 短按出点、按住出划、松手停顿即字符结束
     🎧 抄收 recv   听电台发来的码（或切「看码」读点划条），从选项里选出字符
     🔢 数字 digit  数字专项：一半「给数字 → 用电键发码」，一半「听/看码 → 认数字」

   帮助记住的三件事在所有模式里通用：
     1. 字符按 6 个教学组逐关解锁，每关只多学一组；
     2. 答错立刻回放正确码 + 给口诀；错过的字符进"待复习"，后面几轮还会遇到；
     3. 每个字符记熟练度（对 +2、错 −1，≥6 算掌握），长期存本地，门户显示进度。

   「再放一次」「看答案」随时可用，但看过答案的那道题得分减半 —— 想拿高分就得靠记。
   ============================================================ */
window.MORSE_APP = (function () {
  'use strict';

  var D = window.MORSE_DATA, C = window.MORSE_CORE, A = D.Audio;

  var el = {};
  var active = false;
  var state = 'menu';                 // menu | playing | paused | clear | over
  var MODES = ['send', 'recv', 'digit'];
  var MODE_INFO = {
    send: { name: '发报', art: '📡', kana: 'SENDING', btn: '开始值班',
      brief: '把电文发出去：短按出「点」、按住出「划」，松手停顿一下就是一个字符。',
      rules: [
        ['👆', '短按电键＝<b>点</b>，按住不放＝<b>划</b>'],
        ['⏸️', '松手后<b>停顿一下</b>＝一个字符发完'],
        ['💔', '发错扣一条命，<b>错字后面还会再考</b>']
      ] },
    recv: { name: '抄收', art: '🎧', kana: 'RECEIVING', btn: '开始抄收',
      brief: '听（或看）电台发来的一段码，从选项里选出它是哪个字符。',
      rules: [
        ['🔊', '默认<b>听</b>：别数点划，先记<b>节奏形状</b>'],
        ['👁', '也可以切「<b>看码</b>」：点划条会一段段亮出来'],
        ['🔁', '拿不准按 <b>L 再放一次</b>；看答案则本题<b>得分减半</b>']
      ] },
    digit: { name: '数字', art: '🔢', kana: 'NUMBERS', btn: '开始练数字',
      brief: '数字专项：一半题目给你数字让你发码，一半给你码让你认数字。',
      rules: [
        ['🔢', '数字码都是 5 位，<b>规律</b>比死记好用'],
        ['✍️', '<b>编码题</b>：显示数字，用电键把它的码发出来'],
        ['🎧', '<b>解码题</b>：听/看码，从 0~9 里选出是哪个数字']
      ] }
  };

  var mode = 'send';
  var viewMode = 'listen';            // 抄收/数字里的呈现方式：listen 听 / watch 看

  /* 一局的运行时数据 */
  var level = 1, score = 0, runTotal = 0, combo = 0, bestCombo = 0, lives = 3;
  var okCount = 0, tryCount = 0, helped = false;
  var charStartAt = 0;

  /* 发报模式 */
  var plan = null, msgIndex = 0, charIndex = 0, wrongHere = 0;
  var buffer = '', pressing = false, pressAt = 0;

  /* 抄收 / 数字模式 */
  var rplan = null, dplan = null, roundIndex = 0, answered = false, playToken = 0;

  /* 计时器 */
  var gapTimer = null, paceTimer = null, nextRoundTimer = null, playTimer = null;

  /* 长期存档（掌握度与复习队列三个模式共用；最高分/最高关卡按模式分开记） */
  var best = { send: 0, recv: 0, digit: 0 };
  var levelBest = { send: 1, recv: 1, digit: 1 };
  var mastery = {}, review = [];

  var $ = function (id) { return document.getElementById(id); };
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /* SECTION: storage */
  function loadStore() {
    try {
      for (var i = 0; i < MODES.length; i++) {
        var m = MODES[i];
        best[m] = parseInt(window.localStorage.getItem('morse-' + m + '-best') || '0', 10) || 0;
        levelBest[m] = parseInt(window.localStorage.getItem('morse-' + m + '-level') || '1', 10) || 1;
      }
      /* 兼容早期只发报一版存的键名 */
      var legacy = parseInt(window.localStorage.getItem('morse-best') || '0', 10) || 0;
      if (legacy > best.send) { best.send = legacy; }
      var legacyLv = parseInt(window.localStorage.getItem('morse-level') || '1', 10) || 1;
      if (legacyLv > levelBest.send) { levelBest.send = legacyLv; }

      mastery = JSON.parse(window.localStorage.getItem('morse-mastery') || '{}') || {};
      if (typeof mastery !== 'object' || mastery === null) { mastery = {}; }
      var saved = window.localStorage.getItem('morse-mode');
      if (saved && MODES.indexOf(saved) >= 0) { mode = saved; }
    } catch (e) { mastery = {}; }
  }

  function saveStore() {
    try {
      for (var i = 0; i < MODES.length; i++) {
        var m = MODES[i];
        window.localStorage.setItem('morse-' + m + '-best', String(best[m]));
        window.localStorage.setItem('morse-' + m + '-level', String(levelBest[m]));
      }
      window.localStorage.setItem('morse-best', String(best.send));      // 门户卡片仍读这个
      window.localStorage.setItem('morse-level', String(levelBest.send));
      window.localStorage.setItem('morse-mastery', JSON.stringify(mastery));
      window.localStorage.setItem('morse-mode', mode);
    } catch (e) { /* 忽略隐私模式限制 */ }
  }

  /* SECTION: dom-cache */
  function cacheDom() {
    var ids = ['morseLevel', 'morseScore', 'morseTotal', 'morseCombo', 'morseSignal', 'morseSignalBar',
      'morseLives', 'morseWord', 'morseWordNo', 'morseBuffer', 'morseKey', 'morseLamp', 'morseStatus',
      'morseMastery', 'morseMasteryBar', 'morseNewChars', 'morseCharTip', 'morseToast', 'morsePaceBar',
      'morseBtnSound', 'morseBtnPause', 'morseBtnListen', 'morseBtnReveal', 'morseBtnPlay', 'morseBtnView',
      'morseTabs', 'morseTabSend', 'morseTabRecv', 'morseTabDigit', 'morseChooserStart', 'morseChooserOver',
      'morseViewRow', 'morsePanelSend', 'morsePanelRecv', 'morsePanelDigit',
      'morseRoundNo', 'morseWpm', 'morseOptions', 'morseRoundLabel', 'morseTrace', 'morseProgress',
      'morseDigitType', 'morseDigitTask', 'morseDigitOptions',
      'morseStartArt', 'morseStartTitle', 'morseStartKana', 'morseStartBrief', 'morseCodebook', 'morseRules',
      'morseOvStart', 'morseBtnStart', 'morseOvPause', 'morseBtnResume', 'morseBtnQuit',
      'morseOvOver', 'morseOvOverTitle', 'morseOvOverArt', 'morseOvOverKana',
      'morseRLevel', 'morseRScore', 'morseRTotal', 'morseRAcc', 'morseRCombo', 'morseRMastery',
      'morseRBest', 'morseRRecord', 'morseRTip', 'morseBtnRetry', 'morseBtnNext', 'morseBtnEndRun'];
    for (var i = 0; i < ids.length; i++) { el[ids[i]] = $(ids[i]); }
  }

  /* SECTION: 基础渲染工具 */
  function setTxt(node, txt) { if (node && node.textContent !== txt) { node.textContent = txt; } }
  function show(node, on) { if (node) { node.classList.toggle('show', !!on); } }
  function showEl(node, on) { if (node) { node.style.display = on ? '' : 'none'; } }

  /* 生命点：按数量拼出来（剩下的实心、丢掉的空心），
     不要用 '❤❤❤'.slice(0, n*2) —— '❤' 是单个 UTF-16 码元，长度算错会让扣命看起来没变化 */
  function hearts(n, max) {
    var s = '';
    for (var i = 0; i < Math.max(0, n); i++) { s += '❤'; }
    for (var j = n; j < Math.max(max, n); j++) { s += '🖤'; }
    return s || '—';
  }

  function codeText(code) { return (code || '').replace(/\./g, '·').replace(/-/g, '—'); }

  /* SECTION: 当前模式的状态查询 */
  function cfg() {
    if (mode === 'recv') { return D.recvConfig(level); }
    if (mode === 'digit') { return D.digitConfig(level); }
    return D.levelConfig(level);
  }
  function charsNow() {
    if (mode === 'digit') { return '0123456789'.split(''); }
    if (mode === 'recv' && rplan) { return rplan.chars; }
    if (mode === 'send' && plan) { return plan.chars; }
    return D.charsForGroups(cfg().groups);
  }
  /* 当前要处理的字符：发报看电文第几位；抄收/数字看第几题 */
  function target() {
    if (mode === 'recv') { return rplan ? rplan.rounds[roundIndex].ch : ''; }
    if (mode === 'digit') { return dplan ? dplan.rounds[roundIndex].ch : ''; }
    return plan ? plan.messages[msgIndex].charAt(charIndex) : '';
  }
  function targetCode() { return C.codeOf(target()); }
  function digitType() { return (mode === 'digit' && dplan) ? dplan.rounds[roundIndex].type : ''; }
  /* 需要用电键作答的场合：发报，以及数字模式的编码题 */
  function isKeyMode() { return state === 'playing' && (mode === 'send' || (mode === 'digit' && digitType() === 'encode')); }
  function runScore() { return runTotal + score; }
  function budgetMs() { var c = cfg(); return c.paceMs || c.budgetMs || 4000; }
  function baseScore() { return mode === 'send' ? 10 : (mode === 'recv' ? 12 : 14); }
  function roundTotal() {
    if (mode === 'recv') { return rplan ? rplan.rounds.length : 0; }
    if (mode === 'digit') { return dplan ? dplan.rounds.length : 0; }
    return plan ? plan.messages.length : 0;
  }

  /* SECTION: HUD */
  function renderHud() {
    setTxt(el.morseLevel, String(level));
    setTxt(el.morseScore, String(score));
    setTxt(el.morseTotal, String(runScore()));
    setTxt(el.morseCombo, '×' + C.comboMult(combo));
    var s = C.signalStrength(combo);
    setTxt(el.morseSignal, 'S' + s);
    if (el.morseSignalBar) { el.morseSignalBar.style.width = Math.round((s / 9) * 100) + '%'; }
    setTxt(el.morseLives, hearts(lives, cfg().lives));

    var chars = charsNow();
    var got = C.masteredCount(mastery, chars);
    setTxt(el.morseMastery, got + ' / ' + chars.length);
    if (el.morseMasteryBar) { el.morseMasteryBar.style.width = Math.round((got / chars.length) * 100) + '%'; }
  }

  function renderTip(tip, cls) {
    setTxt(el.morseCharTip, tip || MODE_INFO[mode].brief);
    if (el.morseCharTip) {
      el.morseCharTip.classList.toggle('warn', cls === 'warn');
      el.morseCharTip.classList.toggle('ok', cls === 'ok');
    }
  }

  function renderNewChars() {
    var g = cfg().newGroup;
    if (mode === 'digit') {
      setTxt(el.morseNewChars, '本关练数字：' + D.DIGIT_LAW[0].n + ' = ' + codeText(D.DIGIT_LAW[0].code));
      return;
    }
    if (!g || !D.GROUPS[g]) { setTxt(el.morseNewChars, '全部字符已解锁'); return; }
    var list = [];
    var all = D.CHARS;
    for (var i = 0; i < all.length; i++) { if (all[i].g === g) { list.push(all[i].ch); } }
    setTxt(el.morseNewChars, D.GROUPS[g].name + '：' + list.join(' '));
  }

  function toast(txt, ms) {
    setTxt(el.morseToast, txt);
    show(el.morseToast, true);
    clearTimeout(el._toastTimer);
    el._toastTimer = setTimeout(function () { show(el.morseToast, false); }, ms || 1600);
  }

  /* 已敲的码：点划以图形呈现，玩家能立刻看到自己"手抖"成了什么 */
  function renderBuffer() {
    var host = el.morseBuffer;
    if (!host) { return; }
    host.innerHTML = '';
    for (var i = 0; i < buffer.length; i++) {
      var b = document.createElement('i');
      b.className = buffer[i] === '.' ? 'dot' : 'dash';
      host.appendChild(b);
    }
    host.classList.toggle('empty', buffer.length === 0);
  }

  function renderWord() {
    var msg = (mode === 'send' && plan) ? plan.messages[msgIndex] : '';
    var host = el.morseWord;
    if (!host) { return; }
    host.innerHTML = '';
    for (var i = 0; i < msg.length; i++) {
      var span = document.createElement('span');
      span.className = 'mr-char' + (i < charIndex ? ' done' : (i === charIndex ? ' cur' : ''));
      span.dataset.ch = msg.charAt(i);
      span.textContent = msg.charAt(i);
      host.appendChild(span);
    }
    setTxt(el.morseWordNo, (msgIndex + 1) + ' / ' + roundTotal());
  }

  /* 抄收 / 数字：进度与速度 */
  function renderRoundInfo() {
    var idx = mode === 'send' ? msgIndex : roundIndex;
    if (el.morseRoundNo) { setTxt(el.morseRoundNo, (idx + 1) + ' / ' + roundTotal()); }
    var c = cfg();
    if (c.wpm && el.morseWpm) { setTxt(el.morseWpm, c.wpm + ' WPM'); }   /* 发报模式没有 WPM 概念 */
  }

  /* 抄收的选项组 / 数字模式的 0~9 按钮组 */
  function renderOptions() {
    var host = el.morseOptions;
    if (!host) { return; }
    host.innerHTML = '';
    if (mode !== 'recv' || !rplan) { return; }
    var opts = rplan.rounds[roundIndex].options;
    for (var i = 0; i < opts.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mr-opt';
      b.dataset.ch = opts[i];
      b.textContent = opts[i];
      host.appendChild(b);
    }
    setTxt(el.morseRoundLabel, '听/看这段码，它是哪个字符？');
  }

  function renderDigitOptions() {
    var host = el.morseDigitOptions;
    if (!host) { return; }
    host.innerHTML = '';
    if (mode !== 'digit' || !dplan || digitType() !== 'decode') { return; }
    for (var n = 0; n < 10; n++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mr-dnum';
      b.dataset.ch = String(n);
      b.textContent = String(n);
      host.appendChild(b);
    }
  }

  function renderDigitTask() {
    if (mode !== 'digit' || !dplan) { return; }
    var t = digitType();
    var ch = dplan.rounds[roundIndex].ch;
    setTxt(el.morseDigitType, t === 'encode' ? '✍️ 编码题 · 把码发出来' : '🎧 解码题 · 这是哪个数字');
    clearTrace();
    if (t === 'encode') {
      setTxt(el.morseDigitTask, '发报：' + ch + '　（先把它的 5 位码想出来）');
    } else {
      setTxt(el.morseDigitTask, viewMode === 'watch' ? '看码，选出数字' : '听码，选出数字');
    }
  }

  /* SECTION: 抄收的"看码"点划条与播放 */
  function clearTrace() {
    if (el.morseTrace) { el.morseTrace.innerHTML = ''; }
  }
  function traceAppend(sym) {
    if (!el.morseTrace) { return; }
    var i = document.createElement('i');
    i.className = sym === '.' ? 'dot' : 'dash';
    el.morseTrace.appendChild(i);
  }
  function lampOn() { if (el.morseLamp) { el.morseLamp.classList.add('on'); } }
  function lampOff() { if (el.morseLamp) { el.morseLamp.classList.remove('on'); } }

  /* 播放一段码：声音与灯光用小节拍器同步（看模式只亮灯/画点划条，不出声） */
  function playSignal(code, opts) {
    opts = opts || {};
    stopPlay();
    var unit = C.unitMs(cfg().wpm);
    var sound = A.enabled && viewMode !== 'watch';
    if (sound) { A.play(code, { unit: unit / 1000 }); }
    var token = ++playToken;
    if (opts.watch) { clearTrace(); }
    var i = 0;
    function step() {
      if (token !== playToken) { return; }
      if (i >= code.length) {
        lampOff();
        if (opts.then) { opts.then(); }
        return;
      }
      var sym = code[i++];
      var d = sym === '.' ? unit : unit * 3;
      lampOn();
      if (viewMode === 'watch') { traceAppend(sym); }
      playTimer = setTimeout(function () {
        lampOff();
        playTimer = setTimeout(step, unit);
      }, d);
    }
    step();
  }
  function stopPlay() {
    playToken++;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    lampOff();
  }

  /* SECTION: 节奏条（每题的用时压力，纯观感） */
  function startPace() {
    stopPace();
    paceTimer = setInterval(function () {
      if (state !== 'playing') { return; }
      var t = (now() - charStartAt) / budgetMs();
      if (el.morsePaceBar) {
        el.morsePaceBar.style.width = Math.min(100, Math.round(t * 100)) + '%';
        el.morsePaceBar.classList.toggle('slow', t > 1);
      }
    }, 110);
  }
  function stopPace() {
    if (paceTimer) { clearInterval(paceTimer); paceTimer = null; }
    if (el.morsePaceBar) { el.morsePaceBar.style.width = '0%'; el.morsePaceBar.classList.remove('slow'); }
  }

  /* SECTION: 模式切换 */
  function setMode(m, opts) {
    if (MODES.indexOf(m) < 0) { return; }
    opts = opts || {};
    stopPlay(); stopPace();
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
    cancelPendingChar();
    A.keyOff(); pressing = false; buffer = '';
    mode = m;
    if (!opts.keepRun) {
      state = 'menu';
      level = 1; score = 0; runTotal = 0; combo = 0; lives = cfg().lives;
      okCount = 0; tryCount = 0; roundIndex = 0; msgIndex = 0; charIndex = 0;
    }
    saveStore();
    applyModeUi();
  }

  /* 模式相关的 DOM 切换：标签、面板、按钮文案、起始面板文案 */
  function applyModeUi() {
    var info = MODE_INFO[mode];
    /* 所有 data-mode 按钮（棋盘上的标签 + 覆盖层里的选择器）一起同步高亮 */
    var tabs = document.querySelectorAll('[data-mode]');
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].classList.toggle('on', tabs[t].getAttribute('data-mode') === mode);
    }
    showEl(el.morsePanelSend, mode === 'send');
    showEl(el.morsePanelRecv, mode === 'recv');
    showEl(el.morsePanelDigit, mode === 'digit');
    syncLayout();

    setTxt(el.morseStartArt, info.art);
    setTxt(el.morseStartTitle, info.name === '发报' ? '深夜电台 · 摩尔斯电码' : '深夜电台 · ' + info.name + '练习');
    setTxt(el.morseStartKana, info.kana);
    setTxt(el.morseStartBrief, info.brief);
    setTxt(el.morseBtnStart, info.btn);
    setTxt(el.morseBtnListen, mode === 'send' ? '🔊 收听这个字 (L)' : '🔁 再放一次 (L)');
    setTxt(el.morseBtnReveal, mode === 'send' ? '👁 看一眼码表 (H)' : '👁 看答案（本题减半）(H)');
    renderCodebook();
    renderRules();
    renderStatusIdle();
  }

  function renderCodebook() {
    var host = el.morseCodebook;
    if (!host) { return; }
    host.innerHTML = '';
    var list;
    if (mode === 'digit') {
      list = '0123456789'.split('');
    } else {
      /* 首关先学的那批字符，给个上手参照 */
      list = D.charsForGroups(Math.min(6, 2)).slice(0, 8);
    }
    for (var i = 0; i < list.length; i++) {
      var d = document.createElement('div');
      var b = document.createElement('b');
      b.textContent = list[i];
      var s = document.createElement('span');
      s.textContent = codeText(C.codeOf(list[i]));
      d.appendChild(b); d.appendChild(s);
      host.appendChild(d);
    }
  }

  function renderRules() {
    var host = el.morseRules;
    if (!host) { return; }
    host.innerHTML = '';
    var rules = MODE_INFO[mode].rules;
    for (var i = 0; i < rules.length; i++) {
      var d = document.createElement('div');
      d.className = 'mr-rule';
      var ic = document.createElement('i');
      ic.textContent = rules[i][0];
      var sp = document.createElement('span');
      sp.innerHTML = rules[i][1];
      d.appendChild(ic); d.appendChild(sp);
      host.appendChild(d);
    }
  }

  function renderStatusIdle() {
    var t = { send: '待机 · 发报', recv: '待机 · 抄收', digit: '待机 · 数字' }[mode];
    setTxt(el.morseStatus, t);
  }

  /* 与"当前这一题"相关的显隐：电键只在要你发码时出现；
     听/看重放只在有信号可听时出现；提示语也随场合换。
     换题时要重跑（数字模式编码题/解码题用的控件不同），所以单独抽出来。 */
  function syncLayout() {
    var needPlay = mode === 'recv' || (mode === 'digit' && digitType() === 'decode');
    showEl(el.morseDigitOptions, mode === 'digit' && digitType() === 'decode');
    showEl(el.morseOptions, mode === 'recv');
    showEl(el.morseKey, mode === 'send' || (mode === 'digit' && digitType() === 'encode'));
    showEl(el.morseViewRow, needPlay);
    showEl(el.morseBtnListen, mode === 'send');   /* 侧栏"收听"只服务发报，其余模式用上面的重放键 */
    showEl(el.morseTrace, mode !== 'send');
    showEl(el.morseProgress, mode !== 'send');
    if (el.morseBuffer) {
      el.morseBuffer.setAttribute('data-ph', mode === 'send'
        ? '（按住电键开始发报）'
        : (needPlay ? '（收到的信号会在这里逐段亮出来）' : '（按住电键把 5 位码发出来）'));
    }
    if (!needPlay) { clearTrace(); }
  }

  /* 覆盖层里的模块选择器：与棋盘上的标签同一套 data-mode，点击走统一分发。
     为什么要有这一份：覆盖层是铺满视口的（position:fixed），盖住棋盘上的标签，
     不这样放一份，玩家在开始/结算面板里根本没法换模块。 */
  function fillChooser(host, note) {
    if (!host || host.dataset.filled === '1') { return; }
    host.dataset.filled = '1';
    var line = document.createElement('div');
    line.className = 'mr-tip-line';
    line.textContent = note;
    host.appendChild(line);
    var row = document.createElement('div');
    row.className = 'mr-tabs';
    for (var i = 0; i < MODES.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mr-tab';
      b.setAttribute('data-mode', MODES[i]);
      b.textContent = MODE_INFO[MODES[i]].art + ' ' + MODE_INFO[MODES[i]].name;
      row.appendChild(b);
    }
    host.appendChild(row);
  }

  /* 切模块：换一套练法，直接回到该模块的起始面板 */
  function switchMode(m) {
    if (MODES.indexOf(m) < 0) { return; }
    if (m === mode && state === 'menu') { return; }
    setMode(m);
    renderHud(); renderAll();
    show(el.morseOvStart, true);
    show(el.morseOvOver, false);
    show(el.morseOvPause, false);
  }

  /* SECTION: 关卡流程 */
  function startRun() {
    loadStore();
    review = [];
    runTotal = 0;
    A.resume();
    startLevel(1, true);
  }

  function startLevel(lv, first) {
    level = lv;
    cancelPendingChar();
    stopPlay();
    if (mode === 'recv') { rplan = C.recvPlan(lv, Math.random, review); }
    else if (mode === 'digit') { dplan = C.digitPlan(lv, Math.random); }
    else { plan = C.buildPlan(lv, Math.random, review, mastery); }

    score = 0; combo = 0; bestCombo = 0; lives = cfg().lives;
    okCount = 0; tryCount = 0; helped = false;
    msgIndex = 0; charIndex = 0; roundIndex = 0; answered = false;
    buffer = ''; wrongHere = 0;
    state = 'playing';
    show(el.morseOvStart, false); show(el.morseOvOver, false); show(el.morseOvPause, false);
    applyModeUi();
    renderHud(); renderNewChars();
    setTxt(el.morseStatus, first ? '开始 · 第 1 关' : '第 ' + lv + ' 关');
    beginRound();
    var g = cfg().newGroup;
    if (g && D.GROUPS[g] && mode !== 'digit') { toast('本关新解锁 ' + D.GROUPS[g].name, 2200); }
  }

  /* 开一题（发报模式的一"字"、抄收/数字模式的一"题"） */
  function beginRound() {
    answered = false;
    helped = false;
    wrongHere = 0;
    lastChoice = '';
    buffer = '';
    charStartAt = now();
    renderBuffer();
    startPace();
    renderTip('');
    syncLayout();

    if (mode === 'recv') {
      renderOptions(); renderRoundInfo(); renderStatusIdle();
      setTxt(el.morseStatus, '电台发报中…');
      clearTrace();
      playSignal(targetCode(), {
        then: function () { if (state === 'playing') { setTxt(el.morseStatus, '抄收 · 选一个'); } }
      });
      return;
    }
    if (mode === 'digit') {
      renderDigitTask(); renderDigitOptions(); renderRoundInfo();
      if (digitType() === 'decode') {
        setTxt(el.morseStatus, '电台发报中…');
        clearTrace();
        playSignal(targetCode(), {
          then: function () { if (state === 'playing') { setTxt(el.morseStatus, '解码 · 选一个数字'); } }
        });
      } else {
        setTxt(el.morseStatus, '编码 · 用电键发出来');
      }
      return;
    }
    /* 发报 */
    renderWord();
    setTxt(el.morseStatus, '待发 · 该你了');
  }

  /* 答完一题/发完一条电文后的短暂停顿（让玩家看清结果）。
     待执行的动作分两种，不能混：'begin' = 开始新的一题（索引已经就位，例如一条电文
     发完后 msgIndex/charIndex 已指向下一条），'advance' = 前进一题（索引还没动）。
     踩过的坑：这里如果统一用 advance()，在"电文发完"的停顿里被按键 flush 掉，
     就会多推一位、直接跳过下一句的第一个字符。 */
  var pendingAction = null;
  function scheduleNext(action, ms) {
    cancelPendingChar();
    pendingAction = action;
    nextRoundTimer = setTimeout(function () {
      nextRoundTimer = null;
      var act = pendingAction;
      pendingAction = null;
      if (state !== 'playing') { return; }
      if (act === 'begin') { beginRound(); } else { advance(); }
    }, ms);
  }
  function scheduleNextChar() { scheduleNext('begin', 450); }     // 一条电文发完 → 开始下一条
  function scheduleNextRound(ms) { scheduleNext('advance', ms); } // 判完一题 → 前进
  function flushPending() {
    if (!nextRoundTimer) { return; }
    var act = pendingAction;
    clearTimeout(nextRoundTimer);
    nextRoundTimer = null;
    pendingAction = null;
    if (state !== 'playing') { return; }
    if (act === 'begin') { beginRound(); } else { advance(); }
  }
  function cancelPendingChar() {
    if (nextRoundTimer) { clearTimeout(nextRoundTimer); nextRoundTimer = null; }
    pendingAction = null;
  }

  /* 前进到下一题 / 下一字 */
  function advance() {
    if (state !== 'playing') { return; }
    stopPlay();
    if (mode === 'send') {
      charIndex++;
      if (charIndex < plan.messages[msgIndex].length) { beginRound(); return; }
      A.levelup();
      msgIndex++; charIndex = 0;
      if (msgIndex >= plan.messages.length) { levelClear(); return; }
      setTxt(el.morseStatus, '电文已发 · 继续下一条');
      renderWord(); renderRoundInfo();
      scheduleNextChar();
      return;
    }
    roundIndex++;
    if (roundIndex >= roundTotal()) { levelClear(); return; }
    beginRound();
  }

  /* SECTION: 作答判定 */
  /* 键入（发报 / 数字编码题）：把敲出来的码与目标比对 */
  function submitCode(sent) {
    if (state !== 'playing' || answered) { return; }
    var ch = target();
    tryCount++;
    if (sent === C.codeOf(ch)) { solve(ch); }
    else { miss(ch, '你发的是 ' + codeText(sent || '')); }
  }

  /* 选择（抄收 / 数字解码题）：选中即判定 */
  function submitChoice(ch) {
    if (state !== 'playing' || answered) { return; }
    tryCount++;
    if (ch === target()) { solve(ch); }
    else { miss(target(), '你选的是 ' + ch); }
  }

  function solve(ch) {
    answered = true;
    stopPlay();
    var gain = C.scoreFor({
      base: baseScore(), combo: combo, paceMs: budgetMs(),
      elapsedMs: now() - charStartAt, helped: helped
    });
    score += gain; combo++; okCount++;
    if (combo > bestCombo) { bestCombo = combo; }
    mastery[ch] = C.masteryStep(mastery[ch] || 0, true);
    saveStore();
    A.good(combo);
    var entry = D.BY_CHAR[ch];
    toast('✔ ' + ch + ' = ' + codeText(C.codeOf(ch)) + (combo >= 3 ? ' · 连击 ×' + C.comboMult(combo) : ''), 1400);
    renderTip('对：' + ch + ' = ' + codeText(C.codeOf(ch)) + (entry ? '。' + entry.tip : ''), 'ok');
    markOptions(ch);
    renderHud();
    setTxt(el.morseStatus, '正确 · +' + gain);
    if (mode === 'send') {
      /* 发报：同一电文的中间字符立刻推进（停顿只留在"一条电文发完"处，
         否则电文条的高亮会滞后 450ms，玩家看到的当前字和实际判定的字不一致） */
      renderRoundInfo();
      advance();
      return;
    }
    /* 抄收/数字：先亮一下答案再进下一题 */
    scheduleNextRound(700);
  }

  function miss(ch, detail) {
    answered = true;
    stopPlay();
    combo = 0; lives--; wrongHere++;
    mastery[ch] = C.masteryStep(mastery[ch] || 0, false);
    review = C.reviewPush(review, ch);
    saveStore();
    A.bad();
    var entry = D.BY_CHAR[ch];
    var want = codeText(C.codeOf(ch));
    setTxt(el.morseStatus, '信号有误 · 记住这个码');
    renderTip(detail + '，' + ch + ' 应该是 ' + want + (entry ? '。' + entry.tip : ''), 'warn');
    markOptions(ch);
    if (mode !== 'send') { A.play(C.codeOf(ch), { unit: C.unitMs(cfg().wpm) / 1000 }); }  // 回放正确码
    else { A.play(C.codeOf(ch)); }
    renderHud();
    if (lives <= 0) { endRun(); return; }
    /* 同一题错两次就把码显示出来，别让人卡死 */
    if (wrongHere >= 2) { helped = true; toast('提示：' + ch + ' = ' + want, 2400); }
    if (mode === 'send') { charStartAt = now(); return; }   // 发报：重发本字
    scheduleNextRound(1500);
  }

  /* 答完后把选项标出来（对的绿、错的红） */
  function markOptions(ch) {
    var groups = [el.morseOptions, el.morseDigitOptions];
    for (var g = 0; g < groups.length; g++) {
      var host = groups[g];
      if (!host) { continue; }
      var btns = host.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        b.classList.toggle('right', b.dataset.ch === ch);
        if (b.dataset.ch !== ch) { b.classList.toggle('wrong', b.dataset.ch === lastChoice); }
      }
    }
  }
  var lastChoice = '';

  function levelClear() {
    state = 'clear';
    stopPace(); stopPlay(); A.keyOff();
    levelBest[mode] = Math.max(levelBest[mode], level + 1);
    best[mode] = Math.max(best[mode], runScore());
    saveStore();
    setTxt(el.morseOvOverTitle, '第 ' + level + ' 关 · 完成');
    setTxt(el.morseOvOverKana, 'QSL · 收到');
    setTxt(el.morseOvOverArt, MODE_INFO[mode].art);
    fillResult();
    show(el.morseOvOver, true);
    if (el.morseBtnRetry) { el.morseBtnRetry.textContent = '重做本关'; }
    if (el.morseBtnNext) { el.morseBtnNext.style.display = ''; }
    if (el.morseBtnEndRun) { el.morseBtnEndRun.style.display = ''; }
    A.levelup();
  }

  function endRun() {
    state = 'over';
    stopPace(); stopPlay(); A.keyOff();
    best[mode] = Math.max(best[mode], runScore());
    saveStore();
    setTxt(el.morseOvOverTitle, '信号中断');
    setTxt(el.morseOvOverKana, 'QRT · 关机');
    setTxt(el.morseOvOverArt, '📻');
    fillResult();
    show(el.morseOvOver, true);
    if (el.morseBtnRetry) { el.morseBtnRetry.textContent = '再来一局'; }
    if (el.morseBtnNext) { el.morseBtnNext.style.display = 'none'; }
    if (el.morseBtnEndRun) { el.morseBtnEndRun.style.display = 'none'; }
    A.over();
  }

  function fillResult() {
    var chars = charsNow();
    setTxt(el.morseRLevel, String(level));
    setTxt(el.morseRScore, String(score));
    setTxt(el.morseRTotal, String(runScore()));
    setTxt(el.morseRAcc, C.accuracy(okCount, tryCount) + '%');
    setTxt(el.morseRCombo, String(bestCombo));
    setTxt(el.morseRMastery, C.masteredCount(mastery, chars) + ' / ' + chars.length);
    setTxt(el.morseRBest, String(best[mode]));
    if (el.morseRRecord) { el.morseRRecord.classList.toggle('show', runScore() >= best[mode] && runScore() > 0); }
    var tips = mode === 'recv' ? D.RECV_TIPS : (mode === 'digit' ? D.DIGIT_TIPS : D.TIPS);
    setTxt(el.morseRTip, tips[Math.floor(Math.random() * tips.length)]);
  }

  /* SECTION: 辅助（再放一次 / 看答案） */
  function listen() {
    if (state !== 'playing') { return; }
    if (mode === 'send') {
      /* 发报模式下"听一遍"是很大的帮助，算用过辅助 */
      helped = true;
      var code = targetCode();
      A.play(code);
      renderTip('收听 ' + target() + '：' + codeText(code) + '（本字得分减半）', 'warn');
      setTxt(el.morseStatus, '正在收听…');
      var unit = 140;
      setTimeout(function () { if (state === 'playing') { setTxt(el.morseStatus, '待发 · 该你了'); } },
        60 + code.length * unit * 2);
      return;
    }
    /* 抄收/数字：重放信号属于正常抄报动作，不算用过辅助（时间已经被节奏条计着） */
    setTxt(el.morseStatus, viewMode === 'watch' ? '重放（看码）…' : '重放（听）…');
    playSignal(targetCode(), {
      watch: true,
      then: function () {
        if (state === 'playing') {
          setTxt(el.morseStatus, viewMode === 'watch' ? '看码 · 选一个' : '抄收 · 选一个');
        }
      }
    });
  }

  function reveal() {
    if (state !== 'playing') { return; }
    helped = true;
    var ch = target();
    var entry = D.BY_CHAR[ch];
    renderTip(ch + ' = ' + codeText(targetCode()) + (entry ? '。' + entry.tip : '') + '（本题得分减半）', 'warn');
    if (mode !== 'send') { markOptions(ch); }
  }

  function toggleView() {
    viewMode = viewMode === 'watch' ? 'listen' : 'watch';
    if (el.morseBtnView) {
      el.morseBtnView.textContent = viewMode === 'watch' ? '👁 看码中' : '🎧 听音中';
      el.morseBtnView.classList.toggle('watch', viewMode === 'watch');
    }
    clearTrace();
    setTxt(el.morseStatus, viewMode === 'watch' ? '看码模式：点划条会亮出来' : '听音模式：只靠耳朵');
    if (state === 'playing') { renderDigitTask(); }
    toast(viewMode === 'watch' ? '切到「看码」：点划条会一段段亮出来' : '切到「听音」：只靠耳朵分辨', 2000);
  }

  /* SECTION: 电键（发报 / 数字编码题） */
  function keyDown() {
    if (!isKeyMode() || pressing) { return; }
    flushPending();                 /* 手快：把上一题/上一字后的停顿立即结束 */
    A.resume(); A.keyOn();
    pressing = true; pressAt = now();
    if (el.morseKey) { el.morseKey.classList.add('down'); }
    lampOn();
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  }

  function keyUp() {
    if (!pressing) { return; }
    pressing = false;
    A.keyOff();
    if (el.morseKey) { el.morseKey.classList.remove('down'); }
    lampOff();
    if (!isKeyMode() || answered) { return; }

    buffer += C.classify(now() - pressAt);
    renderBuffer();
    if (buffer.length >= 5) { commit(); return; }   // 摩尔斯最长 5 位，够了就直接判
    if (gapTimer) { clearTimeout(gapTimer); }
    gapTimer = setTimeout(commit, C.GAP_MS);        // 停顿 = 一个字符结束
  }

  function commit() {
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
    var sent = buffer;
    buffer = '';
    renderBuffer();
    if (!sent || !isKeyMode() || answered) { return; }
    submitCode(sent);
  }

  /* SECTION: 暂停 / 切走 */
  function pauseGame() {
    if (state !== 'playing') { return; }
    state = 'paused';
    A.keyOff(); pressing = false;
    stopPlay(); stopPace();
    cancelPendingChar();
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
    buffer = ''; renderBuffer();
    show(el.morseOvPause, true);
    setTxt(el.morseStatus, '暂停中');
  }
  function resumeGame() {
    if (state !== 'paused') { return; }
    state = 'playing';
    show(el.morseOvPause, false);
    /* 恢复时把当前这题重新开一遍（暂停期间敲的半截码作废，节奏重新计时） */
    beginRound();
  }

  /* SECTION: 输入绑定 */
  function bindInput() {
    var key = el.morseKey;
    if (key) {
      key.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        A.resume();
        keyDown();
      });
      key.addEventListener('pointerup', function (e) { e.preventDefault(); keyUp(); });
      key.addEventListener('pointercancel', function () { keyUp(); });
      key.addEventListener('pointerleave', function () { keyUp(); });
      key.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      /* 兜底：某些环境没有 pointer 事件 */
      if (!window.PointerEvent) {
        key.addEventListener('mousedown', function (e) { e.preventDefault(); keyDown(); });
        key.addEventListener('mouseup', function () { keyUp(); });
        key.addEventListener('touchstart', function (e) { e.preventDefault(); keyDown(); }, { passive: false });
        key.addEventListener('touchend', function (e) { e.preventDefault(); keyUp(); });
      }
    }
    /* 选项：抄收的 4 选 1 / 数字解码的 0~9，用事件委托 */
    var optClick = function (e) {
      var b = e.target.closest('button[data-ch]');
      if (!b || answered) { return; }
      lastChoice = b.dataset.ch;
      A.resume();
      submitChoice(b.dataset.ch);
    };
    if (el.morseOptions) { el.morseOptions.addEventListener('click', optClick); }
    if (el.morseDigitOptions) { el.morseDigitOptions.addEventListener('click', optClick); }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  function onKeyDown(e) {
    var k = e.key;
    /* 空格/回车：发报与数字编码题当电键；菜单里直接开始 */
    if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
      if (isKeyMode()) { e.preventDefault(); if (!e.repeat) { keyDown(); } return; }
      if (state === 'menu') { e.preventDefault(); startRun(); return; }
    }
    if (k === 'm' || k === 'M') { toggleSound(); return; }
    if (k === 'p' || k === 'P') {
      if (state === 'playing') { pauseGame(); } else if (state === 'paused') { resumeGame(); }
      return;
    }
    if (k === 'Escape') {
      if (state === 'menu' || state === 'over' || state === 'clear') {
        if (window.APP_ROUTER) { window.APP_ROUTER.go('portal'); }
        return;
      }
      if (state === 'playing') { pauseGame(); return; }
      if (state === 'paused') { resumeGame(); }
      return;
    }
    if (k === 'l' || k === 'L') { listen(); return; }
    if (k === 'h' || k === 'H') { reveal(); return; }
    if (k === 'v' || k === 'V') { toggleView(); return; }
    /* 数字键：抄收选项里的 1~4 / 数字解码题的 0~9 */
    if (/^[0-9]$/.test(k) && state === 'playing' && !answered) {
      if (mode === 'digit' && digitType() === 'decode') { lastChoice = k; submitChoice(k); return; }
      if (mode === 'recv') {
        var list = el.morseOptions ? el.morseOptions.querySelectorAll('button') : [];
        var idx = parseInt(k, 10) - 1;
        if (idx >= 0 && idx < list.length) { lastChoice = list[idx].dataset.ch; submitChoice(list[idx].dataset.ch); }
      }
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') { keyUp(); }
  }

  function toggleSound() {
    A.enabled = !A.enabled;
    if (el.morseBtnSound) {
      el.morseBtnSound.textContent = A.enabled ? '🔊' : '🔇';
      el.morseBtnSound.setAttribute('aria-label', A.enabled ? '音效开关' : '音效已关');
    }
  }

  function bindButtons() {
    var on = function (node, fn) { if (node) { node.addEventListener('click', fn); } };
    on(el.morseBtnStart, function () { A.resume(); startRun(); });
    on(el.morseBtnRetry, function () { startRun(); });
    /* 进入下一关：把本关分数并入本局累计，再开新关 */
    on(el.morseBtnNext, function () { runTotal += score; score = 0; startLevel(level + 1, false); });
    on(el.morseBtnEndRun, function () { endRun(); });
    on(el.morseBtnResume, function () { resumeGame(); });
    on(el.morseBtnQuit, function () { endRun(); });
    on(el.morseBtnPause, function () { if (state === 'playing') { pauseGame(); } else if (state === 'paused') { resumeGame(); } });
    on(el.morseBtnSound, function () { toggleSound(); });
    on(el.morseBtnListen, function () { listen(); });
    on(el.morseBtnReveal, function () { reveal(); });
    on(el.morseBtnPlay, function () { listen(); });
    on(el.morseBtnView, function () { toggleView(); });

    /* 模块切换：棋盘上的标签与覆盖层里的选择器统一用 data-mode 分发 */
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-mode]');
      if (b) { switchMode(b.getAttribute('data-mode')); }
    });
  }

  /* SECTION: 对外接口（多页面 boot.js / 单文件 portal.js 都调这几个） */
  return {
    mount: function () {
      cacheDom();
      loadStore();
      /* 支持 ?mode=recv|digit 深链，方便直接从门户/书签进某个模块 */
      try {
        var q = (window.location.search || '').match(/[?&]mode=(send|recv|digit)/);
        if (q) { mode = q[1]; }
      } catch (e) { /* 忽略 */ }
      if (MODES.indexOf(mode) < 0) { mode = 'send'; }
      bindInput();
      bindButtons();
      fillChooser(el.morseChooserStart, '换个模块练：');
      fillChooser(el.morseChooserOver, '再练别的模块：');
      renderHud();
      renderAll();
      applyModeUi();
      renderTip('');
      show(el.morseOvStart, true);
    },
    activate: function () {
      active = true;
      loadStore();
      renderHud();
    },
    deactivate: function () {
      active = false;
      if (state === 'playing') { pauseGame(); }
      cancelPendingChar();
      stopPlay(); stopPace();
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
      A.keyOff(); pressing = false;
    },
    resize: function () { /* 纯 DOM 布局，无需重算 */ },
    isActive: function () { return active; },
    /* 门户回显 + 自动化测试都读这里；把内部状态一并暴露，便于断言与排查 */
    stats: function () {
      return {
        mode: mode, viewMode: viewMode, state: state,
        best: best[mode], bestAll: { send: best.send, recv: best.recv, digit: best.digit },
        level: levelBest[mode], mastered: C.masteredCount(mastery, D.CHARS),
        runLevel: level, score: score, runTotal: runTotal, combo: combo, lives: lives,
        roundIndex: roundIndex, roundTotal: roundTotal(), answered: answered, helped: helped,
        msgIndex: msgIndex, charIndex: charIndex, buffer: buffer,
        target: target(), answer: target(), digitType: digitType(),
        options: (mode === 'recv' && rplan) ? rplan.rounds[roundIndex].options.slice() : [],
        wpm: cfg().wpm, mastery: mastery
      };
    }
  };

  /* 渲染聚合（放在最后定义也能被上面的函数调用：函数声明会提升） */
  function renderAll() {
    renderHud(); renderWord(); renderBuffer(); renderRoundInfo(); renderNewChars();
    if (mode === 'recv') { renderOptions(); }
    if (mode === 'digit') { renderDigitTask(); renderDigitOptions(); }
  }
})();
