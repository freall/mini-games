# 小游戏乐园 · mini-games

两款纯前端小游戏（无框架、无构建依赖、无后端）：

| 游戏 | 玩法 | 目录 |
| --- | --- | --- |
| 🍣 回转寿司大作战 | Canvas 街机射击：瞄准传送带上的寿司，完成顾客点单，别打芥末 | `site/sushi/` |
| 🧩 AI图标消消乐 | 8×8 三消：交换 AI 工具图标凑三连，四连/五连生成特殊图标 | `site/match3/` |

线上地址：**https://freall.github.io/mini-games/**（门户 → 各游戏独立子页）

---

## 一、两个交付形态，同一份源

```
                      ┌─────────────────────────────┐
   源（手改这两个）    │ 小游戏乐园.html   三个视图 markup + 全局 <style> │
                      │ games.config.mjs  游戏清单（标题/目录/脚本/body 属性）│
                      │ assets/*.js       游戏脚本（sushi 4 个 / match3 3 个）│
                      │ site-src/assets/*.js  多页面专用：boot.js / portal-home.js │
                      └──────────────┬──────────────┘
                                     │  node <脚本>（全部单向生成，产物永不反写源）
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
   build-pages.mjs          build-single.mjs          publish.mjs
             │                       │                       │
             ▼                       ▼                       ▼
  site/            多页面站点   dist/小游戏乐园.html      gh-pages 分支
  index.html       门户        自包含单文件（双击即玩、     → GitHub Pages
  sushi/index.html 寿司页      可直接当附件/URL 版发出）      https://freall.github.io/mini-games/
  match3/index.html 消消乐页
  assets/app.css + *.js（共享）
```

> **为什么不做成单页？** 早期是把三个视图塞进一个 HTML（`APP_ROUTER` 切视图）。
> 问题不在"能不能跑"，而在扩展性：每加一个游戏都会让那个文件更长、样式互相污染、
> 无法按页懒加载、SEO/分享链接只能指向同一个 URL。现在改成多页面：
> 每个游戏一个独立 URL、各自独立的 markup 与脚本集合，门户只负责导航和回显成绩。

---

## 二、常用命令

| 命令 | 作用 |
| --- | --- |
| `node build-pages.mjs` | 生成多页面站点 `site/`（会先清空 site/，无残留） |
| `node build-single.mjs` | 生成自包含单文件 `dist/小游戏乐园.html` |
| `node verify-site.mjs` | 结构自检（详见下） |
| `node verify-site.mjs --selftest` | 注入 4 类缺陷，验证自检本身**真的会报警** |
| `node publish.mjs` | 构建 + 推到 `gh-pages` + 触发 Pages 重建 |
| `node publish.mjs --dry-run` | 只构建并打印将要发布的提交，不推送 |
| `node publish.mjs --api` | 强制走 GitHub API 通道发布（git push 不通时用） |
| `python tools/e2e-smoke.py` | 无头浏览器端到端冒烟（17 项断言：页面跳转 / 开局 / 拖拽换位 / 返回 / 控制台报错） |
| `python tools/e2e-smoke.py --url https://freall.github.io/mini-games` | 同一套断言直接打线上 |

> `verify-site.mjs` 查结构（文件、引用、DOM id），`tools/e2e-smoke.py` 查"真的能玩"。
> 后者不是多余的：多页面改造时正是它抓出了「消消乐开始界面被裁剪、开始按钮点不到」这个
> 结构自检查不出来的 P0。

本地预览（任选）：

```bash
# 多页面站点（相对路径按目录解析，建议起服务而不是双击）
python -m http.server 18080 --directory site     # http://127.0.0.1:18080/
```

```text
# 单文件版：直接双击 dist/小游戏乐园.html 即可（file:// 下已实测可玩）
```

---

## 三、加第 3 款游戏（只碰 3 个地方）

1. **入口 `小游戏乐园.html` 加视图**（带 `SECTION` 标记，视图内的 `<style>` 会被自动抽到共享 CSS）：

   ```html
   <!-- SECTION: view-myGame -->
   <div class="view" id="viewMyGame">
     …视图 markup…
   </div>
   ```

2. **同一文件的门户卡片区加一张卡片**（`data-goto` 必须等于配置里的 `id`）：

   ```html
   <div class="pt-card" data-goto="myGame" role="button" tabindex="0">…</div>
   ```

3. **`games.config.mjs` 的 `GAMES` 加一条**：

   ```js
   {
     id: 'myGame',
     dir: 'myGame',                       // site/myGame/index.html
     title: '我的游戏 · 小游戏乐园',
     bodyAttrs: ' data-game="myGame" data-home="../"',
     scripts: ['assets/myGame-data.js', 'assets/myGame.js', 'assets/boot.js']
   }
   ```

新游戏的脚本放 `assets/`，游戏内"返回乐园"按钮给元素加 `data-back-home` 即由 `boot.js` 接管跳转；
Escape 回门户依赖 `boot.js` 提供的 `window.APP_ROUTER` stub（游戏脚本按菜单态 Escape 调用它）。

改完跑：

```bash
node build-pages.mjs && node verify-site.mjs && node publish.mjs
```

**漏改会被 verify-site 拦住**：视图标记与配置不一致、门户少卡片、页面引用的脚本不存在、
某页缺脚本要用的 DOM id、site/ 里有没被引用的残留文件 —— 都会直接报错或告警。
自检自己也有测试：`node verify-site.mjs --selftest`（当前 4/4 类缺陷可捕获）。

---

## 四、部署

- Pages 源：分支 `gh-pages` 根目录（仓库 Settings → Pages → Build and deployment）。
  线上地址 https://freall.github.io/mini-games/ ，子页 `/sushi/`、`/match3/`。
- 页面里全部使用**相对路径**（`assets/app.css`、`../assets/game.js`、`data-goto="sushi"`），
  所以放在用户名仓库的子路径下也不会挂。
- `publish.mjs` 的实现要点：不切分支、不动工作区 —— 用临时 `GIT_INDEX_FILE` +
  `git add --work-tree=site -A -f .` + `git commit-tree` + `git update-ref` 造提交再推，
  所以 main 上的未提交改动不会被搅乱。`site/` 在 `.gitignore` 里（纯产物），
  但发布时会 `-f` 强制纳入。
- **两条发布通道，自动降级**：本机 git push 走代理常报
  `CONNECT tunnel failed, response 502` / `Error in the HTTP2 framing layer`（README 作者实测多次复现），
  而 GitHub REST API 是通的。所以 `publish.mjs` 先试 git 通道，失败自动降级到 API 通道
  （逐文件建 blob → 建 tree → 建 commit → 移动 ref，等价效果，且不带 `base_tree`
  意味着远端就是 `site/` 的完整快照，源里删掉的页面不会残留）。想跳过 git 直接走 API 用 `--api`。
- 比对基准取**远端**（`origin/gh-pages` / `FETCH_HEAD` / API 上的 ref），不只看本地分支：
  本地引用可能领先（例如上一次 `--dry-run` 造过提交），只看本地会把该发的内容误判成"无需发布"。
- Pages 重建需要约 30～60 秒；期间 CDN 可能还在发旧文件，验证时加个 `?cb=<时间戳>` 更准。

---

## 五、几个必须知道的坑（踩过，写在这免得再踩）

1. **`.view` 的显隐必须用 `!important`**
   `#viewPortal` / `#viewMatch3` / `#viewSushi` 各有 ID 选择器设了 `display:flex`，
   ID 权重高于类，`.view{display:none}` 盖不住 → 三个视图会同时显示并堆叠。
   所以入口里是 `.view{display:none !important}` + `.view.active{display:flex !important}`。

2. **消消乐开局前棋盘高度靠 `aspect-ratio` 兜底**
   开局前 `board` 状态为 `null`，`resize()` 会直接 return，`.m3-board` 高度为 0 →
   `.m3-boardwrap` 塌成 22px，而开始/暂停/结算覆盖层是 `inset:0` 绝对定位在
   boardwrap 里且被 `overflow:hidden` 裁剪 → "开始挑战"按钮完全不可见、点不到。
   故给 `.m3-board` 加了 `aspect-ratio:1/1`（8×8 等间距棋盘高度恒等于宽度，
   开局后 JS 写入的行内高度 596px 与之一致，不会有布局跳动）。

3. **`site/` 和 `dist/` 都是产物，不要手改**
   改完入口重跑构建即可；`site/` 每次构建整目录重建（删游戏不会留残留页面）。

4. **内联单文件时 `</script>` 要转义**
   JS 文本里出现 `</script>` 会提前闭合标签，`build-single.mjs` 里统一转成 `<\/script`。

---

## 六、目录速查

```
mini-games/
├─ 小游戏乐园.html          ← 源：三视图 markup + 全局样式（本地双击即玩）
├─ games.config.mjs         ← 源：游戏清单（唯一事实来源）
├─ assets/*.js              ← 源：游戏脚本
├─ site-src/assets/*.js     ← 源：多页面专用脚本（boot.js / portal-home.js）
├─ build-pages.mjs          → site/          多页面站点
├─ build-single.mjs         → dist/          自包含单文件交付版
├─ publish.mjs              → gh-pages 分支  （内部调用 build-pages.mjs）
├─ verify-site.mjs          结构自检 + --selftest
├─ tools/e2e-smoke.py       无头浏览器端到端冒烟（截图落在 tools/_shots/，已忽略）
├─ site/                    （git 忽略）多页面产物，也是 Pages 发布内容
├─ dist/                    （git 忽略）单文件交付版
├─ history/                 版本台账（v1/v2/v3 … 与 MANIFEST.md）
└─ games/                   早期单机版残留（v1 寿司页副本），未被构建引用
```
