/* ============================================================
   多页面部署 · 门户首页逻辑
   SECTION: portal-home
   负责：卡片导航到各游戏子页、回显本地最高分与关卡进度、
   渲染消消乐封面（与棋盘同源的图标素材）。
   单文件交付版的视图切换由 APP_ROUTER 处理，多页面不需要。
   ============================================================ */
(function () {
  'use strict';

  function readStore(key, def) {
    try {
      var v = parseInt(window.localStorage.getItem(key) || '', 10);
      return isNaN(v) ? def : v;
    } catch (e) { return def; }
  }

  function setTxt(id, txt) {
    var n = document.getElementById(id);
    if (n && n.textContent !== txt) { n.textContent = txt; }
  }

  /* SECTION: stats · 回显各游戏本地最高纪录 */
  function refreshStats() {
    var sushiBest = readStore('kaiten-sushi-best', 0);
    var m3Best = readStore('match3-best', 0);
    var m3Level = readStore('match3-level', 1);
    setTxt('ptSushiBest', sushiBest > 0 ? sushiBest.toLocaleString('zh-CN') : '—');
    setTxt('ptM3Best', m3Best > 0 ? m3Best.toLocaleString('zh-CN') : '—');
    setTxt('ptM3Level', m3Level > 1 ? '第 ' + m3Level + ' 关' : '未通关');
    var badge = document.getElementById('ptRecordBadge');
    if (badge) { badge.classList.toggle('show', sushiBest > 0 || m3Best > 0); }
  }

  /* SECTION: cover · 消消乐封面，用与棋盘一致的图标素材
     远程图标加载失败时保留品牌配色徽章兜底 */
  function buildCover() {
    var host = document.getElementById('ptM3Cover');
    if (!host || !window.MATCH3_DATA) { return; }
    var icons = window.MATCH3_DATA.ICONS;
    var pick = [0, 1, 2, 3, 6, 9, 4, 7, 8];
    host.innerHTML = '';
    for (var i = 0; i < pick.length; i++) {
      var icon = icons[pick[i]];
      if (!icon) { continue; }
      var cell = document.createElement('div');
      cell.className = 'pt-cover-cell';
      cell.style.background = 'linear-gradient(150deg,' + icon.c1 + ' 0%,' + icon.c2 + ' 100%)';

      var badge = document.createElement('span');
      badge.className = 'pt-cover-badge';
      badge.textContent = icon.letter;
      cell.appendChild(badge);

      var im = document.createElement('img');
      im.alt = icon.name;
      im.className = 'pt-cover-img';
      im.draggable = false;
      im.style.display = 'none';
      im.onerror = function () { this.style.display = 'none'; };
      im.onload = function () { this.style.display = ''; };
      im.src = icon.img;
      cell.appendChild(im);

      host.appendChild(cell);
    }
  }

  /* SECTION: navigate · 卡片点击/回车跳转到对应游戏子页 */
  function bindCards() {
    var cards = document.querySelectorAll('[data-goto]');
    for (var i = 0; i < cards.length; i++) {
      (function (node) {
        var target = node.getAttribute('data-goto') + '/';
        node.addEventListener('click', function () { window.location.href = target; });
        node.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            window.location.href = target;
          }
        });
      })(cards[i]);
    }
  }

  function init() {
    refreshStats();
    buildCover();
    bindCards();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
