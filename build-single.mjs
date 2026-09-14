/* ============================================================
   build-single.mjs · 生成自包含单文件交付版
   SECTION: build-single
   ------------------------------------------------------------
   台账 v1/v2/v3 的「单文件URL版」一直是手工拼出来的，没有脚本。
   这里补上：把入口里的 <script src="..."> / <link rel="stylesheet">
   全部内联进 HTML，产出 dist/小游戏乐园.html —— 双击即玩、
   也可以直接当附件/URL 版发出去（无需 assets 目录）。

   内联时的两个坑：
     1. JS/CSS 文本里如果出现 </script> 会提前截断标签，必须转义
     2. 相对路径按入口所在目录解析，找不到文件直接报错（不静默跳过）

   用法：node build-single.mjs
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { SINGLE_OUT } from './games.config.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(ROOT, '小游戏乐园.html');
const OUT = join(ROOT, SINGLE_OUT);

/* 内联时唯一必须小心的地方：文本里出现 </script> 会让浏览器提前闭合标签 */
function safeInline(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

export function buildSingle() {
  let html = readFileSync(ENTRY, 'utf8');
  const inlined = [];

  html = html.replace(/<script src="([^"]+)"><\/script>/g, (full, src) => {
    const abs = resolve(dirname(ENTRY), src);
    if (!existsSync(abs)) { throw new Error(`入口引用的脚本不存在：${src}（解析为 ${abs}）`); }
    const code = readFileSync(abs, 'utf8');
    inlined.push({ src, size: code.length });
    return '<script>\n' + safeInline(code) + '\n</script>';
  });

  html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g, (full, href) => {
    const abs = resolve(dirname(ENTRY), href);
    if (!existsSync(abs)) { throw new Error(`入口引用的样式表不存在：${href}（解析为 ${abs}）`); }
    const css = readFileSync(abs, 'utf8');
    inlined.push({ src: href, size: css.length });
    return '<style>\n' + css + '\n</style>';
  });

  if (!inlined.length) { throw new Error('入口里没有可内联的外链资源，检查是不是已经内联过了'); }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html, 'utf8');

  console.log('✅ 单文件交付版已生成：' + SINGLE_OUT
    + '（' + (statSync(OUT).size / 1024).toFixed(1) + ' KB，内联 ' + inlined.length + ' 个资源）');
  for (const f of inlined) { console.log('   ← ' + f.src.padEnd(26) + (f.size / 1024).toFixed(1) + ' KB'); }
  return { out: OUT, inlined };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  buildSingle();
}
