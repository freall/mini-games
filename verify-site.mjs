/* ============================================================
   verify-site.mjs · 多页面产物结构自检
   SECTION: verify-site
   ------------------------------------------------------------
   只读检查（--selftest 除外，它在系统临时目录里做注入测试），
   改完入口或 games.config.mjs 后跑：node verify-site.mjs

   检查项：
     1. 配置 ←→ 入口视图标记 双向对齐（漏配、孤儿视图都报错）
     2. 门户卡片：每款游戏都要有 data-goto="<id>" 卡片（最容易漏改的一步）
     3. 页面引用的 CSS/JS 都能在 site/ 里解析到
     4. 每个游戏页恰好一个 active 视图
     5. DOM id 交叉核对：页面脚本要用的 id（getElementById('x') / $('x') /
        批量缓存 var ids=[...]）必须在该页 HTML 里，或者由脚本动态创建
     6. site/ 里没有被任何页面引用的多余文件（旧版本残留）

   用法：
     node verify-site.mjs                 自检产物
     node verify-site.mjs --selftest      注入 4 类缺陷，断言自检能报出来
     node verify-site.mjs --root=<目录>   检查指定工程根（默认脚本所在目录）
   ============================================================ */
import { readFileSync, readdirSync, statSync, existsSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve, relative, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { PORTAL, GAMES, PAGES_SCRIPTS } from './games.config.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/* SECTION: id 提取
   三种写法都要覆盖：getElementById('x')、$( 'x' )（game.js 的简写）、
   以及 match3.js 那种 `var ids = ['a','b',…]` 批量缓存后循环取。 */
function collectIds(src) {
  const out = new Set();
  for (const m of src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) { out.add(m[1]); }
  for (const m of src.matchAll(/\$\(\s*['"]([\w-]+)['"]\s*\)/g)) { out.add(m[1]); }
  for (const m of src.matchAll(/(?:var|let|const)\s+ids\s*=\s*\[([\s\S]*?)\]/g)) {
    for (const s of m[1].matchAll(/['"]([\w-]+)['"]/g)) { out.add(s[1]); }
  }
  return out;
}

function collectCreatedIds(src) {
  const out = new Set();
  for (const m of src.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]/g)) { out.add(m[1]); }
  return out;
}

/* SECTION: verify */
export function verify(root = SCRIPT_DIR) {
  const ENTRY = join(root, '小游戏乐园.html');
  const SITE = join(root, 'site');
  const fails = [];
  const warns = [];
  const fail = m => fails.push(m);
  const warn = m => warns.push(m);
  const pages = [PORTAL, ...GAMES];

  const bail = () => ({ root, pages: pages.map(p => (p.dir ? p.dir + '/' : '/')), fails, warns });
  if (!existsSync(SITE)) { fail('site/ 不存在，先跑 node build-pages.mjs'); return bail(); }
  if (!existsSync(ENTRY)) { fail('入口 小游戏乐园.html 不存在'); return bail(); }
  const entry = readFileSync(ENTRY, 'utf8');

  /* 1. 视图标记 ←→ 配置 */
  const viewKeys = [...entry.matchAll(/<!--\s*SECTION:\s*view-([\w-]+)\s*-->/g)].map(m => m[1]);
  for (const p of pages) {
    if (!viewKeys.includes(p.id)) { fail(`配置里的页面 "${p.id}" 在入口找不到 <!-- SECTION: view-${p.id} -->`); }
  }
  for (const k of viewKeys) {
    if (!pages.some(p => p.id === k)) { fail(`入口有视图 "${k}" 但 games.config.mjs 里没有对应配置`); }
  }

  /* 2. 门户卡片 */
  for (const g of GAMES) {
    if (!entry.includes(`data-goto="${g.id}"`)) {
      fail(`门户缺卡片：入口里找不到 data-goto="${g.id}"（新游戏配了但卡片没加）`);
    }
  }

  /* 3~5. 逐页 */
  const referenced = new Set();
  for (const p of pages) {
    const rel = (p.dir ? p.dir + '/' : '') + 'index.html';
    const abs = join(SITE, rel);
    if (!existsSync(abs)) { fail(`页面缺失：site/${rel}`); continue; }
    const html = readFileSync(abs, 'utf8');

    const viewDivs = [...html.matchAll(/class="view[^"]*"/g)];
    const actives = [...html.matchAll(/class="([^"]*)"\s+id="view[\w]+"/g)].filter(m => /\bactive\b/.test(m[1]));
    if (viewDivs.length !== 1) { fail(`site/${rel} 视图数 = ${viewDivs.length}（每页应只放 1 个视图）`); }
    if (actives.length !== 1) { fail(`site/${rel} 没有唯一的 active 视图（找到 ${actives.length} 个）`); }

    referenced.add(rel);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) { continue; }
      const target = resolve(dirname(abs), url);
      if (!target.startsWith(resolve(SITE) + sep)) { fail(`site/${rel} 引用了 site/ 之外的路径：${url}`); continue; }
      if (!existsSync(target)) { fail(`site/${rel} 引用的文件不存在：${url}`); continue; }
      referenced.add(relative(SITE, target).replace(/\\/g, '/'));
    }

    let jsSource = '';
    for (const s of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1])) {
      const p2 = resolve(dirname(abs), s);
      if (!existsSync(p2)) { continue; } // 缺文件上面已报过，这里跳过以免自检自己崩掉
      jsSource += readFileSync(p2, 'utf8');
    }

    /* 6'. data-app 写的游戏模块名，必须真的在页面脚本里被定义（boot.js 靠它挂载） */
    const appAttr = html.match(/<body[^>]*\sdata-app="([^"]+)"/);
    if (p.app) {
      if (!appAttr || appAttr[1] !== p.app) {
        fail(`site/${rel} 的 <body data-app> 与配置不一致（配置 ${p.app}，页面 ${appAttr ? appAttr[1] : '缺失'}）`);
      } else if (!new RegExp('window\\.' + p.app + '\\s*=').test(jsSource)) {
        fail(`site/${rel} 声明了 ${p.app}，但页面脚本里没有 window.${p.app} = …（游戏模块没挂上）`);
      }
    } else if (appAttr) {
      warn(`site/${rel} 有 data-app 但 games.config.mjs 里没写 app 字段`);
    }
    if (p.app && !html.includes(`data-game="${p.id}"`)) {
      warn(`site/${rel} 的 data-game 与配置 id（${p.id}）不一致，旧版 boot.js 的兜底映射会失效`);
    }

    const needIds = collectIds(jsSource);
    const dynamicIds = collectCreatedIds(jsSource);
    const missing = [...needIds].filter(id => !dynamicIds.has(id) && !new RegExp(`id="${id}"`).test(html));
    if (missing.length) {
      fail(`site/${rel} 页面缺少脚本要用的 DOM id：${missing.join(', ')}（视图 markup 没带过来？）`);
    }
  }

  /* 6. 多余文件 */
  const actual = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) { walk(full); } else { actual.push(relative(SITE, full).replace(/\\/g, '/')); }
    }
  })(SITE);
  for (const f of actual) {
    if (!referenced.has(f)) { warn(`site/${f} 没有被任何页面引用（多余文件？）`); }
  }

  return { root, pages: pages.map(p => (p.dir ? p.dir + '/' : '/')), fails, warns };
}

function printReport(res) {
  console.log('=== verify-site · 结构自检 ===');
  console.log(`工程根：${res.root}`);
  console.log(`页面：${res.pages.join('  ')}`);
  for (const w of res.warns) { console.log('  ⚠ ' + w); }
  for (const f of res.fails) { console.log('  ✗ ' + f); }
  if (!res.fails.length && !res.warns.length) { console.log('  ✓ 全部通过'); }
  console.log(res.fails.length
    ? `\n❌ 失败 ${res.fails.length} 项 / 警告 ${res.warns.length} 项`
    : `\n✅ 通过（警告 ${res.warns.length} 项）`);
}

/* SECTION: selftest
   把工程复制到临时目录，注入 4 类缺陷，断言自检都能报出来。
   自检本身也是代码，也要有测试 —— 否则就是个永远绿的摆设。

   实现注意（踩过的坑）：早期版本每个用例都把 assets/site-src/site 三个目录
   整个 rmSync + cpSync 一遍 —— 一次 selftest 要搅动 ~200 个文件，
   在本机的 node 22.22.2 上会触发 libuv 的原生崩溃（0xC0000005，必现）。
   现在只在开局做一次完整 pristine 拷贝，每个用例只回滚**它自己动过的那一个
   路径**，搅动量降到个位数文件，任何 node 版本都稳定。 */
function selftest() {
  const tmp = join(tmpdir(), 'mini-games-verify-selftest-' + process.pid);
  const pristine = join(tmp, 'pristine');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(pristine, { recursive: true });
  for (const f of ['games.config.mjs', '小游戏乐园.html']) { cpSync(join(SCRIPT_DIR, f), join(pristine, f)); }
  for (const d of ['assets', 'site-src', 'site']) { cpSync(join(SCRIPT_DIR, d), join(pristine, d), { recursive: true }); }
  mkdirSync(tmp, { recursive: true });
  /* 工作树只从 pristine 完整铺一次；之后每个用例各自恢复自己改过的文件 */
  for (const f of ['games.config.mjs', '小游戏乐园.html']) { cpSync(join(pristine, f), join(tmp, f)); }
  for (const d of ['assets', 'site-src', 'site']) { cpSync(join(pristine, d), join(tmp, d), { recursive: true }); }

  /* restore：把该用例动过的路径恢复成 pristine 的样子（只碰这一处） */
  const cases = [
    ['删除 site 里被引用的脚本',
      () => rmSync(join(tmp, 'site/assets/boot.js'), { force: true }),
      (done) => cpSync(join(pristine, 'site/assets/boot.js'), join(tmp, 'site/assets/boot.js')),
      /引用的文件不存在/],
    ['门户卡片 data-goto 拼错',
      () => patch(join(tmp, '小游戏乐园.html'), 'data-goto="match3"', 'data-goto="match3x"'),
      (done) => cpSync(join(pristine, '小游戏乐园.html'), join(tmp, '小游戏乐园.html')),
      /门户缺卡片/],
    ['页面缺少脚本要用的 DOM id',
      () => patch(join(tmp, 'site/match3/index.html'), 'id="m3Score"', 'data-x="m3Score"'),
      (done) => cpSync(join(pristine, 'site/match3/index.html'), join(tmp, 'site/match3/index.html')),
      /缺少脚本要用的 DOM id/],
    ['site 里留下无用文件',
      () => writeFileSync(join(tmp, 'site/old-game.html'), 'x'),
      (done) => rmSync(join(tmp, 'site/old-game.html'), { force: true }),
      /没有被任何页面引用/]
  ];

  let bad = 0;
  console.log('=== verify-site --selftest · 注入缺陷自检是否报得出来 ===');
  for (const [name, mutate, restore, expect] of cases) {
    mutate();
    const res = verify(tmp);
    const msgs = [...res.fails, ...res.warns];
    const hit = msgs.some(m => expect.test(m));
    console.log((hit ? '  ✓ 已捕获  ' : '  ✗ 漏报    ') + name);
    if (!hit) { bad++; }
    restore(hit);
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `\n❌ 自检有 ${bad} 类缺陷漏报` : '\n✅ 4 类缺陷全部能报出');
  return bad;

  function patch(file, from, to) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to), 'utf8');
  }
}

/* SECTION: cli */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 1 : 0);
  } else {
    const arg = process.argv.find(a => a.startsWith('--root='));
    const res = verify(arg ? arg.slice('--root='.length) : SCRIPT_DIR);
    printReport(res);
    process.exit(res.fails.length ? 1 : 0);
  }
}
