/* ============================================================
   games.config.mjs · 小游戏乐园 · 游戏清单（单一事实来源）
   SECTION: games-config
   ------------------------------------------------------------
   新增一款游戏的完整步骤（只碰 3 个地方，不用改构建脚本逻辑）：

     1. 小游戏乐园.html 里加一段视图：
          <!-- SECTION: view-<id> -->
          <div class="view" id="view<Id>"> …视图 markup… </div>
        （视图内若带 <style> 会被构建脚本自动抽到共享 CSS）
     2. 小游戏乐园.html 的门户卡片区加一张卡片，带 data-goto="<id>"
     3. 本文件 GAMES 数组里加一条配置
     4. node build-pages.mjs && node verify-site.mjs
        —— verify 会在「门户缺卡片」「脚本文件缺失」「视图标记写了但没配」
          这类漏改上直接报错。

   路径约定：scripts 一律写相对 site/ 根 的路径（assets/xxx.js）。
   子页面（sushi/match3/…）需要的 ../ 前缀由构建脚本自动补，不用手写。
   app 字段 = 游戏模块挂载的全局名（window.<app>），构建时写成 <body data-app="...">，
   多页面下的 boot.js 靠它挂载，所以加游戏不用改 boot.js。
   ============================================================ */

export const SITE_TITLE = '小游戏乐园 · 迷你游戏合集';

/* 门户首页（不在子目录里，dir 为空串） */
export const PORTAL = {
  id: 'portal',
  dir: '',
  title: SITE_TITLE,
  bodyAttrs: ' data-page="portal"',
  /* 门户封面直接借用消消乐的图标素材渲染，所以门户也要加载 match3-data.js */
  scripts: ['assets/match3-data.js', 'assets/portal-home.js']
};

export const GAMES = [
  {
    id: 'sushi',
    dir: 'sushi',
    title: '回转寿司大作战 · 小游戏乐园',
    /* 游戏模块挂载在 window 上的名字：构建时写成 <body data-app="...">，
       多页面下的 boot.js 据此挂载，加游戏不用改 boot.js */
    app: 'SUSHI_APP',
    /* body 上的 data-* 供 boot.js 读取（data-home=门户相对地址） */
    bodyAttrs: ' data-game="sushi" data-home="../"',
    scripts: [
      'assets/game-data.js',
      'assets/game-scene.js',
      'assets/game-core.js',
      'assets/game.js',
      'assets/boot.js'
    ]
  },
  {
    id: 'match3',
    dir: 'match3',
    title: 'AI图标消消乐 · 小游戏乐园',
    app: 'MATCH3_APP',
    bodyAttrs: ' data-game="match3" data-home="../"',
    scripts: [
      'assets/match3-data.js',
      'assets/match3-core.js',
      'assets/match3.js',
      'assets/boot.js'
    ]
  },
  {
    id: 'morse',
    dir: 'morse',
    title: '深夜电台 · 摩尔斯电码 · 小游戏乐园',
    app: 'MORSE_APP',
    bodyAttrs: ' data-game="morse" data-home="../"',
    scripts: [
      'assets/morse-data.js',
      'assets/morse-core.js',
      'assets/morse.js',
      'assets/boot.js'
    ]
  },
  {
    id: 'manhole',
    dir: 'manhole',
    title: '开车不要压井盖儿 · 小游戏乐园',
    app: 'MANHOLE_APP',
    bodyAttrs: ' data-game="manhole" data-home="../"',
    scripts: [
      'assets/manhole-data.js',
      'assets/manhole-core.js',
      'assets/manhole.js',
      'assets/boot.js'
    ]
  }
];

/* 多页面专用脚本：源文件在 site-src/assets/（受版本控制），构建时复制进 site/assets/。
   与「游戏脚本」分开，因为它们不属于任何一款游戏，只服务于多页面导航/启动。 */
export const PAGES_SCRIPTS = ['boot.js', 'portal-home.js'];

/* 共享样式表产物（由 小游戏乐园.html 的 <style> + 各视图内嵌 <style> 合并生成） */
export const CSS_OUT = 'assets/app.css';

/* 单文件交付版：入口里 <script src="assets/*.js"> 会被内联进 dist/ 下的自包含 HTML */
export const SINGLE_OUT = 'dist/小游戏乐园.html';
