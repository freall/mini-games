/* ============================================================
   publish.mjs · 一条命令构建并发布到 GitHub Pages
   SECTION: publish
   ------------------------------------------------------------
   做三件事：
     1. 跑 build-pages.mjs 生成 site/
     2. 把 site/ 的内容做成一个提交
     3. 推到 gh-pages 分支（触发 Pages 重建）

   两条发布通道（自动降级）：
     A. git 通道（默认）：不切分支、不动工作区 —— 用临时 GIT_INDEX_FILE
        `git read-tree --empty` / `git add --work-tree=site -A -f .` /
        `git commit-tree` / `git update-ref` 造提交，再 `git push`。
        main 上的未提交改动不会被搅乱，也不用 checkout 来回跳。
     B. GitHub API 通道（A 失败时自动降级）：有些网络环境 git push 走代理会
        报 "CONNECT tunnel failed / HTTP2 framing layer"，但 REST API 是通的。
        此时逐文件建 blob → 建 tree → 建 commit → 移动 ref，效果等价。

   比对基准取远端（origin/gh-pages 或 API 上的 ref），不只看本地分支 ——
   本地引用可能领先（例如上次 --dry-run 造过提交），只看本地会把该发的误判成"无需发布"。

   用法：
     node publish.mjs              构建 + 发布
     node publish.mjs --dry-run    构建 + 打印将要发布的提交，不推送
     node publish.mjs --api        跳过 git push，直接用 GitHub API 发布
   ============================================================ */
import { execFileSync } from 'child_process';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync, statSync, readFileSync, rmSync } from 'fs';
import { build } from './build-pages.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = join(ROOT, 'site');
const BRANCH = 'gh-pages';
const DRY = process.argv.includes('--dry-run');
const FORCE_API = process.argv.includes('--api');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    input: opts.input,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}
const git = (args, env) => run('git', args, { env });
const gh = (args, input) => run('gh', args, { input });

/* SECTION: 文件清单 */
function siteFiles() {
  const out = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) { walk(full); } else {
        out.push({ path: relative(SITE, full).replace(/\\/g, '/'), abs: full });
      }
    }
  })(SITE);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* SECTION: 发布通道 A · git */
function commitLocally(files) {
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  const indexFile = join(gitDir, 'publish-index-' + process.pid);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    git(['read-tree', '--empty'], env);
    git(['--work-tree=site', 'add', '-A', '-f', '.'], env); // -f 绕过 .gitignore（site/ 是产物但要发）
    const tree = git(['write-tree'], env);

    /* 比对基准必须是远端，不能只看本地 gh-pages。
       注意 `git fetch origin <branch>` 只写 FETCH_HEAD，不会建 origin/<branch>，
       所以远端跟踪引用不存在时要退到 FETCH_HEAD，否则会误判成"新建分支"造出无父提交。 */
    let base = 'origin/' + BRANCH;
    let baseSha = '';
    try {
      git(['fetch', 'origin', BRANCH]);
      try { baseSha = git(['rev-parse', base]); } catch {
        try { baseSha = git(['rev-parse', 'FETCH_HEAD']); base = 'FETCH_HEAD'; } catch { baseSha = ''; }
      }
    } catch (e) {
      console.log('⚠️  git fetch 失败，退回本地 ' + BRANCH + ' 作比对基准');
      base = BRANCH;
      try { baseSha = git(['rev-parse', base]); } catch { baseSha = ''; }
    }
    console.log('比对基准 ' + base + ' = ' + (baseSha ? baseSha.slice(0, 8) : '(拿不到远端引用，按新建分支处理)'));

    return { tree, base, env, indexFile };
  } catch (e) {
    if (existsSync(indexFile)) { rmSync(indexFile, { force: true }); }
    throw e;
  }
}

function commitMessage(files, total) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `deploy: 小游戏乐园多页站点 ${stamp}\n\n`
    + `页面：${files.filter(f => f.path.endsWith('index.html')).map(f => '/' + f.path.replace(/index\.html$/, '')).join('  ')}\n`
    + `文件：${files.length} 个 / ${(total / 1024).toFixed(1)} KB\n`
    + '由 publish.mjs 自动生成，源在 main 分支（小游戏乐园.html + games.config.mjs + build-pages.mjs）';
}

function publishViaGit(res, files) {
  const env = res.env;
  let parent = '', oldTree = '', hasParent = true;
  try {
    parent = git(['rev-parse', res.base]);
    oldTree = git(['rev-parse', res.base + '^{tree}']);
  } catch { hasParent = false; }

  if (hasParent && oldTree === res.tree) { return { unchanged: true }; }

  const args = ['commit-tree', res.tree, '-m', commitMessage(files, res.total)];
  if (hasParent) { args.push('-p', parent); }
  const commit = git(args, env);
  if (DRY) { return { commit, dryRun: true }; }
  git(['update-ref', 'refs/heads/' + BRANCH, commit], env);
  return { commit };
}

/* SECTION: 发布通道 B · GitHub REST API
   有些网络下 git push 走代理必失败，但 API 通。逐文件建 blob → tree → commit → 移 ref。 */
let OR = null;
function repoSlug() {
  if (OR) { return OR; }
  const url = git(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) { throw new Error('无法从 origin URL 解析 owner/repo：' + url); }
  OR = m[1] + '/' + m[2];
  return OR;
}
const api = (path, method = 'GET', body) => gh(
  ['api', '--method', method, path].concat(body ? ['--input', '-'] : []),
  body ? JSON.stringify(body) : undefined
);
const apiJson = (path, method = 'GET', body) => JSON.parse(api(path, method, body));

async function publishViaApi(files, total) {
  const slug = repoSlug();
  const refPath = `repos/${slug}/git/ref/heads/${BRANCH}`;
  let head = null;
  try { head = apiJson(refPath).object.sha; } catch { /* 远端还没有 gh-pages */ }
  console.log('GitHub API 通道：' + slug + ' / ' + BRANCH + ' 当前头 = ' + (head ? head.slice(0, 8) : '(无)'));

  /* 远端头 tree 与本地 tree 的 sha 算法一致，可以直接比 */
  if (head) {
    const headCommit = apiJson(`repos/${slug}/git/commits/${head}`);
    if (headCommit.tree.sha === localTreeFor(files)) {
      return { unchanged: true };
    }
  }

  const tree = [];
  for (const f of files) {
    const content = readFileSync(f.abs).toString('base64');
    const blob = apiJson(`repos/${slug}/git/blobs`, 'POST', { content, encoding: 'base64' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write('.');
  }
  console.log(`\n已上传 ${tree.length} 个 blob`);

  /* 不带 base_tree：远端 tree 就是 site/ 的完整快照，源里删掉的文件不会残留 */
  const treeRes = apiJson(`repos/${slug}/git/trees`, 'POST', { tree });
  const msg = commitMessage(files, total);
  const commitRes = apiJson(`repos/${slug}/git/commits`, 'POST', {
    message: msg, tree: treeRes.sha, parents: head ? [head] : []
  });
  if (DRY) { return { commit: commitRes.sha, dryRun: true }; }

  if (head) {
    api(`repos/${slug}/git/refs/heads/${BRANCH}`, 'PATCH', { sha: commitRes.sha, force: true });
  } else {
    api(`repos/${slug}/git/refs`, 'POST', { ref: 'refs/heads/' + BRANCH, sha: commitRes.sha });
  }
  return { commit: commitRes.sha, viaApi: true };
}

/* 本地算一次 tree sha，用来和远端头比对（git 对象哈希是内容寻址，两端一致） */
let cachedTree = null;
function localTreeFor() {
  if (cachedTree) { return cachedTree; }
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  const indexFile = join(gitDir, 'publish-probe-' + process.pid);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    git(['read-tree', '--empty'], env);
    git(['--work-tree=site', 'add', '-A', '-f', '.'], env);
    cachedTree = git(['write-tree'], env);
  } finally {
    if (existsSync(indexFile)) { rmSync(indexFile, { force: true }); }
  }
  return cachedTree;
}

/* SECTION: main */
const res = build();
const files = siteFiles();
res.total = files.reduce((s, f) => s + statSync(f.abs).size, 0);

let result = null;
if (!FORCE_API) {
  const local = commitLocally(files);
  try {
    result = publishViaGit(local, files);
  } catch (e) {
    console.log('⚠️  git 通道失败：' + String(e.stderr || e.message).split('\n')[0]);
    result = null;
  } finally {
    if (existsSync(local.indexFile)) { rmSync(local.indexFile, { force: true }); }
  }
  if (result) {
    if (result.unchanged) {
      console.log('\nℹ️  site/ 内容与远端 ' + BRANCH + ' 完全一致，无需发布。');
      process.exit(0);
    }
    console.log('\n✅ 已生成本地提交 ' + result.commit.slice(0, 8) + '（' + files.length + ' 个文件 / '
      + (res.total / 1024).toFixed(1) + ' KB）');
    if (result.dryRun) { console.log('ℹ️  --dry-run：跳过推送。'); process.exit(0); }

    try {
      console.log('→ git push origin ' + BRANCH + ':' + BRANCH);
      console.log(git(['push', 'origin', BRANCH + ':' + BRANCH]) || '（已推送）');
      const remote = (git(['fetch', 'origin', BRANCH]) , git(['rev-parse', 'origin/' + BRANCH]));
      if (remote !== result.commit) {
        throw new Error('推送后 origin/' + BRANCH + ' = ' + remote + ' != ' + result.commit);
      }
      console.log('✅ 远端 origin/' + BRANCH + ' 已确认指向 ' + remote.slice(0, 8));
    } catch (e) {
      console.log('⚠️  git push 失败：' + String(e.stderr || e.message).split('\n')[0]);
      console.log('→ 降级到 GitHub API 通道…');
      result = null;
    }
  }
}

if (!result) {
  result = await publishViaApi(files, res.total);
  if (result.unchanged) {
    console.log('\nℹ️  site/ 内容与远端 ' + BRANCH + ' 完全一致，无需发布。');
    process.exit(0);
  }
  console.log('✅ 已通过 GitHub API 发布提交 ' + result.commit.slice(0, 8)
    + '（' + files.length + ' 个文件 / ' + (res.total / 1024).toFixed(1) + ' KB）');
  if (result.dryRun) { console.log('ℹ️  --dry-run：未移动远端 ref。'); process.exit(0); }
  /* 让本地 gh-pages 跟上远端，保持仓库状态一致 */
  try {
    git(['fetch', 'origin', BRANCH + ':refs/heads/' + BRANCH, '--force']);
    console.log('✅ 本地 ' + BRANCH + ' 已同步到 ' + git(['rev-parse', 'refs/heads/' + BRANCH]).slice(0, 8));
  } catch { console.log('ℹ️  本地 ' + BRANCH + ' 暂未同步（网络受限，不影响线上）'); }
}

console.log('✅ GitHub Pages 重建约需 30～60 秒，之后访问 https://freall.github.io/mini-games/ 验证。');
