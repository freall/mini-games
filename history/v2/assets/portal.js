/* ============================================================
   小游戏乐园 · 门户与视图路由
   SECTION: portal-router
   ============================================================ */
window.APP_ROUTER = (function () {
  'use strict';

  var VIEW_IDS = {
    portal: 'viewPortal',
    sushi: 'viewSushi',
    match3: 'viewMatch3'
  };

  /* 视图 → 对应应用模块（门户自身无模块） */
  var APPS = {
    sushi: function () { return window.SUSHI_APP; },
    match3: function () { return window.MATCH3_APP; }
  };

  var current = 'portal';
  var mounted = { sushi: false, match3: false };

  function $(id) { return document.getElementById(id); }

  function viewEl(name) { return $(VIEW_IDS[name]); }

  /* SECTION: stats
     门户卡片展示各游戏的本地最高纪录，切换回门户时刷新 */
  function readStore(key, def) {
    try {
      var v = parseInt(window.localStorage.getItem(key) || '', 10);
      return isNaN(v) ? def : v;
    } catch (e) { return def; }
  }

  function refreshStats() {
    var sushiBest = readStore('kaiten-sushi-best', 0);
    var m3Best = readStore('match3-best', 0);
    var m3Level = readStore('match3-level', 1);
    setTxt('ptSushiBest', sushiBest > 0 ? sushiBest.toLocaleString('zh-CN') : '—');
    setTxt('ptM3Best', m3Best > 0 ? m3Best.toLocaleString('zh-CN') : '—');
    setTxt('ptM3Level', m3Level > 1 ? '第 ' + m3Level + ' 关' : '未通关');
    var badge = $('ptRecordBadge');
    if (badge) { badge.classList.toggle('show', sushiBest > 0 || m3Best > 0); }
  }

  function setTxt(id, txt) {
    var n = $(id);
    if (n && n.textContent !== txt) { n.textContent = txt; }
  }

  /* SECTION: mount-lazy
     游戏模块在首次进入该视图时才绑定 DOM 与事件 */
  function ensureMounted(name) {
    if (mounted[name]) { return; }
    var app = APPS[name] && APPS[name]();
    if (!app) { return; }
    if (typeof app.mount === 'function') { app.mount(viewEl(name)); }
    mounted[name] = true;
  }

  /* SECTION: navigate */
  function go(name, opts) {
    if (!VIEW_IDS[name]) { name = 'portal'; }
    if (name === current) { return; }

    /* 关闭当前视图的应用：停止循环、释放输入 */
    var prevApp = APPS[current] && APPS[current]();
    if (prevApp && typeof prevApp.deactivate === 'function') { prevApp.deactivate(); }

    var prevEl = viewEl(current);
    if (prevEl) { prevEl.classList.remove('active'); }

    current = name;

    if (name === 'portal') {
      refreshStats();
    } else {
      ensureMounted(name);
      var app = APPS[name]();
      if (app && typeof app.activate === 'function') { app.activate(); }
    }

    var nextEl = viewEl(name);
    if (nextEl) { nextEl.classList.add('active'); }

    if (!opts || !opts.silent) {
      var hash = name === 'portal' ? '' : '#' + name;
      if (window.location.hash !== hash) {
        try { window.history.replaceState(null, '', hash || window.location.pathname); }
        catch (e) { window.location.hash = hash; }
      }
    }
    window.scrollTo(0, 0);
  }

  function goFromHash() {
    var h = (window.location.hash || '').replace('#', '');
    go(VIEW_IDS[h] ? h : 'portal', { silent: true });
  }

  /* SECTION: cover-art
     门户上消消乐卡片的封面：用与棋盘一致的图标素材渲染一组小格，
     远程图标加载失败时自动保留品牌配色徽章。 */
  function buildCover() {
    var host = $('ptM3Cover');
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
      im.dataset.image = icon.id;
      im.onerror = function () { this.style.display = 'none'; };
      im.onload = function () { this.style.display = ''; };
      im.style.display = 'none';
      im.src = icon.img;
      cell.appendChild(im);

      host.appendChild(cell);
    }
  }

  /* SECTION: bind */
  function bind() {
    var cards = document.querySelectorAll('[data-goto]');
    for (var i = 0; i < cards.length; i++) {
      (function (node) {
        var target = node.getAttribute('data-goto');
        node.addEventListener('click', function () { go(target); });
      })(cards[i]);
    }
    var backs = document.querySelectorAll('[data-back-home]');
    for (var j = 0; j < backs.length; j++) {
      backs[j].addEventListener('click', function () { go('portal'); });
    }
    window.addEventListener('hashchange', goFromHash);
    window.addEventListener('resize', function () {
      var app = APPS[current] && APPS[current]();
      if (app && typeof app.resize === 'function') { app.resize(); }
    });
  }

  /* SECTION: boot */
  function init() {
    buildCover();
    bind();
    refreshStats();
    /* 预挂载消消乐，让远程图标在门户阶段就开始加载 */
    ensureMounted('match3');
    ensureMounted('sushi');
    goFromHash();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { go: go, current: function () { return current; } };
})();
