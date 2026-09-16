/* ============================================================
   tools/test-morse-core.mjs · 摩尔斯核心逻辑断言
   SECTION: test-morse-core
   ------------------------------------------------------------
   morse-data.js / morse-core.js 只依赖一个 window 对象，
   这里给个假的 window 就能在 node 里直接跑，不需要浏览器。
   用法：node tools/test-morse-core.mjs
   ============================================================ */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const win = {};
for (const f of ['assets/morse-data.js', 'assets/morse-core.js']) {
  new Function('window', readFileSync(join(ROOT, f), 'utf8'))(win);
}
const D = win.MORSE_DATA, C = win.MORSE_CORE;

let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; out.push('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

/* 固定种子的 RNG，保证随机相关的断言可复现 */
function seeded(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* SECTION: 码表 */
out.push('=== 码表 ===');
eq('字符总数 36（A-Z + 0-9）', D.CHARS.length, 36);
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
ok('A-Z 0-9 全覆盖', letters.every(ch => !!D.BY_CHAR[ch]),
  '缺: ' + letters.filter(ch => !D.BY_CHAR[ch]).join(',') || '无');
ok('码只由 . 和 - 组成', D.CHARS.every(c => /^[.-]+$/.test(c.code)),
  '异常: ' + D.CHARS.filter(c => !/^[.-]+$/.test(c.code)).map(c => c.ch).join(',') || '无');
ok('码长都在 1~5 位', D.CHARS.every(c => c.code.length >= 1 && c.code.length <= 5),
  '最长 ' + Math.max(...D.CHARS.map(c => c.code.length)));
const codes = D.CHARS.map(c => c.code);
ok('码不重复', new Set(codes).size === codes.length);
ok('每个字符都有教学分组与口诀', D.CHARS.every(c => c.g >= 1 && c.g <= 6 && typeof c.tip === 'string' && c.tip.length >= 4));
eq('E 是单点', D.BY_CHAR.E.code, '.');
eq('T 是单划', D.BY_CHAR.T.code, '-');
eq('SOS 拼法正确', 'SOS'.split('').map(ch => D.BY_CHAR[ch].code).join(' '), '... --- ...');
/* 数字按 ITU 原样核对，别用"推导规则"糊过去 */
const DIGITS = { '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.' };
for (const d of Object.keys(DIGITS)) {
  eq('数字 ' + d + ' 的码', D.BY_CHAR[d].code, DIGITS[d]);
}
ok('数字 1~5 是"n 个点补划"，6~9 是"划在前点在后"',
  [1, 2, 3, 4, 5].every(n => D.BY_CHAR[String(n)].code.indexOf('.') === 0)
  && [6, 7, 8, 9].every(n => D.BY_CHAR[String(n)].code.indexOf('-') === 0));

/* SECTION: 电键判定 */
out.push('=== 电键判定 ===');
eq('40ms → 点', C.classify(40), '.');
eq('199ms → 点（阈值内）', C.classify(199), '.');
eq('200ms → 划（阈值边界算划）', C.classify(200), '-');
eq('900ms → 划', C.classify(900), '-');
ok('点划阈值 200ms、字符间隔 560ms', C.DOT_MAX_MS === 200 && C.GAP_MS === 560,
  `${C.DOT_MAX_MS}/${C.GAP_MS}`);

/* SECTION: 查表 */
out.push('=== 查表 ===');
eq('codeOf(E)', C.codeOf('E'), '.');
eq('charOf("...")', C.charOf('...'), 'S');
eq('charOf 未知码返回空串', C.charOf('......'), '');
eq('codeOf 未知字符返回空串', C.codeOf('!'), '');
ok('36 个字符 code↔char 双向一致', D.CHARS.every(c => C.charOf(c.code) === c.ch && C.codeOf(c.ch) === c.code));
eq('isValidCode("...")', C.isValidCode('...'), true);
eq('isValidCode("..-")', C.isValidCode('..-'), true);
eq('isValidCode("......")（超长无效）', C.isValidCode('......'), false);
eq('isValidCode("")', C.isValidCode(''), false);

/* SECTION: 计分 */
out.push('=== 计分 ===');
eq('连击倍率 combo=0 → 1', C.comboMult(0), 1);
eq('连击倍率 combo=3 → 2', C.comboMult(3), 2);
eq('连击倍率 combo=6 → 3', C.comboMult(6), 3);
eq('连击倍率 combo=12 → 5（封顶）', C.comboMult(12), 5);
eq('连击倍率 combo=99 → 5（封顶）', C.comboMult(99), 5);
const fast = C.scoreFor({ combo: 0, paceMs: 4000, elapsedMs: 1500, helped: false });
const normal = C.scoreFor({ combo: 0, paceMs: 4000, elapsedMs: 6000, helped: false });
const verySlow = C.scoreFor({ combo: 0, paceMs: 4000, elapsedMs: 9000, helped: false });
eq('快于标准用时（≤pace）→ 10×1.5 = 15', fast, 15);
eq('标准用时内（pace~2×pace）→ 10×1.0 = 10', normal, 10);
eq('超时太多（>2×pace）→ 10×0.6 = 6', verySlow, 6);
eq('用过辅助 → 打对折', C.scoreFor({ combo: 0, paceMs: 4000, elapsedMs: 6000, helped: true }), 5);
eq('连击倍率叠加：combo=6 快速', C.scoreFor({ combo: 6, paceMs: 4000, elapsedMs: 1000, helped: false }), 45);
ok('得分永远 ≥1（不会得 0）', C.scoreFor({ combo: 0, paceMs: 1, elapsedMs: 99999, helped: true }) >= 1);
eq('信号强度上限 S9', C.signalStrength(50), 9);
eq('信号强度起点 S1', C.signalStrength(0), 1);

/* SECTION: 熟练度 */
out.push('=== 熟练度 / 复习队列 ===');
eq('答对 +2', C.masteryStep(3, true), 5);
eq('答对封顶 10', C.masteryStep(9, true), 10);
eq('答错 -1', C.masteryStep(3, false), 2);
eq('答错不会到负', C.masteryStep(0, false), 0);
eq('掌握门槛 6', C.MASTERY_PASS, 6);
eq('已掌握计数', C.masteredCount({ S: 6, O: 5, E: 10 }, ['S', 'O', 'E', 'T']), 2);
eq('准确率 3/4', C.accuracy(3, 4), 75);
eq('没答过时准确率 100%', C.accuracy(0, 0), 100);
let q = [];
q = C.reviewPush(q, 'S'); q = C.reviewPush(q, 'O');
eq('复习队列按顺序累积', q.join(''), 'SO');
q = C.reviewPush(q, 'S');
eq('重复字符会移到末尾而不是重复', q.join(''), 'OS');
q = [];
for (const ch of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) { q = C.reviewPush(q, ch); }
eq('队列最多留 5 个', q.length, 5);
eq('保留最近 5 个', q.join(''), 'CDEFG');

/* SECTION: 关卡与出题 */
out.push('=== 关卡与出题 ===');
eq('第 1 关解锁 2 组字符', D.levelConfig(1).groups, 2);
eq('第 1 关字符集 = E T A I N M S O', D.charsForGroups(2).join(''), 'ET AINMSO'.replace(' ', ''));
eq('第 1 关生命 3', D.levelConfig(1).lives, 3);
ok('关卡越高解锁越多、封顶 6 组',
  [1, 2, 3, 4, 5, 6, 9].every(lv => D.levelConfig(lv).groups <= 6) && D.levelConfig(9).groups === 6);
ok('电文条数随关卡不减',
  [1, 2, 3, 4, 5].every(lv => D.levelConfig(lv + 1).messages >= D.levelConfig(lv).messages));
ok('电文长度不超过 6', [1, 5, 9, 20].every(lv => D.levelConfig(lv).msgLen <= 6));
ok('节奏要求随关卡收紧',
  D.levelConfig(5).paceMs < D.levelConfig(1).paceMs, `${D.levelConfig(1).paceMs} → ${D.levelConfig(5).paceMs}ms`);

const rng = seeded(42);
const plan = C.buildPlan(1, rng, [], {});
eq('电文条数与关卡配置一致', plan.messages.length, D.levelConfig(1).messages);
ok('电文只用了已解锁字符',
  plan.messages.every(m => m.split('').every(ch => plan.chars.indexOf(ch) >= 0)),
  plan.messages.join(' / '));
ok('电文长度不超上限',
  plan.messages.every(m => m.length <= D.levelConfig(1).msgLen));
ok('电文是真词（不是随机字母）',
  plan.messages.every(m => D.WORDS.indexOf(m) >= 0), plan.messages.join(' / '));

/* 待复习：P 是第 4 组字符，第 3 关（解锁到第 4 组）可用；Z 是第 5 组，那时还没解锁 */
const reviewPlan = C.buildPlan(3, seeded(7), ['P'], {});
ok('待复习字符会出现在电文里（词库没现成词时就拼一个）',
  reviewPlan.messages.some(m => m.indexOf('P') >= 0), reviewPlan.messages.join(' / '));
const lockedPlan = C.buildPlan(3, seeded(7), ['Z'], {});
ok('还没解锁的字符不会被硬塞进电文',
  lockedPlan.messages.every(m => m.split('').every(ch => lockedPlan.chars.indexOf(ch) >= 0)),
  lockedPlan.messages.join(' / '));

eq('字符太少时兜底拼随机串', C.pickWord(['E'], 1, seeded(1), []).length, 1);
ok('pickWord 不会给出超长词', C.pickWord(D.charsForGroups(6), 3, seeded(3), []).length <= 3);
ok('数字电文只含数字', /^\d+$/.test(C.pickNumber(6, seeded(5))));
eq('数字电文长度受限', C.pickNumber(2, seeded(9)).length, 2);
ok('高阶关会掺入数字电文',
  C.buildPlan(6, seeded(11), [], {}).messages.some(m => /^\d+$/.test(m)));

/* SECTION: 抄收（听/看码解码） */
out.push('=== 抄收模块 ===');
eq('WPM → 点长：6WPM = 200ms', C.unitMs(6), 200);
eq('WPM → 点长：12WPM = 100ms', C.unitMs(12), 100);
ok('WPM 下限保护（不会算出 0 或负数）', C.unitMs(0) > 0 && C.unitMs(1) >= 300, 'unitMs(0)=' + C.unitMs(0));
eq('码距离：完全相同 = 0', C.codeDistance('.-', '.-'), 0);
eq('码距离：点划互换 = 2', C.codeDistance('.-', '-.'), 2);
eq('码距离：长度不同会累加', C.codeDistance('.', '...'), 2);
eq('码距离：一位之差 = 1', C.codeDistance('-.', '-..'), 1);
eq('码距离：数字比字母远', C.codeDistance('.....', '----.'), 4);

const pool6 = ['A', 'B', 'C', 'D', 'E', 'T'];
const opts = C.pickOptions('A', pool6, 3, seeded(3));
eq('选项数 = 请求数', opts.length, 3);
eq('选项里正确答案只出现一次', opts.filter(x => x === 'A').length, 1);
ok('选项都在候选里且不重复', opts.every(x => pool6.indexOf(x) >= 0) && new Set(opts).size === opts.length, opts.join(''));
ok('候选不足时不会硬凑（超量请求）', C.pickOptions('A', ['A', 'B'], 4, seeded(1)).length === 2);
/* 干扰项要有"形近"偏好：把目标码 A(.-) 的相似度统计一下，应显著优于随机乱取 */
const TARGET_CODE = D.BY_CHAR.A.code;
const othersByDist = D.CHARS.filter(c => c.ch !== 'A')
  .map(c => ({ ch: c.ch, d: C.codeDistance(c.code, TARGET_CODE) }))
  .sort((a, b) => a.d - b.d);
const nearest8 = new Set(othersByDist.slice(0, 8).map(o => o.ch));
const nearest8Max = othersByDist[7].d;
const poolAvg = othersByDist.reduce((s, o) => s + o.d, 0) / othersByDist.length;
let nearSum = 0, trials = 300;
let allFromNearest = true;
for (let i = 0; i < trials; i++) {
  const picked = C.pickOptions('A', D.CHARS.map(c => c.ch), 4, seeded(i + 1)).filter(x => x !== 'A');
  for (const ch of picked) {
    nearSum += C.codeDistance(D.BY_CHAR[ch].code, TARGET_CODE);
    if (!nearest8.has(ch)) { allFromNearest = false; }
  }
}
const nearAvg = nearSum / (trials * 3);
ok('干扰项只从"最近的 8 个形近码"里抽', allFromNearest, '最近 8 个的距离上限=' + nearest8Max);
ok('干扰项平均距离显著小于整个码表的平均距离', nearAvg < poolAvg,
  `形近取均值=${nearAvg.toFixed(2)} vs 全表均值=${poolAvg.toFixed(2)}`);

const rcfg1 = D.recvConfig(1), rcfg3 = D.recvConfig(3), rcfg9 = D.recvConfig(9);
eq('抄收第 1 关 3 个选项', rcfg1.options, 3);
eq('抄收第 3 关起 4 个选项', rcfg3.options, 4);
ok('抄收速度随关卡变快并封顶 14WPM',
  rcfg1.wpm < rcfg3.wpm && rcfg9.wpm <= 14, `${rcfg1.wpm} → ${rcfg3.wpm} → ${rcfg9.wpm}`);
ok('抄收题目的作答时间随关卡收紧', rcfg9.budgetMs < rcfg1.budgetMs, `${rcfg1.budgetMs} → ${rcfg9.budgetMs}ms`);
eq('抄收第 1 关生命 3', rcfg1.lives, 3);

const rplan1 = C.recvPlan(1, seeded(11), []);
eq('抄收出题数 = 关卡配置', rplan1.rounds.length, rcfg1.rounds);
ok('每题都含正确项且选项数正确',
  rplan1.rounds.every(r => r.options.length === Math.min(rcfg1.options, rplan1.chars.length) && r.options.indexOf(r.ch) >= 0));
ok('抄收不会出未解锁的字符',
  rplan1.rounds.every(r => rplan1.chars.indexOf(r.ch) >= 0), rplan1.rounds.map(r => r.ch).join(''));
ok('抄收选项不重复', rplan1.rounds.every(r => new Set(r.options).size === r.options.length));
const rplanReview = C.recvPlan(3, seeded(5), ['P']);
ok('待复习字符会优先出现（抄收）', rplanReview.rounds.some(r => r.ch === 'P'),
  rplanReview.rounds.map(r => r.ch).join(''));
const recap = C.recvPlan(20, seeded(2), []);
ok('满级抄收速度封顶', D.recvConfig(20).wpm === 14 && recap.rounds.length <= 8, 'wpm=' + D.recvConfig(20).wpm);

/* SECTION: 数字专项 */
out.push('=== 数字模块 ===');
const dcfg1 = D.digitConfig(1);
eq('数字每关 6 题', dcfg1.rounds, 6);
eq('数字第 1 关速度 5WPM', dcfg1.wpm, 5);
ok('数字速度随关卡变快并封顶 12WPM',
  D.digitConfig(2).wpm > dcfg1.wpm && D.digitConfig(9).wpm === 12);
const dplan1 = C.digitPlan(1, seeded(7));
eq('数字出题数 = 6', dplan1.rounds.length, 6);
eq('数字编码/解码各 3 题',
  dplan1.rounds.filter(r => r.type === 'encode').length + '/' + dplan1.rounds.filter(r => r.type === 'decode').length, '3/3');
ok('数字题都是 0~9', dplan1.rounds.every(r => /^[0-9]$/.test(r.ch)), dplan1.rounds.map(r => r.ch).join(''));
ok('编码解码交替出现',
  dplan1.rounds.every((r, i) => r.type === (i % 2 === 0 ? 'encode' : 'decode')));
eq('数字模式的掌握度基数 = 10 个数字', dplan1.chars.length, 10);
ok('数字码都是 5 位', '0123456789'.split('').every(d => C.codeOf(d).length === 5));
eq('基础分可调：抄收 12 分 ×1.5', C.scoreFor({ base: 12, combo: 0, paceMs: 4000, elapsedMs: 1000, helped: false }), 18);
eq('基础分可调：数字 14 分 ×1.5', C.scoreFor({ base: 14, combo: 0, paceMs: 4000, elapsedMs: 1000, helped: false }), 21);

console.log(out.join('\n'));
console.log('\n' + (fail ? `❌ 失败 ${fail} / 共 ${pass + fail} 项` : `✅ 全部通过（${pass} 项断言）`));
process.exit(fail ? 1 : 0);
