/* ============================================================
   publish.mjs · 一条命令构建并发布到 GitHub Pages
   SECTION: publish
   ------------------------------------------------------------
   做两件事：
     1. 跑 build-pages.mjs 生成 site/
     2. 把 site/ 的内容做成一个提交，推到 gh-pages 分支

   关键点：不切分支、不动工作区 —— 用临时 GIT_INDEX_FILE 直接
   `git read-tree` / `git add --work-tree=site` / `git commit-tree` /
   `git update-ref` 造提交。这样 main 上的未提交改动、工作区文件
   都不会被搅乱，也不用 `git checkout gh-pages` 来回跳。

   用法：
     node publish.mjs              构建 + 发布
     node publish.mjs --dry-run    构建 + 打印将要发布的提交，不推送
   ============================================================ */
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, rmSync } from 'fs';
import { build } from './build-pages.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = join(ROOT, 'site');
const BRANCH = 'gh-pages';
const DRY = process.argv.includes('--dry-run');

function git(args, env) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env
  }).trim();
}

/* 1. 构建 */
const res = build();

/* 2. 造提交 */
const gitDir = git(['rev-parse', '--absolute-git-dir']);
const indexFile = join(gitDir, 'publish-index-' + process.pid);
const env = { GIT_INDEX_FILE: indexFile };

let newCommit = null, unchanged = false;
try {
  git(['read-tree', '--empty'], env);
  /* -f 无视 .gitignore（site/ 被忽略，但它正是我们要发布的内容） */
  git(['--work-tree=site', 'add', '-A', '-f', '.'], env);
  const tree = git(['write-tree'], env);

  let hasParent = true;
  let parent = '', oldTree = '';
  try {
    parent = git(['rev-parse', BRANCH]);
    oldTree = git(['rev-parse', BRANCH + '^{tree}']);
  } catch { hasParent = false; }

  if (hasParent && oldTree === tree) {
    unchanged = true;
  } else {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const msg = `deploy: 小游戏乐园多页站点 ${stamp}\n\n`
      + `页面：${res.pages.join('  ')}\n`
      + `文件：${res.files.length} 个 / ${(res.total / 1024).toFixed(1)} KB\n`
      + '由 publish.mjs 自动生成，源在 main 分支（小游戏乐园.html + games.config.mjs + build-pages.mjs）';
    const args = ['commit-tree', tree, '-m', msg];
    if (hasParent) { args.push('-p', parent); }
    newCommit = git(args, env);
    /* --dry-run 只造提交看看内容，不移动分支引用 */
    if (!DRY) { git(['update-ref', 'refs/heads/' + BRANCH, newCommit], env); }
  }
} finally {
  if (existsSync(indexFile)) { rmSync(indexFile, { force: true }); }
}

if (unchanged) {
  console.log('\nℹ️  site/ 内容与 gh-pages 现有内容完全一致，无需发布。');
  process.exit(0);
}
console.log('\n✅ 已生成本地提交 ' + newCommit.slice(0, 8) + '（' + res.files.length + ' 个文件 / '
  + (res.total / 1024).toFixed(1) + ' KB）');

/* 3. 推送 */
if (DRY) {
  console.log('ℹ️  --dry-run：跳过 git push。要发布去掉 --dry-run 即可。');
} else {
  console.log('→ git push origin ' + BRANCH);
  const out = git(['push', 'origin', BRANCH + ':' + BRANCH]);
  console.log(out || '（已推送）');
}
