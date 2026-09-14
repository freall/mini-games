/* ============================================================
   build-pages.mjs · 从单文件入口生成 GitHub Pages 多页面结构
   SECTION: build-pages
   ------------------------------------------------------------
   单一数据源：小游戏乐园.html（本地双击即玩的单文件入口）
   + games.config.mjs（游戏清单）。

   产物（每次构建先清空 site/，保证没有上一版的残留文件）：
     site/index.html          门户（卡片链接到各子页）
     site/<game>/index.html   每款游戏一个独立页面
     site/assets/app.css      共享样式（入口全局 <style> + 各视图内嵌 <style>）
     site/assets/*.js         被页面引用的游戏脚本 + site-src 里的多页面脚本

   本脚本不含任何游戏名/脚本名硬编码 —— 加游戏只改 games.config.mjs 与入口 HTML，
   改完重跑：node build-pages.mjs（或 node publish.mjs 一步构建+发布）
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync, existsSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { PORTAL, GAMES, PAGES_SCRIPTS, CSS_OUT } from './games.config.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)); // 脚本所在目录 == 工程根（克隆到哪都能跑）
const ENTRY = join(ROOT, '小游戏乐园.html');
const SITE = join(ROOT, 'site');

/* SECTION: helpers */
function between(s, startMarker, endMarker) {
  const i = s.indexOf(startMarker);
  if (i < 0) throw new Error('未找到起始标记: ' + startMarker);
  const j = s.indexOf(endMarker, i + startMarker.length);
  if (j < 0) throw new Error('未找到结束标记: ' + endMarker);
  return s.slice(i + startMarker.length, j);
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

/* 页面骨架：脚本/CSS 一律按「相对 site/ 根」的路径传进来，
   子目录页面自动补 ../ 前缀 */
function page({ title, cssRel, dir, bodyAttrs, viewMarkup, scripts }) {
  const up = dir ? '../' : '';
  const tags = scripts.map(s => `<script src="${up}${s}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${title}</title>
<link rel="stylesheet" href="${up}${cssRel}">
</head>
<body${bodyAttrs}>
${viewMarkup.trim()}
${tags}
</body>
</html>
`;
}

/* SECTION: scan-views
   入口里每个视图都带 <!-- SECTION: view-<key> --> 标记，按标记切分：
   视图内容 = 标记之后 → 下一个视图标记（或首个 <script src=）之前。
   视图内若含 <style>，抽出并入共享 CSS，并从 markup 中移除。 */
function scanViews(html) {
  const re = /<!--\s*SECTION:\s*view-([\w-]+)\s*-->/g;
  const marks = [];
  let m;
  while ((m = re.exec(html))) marks.push({ key: m[1], after: m.index + m[0].length, at: m.index });
  if (!marks.length) throw new Error('入口里没有任何 <!-- SECTION: view-xxx --> 标记');

  const firstScript = html.indexOf('<script src=');
  const bodyEnd = html.indexOf('</body>');
  const tailLimit = firstScript > 0 ? firstScript : (bodyEnd > 0 ? bodyEnd : html.length);

  const views = {};
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : tailLimit;
    let raw = html.slice(mk.after, end);
    let css = '';
    raw = raw.replace(/<style>([\s\S]*?)<\/style>/g, (_, inner) => { css += inner; return ''; });
    views[mk.key] = { markup: raw, css };
  });
  return views;
}

/* SECTION: build */
export function build() {
  const entry = readFileSync(ENTRY, 'utf8');
  const globalCss = between(entry, '<style>', '</style>');
  const views = scanViews(entry);
  const pages = [PORTAL, ...GAMES];

  /* 每个页面用到哪个视图：靠「视图标记 key == 页面 id」约定 */
  for (const p of pages) {
    if (!views[p.id]) {
      throw new Error(`页面 "${p.id}" 在入口里找不到 <!-- SECTION: view-${p.id} --> 视图标记`);
    }
  }

  /* 入口里写了视图却没配到页面 —— 多半是加了游戏忘了写进 games.config.mjs */
  const orphan = Object.keys(views).filter(k => !pages.some(p => p.id === k));
  if (orphan.length) {
    throw new Error('入口里有这些视图没有对应配置（请补进 games.config.mjs）：' + orphan.join(', '));
  }

  /* SECTION: clean
     site/ 是纯生成物（已在 .gitignore 里），整目录重建，避免删掉游戏后残留旧页面 */
  if (dirname(SITE) !== ROOT || SITE.split(/[\\/]/).pop() !== 'site') {
    throw new Error('拒绝清空非 site/ 目录：' + SITE);
  }
  rmSync(SITE, { recursive: true, force: true });
  ensureDir(join(SITE, 'assets'));

  /* SECTION: write-css
     全局样式 + 各视图内嵌样式，按视图顺序拼接 */
  const extraCss = pages.map(p => views[p.id].css.trim()).filter(Boolean);
  writeFileSync(join(SITE, CSS_OUT),
    '/* 自动生成自 小游戏乐园.html + games.config.mjs · 请勿手改，改入口后重跑 build-pages.mjs */\n'
    + globalCss.trim() + '\n\n' + extraCss.join('\n\n') + '\n', 'utf8');

  /* SECTION: write-pages */
  const written = [];
  for (const p of pages) {
    /* 单页只保留一个视图：给它补 active 类（.view.active{display:flex}） */
    const markup = views[p.id].markup.replace('class="view"', 'class="view active"');
    const dir = join(SITE, p.dir);
    ensureDir(dir);
    writeFileSync(join(dir, 'index.html'), page({
      title: p.title,
      cssRel: CSS_OUT,
      dir: p.dir,
      bodyAttrs: p.bodyAttrs,
      viewMarkup: markup,
      scripts: p.scripts
    }), 'utf8');
    written.push(join(p.dir, 'index.html').replace(/\\/g, '/'));
  }

  /* SECTION: copy-scripts
     1) 页面引用到的脚本：先找工程根 assets/（游戏脚本），找不到再找 site-src/assets/
        （多页面专用脚本），两边都没有直接报错
     2) 不再维护"要复制哪些脚本"的硬编码清单 */
  const need = new Set();
  for (const p of pages) {
    for (const s of p.scripts) { if (s.startsWith('assets/')) { need.add(s.slice('assets/'.length)); } }
  }
  for (const f of PAGES_SCRIPTS) { need.add(f); }
  for (const f of need) {
    const inGame = join(ROOT, 'assets', f);
    const inPages = join(ROOT, 'site-src', 'assets', f);
    const from = existsSync(inGame) ? inGame : inPages;
    if (!existsSync(from)) {
      throw new Error(`脚本找不到（assets/ 和 site-src/assets/ 里都没有）：${f}`);
    }
    copyFileSync(from, join(SITE, 'assets', f));
  }

  /* SECTION: report */
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full); } else { files.push(full); }
    }
  })(SITE);
  files.sort();
  let total = 0;
  console.log('✅ site/ 多页面结构已生成（' + pages.length + ' 个页面 / ' + files.length + ' 个文件）');
  for (const f of files) {
    const size = statSync(f).size;
    total += size;
    console.log('   ✓  ' + relative(SITE, f).replace(/\\/g, '/').padEnd(26) + (size / 1024).toFixed(1) + ' KB');
  }
  console.log('   合计 ' + (total / 1024).toFixed(1) + ' KB；入口视图：' + Object.keys(views).join(', '));
  return { pages: written, files, total };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  build();
}
