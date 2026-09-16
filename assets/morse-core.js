/* ============================================================
   深夜电台 · 摩尔斯电码 · 纯逻辑核心
   SECTION: morse-core
   ------------------------------------------------------------
   这里不碰任何 DOM：判定、选词、计分、熟练度全在这，
   可以脱离浏览器直接用 node 跑断言（tools/test-morse-core.mjs）。
   ============================================================ */
window.MORSE_CORE = (function () {
  'use strict';

  var D = window.MORSE_DATA;

  /* 电键判定阈值：按下时长 < DOT_MAX_MS 算点，否则算划。
     松手后静默超过 GAP_MS 就把已敲的码作为一个字符提交（真实摩尔斯就是这个规矩）。 */
  var DOT_MAX_MS = 200;
  var GAP_MS = 560;

  var MASTERY_MAX = 10;     // 单字符熟练度上限
  var MASTERY_PASS = 6;     // ≥ 此值算"已掌握"

  function classify(ms) { return ms < DOT_MAX_MS ? '.' : '-'; }

  function codeOf(ch) { var e = D.BY_CHAR[ch]; return e ? e.code : ''; }
  function charOf(code) { var e = D.BY_CODE[code]; return e ? e.ch : ''; }
  function isValidCode(code) { return !!D.BY_CODE[code]; }

  function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

  /* 拼一个指定长度、且一定包含 ch 的串（用于"错过的字必被再考"） */
  function withChar(ch, chars, msgLen, rng) {
    var at = Math.floor(rng() * Math.max(1, msgLen));
    var out = '';
    for (var i = 0; i < msgLen; i++) { out += (i === at ? ch : pick(chars, rng)); }
    return out;
  }

  /* SECTION: 选词
     只用本关已解锁字符组成的词；若给了待复习字符，优先挑含它们的词
     （简化的间隔重复：刚答错的，后面几轮会再遇到）。
     词库里确实没有含待复习字符的短词时，直接拼一个带上它 ——
     否则"错字会再考"这个承诺在短词阶段根本不会兑现。 */
  function pickWord(chars, msgLen, rng, review) {
    var has = {};
    for (var i = 0; i < chars.length; i++) { has[chars[i]] = true; }
    var pool = [];
    for (var j = 0; j < D.WORDS.length; j++) {
      var w = D.WORDS[j];
      if (w.length < 2 || w.length > msgLen) { continue; }
      var ok = true;
      for (var k = 0; k < w.length; k++) { if (!has[w[k]]) { ok = false; break; } }
      if (ok) { pool.push(w); }
    }

    if (review && review.length) {
      var usable = [];
      for (var r = 0; r < review.length; r++) { if (has[review[r]]) { usable.push(review[r]); } }
      if (usable.length) {
        var want = [];
        for (var m = 0; m < pool.length; m++) {
          for (var n = 0; n < usable.length; n++) {
            if (pool[m].indexOf(usable[n]) >= 0) { want.push(pool[m]); break; }
          }
        }
        if (want.length) { pool = want; }
        else { return withChar(usable[Math.floor(rng() * usable.length)], chars, msgLen, rng); }
      }
    }
    if (pool.length) { return pick(pool, rng); }

    /* 兜底：候选词为空（某关字符少且长度限制紧）时随机拼一个 */
    return withChar(pick(chars, rng), chars, msgLen, rng);
  }

  /* 数字电文（解锁数字后才有） */
  function pickNumber(msgLen, rng) {
    var pool = [];
    for (var i = 0; i < D.NUM_WORDS.length; i++) {
      if (D.NUM_WORDS[i].length <= msgLen) { pool.push(D.NUM_WORDS[i]); }
    }
    return pool.length ? pick(pool, rng) : '73';
  }

  /* SECTION: buildPlan · 出这一关的电文
     返回 { config, messages: [...] }，messages 里每条是要发的一串字符 */
  function buildPlan(level, rng, review, mastery) {
    rng = rng || Math.random;
    review = review || [];
    var cfg = D.levelConfig(level);
    var chars = D.charsForGroups(cfg.groups);
    var messages = [];
    for (var i = 0; i < cfg.messages; i++) {
      var useNum = cfg.groups >= 6 && rng() < 0.25;
      messages.push(useNum ? pickNumber(cfg.msgLen, rng) : pickWord(chars, cfg.msgLen, rng, review));
    }
    return { config: cfg, chars: chars, messages: messages };
  }

  /* SECTION: 计分 */
  function comboMult(combo) { return Math.min(5, 1 + Math.floor(combo / 3)); }

  /* 信号强度只是趣味化的连击展示：S1~S9 */
  function signalStrength(combo) { return Math.min(9, 1 + combo); }

  /* 一个字符得分：基础 10 × 连击倍率 × 速度系数；用过辅助（收听/看码）打对折 */
  function scoreFor(o) {
    var base = 10 * comboMult(o.combo);
    var pace = o.paceMs || 3000;
    var speed = o.elapsedMs <= pace ? 1.5 : (o.elapsedMs <= pace * 2 ? 1 : 0.6);
    var v = base * speed * (o.helped ? 0.5 : 1);
    return Math.max(1, Math.round(v));
  }

  /* SECTION: 熟练度与掌握进度 */
  function masteryStep(cur, ok) {
    var v = cur | 0;
    return ok ? Math.min(MASTERY_MAX, v + 2) : Math.max(0, v - 1);
  }
  function masteredCount(mastery, chars) {
    var n = 0;
    for (var i = 0; i < chars.length; i++) {
      if ((mastery[chars[i]] | 0) >= MASTERY_PASS) { n++; }
    }
    return n;
  }
  /* 待复习队列：答错的字符压进去，只留最近 5 个不重复项 */
  function reviewPush(queue, ch) {
    var out = [];
    for (var i = 0; i < queue.length; i++) { if (queue[i] !== ch) { out.push(queue[i]); } }
    out.push(ch);
    while (out.length > 5) { out.shift(); }
    return out;
  }
  function accuracy(okCount, total) { return total ? Math.round((okCount / total) * 100) : 100; }

  return {
    DOT_MAX_MS: DOT_MAX_MS, GAP_MS: GAP_MS,
    MASTERY_MAX: MASTERY_MAX, MASTERY_PASS: MASTERY_PASS,
    classify: classify, codeOf: codeOf, charOf: charOf, isValidCode: isValidCode,
    pickWord: pickWord, pickNumber: pickNumber, buildPlan: buildPlan,
    comboMult: comboMult, signalStrength: signalStrength, scoreFor: scoreFor,
    masteryStep: masteryStep, masteredCount: masteredCount,
    reviewPush: reviewPush, accuracy: accuracy
  };
})();
