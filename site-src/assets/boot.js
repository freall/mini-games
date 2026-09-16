/* ============================================================
   多页面部署 · 游戏页启动与返回门户
   SECTION: pages-boot
   单文件交付版用 APP_ROUTER 做视图切换；多页面下没有路由，
   本脚本负责挂载对应游戏、并把「返回乐园」按钮接到真实导航。

   挂哪个游戏由 <body data-app="XXX_APP"> 决定（构建时从 games.config.mjs 写入），
   所以加游戏不用改这个文件。老页面只写了 data-game 的也能用，靠下面的兜底映射。
   ============================================================ */
(function () {
  'use strict';

  var body = document.body;
  var home = body.dataset.home || '../';   // 门户相对地址

  /* 兜底：早期页面只有 data-game，没有 data-app */
  var LEGACY = { sushi: 'SUSHI_APP', match3: 'MATCH3_APP', morse: 'MORSE_APP' };
  var appName = body.dataset.app || LEGACY[body.dataset.game] || '';

  /* SECTION: back-home
     所有 data-back-home 元素统一跳回门户（阻止按钮默认行为） */
  function bindBack() {
    var nodes = document.querySelectorAll('[data-back-home]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener('click', function (e) {
        e.preventDefault();
        window.location.href = home;
      });
    }
  }

  /* SECTION: start-game
     游戏脚本导出 mount/activate；多页面下进入即挂载并激活 */
  function start() {
    var app = appName ? window[appName] : null;
    if (!app) {
      if (appName) { console.warn('[boot] 未找到游戏模块 window.' + appName + '（脚本顺序或名字写错了？）'); }
      return;
    }
    if (typeof app.mount === 'function') { app.mount(); }
    if (typeof app.activate === 'function') { app.activate(); }
  }

  /* SECTION: router-stub
     游戏脚本的 Escape 返回逻辑依赖 window.APP_ROUTER.go('portal')；
     多页面下没有视图路由，这里提供一个跳转 stub，让 Escape 也能返回门户。
     必须在 start() 之前装好，游戏 mount 时即可读到。 */
  function setupRouterStub() {
    window.APP_ROUTER = {
      go: function (name) {
        if (name === 'portal') { window.location.href = home; }
      }
    };
  }

  function init() {
    setupRouterStub();
    bindBack();
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
