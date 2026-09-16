/* ============================================================
   深夜电台 · 摩尔斯电码 · 界面与玩法
   SECTION: morse
   ------------------------------------------------------------
   玩法：面板给出一条电文（真词，如 SOS / TEAM / STONE），
   用电键把它逐字发出去 —— 短按出点、按住出划、松手停顿就算一个字符结束
   （真实摩尔斯就是这个节奏，所以练的是"手上功夫"而不是背表格）。

   帮助记忆的三件事：
     1. 逐组解锁字符（先 E T，再高频字母…），每关只多学一组；
     2. 答错立刻回放正确码 + 给口诀，错过的字符进"待复习"，后面几轮还会遇到；
     3. 每个字符记熟练度（答对 +2、答错 -1，≥6 算掌握），长期存在本地，门户上显示进度。

   「收听」和「看码」随时可用，但用了这条电文得分减半 —— 想拿高分就得靠记。
   ============================================================ */
window.MORSE_APP = (function () {
  'use strict';

  var D = window.MORSE_DATA, C = window.MORSE_CORE, A = D.Audio;

  var el = {};
  var active = false;
  var state = 'menu';            // menu | sending | paused | clear | over

  /* 一局/一关的运行时数据 */
  var level = 1, score = 0, runTotal = 0, combo = 0, bestCombo = 0, lives = 3;
  var okCount = 0, tryCount = 0;
  var plan = null, msgIndex = 0, charIndex = 0, wrongHere = 0;
  var buffer = '', helped = false, pressing = false, pressAt = 0;
  var charStartAt = 0, gapTimer = null, paceTimer = null, nextCharTimer = null;

  /* 长期存档 */
  var best = 0, bestLevel = 1, mastery = {}, review = [];

  var $ = function (id) { return document.getElementById(id); };
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /* SECTION: storage */
  function loadStore() {
    try {
      best = parseInt(window.localStorage.getItem('morse-best') || '0', 10) || 0;
      bestLevel = parseInt(window.localStorage.getItem('morse-level') || '1', 10) || 1;
      mastery = JSON.parse(window.localStorage.getItem('morse-mastery') || '{}') || {};
      if (typeof mastery !== 'object' || mastery === null) { mastery = {}; }
    } catch (e) { mastery = {}; }
  }
  function saveStore() {
    try {
      window.localStorage.setItem('morse-best', String(best));
      window.localStorage.setItem('morse-level', String(bestLevel));
      window.localStorage.setItem('morse-mastery', JSON.stringify(mastery));
    } catch (e) { /* 忽略隐私模式限制 */ }
  }

  /* SECTION: dom-cache */
  function cacheDom() {
    var ids = ['morseLevel', 'morseScore', 'morseTotal', 'morseCombo', 'morseSignal', 'morseSignalBar',
      'morseLives', 'morseWord', 'morseWordNo', 'morseBuffer', 'morseKey', 'morseLamp', 'morseStatus',
      'morseMastery', 'morseMasteryBar', 'morseNewChars', 'morseCharTip', 'morseToast', 'morsePaceBar',
      'morseBtnSound', 'morseBtnPause', 'morseBtnListen', 'morseBtnReveal',
      'morseOvStart', 'morseBtnStart', 'morseOvPause', 'morseBtnResume', 'morseBtnQuit',
      'morseOvOver', 'morseOvOverTitle', 'morseOvOverArt', 'morseOvOverKana',
      'morseRLevel', 'morseRScore', 'morseRTotal', 'morseRAcc', 'morseRCombo', 'morseRMastery',
      'morseRBest', 'morseRRecord', 'morseRTip', 'morseBtnRetry', 'morseBtnNext', 'morseBtnEndRun'];
    for (var i = 0; i < ids.length; i++) { el[ids[i]] = $(ids[i]); }
  }

  /* SECTION: 渲染 */
  function setTxt(node, txt) { if (node && node.textContent !== txt) { node.textContent = txt; } }
  function show(node, on) { if (node) { node.classList.toggle('show', !!on); } }

  /* 生命点：按数量拼出来（剩下的实心、丢掉的空心），
     不要用 '❤❤❤'.slice(0, n*2) —— '❤' 是单个 UTF-16 码元，长度算错会让扣命看起来没变化 */
  function hearts(n, max) {
    var s = '';
    for (var i = 0; i < Math.max(0, n); i++) { s += '❤'; }
    for (var j = n; j < Math.max(max, n); j++) { s += '🖤'; }
    return s || '—';
  }

  function cfg() { return D.levelConfig(level); }
  function message() { return plan ? plan.messages[msgIndex] : ''; }
  function targetChar() { return message().charAt(charIndex); }
  /* 本局累计 = 已过关的分数 + 本关当前分数（结算面板与 HUD 都用它） */
  function runScore() { return runTotal + score; }

  function renderHud() {
    setTxt(el.morseLevel, String(level));
    setTxt(el.morseScore, String(score));
    setTxt(el.morseTotal, String(runScore()));
    setTxt(el.morseCombo, '×' + C.comboMult(combo));
    var s = C.signalStrength(combo);
    setTxt(el.morseSignal, 'S' + s);
    if (el.morseSignalBar) { el.morseSignalBar.style.width = Math.round((s / 9) * 100) + '%'; }
    setTxt(el.morseLives, hearts(lives, cfg().lives));

    /* 掌握进度：只统计已解锁字符 */
    var chars = plan ? plan.chars : D.charsForGroups(cfg().groups);
    var got = C.masteredCount(mastery, chars);
    setTxt(el.morseMastery, got + ' / ' + chars.length);
    if (el.morseMasteryBar) { el.morseMasteryBar.style.width = Math.round((got / chars.length) * 100) + '%'; }
  }

  function renderWord() {
    var msg = message();
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
    setTxt(el.morseWordNo, (msgIndex + 1) + ' / ' + plan.messages.length);
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

  function renderTip(tip, cls) {
    setTxt(el.morseCharTip, tip || '短按出「点」，按住出「划」；松手停顿一下，一个字符就发出去了。');
    if (el.morseCharTip) {
      el.morseCharTip.classList.toggle('warn', cls === 'warn');
      el.morseCharTip.classList.toggle('ok', cls === 'ok');
    }
  }

  function renderNewChars() {
    var g = cfg().newGroup;
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

  function renderAll() { renderHud(); renderWord(); renderBuffer(); renderNewChars(); }

  /* SECTION: 节奏条（每字符用时压力，纯观感） */
  function startPace() {
    stopPace();
    paceTimer = setInterval(function () {
      if (state !== 'sending') { return; }
      var t = (now() - charStartAt) / cfg().paceMs;
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
    plan = C.buildPlan(lv, Math.random, review, mastery);
    score = 0; combo = 0; bestCombo = 0; lives = plan.config.lives;
    okCount = 0; tryCount = 0;
    msgIndex = 0; charIndex = 0; buffer = ''; wrongHere = 0;
    state = 'sending';
    show(el.morseOvStart, false); show(el.morseOvOver, false); show(el.morseOvPause, false);
    setTxt(el.morseStatus, first ? '待发 · 新一局' : '待发 · 第 ' + lv + ' 关');
    renderTip('');
    renderAll();
    startChar();
    renderToastForLevel();
  }

  function renderToastForLevel() {
    var g = cfg().newGroup;
    if (g && D.GROUPS[g]) { toast('本关新解锁 ' + D.GROUPS[g].name, 2200); }
  }

  function startChar() {
    buffer = ''; helped = false; wrongHere = 0;
    charStartAt = now();
    renderWord(); renderBuffer(); startPace();
    renderTip('');
  }

  /* 一条电文发完后的 450ms 停顿（让玩家看清"已发送"）。
     若玩家手快、在停顿里就按了键，flushPendingChar() 会立刻把新字符开始掉 ——
     否则 startChar() 的延迟执行会把刚敲下的第一个符号清掉（E2E 抓出来的真 bug）。 */
  function scheduleNextChar() {
    if (nextCharTimer) { clearTimeout(nextCharTimer); }
    nextCharTimer = setTimeout(function () {
      nextCharTimer = null;
      if (state === 'sending') { startChar(); }
    }, 450);
  }
  function flushPendingChar() {
    if (!nextCharTimer) { return; }
    clearTimeout(nextCharTimer);
    nextCharTimer = null;
    if (state === 'sending') { startChar(); }
  }
  function cancelPendingChar() {
    if (nextCharTimer) { clearTimeout(nextCharTimer); nextCharTimer = null; }
  }

  function currentCode() { return C.codeOf(targetChar()); }
  function codeText(code) { return code.replace(/\./g, '·').replace(/-/g, '—'); }

  /* 电键按下 / 松开 */
  function keyDown() {
    if (state !== 'sending' || pressing) { return; }
    flushPendingChar();                 /* 手快：把上一条电文后的停顿立即结束 */
    A.resume(); A.keyOn();
    pressing = true; pressAt = now();
    if (el.morseKey) { el.morseKey.classList.add('down'); }
    if (el.morseLamp) { el.morseLamp.classList.add('on'); }
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  }

  function keyUp() {
    if (!pressing) { return; }
    pressing = false;
    A.keyOff();
    if (el.morseKey) { el.morseKey.classList.remove('down'); }
    if (el.morseLamp) { el.morseLamp.classList.remove('on'); }
    if (state !== 'sending') { return; }

    buffer += C.classify(now() - pressAt);
    renderBuffer();
    if (buffer.length >= 5) { commit(); return; }   // 摩尔斯最长 5 位（数字），够了就直接判
    if (gapTimer) { clearTimeout(gapTimer); }
    gapTimer = setTimeout(commit, C.GAP_MS);        // 停顿 = 一个字符结束
  }

  /* 提交当前敲出的码 */
  function commit() {
    if (state !== 'sending') { return; }
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
    var sent = buffer;
    buffer = '';
    renderBuffer();
    if (!sent) { return; }                          // 没敲任何东西，忽略

    var ch = targetChar();
    var want = C.codeOf(ch);
    tryCount++;

    if (sent === want) {
      onCorrect(ch);
    } else {
      onWrong(ch, want, sent);
    }
  }

  function onCorrect(ch) {
    var base = C.scoreFor({
      combo: combo, paceMs: cfg().paceMs,
      elapsedMs: now() - charStartAt, helped: helped
    });
    score += base;
    combo++; okCount++;
    if (combo > bestCombo) { bestCombo = combo; }
    mastery[ch] = C.masteryStep(mastery[ch] || 0, true);
    saveStore();
    A.good(combo);
    toast('✔ ' + ch + ' 收到' + (combo >= 3 ? ' · 连击 ×' + C.comboMult(combo) : ''), 1000);
    renderTip(D.BY_CHAR[ch] ? D.BY_CHAR[ch].tip : '', 'ok');

    charIndex++;
    if (charIndex >= message().length) {
      /* 一条电文发完 */
      A.levelup();
      msgIndex++; charIndex = 0;
      if (msgIndex >= plan.messages.length) { levelClear(); return; }
      setTxt(el.morseStatus, '电文已发 · 继续下一条');
      renderAll();
      scheduleNextChar();
      return;
    }
    renderAll();
    charStartAt = now(); wrongHere = 0; helped = false; buffer = '';
    renderBuffer();
  }

  function onWrong(ch, want, sent) {
    combo = 0; lives--; wrongHere++;
    mastery[ch] = C.masteryStep(mastery[ch] || 0, false);
    review = C.reviewPush(review, ch);
    saveStore();
    A.bad();
    if (state === 'sending') {
      setTxt(el.morseStatus, '信号有误 · 重发本字');
      renderTip('你发的是 ' + codeText(sent || '') + '，' + ch + ' 应该是 ' + codeText(want)
        + (D.BY_CHAR[ch] ? '。' + D.BY_CHAR[ch].tip : ''), 'warn');
      A.play(want);                                  // 立刻回放正确码，耳朵先记住
    }
    renderHud();
    if (lives <= 0) { endRun(false); return; }
    /* 同一个字错两次就把码显示出来，别让人卡死 */
    if (wrongHere >= 2) { helped = true; toast('提示：' + ch + ' = ' + codeText(want), 2400); }
    charStartAt = now();
  }

  function levelClear() {
    state = 'clear';
    stopPace(); A.keyOff();
    bestLevel = Math.max(bestLevel, level + 1);
    best = Math.max(best, runScore());
    saveStore();
    setTxt(el.morseOvOverTitle, '第 ' + level + ' 关 · 完成');
    setTxt(el.morseOvOverKana, 'QSL · 收到');
    setTxt(el.morseOvOverArt, '📡');
    fillResult();
    show(el.morseOvOver, true);
    if (el.morseBtnRetry) { el.morseBtnRetry.textContent = '重发本关'; }
    if (el.morseBtnNext) { el.morseBtnNext.style.display = ''; }
    if (el.morseBtnEndRun) { el.morseBtnEndRun.style.display = ''; }
    A.levelup();
  }

  function endRun() {
    state = 'over';
    stopPace(); A.keyOff();
    best = Math.max(best, runScore());
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
    var chars = plan ? plan.chars : D.charsForGroups(cfg().groups);
    setTxt(el.morseRLevel, String(level));
    setTxt(el.morseRScore, String(score));
    setTxt(el.morseRTotal, String(runScore()));
    setTxt(el.morseRAcc, C.accuracy(okCount, tryCount) + '%');
    setTxt(el.morseRCombo, String(bestCombo));
    setTxt(el.morseRMastery, C.masteredCount(mastery, chars) + ' / ' + chars.length);
    setTxt(el.morseRBest, String(best));
    if (el.morseRRecord) { el.morseRRecord.classList.toggle('show', runScore() >= best && runScore() > 0); }
    setTxt(el.morseRTip, D.TIPS[Math.floor(Math.random() * D.TIPS.length)]);
  }

  /* SECTION: 辅助（收听 / 看码，用了本字得分减半） */
  function listen() {
    if (state !== 'sending') { return; }
    var code = currentCode();
    helped = true;
    var ms = A.play(code) || 600;
    renderTip('收听 ' + targetChar() + '：' + codeText(code) + '（本字得分减半）', 'warn');
    setTxt(el.morseStatus, '正在收听…');
    setTimeout(function () { if (state === 'sending') { setTxt(el.morseStatus, '待发 · 该你了'); } }, ms + 200);
  }

  function reveal() {
    if (state !== 'sending') { return; }
    helped = true;
    var ch = targetChar();
    var entry = D.BY_CHAR[ch];          /* 口诀在数据模块里（MORSE_DATA.BY_CHAR），不是核心里 */
    renderTip(ch + ' = ' + codeText(currentCode())
      + (entry ? '。' + entry.tip : '') + '（本字得分减半）', 'warn');
  }

  /* SECTION: 暂停 / 切走 */
  function pauseGame() {
    if (state !== 'sending') { return; }
    state = 'paused';
    A.keyOff(); pressing = false;
    cancelPendingChar();
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
    buffer = ''; renderBuffer();
    stopPace();
    show(el.morseOvPause, true);
    setTxt(el.morseStatus, '暂停中');
  }
  function resumeGame() {
    if (state !== 'paused') { return; }
    state = 'sending';
    show(el.morseOvPause, false);
    startChar();          /* 暂停期间敲的半截码作废，节奏从新计时 */
    setTxt(el.morseStatus, '待发 · 该你了');
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  function onKeyDown(e) {
    var k = e.key;
    if (k === ' ' || k === 'Spacebar' || k === 'Enter') {
      if (state === 'sending') { e.preventDefault(); if (!e.repeat) { keyDown(); } return; }
      if (state === 'menu') { e.preventDefault(); startRun(); return; }
    }
    if (k === 'm' || k === 'M') { toggleSound(); return; }
    if (k === 'p' || k === 'P') {
      if (state === 'sending') { pauseGame(); } else if (state === 'paused') { resumeGame(); }
      return;
    }
    if (k === 'Escape') {
      if (state === 'menu' || state === 'over' || state === 'clear') {
        if (window.APP_ROUTER) { window.APP_ROUTER.go('portal'); }
        return;
      }
      if (state === 'sending') { pauseGame(); return; }
      if (state === 'paused') { resumeGame(); }
      return;
    }
    if (k === 'l' || k === 'L') { listen(); return; }
    if (k === 'h' || k === 'H') { reveal(); }
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
    on(el.morseBtnPause, function () { if (state === 'sending') { pauseGame(); } else if (state === 'paused') { resumeGame(); } });
    on(el.morseBtnSound, function () { toggleSound(); });
    on(el.morseBtnListen, function () { listen(); });
    on(el.morseBtnReveal, function () { reveal(); });
  }

  /* SECTION: 对外接口（多页面 boot.js / 单文件 portal.js 都调这几个） */
  return {
    mount: function () {
      cacheDom();
      loadStore();
      bindInput();
      bindButtons();
      plan = C.buildPlan(1, Math.random, review, mastery);
      renderAll();
      setTxt(el.morseStatus, '待机');
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
      if (state === 'sending') { pauseGame(); }
      cancelPendingChar();
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
      A.keyOff(); pressing = false;
      stopPace();
    },
    resize: function () { /* 纯 DOM 布局，无需重算 */ },
    isActive: function () { return active; },
    /* 门户回显 + 自动化测试都读这里；把内部状态一并暴露，便于断言与排查 */
    stats: function () {
      return {
        best: best, level: bestLevel, mastered: C.masteredCount(mastery, D.CHARS),
        runLevel: level, score: score, runTotal: runTotal, combo: combo, lives: lives,
        state: state, msgIndex: msgIndex, charIndex: charIndex, buffer: buffer,
        target: targetChar(), mastery: mastery
      };
    }
  };
})();
