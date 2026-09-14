/* ============================================================
   多页面部署 · 游戏页启动与返回门户
   SECTION: pages-boot
   单文件交付版用 APP_ROUTER 做视图切换；多页面下没有路由，
   本脚本负责挂载对应游戏、并把「返回乐园」按钮接到真实导航。
   ============================================================ */
(function () {
  'use strict';

  var body = document.body;
  var game = body.dataset.game;            // 'sushi' | 'match3'
  var home = body.dataset.home || '../';   // 门户相对地址

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
    if (game === 'sushi' && window.SUSHI_APP) {
      window.SUSHI_APP.mount();
      window.SUSHI_APP.activate();
    } else if (game === 'match3' && window.MATCH3_APP) {
      window.MATCH3_APP.mount();
      window.MATCH3_APP.activate();
    }
  }

  /* SECTION: router-stub
     游戏脚本的 Escape 键返回逻辑依赖 window.APP_ROUTER.go('portal')；
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
