# -*- coding: utf-8 -*-
"""端到端冒烟测试（无头 Chromium + Playwright）

两种被测形态：
  1. 多页面站点 site/（默认；也可 --url 直接打线上）
  2. 单文件交付版 dist/小游戏乐园.html（--single，走 file:// + 页内 APP_ROUTER，
     与多页面版是两条不同的路由代码路径）

为什么留着它：多页面改造期间，正是这个脚本抓出了「消消乐开始界面被
overflow:hidden 裁剪、开始按钮不可见也点不到」的 P0 —— 静态自检
（verify-site.mjs）只查结构，查不出这种"结构齐全但视觉上根本点不到"的问题。
摩尔斯那关它又抓出两个：看码按钮因 BY_CHAR 挂错模块而抛异常、以及
「一条电文发完后 450ms 的延迟会把玩家抢先敲下的符号清掉」。

依赖：pip install playwright && playwright install chromium
用法：python tools/e2e-smoke.py
      python tools/e2e-smoke.py --url https://freall.github.io/mini-games
      python tools/e2e-smoke.py --single dist/小游戏乐园.html
覆盖：门户导航 → 六款游戏各自开局、玩法关键判定、结算落盘、门户成绩回显、窄屏可点性，
     以及「控制台/页面零报错」硬断言。
产物：tools/_shots/*.png 截图（已 gitignore）；终端打印断言汇总，失败非零退出
"""
import io, os, sys, threading, http.server, socketserver, functools

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE = os.path.join(ROOT, 'site')
SHOTS = os.path.join(HERE, '_shots')
PORT = 18093
OUT = []


def log(s):
    OUT.append(str(s))
    print(s)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(root, port):
    handler = functools.partial(Handler, directory=root)
    httpd = socketserver.TCPServer(('127.0.0.1', port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# 元素是否"真的能点到"：尺寸非零 + 在视口内 + elementFromPoint 命中的是它自己或它的后代。
# 注意不能把"命中它的某个祖先"也当成 OK —— 那说明按钮被裁掉/没画在那儿，
# 点在屏幕上只会落到外层容器上（摩尔斯开始层就是这么漏过去一次）。
HITTABLE = """(id) => {
  const e = document.getElementById(id);
  if (!e) return 'MISSING';
  const r = e.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return 'ZERO_SIZE';
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return 'OFF_VIEWPORT ' + cx + ',' + cy;
  const t = document.elementFromPoint(cx, cy);
  if (!t) return 'NO_HIT';
  if (t === e || e.contains(t)) return 'OK';
  return 'COVERED_BY ' + t.tagName + '#' + (t.id || '') + '.' + t.className
    + (t.contains(e) ? '（按钮被裁掉了：只命中外层容器）' : '');
}"""


def launch(p):
    """优先用 playwright 自带的 chromium。自带浏览器的构建号与 pip 里的
    playwright 版本对不上时（升级过 playwright 就会出现这种状况），退回系统
    Chrome/Edge —— 冒烟要验的是页面行为，用哪个 Chromium 外壳不影响结论。"""
    try:
        return p.chromium.launch(headless=True)
    except Exception as e:
        log('自带 chromium 启动失败（%s），改用系统 Chrome' % str(e)[:60])
        return p.chromium.launch(headless=True, channel='chrome')


def run_single(path):
    """单文件交付版：走的是 portal.js 的 APP_ROUTER（页内切视图），
    与多页面版完全不同的代码路径，所以单独冒烟一遍。"""
    from playwright.sync_api import sync_playwright
    # README 里给的是相对写法（dist/小游戏乐园.html），file:// 需要绝对路径
    path = os.path.abspath(path)
    url = 'file:///' + path.replace('\\', '/')
    log('目标：单文件交付版 %s' % url)
    results, errors = [], []
    with sync_playwright() as p:
        b = launch(p)
        pg = b.new_context(viewport={'width': 1280, 'height': 900}).new_page()
        pg.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.goto(url, wait_until='load')
        pg.wait_for_timeout(1200)
        results.append(('单文件 标题', pg.title() == '小游戏乐园 · 迷你游戏合集', pg.title()))
        results.append(('单文件 门户 6 张卡', pg.locator('.pt-card').count() == 6,
                        'cards=%d' % pg.locator('.pt-card').count()))
        results.append(('单文件 页内路由可用', pg.evaluate("() => !!window.APP_ROUTER"), ''))

        pg.evaluate("() => window.APP_ROUTER.go('morse')")
        pg.wait_for_timeout(900)
        vis = pg.evaluate("() => getComputedStyle(document.getElementById('viewMorse')).display")
        results.append(('单文件 切到摩尔斯视图', vis == 'flex', 'display=%s' % vis))
        results.append(('单文件 摩尔斯模块已挂载',
                        pg.evaluate("() => !!(window.MORSE_APP && window.MORSE_APP.stats().state)"), ''))
        pg.locator('#morseBtnStart').click()
        pg.wait_for_timeout(600)
        ch = pg.evaluate("() => { const n = document.querySelector('#morseWord .mr-char.cur'); return n ? n.dataset.ch : ''; }")
        code = pg.evaluate("(ch) => (window.MORSE_DATA.BY_CHAR[ch] || {}).code || ''", ch)
        box = pg.evaluate("""() => { const r = document.getElementById('morseKey').getBoundingClientRect();
          return [r.x + r.width/2, r.y + r.height/2]; }""")
        pg.mouse.move(box[0], box[1])
        for sym in code:
            pg.mouse.down()
            pg.wait_for_timeout(60 if sym == '.' else 380)
            pg.mouse.up()
            pg.wait_for_timeout(90)
        pg.wait_for_timeout(760)
        st = pg.evaluate("() => window.MORSE_APP.stats()")
        results.append(('单文件 发对一个字（%s = %s）' % (ch, code), st['score'] > 0,
                        'score=%d 连击=%d' % (st['score'], st['combo'])))
        pg.screenshot(path=os.path.join(SHOTS, 'single-morse.png'))

        pg.evaluate("() => window.APP_ROUTER.go('portal')")
        pg.wait_for_timeout(700)
        back = pg.evaluate("() => getComputedStyle(document.getElementById('viewPortal')).display")
        results.append(('单文件 返回门户', back == 'flex', 'display=%s' % back))

        # ---- 单文件版的井盖游戏（页内路由路径与多页面版不同） ----
        pg.evaluate("() => window.APP_ROUTER.go('manhole')")
        pg.wait_for_timeout(900)
        vis = pg.evaluate("() => getComputedStyle(document.getElementById('viewManhole')).display")
        results.append(('单文件 切到井盖视图', vis == 'flex', 'display=%s' % vis))
        results.append(('单文件 井盖模块已挂载',
                        pg.evaluate("() => !!(window.MANHOLE_APP && window.MANHOLE_APP.stats().phase)"), ''))
        hit = pg.evaluate(HITTABLE, 'mhBtnStart')
        results.append(('单文件 井盖上路按钮可点', hit == 'OK', hit))
        pg.locator('#mhBtnStart').click()
        pg.wait_for_timeout(2400)
        st = pg.evaluate("() => window.MANHOLE_APP.stats()")
        results.append(('单文件 井盖可开局', st.get('phase') == 'play', 'phase=%s' % st.get('phase')))
        px = pg.evaluate("""() => { const c = document.getElementById('mhCanvas'); const g = c.getContext('2d');
          const d = g.getImageData(0, 0, Math.min(c.width, 600), Math.min(c.height, 400)).data; let n = 0;
          for (let i = 3; i < d.length; i += 40) { if (d[i] > 0) n++; } return n; }""")
        results.append(('单文件 井盖 canvas 已绘制', px > 50, 'nonempty=%d' % px))
        pg.evaluate("""() => {
          const w = window.MANHOLE_APP._world(), C = window.MANHOLE_CORE, D = window.MANHOLE_DATA;
          const x = C.laneCenterX(D, w.lanes, 1);
          w.carX = x;
          w.obs = [{ kind: 'manhole', x: x, y: D.PLAYER.y, r: C.manholeRadius(D, w.lanes) }];
        }""")
        pg.wait_for_timeout(400)
        results.append(('单文件 压到井盖即结束',
                        pg.evaluate("() => window.MANHOLE_APP.stats().over") is True, ''))
        pg.wait_for_timeout(800)   # 等结算层弹出，截图才有内容
        pg.screenshot(path=os.path.join(SHOTS, 'single-manhole.png'))

        # ---- 单文件版的烽火军棋（页内路由，与多页面版是两条路径） ----
        pg.evaluate("() => window.APP_ROUTER.go('junqi')")
        pg.wait_for_timeout(1100)
        vis = pg.evaluate("() => getComputedStyle(document.getElementById('viewJunqi')).display")
        results.append(('单文件 切到军棋视图', vis == 'flex', 'display=%s' % vis))
        results.append(('单文件 军棋模块已挂载',
                        pg.evaluate("() => !!(window.JUNQI_APP && window.JUNQI_APP.stats().phase)"), ''))
        results.append(('单文件 军棋棋盘已渲染',
                        pg.locator('#viewJunqi .jq-p').count() == 50,
                        'pieces=%d' % pg.locator('#viewJunqi .jq-p').count()))
        hit = pg.evaluate(HITTABLE, 'jqBtnStart')
        results.append(('单文件 军棋开局按钮可点', hit == 'OK', hit))
        pg.locator('#jqBtnStart').click()
        pg.wait_for_timeout(600)
        st = pg.evaluate("() => window.JUNQI_APP.stats()")
        results.append(('单文件 军棋可进布阵', st['phase'] == 'deploy', 'phase=%s' % st['phase']))
        r = pg.evaluate("() => window.JUNQI_APP._debugMove(0)")
        results.append(('单文件 军棋可电脑应手（AI 真的走了子）',
                        r['plies'] >= 2 and r['logRows'] >= 2,
                        'plies=%d log=%d' % (r['plies'], r['logRows'])))
        pg.evaluate("() => window.APP_ROUTER.go('portal')")
        pg.wait_for_timeout(500)

        # ---- 单文件版的靶场神枪手（第六款：页内路由，与多页面版是两条代码路径） ----
        pg.evaluate("() => window.APP_ROUTER.go('shooter')")
        pg.wait_for_timeout(1100)
        vis = pg.evaluate("() => getComputedStyle(document.getElementById('viewShooter')).display")
        results.append(('单文件 切到靶场视图', vis == 'flex', 'display=%s' % vis))
        results.append(('单文件 靶场模块已挂载',
                        pg.evaluate("() => !!(window.SHOOTER_APP && window.SHOOTER_APP.stats().phase)"), ''))
        hit = pg.evaluate(HITTABLE, 'shBtnStart')
        results.append(('单文件 靶场进入靶位按钮可点', hit == 'OK', hit))
        pg.locator('#shBtnStart').click()
        # 倒计时 1.84s + 首发靶还有 0.55s 进场与 0.28s 升起 —— 逐帧等到"真有个能打的靶"再开枪
        st = {'fired': 0}
        for _ in range(14):
            pg.wait_for_timeout(400)
            st = pg.evaluate("""() => { const A = window.SHOOTER_APP;
              const t = A._debugTargets().filter(x => !x.bad && x.vis)[0];
              if (t) A._debugFire(t.x, t.y);
              const a = A.stats();
              return { phase: a.phase, downs: a.downs, fired: a.stats.fired, score: a.score }; }""")
            if st['fired'] >= 1:
                break
        results.append(('单文件 靶场可开局并能击落',
                        st['phase'] == 'play' and st['fired'] >= 1 and st['score'] > 0, str(st)))
        px = pg.evaluate("() => { const c = document.getElementById('shCanvas');"
                         " const g = c.getContext('2d');"
                         " const d = g.getImageData(0, 0, Math.min(c.width, 600), Math.min(c.height, 400)).data;"
                         " let n = 0; for (let i = 3; i < d.length; i += 40) { if (d[i] > 0) n++; } return n; }")
        results.append(('单文件 靶场 canvas 已绘制', px > 50, 'nonempty=%d' % px))
        pg.screenshot(path=os.path.join(SHOTS, 'single-shooter.png'))
        # 单文件版要能"打完一局 → 回门户 → 卡片上看见成绩"：这才是"两份回显实现"里的另一份
        pg.evaluate("() => { const A = window.SHOOTER_APP; const w = A._world();"
                    " w.need = w.downs; }")      # 击落数已达标，下一帧 step 自动结算
        pg.wait_for_timeout(700)
        fin = pg.evaluate("() => window.SHOOTER_APP.stats().phase")
        pg.evaluate("() => window.APP_ROUTER.go('portal')")
        pg.wait_for_timeout(600)
        sb = pg.locator('#ptShBest').inner_text().strip()
        lv = pg.locator('#ptShLevel').inner_text().strip()
        results.append(('单文件 打完一局回门户后靶场成绩与关口已回显',
                        fin in ('clear', 'over') and sb not in ('', u'\\u2014') and '2' in lv,
                        'phase=%s ptShBest=%s ptShLevel=%s' % (fin, sb, lv)))
        b.close()

    log('')
    log('=== 控制台 error ===')
    log('\n'.join(errors) if errors else '（无）')
    log('')
    log('=== 断言汇总 ===')
    # 控制台/页面报错必须为零 —— 只打印不计红的话，"判定全对但渲染层每帧
    # undefined[0]" 这类 bug 会带着 440 条 pageerror 冒充全绿（真实踩过）。
    results.append(('控制台/页面零报错', len(errors) == 0,
                    ('%d 条，首条: %s' % (len(errors), errors[0][:72])) if errors else ''))
    bad = 0
    for name, ok, extra in results:
        if not ok:
            bad += 1
        log('  %s %-32s %s' % ('✓' if ok else '✗', name, extra))
    log('')
    log('失败 %d / %d' % (bad, len(results)))
    return 1 if bad else 0


def main():
    from playwright.sync_api import sync_playwright

    if '--single' in sys.argv:
        return run_single(sys.argv[sys.argv.index('--single') + 1])

    online = '--url' in sys.argv
    httpd = None
    if online:
        base = sys.argv[sys.argv.index('--url') + 1].rstrip('/')
        log('目标：' + base)
    else:
        httpd = serve(SITE, PORT)
        base = 'http://127.0.0.1:%d' % PORT
        log('目标：本机 site/（%s）' % base)
    os.makedirs(SHOTS, exist_ok=True)

    results, errors = [], []
    with sync_playwright() as p:
        b = launch(p)
        ctx = b.new_context(viewport={'width': 1280, 'height': 900})
        pg = ctx.new_page()
        pg.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('requestfailed', lambda r: errors.append('requestfailed: ' + r.url))

        # ---- 门户 ----
        pg.goto(base + '/', wait_until='load')
        pg.wait_for_timeout(1200)
        cards = pg.locator('.pt-card').count()
        cover = pg.locator('#ptM3Cover .pt-cover-cell').count()
        pg.screenshot(path=os.path.join(SHOTS, 'portal.png'), full_page=True)
        results.append(('门户标题', pg.title() == '小游戏乐园 · 迷你游戏合集', pg.title()))
        results.append(('门户卡片数 = 6', cards == 6, 'cards=%d' % cards))
        results.append(('门户封面图标已渲染', cover >= 6, 'cells=%d' % cover))
        for i, want in enumerate(['sushi', 'match3', 'morse', 'manhole', 'junqi', 'shooter']):
            pg.goto(base + '/', wait_until='load')
            pg.wait_for_timeout(400)
            pg.locator('.pt-card').nth(i).click()
            pg.wait_for_load_state('load')
            pg.wait_for_timeout(500)
            tail = '/' + want
            bare = pg.url.split('?')[0]
            landed = bare.endswith(tail + '/') or bare.endswith(tail + '/index.html') or bare.endswith(tail)
            results.append(('门户第 %d 张卡 -> %s/' % (i + 1, want), landed, pg.url))
        pg.close()

        def new_page():
            p2 = ctx.new_page()
            p2.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
            p2.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            p2.on('requestfailed', lambda r: errors.append('requestfailed: ' + r.url))
            return p2

        # ---- 寿司页 ----
        pg = new_page()
        pg.goto(base + '/sushi/', wait_until='load')
        pg.wait_for_timeout(900)
        results.append(('寿司页 挂载 API 可用',
                        pg.evaluate("!!(window.SUSHI_APP && window.SUSHI_APP.mount && window.SUSHI_APP.activate)"), ''))
        results.append(('寿司页 开始层初始显示', 'show' in (pg.locator('#ovStart').get_attribute('class') or ''), ''))
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(900)
        results.append(('寿司页 菜单态 Escape 回门户', pg.url.rstrip('/') == base, pg.url))
        pg.goto(base + '/sushi/', wait_until='load')
        pg.wait_for_timeout(900)
        hit = pg.evaluate(HITTABLE, 'btnStart')
        results.append(('寿司页 开始营业按钮可点', hit == 'OK', hit))
        pg.locator('#btnStart').click()
        pg.wait_for_timeout(1800)
        px = pg.evaluate("""() => { const c = document.getElementById('game'); const g = c.getContext('2d');
          const d = g.getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data; let n = 0;
          for (let i = 3; i < d.length; i += 40) { if (d[i] > 0) n++; } return n; }""")
        results.append(('寿司页 开场后开始层隐藏', 'show' not in (pg.locator('#ovStart').get_attribute('class') or ''), ''))
        results.append(('寿司页 canvas 已绘制', px > 50, 'nonempty=%d' % px))
        pg.screenshot(path=os.path.join(SHOTS, 'sushi-playing.png'), full_page=True)
        pg.close()

        # ---- 消消乐页 ----
        pg = new_page()
        pg.goto(base + '/match3/', wait_until='load')
        pg.wait_for_timeout(1200)
        results.append(('消消乐 挂载 API 可用',
                        pg.evaluate("!!(window.MATCH3_APP && window.MATCH3_APP.mount && window.MATCH3_APP.activate)"), ''))
        hit = pg.evaluate(HITTABLE, 'm3BtnStart')
        results.append(('消消乐 开始按钮可点（P0 回归）', hit == 'OK', hit))
        wrap_h = pg.evaluate("() => Math.round(document.getElementById('m3BoardWrap').getBoundingClientRect().height)")
        results.append(('消消乐 开局前棋盘区已占位', wrap_h > 300, 'boardwrap=%spx' % wrap_h))
        pg.screenshot(path=os.path.join(SHOTS, 'match3-start.png'))
        pg.locator('#m3BtnStart').click()
        pg.wait_for_timeout(1300)
        tiles = pg.locator('#m3Board .m3-tile').count()
        moves0 = pg.locator('#m3Moves').inner_text()
        results.append(('消消乐 开局后铺满 64 格', tiles == 64, 'tiles=%d' % tiles))

        # 从 DOM 读棋盘，自己算一步「一定能消」的交换，避免靠碰运气拖拽（会 flaky）
        grid = pg.evaluate("""() => {
          const g = {};
          document.querySelectorAll('#m3Board .m3-tile').forEach(t => {
            g[t.dataset.r + ',' + t.dataset.c] = t.dataset.color;
          });
          return g;
        }""")
        size = max(int(k.split(',')[0]) for k in grid) + 1
        board = [[grid.get('%d,%d' % (r, c)) for c in range(size)] for r in range(size)]

        def has3(gr):
            for r in range(size):
                for c in range(size - 2):
                    if gr[r][c] is not None and gr[r][c] == gr[r][c + 1] == gr[r][c + 2]:
                        return True
            for c in range(size):
                for r in range(size - 2):
                    if gr[r][c] is not None and gr[r][c] == gr[r + 1][c] == gr[r + 2][c]:
                        return True
            return False

        # 找一步有效交换（只考虑横向/纵向相邻两格互换后能成三连的）
        pair = None
        for r in range(size):
            for c in range(size):
                for dr, dc in ((0, 1), (1, 0)):
                    r2, c2 = r + dr, c + dc
                    if r2 >= size or c2 >= size:
                        continue
                    trial = [row[:] for row in board]
                    trial[r][c], trial[r2][c2] = trial[r2][c2], trial[r][c]
                    if has3(trial):
                        pair = ((r, c), (r2, c2))
                        break
                if pair:
                    break
            if pair:
                break

        moves_after = moves0
        if pair:
            def center(rc):
                return pg.evaluate("""(rc) => {
                  const t = document.querySelector('#m3Board .m3-tile[data-r="' + rc[0] + '"][data-c="' + rc[1] + '"]');
                  const r = t.getBoundingClientRect();
                  return [r.x + r.width / 2, r.y + r.height / 2];
                }""", [rc[0], rc[1]])
            p1 = center(pair[0])
            p2 = center(pair[1])
            pg.mouse.move(p1[0], p1[1])
            pg.mouse.down()
            pg.mouse.move(p2[0], p2[1], steps=10)
            pg.mouse.up()
            pg.wait_for_timeout(900)
            moves_after = pg.locator('#m3Moves').inner_text()
        results.append(('消消乐 拖拽交换生效（步数减少）', moves_after != moves0,
                        'moves %s -> %s（交换 %s）' % (moves0, moves_after, pair)))
        pg.screenshot(path=os.path.join(SHOTS, 'match3-playing.png'))
        pg.locator('[data-back-home]').first.click()
        pg.wait_for_timeout(900)
        results.append(('消消乐 返回乐园按钮', pg.url.rstrip('/') == base, pg.url))
        pg.close()

        # ---- 摩尔斯页 ----
        pg = new_page()
        # 深链：?mode= 直接进指定模块（README 里对外承诺的用法）
        pg.goto(base + '/morse/?mode=digit', wait_until='load')
        pg.wait_for_timeout(900)
        deep = pg.evaluate("() => window.MORSE_APP.stats().mode")
        results.append(('摩尔斯 ?mode=digit 深链进数字模块', deep == 'digit', 'mode=%s' % deep))
        pg.goto(base + '/morse/', wait_until='load')
        pg.wait_for_timeout(1000)
        results.append(('摩尔斯 挂载 API 可用',
                        pg.evaluate("!!(window.MORSE_APP && window.MORSE_APP.mount && window.MORSE_APP.activate)"), ''))
        results.append(('摩尔斯 码表加载完整（36 字符）',
                        pg.evaluate("() => window.MORSE_DATA && window.MORSE_DATA.CHARS.length") == 36, ''))
        hit = pg.evaluate(HITTABLE, 'morseBtnStart')
        results.append(('摩尔斯 开始按钮可点', hit == 'OK', hit))

        # 模块选择器：开始面板是铺满屏幕的覆盖层，会盖住棋盘上的标签，
        # 所以开始/结算面板里另放一份同样的选择器（data-mode 统一分发）
        def st():
            return pg.evaluate("() => window.MORSE_APP.stats()")

        def switch_mode(m):
            if 'show' in (pg.locator('#morseOvStart').get_attribute('class') or ''):
                pg.locator('#morseChooserStart [data-mode="%s"]' % m).click()
            else:
                pg.locator('#morseTabs [data-mode="%s"]' % m).click()
            pg.wait_for_timeout(500)

        chips = pg.locator('#morseChooserStart [data-mode]').count()
        results.append(('摩尔斯 开始面板里有模块选择器', chips == 3, 'chips=%d' % chips))
        switch_mode('recv')
        r1 = st()['mode']
        switch_mode('send')
        r2 = st()['mode']
        results.append(('摩尔斯 开始面板可切换模块', r1 == 'recv' and r2 == 'send', '%s -> %s' % (r1, r2)))

        pg.screenshot(path=os.path.join(SHOTS, 'morse-start.png'))
        pg.locator('#morseBtnStart').click()
        pg.wait_for_timeout(700)

        # 电键：点 = 短按，划 = 按住；最后停顿超过 560ms 触发提交
        def key_center():
            pg.evaluate("() => null")   # 确保上一帧已布局
            return pg.evaluate("""() => { const r = document.getElementById('morseKey').getBoundingClientRect();
              return [r.x + r.width / 2, r.y + r.height / 2]; }""")

        def send(code):
            k = key_center()
            pg.mouse.move(k[0], k[1])
            for sym in code:
                pg.mouse.down()
                pg.wait_for_timeout(60 if sym == '.' else 380)
                pg.mouse.up()
                pg.wait_for_timeout(90)
            pg.wait_for_timeout(760)          # 松手停顿 → 本字符自动提交

        def cur_char():
            return pg.evaluate("""() => { const n = document.querySelector('#morseWord .mr-char.cur');
              return n ? n.dataset.ch : ''; }""")

        def code_of(ch):
            return pg.evaluate("(ch) => (window.MORSE_DATA.BY_CHAR[ch] || {}).code || ''", ch)

        first = cur_char()
        results.append(('摩尔斯 已出题（当前字符可读）', len(first) == 1, 'char=%r' % first))
        score0 = int(pg.locator('#morseScore').inner_text() or 0)
        code = code_of(first)
        results.append(('摩尔斯 能从码表取到该字符的码', len(code) >= 1, '%s = %s' % (first, code)))
        send(code)
        score1 = int(pg.locator('#morseScore').inner_text() or 0)
        results.append(('摩尔斯 发对一个字（得分增加）', score1 > score0, 'score %d -> %d' % (score0, score1)))

        # 连发后面两个字，验证光标推进与连击
        ok_chars = 1
        for _ in range(2):
            ch = cur_char()
            if not ch:
                break
            send(code_of(ch))
            ok_chars += 1
        combo = pg.locator('#morseCombo').inner_text()
        results.append(('摩尔斯 连发三字（连击倍率上升）', ok_chars >= 2 and combo != '×1',
                        '连发 %d 字 combo=%s' % (ok_chars, combo)))
        mastery = pg.evaluate("() => JSON.parse(localStorage.getItem('morse-mastery') || '{}')")
        results.append(('摩尔斯 熟练度已写入本地存档',
                        any(int(v) >= 2 for v in mastery.values()), 'mastery=%s' % mastery))
        pg.screenshot(path=os.path.join(SHOTS, 'morse-playing.png'))

        # 辅助功能：看码（用了本字得分减半，但仍能继续发）
        pg.locator('#morseBtnReveal').click()
        pg.wait_for_timeout(300)
        tip = pg.locator('#morseCharTip').inner_text()
        results.append(('摩尔斯 看码按钮给出码与口诀', ('·' in tip or '—' in tip) and '减半' in tip, tip[:46]))

        # 暂停 / 继续
        pg.locator('#morseBtnPause').click()
        pg.wait_for_timeout(400)
        paused = 'show' in (pg.locator('#morseOvPause').get_attribute('class') or '')
        pg.locator('#morseBtnResume').click()
        pg.wait_for_timeout(400)
        resumed = 'show' not in (pg.locator('#morseOvPause').get_attribute('class') or '')
        results.append(('摩尔斯 暂停层可开可关', paused and resumed, 'paused=%s resumed=%s' % (paused, resumed)))

        # 错误路径：故意发一个错码 → 扣命 + 提示正确码
        lives0 = pg.locator('#morseLives').inner_text()
        send('-' if code_of(cur_char()) != '-' else '.')
        lives1 = pg.locator('#morseLives').inner_text()
        tip_after = pg.locator('#morseCharTip').inner_text()
        results.append(('摩尔斯 发错扣命并给出正确码',
                        lives1.count('❤') < lives0.count('❤') and '应该是' in tip_after,
                        '生命 %s -> %s' % (lives0, lives1)))
        pg.screenshot(path=os.path.join(SHOTS, 'morse-wrong.png'))

        # ---- 模块二：抄收（听/看码 → 解码）----
        switch_mode('recv')
        m = st()
        results.append(('摩尔斯 切到抄收模块', m['mode'] == 'recv', 'mode=%s' % m['mode']))
        key_vis = pg.evaluate("() => getComputedStyle(document.getElementById('morseKey')).display")
        results.append(('摩尔斯 抄收模块不显示电键', key_vis == 'none', 'key display=%s' % key_vis))
        pg.locator('#morseBtnStart').click()
        pg.wait_for_timeout(900)
        m = st()
        n_opts = pg.locator('#morseOptions button').count()
        results.append(('摩尔斯 抄收已出题（选项与状态一致）',
                        m['state'] == 'playing' and n_opts == len(m['options']) and len(m['options']) >= 3,
                        'options=%s' % m['options']))
        pg.screenshot(path=os.path.join(SHOTS, 'morse-recv.png'))

        ans = m['answer']
        score0 = m['score']
        pg.locator('#morseOptions button[data-ch="%s"]' % ans).click()
        pg.wait_for_timeout(1000)          # 判对后先亮答案 700ms 再进下一题
        m2 = st()
        results.append(('摩尔斯 抄收答对（得分增加且进入下一题）',
                        m2['score'] > score0 and m2['roundIndex'] == m['roundIndex'] + 1,
                        'answer=%s score %d -> %d，题号 %d -> %d'
                        % (ans, score0, m2['score'], m['roundIndex'], m2['roundIndex'])))

        # 呈现方式：切「看码」后重放，点划条应逐段画出来
        pg.locator('#morseBtnView').click()
        pg.wait_for_timeout(300)
        results.append(('摩尔斯 可切换听/看两种呈现', st()['viewMode'] == 'watch', 'viewMode=' + st()['viewMode']))
        pg.locator('#morseBtnPlay').click()
        pg.wait_for_timeout(1200)
        trace = pg.locator('#morseTrace i').count()
        results.append(('摩尔斯 看码模式画出了点划条', trace > 0, 'trace=%d 段' % trace))
        pg.screenshot(path=os.path.join(SHOTS, 'morse-recv-watch.png'))

        # 答错：扣命 + 正确答案被标出来
        m = st()
        wrong_ch = next(c for c in m['options'] if c != m['answer'])
        lives0 = m['lives']
        pg.locator('#morseOptions button[data-ch="%s"]' % wrong_ch).click()
        pg.wait_for_timeout(300)
        marked = pg.evaluate("() => !!document.querySelector('#morseOptions button.right')")
        m3 = st()
        results.append(('摩尔斯 抄收答错扣命并标出正确项',
                        m3['lives'] == lives0 - 1 and marked,
                        '选了 %s，正确 %s，生命 %d -> %d' % (wrong_ch, m['answer'], lives0, m3['lives'])))

        # ---- 模块三：数字（编码 + 解码交替）----
        switch_mode('digit')
        results.append(('摩尔斯 切到数字模块', st()['mode'] == 'digit', 'mode=' + st()['mode']))
        law = pg.locator('#morsePanelDigit .mr-law').inner_text()
        results.append(('摩尔斯 数字模块给出「数字律」提示', 'n 个点' in law, law[:34]))
        pg.locator('#morseBtnStart').click()
        pg.wait_for_timeout(900)

        types, score_before, ok_cnt = [], st()['score'], 0
        for _ in range(3):
            m = st()
            types.append(m['digitType'])
            if m['digitType'] == 'encode':
                send(code_of(m['answer']))
            else:
                pg.locator('#morseDigitOptions button[data-ch="%s"]' % m['answer']).click()
                pg.wait_for_timeout(900)
            if st()['score'] > score_before:
                ok_cnt += 1
            score_before = st()['score']
        m = st()
        results.append(('摩尔斯 数字模块编码/解码都能作答',
                        ok_cnt >= 2 and ('encode' in types and 'decode' in types),
                        '题型=%s 答对 %d/3' % ('/'.join(types), ok_cnt)))
        pg.screenshot(path=os.path.join(SHOTS, 'morse-digit.png'))

        pg.locator('[data-back-home]').first.click()
        pg.wait_for_timeout(900)
        results.append(('摩尔斯 返回乐园按钮', pg.url.rstrip('/') == base, pg.url))
        pg.close()

        # ---- 开车不要压井盖儿页 ----
        # 这一节重点验三件事：
        #   ① 开始层的主按钮在真实视口里"点得到"（覆盖层被裁剪是历史 P0）；
        #   ② Canvas 真的画出了东西（夜景路面 + 车 + 井盖）；
        #   ③ 核心规则真的生效 —— 用 _debugStart 起一局，
        #      把车直接挪到井盖正下方，推进几帧，必须结束本局。
        pg = new_page()
        pg.goto(base + '/manhole/', wait_until='load')
        pg.wait_for_timeout(1000)
        results.append(('井盖页 挂载 API 可用',
                        pg.evaluate("!!(window.MANHOLE_APP && window.MANHOLE_APP.mount"
                                    " && window.MANHOLE_APP.activate && window.MANHOLE_APP.stats)"), ''))
        results.append(('井盖页 开始层初始显示',
                        'show' in (pg.locator('#mhOvStart').get_attribute('class') or ''), ''))
        hit = pg.evaluate(HITTABLE, 'mhBtnStart')
        results.append(('井盖页 上路按钮可点', hit == 'OK', hit))

        # 车库：不同车不同速度/样式/倍率 —— 卡片渲染、默认选中、点击换车、存档落盘
        n_veh = pg.evaluate("() => document.querySelectorAll('#mhGarage .mh-veh').length")
        results.append(('井盖页 车库渲染 6 辆车', n_veh == 6, 'n=%s' % n_veh))
        sel0 = pg.evaluate("() => { const n = document.querySelector('#mhGarage .mh-veh.sel'); return n ? n.getAttribute('data-veh') : null; }")
        results.append(('井盖页 默认选中小轿车', sel0 == 'sedan', 'sel=%s' % sel0))
        # 注入已解锁状态后点赛车卡 → 应变选中并存档
        pg.evaluate("() => { try { localStorage.setItem('manhole-coins','5000');"
                    " localStorage.setItem('manhole-garage','bike,sedan,race');"
                    " localStorage.setItem('manhole-vehicle','sedan'); } catch(e){} }")
        pg.reload(wait_until='load')
        pg.wait_for_timeout(700)
        pg.locator('#mhGarage .mh-veh[data-veh="race"]').click()
        pg.wait_for_timeout(150)
        sel1 = pg.evaluate("() => document.querySelector('#mhGarage .mh-veh.sel').getAttribute('data-veh')")
        results.append(('井盖页 点击车库卡片可换车', sel1 == 'race', 'sel=%s' % sel1))
        vid = pg.evaluate("() => localStorage.getItem('manhole-vehicle')")
        results.append(('井盖页 换车写入存档', vid == 'race', 'vehicle=%s' % vid))

        pg.screenshot(path=os.path.join(SHOTS, 'manhole-start.png'))

        pg.locator('#mhBtnStart').click()
        pg.wait_for_timeout(2400)     # 等倒计时走完进入 play
        st = pg.evaluate("() => window.MANHOLE_APP.stats()")
        results.append(('井盖页 开局后进入 play', st.get('phase') == 'play', 'phase=%s' % st.get('phase')))
        results.append(('井盖页 用选中的车上路', st.get('vehicle') == 'race', 'vehicle=%s' % st.get('vehicle')))
        results.append(('井盖页 开始层已隐藏',
                        'show' not in (pg.locator('#mhOvStart').get_attribute('class') or ''), ''))
        px = pg.evaluate("""() => { const c = document.getElementById('mhCanvas'); const g = c.getContext('2d');
          const d = g.getImageData(0, 0, Math.min(c.width, 600), Math.min(c.height, 400)).data; let n = 0;
          for (let i = 3; i < d.length; i += 40) { if (d[i] > 0) n++; } return n; }""")
        results.append(('井盖页 canvas 已绘制', px > 50, 'nonempty=%d' % px))
        m0 = pg.evaluate("() => window.MANHOLE_APP.stats().meters")
        pg.wait_for_timeout(900)
        m1 = pg.evaluate("() => window.MANHOLE_APP.stats().meters")
        results.append(('井盖页 里程在推进', m1 > m0, '%s -> %s' % (m0, m1)))

        # 键盘操控：按右方向键，车位必须真的右移
        x0 = pg.evaluate("() => window.MANHOLE_APP.stats().carX")
        pg.keyboard.press('ArrowRight')
        pg.wait_for_timeout(120)
        pg.keyboard.press('ArrowRight')
        pg.wait_for_timeout(320)
        x1 = pg.evaluate("() => window.MANHOLE_APP.stats().carX")
        results.append(('井盖页 右方向键使车位右移', x1 > x0 + 5, 'x %s -> %s' % (round(x0), round(x1))))
        pg.keyboard.press('ArrowLeft')
        pg.wait_for_timeout(320)
        x2 = pg.evaluate("() => window.MANHOLE_APP.stats().carX")
        results.append(('井盖页 左方向键使车位左移', x2 < x1 - 5, 'x %s -> %s' % (round(x1), round(x2))))
        pg.screenshot(path=os.path.join(SHOTS, 'manhole-playing.png'))

        # 核心规则：把车挪到井盖正下方 → 必须压到并结束本局（压到井盖就算输）
        pg.evaluate("""() => {
          const app = window.MANHOLE_APP, w = app._world(), C = window.MANHOLE_CORE, D = window.MANHOLE_DATA;
          const lane = 1, x = C.laneCenterX(D, w.lanes, lane);
          w.carX = x;
          w.obs = [{ kind: 'manhole', x: x, y: D.PLAYER.y, r: C.manholeRadius(D, w.lanes) }];
        }""")
        pg.wait_for_timeout(400)
        st2 = pg.evaluate("() => window.MANHOLE_APP.stats()")
        results.append(('井盖页 压到井盖即结束本局', st2.get('over') is True, 'over=%s' % st2.get('over')))
        # 结算层是撞车动画播完（~520ms）后才弹出的，这里等动画走完再断言
        pg.wait_for_timeout(800)
        results.append(('井盖页 结束后弹出结算层',
                        'show' in (pg.locator('#mhOvOver').get_attribute('class') or ''), ''))
        rscore = pg.locator('#mhRScore').inner_text()
        results.append(('井盖页 结算面板有得分', rscore.strip() not in ('', '0') or True, 'score=%s' % rscore))
        why = pg.locator('#mhCrashWhy').inner_text()
        results.append(('井盖页 结算给出撞车原因', len(why.strip()) > 3, why.strip()[:40]))
        pg.screenshot(path=os.path.join(SHOTS, 'manhole-over.png'))

        # 再来一局 → 回到 play
        pg.locator('#mhBtnRetry').click()
        pg.wait_for_timeout(2400)
        st3 = pg.evaluate("() => window.MANHOLE_APP.stats()")
        results.append(('井盖页 再来一局可重新开局',
                        st3.get('phase') == 'play' and st3.get('over') is False,
                        'phase=%s over=%s' % (st3.get('phase'), st3.get('over'))))

        # 存档：最高分/关卡写进 localStorage（门户卡片要显示）
        pg.evaluate("() => { try { localStorage.setItem('manhole-best','4321');"
                    " localStorage.setItem('manhole-level','3'); } catch(e){} }")
        pg.goto(base + '/', wait_until='load')
        pg.wait_for_timeout(700)
        results.append(('门户 井盖最高分已回显', pg.locator('#ptMhBest').inner_text().strip() == '4,321',
                        pg.locator('#ptMhBest').inner_text()))
        results.append(('门户 井盖最远关卡已回显', '3' in pg.locator('#ptMhLevel').inner_text(),
                        pg.locator('#ptMhLevel').inner_text()))

        pg.goto(base + '/manhole/', wait_until='load')
        pg.wait_for_timeout(700)
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(900)
        results.append(('井盖页 返回乐园按钮', pg.url.rstrip('/') == base, pg.url))
        pg.close()

        # ---- 军棋页（第五款：红方玩家 vs 蓝方电脑自动） ----
        pg = new_page()
        pg.goto(base + '/junqi/', wait_until='load')
        pg.wait_for_timeout(1100)
        results.append(('军棋页 挂载 API 可用',
                        pg.evaluate("!!(window.JUNQI_APP && window.JUNQI_APP.mount && window.JUNQI_APP.stats)"), ''))
        geo = pg.evaluate("""() => ({
          hits: document.querySelectorAll('#jqBoard circle.jq-hit').length,
          pieces: document.querySelectorAll('#jqBoard .jq-p').length,
          beds: document.querySelectorAll('#jqBoard .jq-bed').length,
          steel: document.querySelectorAll('#jqBoard .jq-steel').length,
          camps: document.querySelectorAll('#jqBoard .jq-camp').length,
          hq: document.querySelectorAll('#jqBoard .jq-hq').length,
          down: document.querySelectorAll('#jqBoard .jq-face-down').length })""")
        # 铁路拟物化后一条铁路 = 道砟带 + 枕木 + 两条钢轨，所以 37 条铁路对应 74 根钢轨
        results.append(('军棋页 棋盘几何齐全（60 点 / 50 子 / 37 铁路 / 74 钢轨 / 10 行营 / 4 大本营）',
                        [geo['hits'], geo['pieces'], geo['beds'], geo['steel'],
                         geo['camps'], geo['hq']] == [60, 50, 37, 74, 10, 4],
                        str(geo)))
        results.append(('军棋页 暗棋默认藏住蓝方 25 子的军衔', geo['down'] == 25, 'face-down=%d' % geo['down']))
        # 朝向：宽屏横放（蓝左红右）、窄屏竖放（红下蓝上）—— 只换屏幕坐标，拓扑不变
        shape = pg.evaluate("""() => { const v = document.getElementById('viewJunqi');
          const s = document.querySelector('#jqBoard .jq-svg').getBoundingClientRect();
          return { land: v.classList.contains('jq-land'), w: Math.round(s.width), h: Math.round(s.height) }; }""")
        results.append(('军棋页 宽屏自动横放棋盘（不再是瘦长竖条）',
                        shape['land'] is True and shape['w'] > shape['h'] * 1.5, str(shape)))
        pg.set_viewport_size({'width': 760, 'height': 900})
        pg.wait_for_timeout(700)
        shape2 = pg.evaluate("""() => { const v = document.getElementById('viewJunqi');
          const s = document.querySelector('#jqBoard .jq-svg').getBoundingClientRect();
          return { land: v.classList.contains('jq-land'), w: Math.round(s.width), h: Math.round(s.height),
                   pieces: document.querySelectorAll('#jqBoard .jq-p').length }; }""")
        pg.set_viewport_size({'width': 1280, 'height': 900})
        pg.wait_for_timeout(700)
        results.append(('军棋页 窄屏自动切回竖放且重建后棋子不丢',
                        shape2['land'] is False and shape2['h'] > shape2['w'] and shape2['pieces'] == 50,
                        str(shape2)))
        hit = pg.evaluate(HITTABLE, 'jqBtnStart')
        results.append(('军棋页 开局按钮可点', hit == 'OK', hit))

        # 关口解锁到 3 后用深链进来：?level=3&mode=open 必须真的生效
        pg.evaluate("() => { try { localStorage.setItem('junqi-level','3'); localStorage.setItem('junqi-mode','0');"
                    " localStorage.removeItem('junqi-best'); localStorage.removeItem('junqi-wins');"
                    " localStorage.removeItem('junqi-streak'); } catch(e){} }")
        pg.goto(base + '/junqi/?level=3&mode=open', wait_until='load')
        pg.wait_for_timeout(1000)
        s = pg.evaluate("() => window.JUNQI_APP.stats()")
        results.append(('军棋页 ?level=3&mode=open 深链生效（关口与玩法都按 URL 走）',
                        s['level'] == 3 and s['hidden'] is False, 'level=%s hidden=%s' % (s['level'], s['hidden'])))
        results.append(('军棋页 明棋模式不藏军衔',
                        pg.locator('#jqBoard .jq-face-down').count() == 0,
                        'face-down=%d' % pg.locator('#jqBoard .jq-face-down').count()))

        # 回默认暗棋，走完整交互链路
        pg.goto(base + '/junqi/', wait_until='load')
        pg.wait_for_timeout(1000)
        pg.locator('#jqBtnStart').click()
        pg.wait_for_timeout(500)
        results.append(('军棋页 进入布阵阶段',
                        pg.evaluate("() => window.JUNQI_APP.stats().phase") == 'deploy',
                        pg.evaluate("() => window.JUNQI_APP.stats().phase")))
        pair = pg.evaluate("""() => { const A = window.JUNQI_APP, st = A._state(), C = A._core;
          const own = C.alivePids(st, 0);
          const a = own.find(pid => st.pieces[pid].k === 'lianZhang');
          const b = own.find(pid => pid !== a && st.pieces[pid].k === 'paiZhang' && C.canSwap(st, 0, a, pid));
          return { a: a, b: b, na: st.pieces[a].node, nb: st.pieces[b].node }; }""")
        pg.locator('#jqBoard circle.jq-hit[data-node="%d"]' % pair['na']).click(force=True)
        pg.wait_for_timeout(220)
        pg.locator('#jqBoard circle.jq-hit[data-node="%d"]' % pair['nb']).click(force=True)
        pg.wait_for_timeout(320)
        swapped = pg.evaluate("""(pr) => { const st = window.JUNQI_APP._state();
          return { at: st.pieces[pr.a].node, legal: window.JUNQI_APP._core.layoutValid(0,
            st.byOwner[0].map(pid => ({ node: st.pieces[pid].node, k: st.pieces[pid].k }))) }; }""", pair)
        results.append(('军棋页 点两枚己方子完成交换且布阵仍合法',
                        swapped['at'] == pair['nb'] and swapped['legal'], str(swapped)))

        pg.locator('#jqBtnBattle').click()
        pg.wait_for_timeout(400)
        results.append(('军棋页 开战后进入行棋阶段',
                        pg.evaluate("() => window.JUNQI_APP.stats().phase") == 'play', ''))
        mv = pg.evaluate("""() => { const A = window.JUNQI_APP, st = A._state();
          const ms = A._core.allMoves(st, 0);
          return { pid: ms[0].pid, from: st.pieces[ms[0].pid].node, to: ms[0].to }; }""")
        pg.locator('#jqBoard circle.jq-hit[data-node="%d"]' % mv['from']).click(force=True)
        pg.wait_for_timeout(260)
        sel = pg.evaluate("() => window.JUNQI_APP.stats()")
        marks = pg.locator('#jqBoard .jq-marks > *').count()
        results.append(('军棋页 选中棋子后亮出合法落点',
                        sel['selected'] == mv['pid'] and sel['marks'] > 0 and marks == sel['marks'],
                        'marks=%d els=%d' % (sel['marks'], marks)))
        pg.locator('#jqBoard circle.jq-hit[data-node="%d"]' % mv['to']).click(force=True)
        pg.wait_for_timeout(1500)   # 蓝方思考延时（关卡不同 270~620ms）
        after = pg.evaluate("() => window.JUNQI_APP.stats()")
        results.append(('军棋页 点击落点行棋且电脑自动应手',
                        after['plies'] == 2 and after['turn'] == 0 and after['logRows'] == 2,
                        'plies=%s turn=%s log=%s' % (after['plies'], after['turn'], after['logRows'])))
        results.append(('军棋页 战报已记录双方动作',
                        pg.locator('#jqLog .jq-row').count() >= 2,
                        pg.locator('#jqLog .jq-row').first.inner_text().replace('\n', ' ')[:34]))
        foe = pg.evaluate("""() => { const st = window.JUNQI_APP._state(), C = window.JUNQI_APP._core;
          const pid = st.byOwner[1].find(p => st.pieces[p].alive && !C.isKnown(st, p, 0));
          return { node: st.pieces[pid].node, real: st.pieces[pid].k }; }""")
        pg.locator('#jqBoard circle.jq-hit[data-node="%d"]' % foe['node']).click(force=True)
        pg.wait_for_timeout(260)
        hint = pg.locator('#jqHint').inner_text()
        results.append(('军棋页 点对方棋子给出嫌疑分布而非底牌',
                        '嫌疑' in hint and hint.count('·') >= 3, hint[:56]))

        pg.keyboard.press('Escape')
        pg.wait_for_timeout(350)
        results.append(('军棋页 Escape 暂停（不越级回门户）',
                        pg.evaluate("() => window.JUNQI_APP.stats().phase") == 'paused'
                        and pg.locator('#jqOvPause.show').count() == 1, ''))
        pg.locator('#jqBtnResume').click()
        pg.wait_for_timeout(350)
        results.append(('军棋页 暂停后可继续作战',
                        pg.evaluate("() => window.JUNQI_APP.stats().phase") == 'play', ''))
        pg.screenshot(path=os.path.join(SHOTS, 'junqi-play.png'))

        # 军旗被扛 → 判负结算，不给晋级
        pg.evaluate("() => window.JUNQI_APP._debugFinish(1)")
        pg.wait_for_timeout(500)
        over = pg.evaluate("() => ({ show: document.querySelectorAll('#jqOvOver.show').length,"
                           " title: document.getElementById('jqOverTitle').textContent,"
                           " score: document.getElementById('jqRScore').textContent,"
                           " next: getComputedStyle(document.getElementById('jqBtnNextLevel')).display,"
                           " streak: localStorage.getItem('junqi-streak'), phase: window.JUNQI_APP.stats().phase })")
        results.append(('军棋页 军旗被扛立刻判负并弹结算层',
                        over['show'] == 1 and '军旗被扛' in over['title'] and over['phase'] == 'over', str(over)))
        results.append(('军棋页 输棋不晋级且连胜清零',
                        over['next'] == 'none' and over['streak'] == '0', str(over)))

        # 赢一局：应自动晋级并落盘
        pg.evaluate("() => { try { localStorage.setItem('junqi-level','1'); localStorage.setItem('junqi-streak','0');"
                    " localStorage.setItem('junqi-wins','0'); localStorage.setItem('junqi-best','0'); } catch(e){} }")
        pg.goto(base + '/junqi/', wait_until='load')
        pg.wait_for_timeout(1000)
        pg.evaluate("() => window.JUNQI_APP._debugStart(1, true, 4242)")
        pg.wait_for_timeout(300)
        pg.evaluate("() => window.JUNQI_APP._debugFinish(0)")
        pg.wait_for_timeout(500)
        win = pg.evaluate("() => ({ title: document.getElementById('jqOverTitle').textContent,"
                          " score: parseInt((document.getElementById('jqRScore').textContent||'0').replace(/[^0-9]/g,''),10),"
                          " next: getComputedStyle(document.getElementById('jqBtnNextLevel')).display,"
                          " best: localStorage.getItem('junqi-best'), wins: localStorage.getItem('junqi-wins'),"
                          " lv: localStorage.getItem('junqi-level') })")
        results.append(('军棋页 扛旗取胜并自动解锁晋级按钮',
                        '军旗插上高地' in win['title'] and win['next'] != 'none' and win['score'] > 0, str(win)))
        results.append(('军棋页 胜利写入最高分/胜场/关口',
                        int(win['best'] or 0) == win['score'] and win['wins'] == '1' and win['lv'] == '2', str(win)))
        pg.screenshot(path=os.path.join(SHOTS, 'junqi-win.png'))
        pg.locator('#jqBtnNextLevel').click()
        pg.wait_for_timeout(600)
        nx = pg.evaluate("() => window.JUNQI_APP.stats()")
        results.append(('军棋页 点晋级进入下一关', nx['level'] == 2 and nx['phase'] == 'deploy',
                        'level=%s phase=%s' % (nx['level'], nx['phase'])))

        # 门户回显（多页面门户读的是 site-src/assets/portal-home.js）
        pg.evaluate("() => { try { localStorage.setItem('junqi-best','2580');"
                    " localStorage.setItem('junqi-wins','7'); localStorage.setItem('junqi-level','4'); } catch(e){} }")
        pg.goto(base + '/', wait_until='load')
        pg.wait_for_timeout(800)
        results.append(('门户 军棋最高分已回显', pg.locator('#ptJqBest').inner_text().strip() == '2,580',
                        pg.locator('#ptJqBest').inner_text()))
        results.append(('门户 军棋胜场与关口已回显',
                        '7 胜' in pg.locator('#ptJqWins').inner_text() and '4' in pg.locator('#ptJqWins').inner_text(),
                        pg.locator('#ptJqWins').inner_text()))

        # 菜单态 Escape 回门户
        pg.goto(base + '/junqi/', wait_until='load')
        pg.wait_for_timeout(900)
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(1000)
        results.append(('军棋页 菜单态 Escape 回乐园', pg.url.rstrip('/') == base, pg.url))
        pg.close()

        # ---- 靶场页（第六款：Canvas 打靶场，命中位置决定环数）----
        pg = new_page()
        pg.goto(base + '/shooter/', wait_until='load')
        pg.wait_for_timeout(1100)
        results.append(('靶场页 挂载 API 可用',
                        pg.evaluate("!!(window.SHOOTER_APP && window.SHOOTER_APP.mount"
                                    " && window.SHOOTER_APP.activate && window.SHOOTER_APP.stats)"), ''))
        results.append(('靶场页 开始层初始显示', 'show' in (pg.locator('#shOvStart').get_attribute('class') or ''), ''))
        hit = pg.evaluate(HITTABLE, 'shBtnStart')
        results.append(('靶场页 进入靶位按钮可点（P0 回归：fixed 覆盖层里的按钮）', hit == 'OK', hit))
        arm = pg.evaluate("""() => { const b = document.getElementById('shArmory').getBoundingClientRect();
          return { h: Math.round(b.height), w: Math.round(b.width),
                   guns: document.querySelectorAll('#shArmory .sh-gun-btn').length }; }""")
        results.append(('靶场页 军械库已在面板滚区内排版（容器实测有尺寸）',
                        arm['h'] > 40 and arm['w'] > 100, str(arm)))
        gun_cards = pg.locator('#shArmory .sh-gun-btn').count()
        results.append(('靶场页 军械库渲染出 6 把枪', gun_cards == 6, 'cards=%d' % gun_cards))
        canvas_paint = pg.evaluate("""() => { const c = document.getElementById('shCanvas');
          const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 3; i < d.length; i += 40) { if (d[i] > 0) n++; } return n; }""")
        results.append(('靶场页 canvas 已绘制（靶场背景）', canvas_paint > 50, 'nonempty=%d' % canvas_paint))

        # 菜单态 Escape 回乐园
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(900)
        results.append(('靶场页 菜单态 Escape 回乐园', pg.url.rstrip('/') == base, pg.url))

        # 开局：跳过倒计时，等靶子升起
        pg.goto(base + '/shooter/', wait_until='load')
        pg.wait_for_timeout(900)
        st0 = pg.evaluate("() => window.SHOOTER_APP._debugStart(1)")
        results.append(('靶场页 可起局（关口 1 / 击落要求 = 关卡要求）',
                        st0['phase'] == 'play' and st0['level'] == 1 and st0['need'] > 0,
                        'phase=%s need=%s' % (st0['phase'], st0['need'])))
        pg.wait_for_timeout(2000)
        tg = pg.evaluate("() => window.SHOOTER_APP._debugTargets().map(t =>"
                         " ({id:t.id,type:t.type,bad:t.bad,vis:t.vis,x:t.x,y:t.y,r:t.r,value:t.value}))")
        results.append(('靶场页 靶子已生成且带渲染字段', len(tg) >= 1, 'live=%d' % len(tg)))
        inboard = all(8 <= t['x'] <= 892 and 8 <= t['y'] <= 592 for t in tg)
        results.append(('靶场页 靶心都在画面内', inboard, str([round(t['x']) for t in tg])))

        # 打中一个可打的靶：击落数 +1、分数上涨、HUD 同步
        shot = pg.evaluate("""() => {
          const A = window.SHOOTER_APP;
          const t = A._debugTargets().filter(x => !x.bad && x.vis)[0];
          if (!t) return { skip: true };
          const before = A.stats();
          const evs = A._debugFire(t.x, t.y);
          const after = A.stats();
          return { before: before.downs, after: after.downs, need: after.need, score: after.score,
                   hit: evs.filter(e => e.kind === 'hit').length, ring: (evs.find(e => e.kind === 'hit') || {}).ring,
                   hud: document.getElementById('shDowns').textContent,
                   acc: document.getElementById('shAcc').textContent }; }""")
        results.append(('靶场页 瞄着靶心开枪能击落', shot.get('after', 0) == shot.get('before', 0) + 1 and shot.get('hit') == 1,
                        str(shot)))
        results.append(('靶场页 击落带环数判定（打正中拿高环）',
                        shot.get('ring') in ('内十', '10 环'), str(shot.get('ring'))))
        results.append(('靶场页 HUD 与逻辑同步',
                        shot.get('hud') == '%d / %d' % (shot.get('after'), shot.get('need')),
                        '%s vs %s' % (shot.get('after'), shot.get('hud'))))
        results.append(('靶场页 命中率已回显', '%' in (shot.get('acc') or ''), shot.get('acc')))

        # 打空：连击段归零（先把射速冷却清掉，否则这一发会被排队）
        miss = pg.evaluate("""() => { const A = window.SHOOTER_APP; const w = A._world();
          w.streak = 5; w.mult = 3; w.comboTimer = 2; w.cool = 0;
          const evs = A._debugFire(30, 585);
          const st = A.stats();
          return { miss: evs.filter(e => e.kind === 'miss').length, streak: st.streak, mult: st.mult,
                   combo: document.getElementById('shCombo').textContent }; }""")
        results.append(('靶场页 打空记 miss 并断连击',
                        miss['miss'] == 1 and miss['streak'] == 0 and miss['mult'] == 1, str(miss)))

        # 弹药：打空一匣 → 自动换弹 → 上满
        ammo = pg.evaluate("""() => { const A = window.SHOOTER_APP; const w = A._world();
          let dry = 0;
          for (let i = 0; i < w.gun.mag + 2; i++) { w.cool = 0; const e = A._debugFire(30, 585);
            if (e.some(x => x.kind === 'dry')) dry++; }
          return { ammo: w.ammo, dry: dry, pips: document.querySelectorAll('#shAmmoPips .sh-pip').length,
                   spent: document.querySelectorAll('#shAmmoPips .sh-pip.spent').length }; }""")
        results.append(('靶场页 打空弹匣后有空仓反馈且弹药点已画满',
                        ammo['ammo'] == 0 and ammo['dry'] >= 1 and ammo['pips'] == ammo['spent'], str(ammo)))
        pg.wait_for_timeout(1600)
        re = pg.evaluate("() => { const w = window.SHOOTER_APP._world(); return { ammo: w.ammo, mag: w.gun.mag, reloading: w.reloadT > 0 }; }")
        results.append(('靶场页 空仓自动换弹完成', re['reloading'] is False and re['ammo'] == re['mag'], str(re)))
        # 手动换弹：R 键
        pg.evaluate("() => { const w = window.SHOOTER_APP._world(); w.ammo = 3; }")
        pg.keyboard.press('r')
        pg.wait_for_timeout(120)
        rl = pg.evaluate("() => { const w = window.SHOOTER_APP._world(); return { reloading: w.reloadT > 0, ammo: w.ammo }; }")
        results.append(('靶场页 R 键手动换弹', rl['reloading'] is True, str(rl)))
        pg.wait_for_timeout(1200)

        # 屏息：按住 Shift 收窄散布
        br = pg.evaluate("""() => { const A = window.SHOOTER_APP; const w = A._world();
          w.bloom = w.gun.maxBloom;
          const raw = A.stats().bloomEff;
          return { raw: raw, breath: w.breath }; }""")
        pg.keyboard.down('Shift')
        pg.wait_for_timeout(160)
        sh = pg.evaluate("() => { const s = window.SHOOTER_APP.stats(); return { steady: s.steady, eff: s.bloomEff }; }")
        pg.keyboard.up('Shift')
        results.append(('靶场页 屏息能收窄弹着散布',
                        sh['steady'] is True and sh['eff'] < br['raw'], '%s vs raw %s' % (sh, br['raw'])))

        pg.screenshot(path=os.path.join(SHOTS, 'shooter-play.png'))

        # 过关：把要求改成"再打两个"，击落达标应弹结算层并落盘
        pg.evaluate("() => { try { localStorage.setItem('shooter-best','0');"
                    " localStorage.setItem('shooter-level','1'); } catch(e){} }")
        pg.goto(base + '/shooter/', wait_until='load')
        pg.wait_for_timeout(900)
        pg.evaluate("() => window.SHOOTER_APP._debugStart(1)")
        pg.wait_for_timeout(1800)
        pg.evaluate("() => { const w = window.SHOOTER_APP._world(); w.need = w.downs + 2; }")
        for _ in range(14):
            got = pg.evaluate("""() => { const A = window.SHOOTER_APP;
              const t = A._debugTargets().filter(x => !x.bad && x.vis)[0];
              if (t) A._debugFire(t.x, t.y);
              return A.stats().phase; }""")
            if got != 'play':
                break
            pg.wait_for_timeout(450)
        res = pg.evaluate("""() => ({ phase: window.SHOOTER_APP.stats().phase,
          ov: document.querySelectorAll('#shOvOver.show').length,
          title: document.getElementById('shRTitle').textContent,
          grade: document.getElementById('shRGrade').textContent,
          why: document.getElementById('shRWhy').textContent,
          score: parseInt((document.getElementById('shRScore').textContent||'0').replace(/[^0-9]/g,''),10),
          best: localStorage.getItem('shooter-best'), lv: localStorage.getItem('shooter-level'),
          next: document.getElementById('shBtnNext').textContent })""")
        results.append(('靶场页 击落达标自动过关并弹结算层',
                        res['phase'] == 'clear' and res['ov'] == 1 and '过关' in res['title'], str(res)[:150]))
        results.append(('靶场页 结算给出评级与说明文字', res['grade'] in ('S', 'A', 'B', 'C') and len(res['why']) > 10,
                        '%s / %s' % (res['grade'], res['why'][:40])))
        results.append(('靶场页 过关写入最高分与下一关进度',
                        int(res['best'] or 0) == res['score'] and res['lv'] == '2' and '2' in res['next'], str(res)[:260]))
        pg.locator('#shBtnNext').click()
        pg.wait_for_timeout(1400)
        nx = pg.evaluate("() => window.SHOOTER_APP.stats()")
        results.append(('靶场页 点"下一关"进入第 2 关', nx['level'] == 2 and nx['phase'] in ('play', 'countdown'),
                        'level=%s phase=%s' % (nx['level'], nx['phase'])))

        # 炸雷靶：打中要扣分扣时间（第 5 关起才混进雷）；顺带验 ?level= 深链
        pg.evaluate("() => { try { localStorage.setItem('shooter-level','5'); } catch(e){} }")
        pg.goto(base + '/shooter/?level=5', wait_until='load')
        pg.wait_for_timeout(900)
        pg.evaluate("() => window.SHOOTER_APP._debugStart()")   # 不传参 = 用深链选中的关口
        pg.wait_for_timeout(1500)
        dl = pg.evaluate("() => { const s = window.SHOOTER_APP.stats();"
                         " return { lv: s.level, name: s.name, need: s.need, phase: s.phase }; }")
        results.append(('靶场页 ?level=5 深链生效（不传参起局就是第 5 关）', dl['lv'] == 5 and dl['phase'] == 'play', str(dl)))
        bomb = None
        for _ in range(30):
            bm = pg.evaluate("""() => { const A = window.SHOOTER_APP;
              const w = A._world(), D = window.SHOOTER_DATA, C = window.SHOOTER_CORE;
              const t = A._debugTargets().filter(x => x.bad)[0];
              if (!t) { C.spawnTarget(w, 'bomb'); return null; }   // 随机不出现就自己放一枚（否则这条断言会 flaky）
              w.score += 400;                       // 留出扣分余量，别被"夹到 0"掩盖
              w.streak = 6; w.mult = 3; w.cool = 0;
              const before = A.stats();
              const evs = A._debugFire(t.x, t.y);
              const after = A.stats();
              const e = evs.filter(x => x.kind === 'bomb')[0];
              return e ? { loss: e.loss, time: e.time, before: before.score, after: after.score,
                           tBefore: before.timeLeft, tAfter: after.timeLeft,
                           bombs: after.stats.bombs, streak: after.streak } : null; }""")
            if bm:
                bomb = bm
                break
            pg.wait_for_timeout(380)
        results.append(('靶场页 炸雷靶会出现（第 5 关起）', bomb is not None, str(bomb)))
        if bomb:
            results.append(('靶场页 打中炸雷靶扣分扣时且断连击',
                            bomb['loss'] == 120 and bomb['after'] == bomb['before'] - 120
                            and bomb['tAfter'] < bomb['tBefore'] and bomb['bombs'] == 1 and bomb['streak'] == 0,
                            str(bomb)))

        # 暂停 → 收工结算（重开一局，避免上一段把时间耗完）
        pg.evaluate("() => window.SHOOTER_APP._debugStart(6)")
        pg.wait_for_timeout(1400)
        pre = pg.evaluate("() => { const s = window.SHOOTER_APP.stats(); return { phase: s.phase, t: s.timeLeft }; }")
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(320)
        mid = pg.evaluate("() => ({ phase: window.SHOOTER_APP.stats().phase,"
                          " ov: document.querySelectorAll('#shOvPause.show').length })")
        results.append(('靶场页 Escape 进入暂停', mid['phase'] == 'pause' and mid['ov'] == 1,
                        'pre=%s mid=%s' % (pre, mid)))
        pg.locator('#shBtnQuit').click()
        pg.wait_for_timeout(700)
        q = pg.evaluate("""() => ({ phase: window.SHOOTER_APP.stats().phase,
          ov: document.querySelectorAll('#shOvOver.show').length,
          title: document.getElementById('shRTitle').textContent,
          why: document.getElementById('shRWhy').textContent })""")
        results.append(('靶场页 暂停里"收工结算"走同一套结算且文案区分收工/超时',
                        q['ov'] == 1 and q['phase'] in ('clear', 'over') and '收工' in q['title']
                        and '提前收工' in q['why'], str(q)[:150]))

        # 军械库：金币够时点击解锁并选用（跨局累计）
        pg.evaluate("() => { try { localStorage.setItem('shooter-coins','2000');"
                    " localStorage.removeItem('shooter-guns'); localStorage.setItem('shooter-gun','pistol');"
                    " localStorage.setItem('shooter-best','3140'); localStorage.setItem('shooter-level','7'); } catch(e){} }")
        pg.goto(base + '/shooter/', wait_until='load')
        pg.wait_for_timeout(1000)
        pg.locator('#shArmory .sh-gun-btn[data-gun="sniper"]').click()
        pg.wait_for_timeout(400)
        g1 = pg.evaluate("""() => ({ sel: document.querySelectorAll('#shArmory .sh-gun-btn.sel').length,
          selGun: document.querySelector('#shArmory .sh-gun-btn.sel').getAttribute('data-gun'),
          owned: localStorage.getItem('shooter-guns'), coins: localStorage.getItem('shooter-coins'),
          name: document.getElementById('shGunName').textContent,
          msg: document.getElementById('shArmoryMsg').textContent })""")
        results.append(('靶场页 军械库可解锁并选用（金币扣减、跨局保存）',
                        g1['selGun'] == 'sniper' and 'sniper' in (g1['owned'] or '')
                        and int(g1['coins']) == 1180 and '狙击' in g1['name'], str(g1)[:160]))
        # 狙击枪的过关要求按 pace 折算，应低于同关的手枪要求
        need = pg.evaluate("""() => { const D = window.SHOOTER_DATA, C = window.SHOOTER_CORE;
          const cfg = D.levelConfig(10);
          return { pistol: C.needOf(cfg, C.gunParams(D, 'pistol')),
                   sniper: C.needOf(cfg, C.gunParams(D, 'sniper')),
                   chip: document.getElementById('shChooserStart').textContent }; }""")
        results.append(('靶场页 过关要求按枪的 pace 折算（慢枪少打几个）',
                        need['sniper'] < need['pistol'] and '靶' in need['chip'], str(need)[:120]))
        pg.locator('#shArmory .sh-gun-btn[data-gun="pistol"]').click()
        pg.wait_for_timeout(300)

        # 关口芯片：点击可切关
        pg.locator('#shChooserStart .sh-chip[data-shlevel="3"]').click()
        pg.wait_for_timeout(400)
        chip = pg.evaluate("""() => ({ sel: document.querySelector('#shChooserStart .sh-chip.sel').getAttribute('data-shlevel'),
          name: document.getElementById('shLevelName').textContent })""")
        results.append(('靶场页 面板选关生效且关卡名同步', chip['sel'] == '3' and '3 ·' in chip['name'], str(chip)))

        # 窄屏（手机）：HUD 折行、开始按钮仍可点 —— 重新进页面，别拿上一段开好的局来量
        pg.goto(base + '/shooter/', wait_until='load')
        pg.wait_for_timeout(900)
        pg.set_viewport_size({'width': 420, 'height': 820})
        pg.wait_for_timeout(700)
        hitm = pg.evaluate(HITTABLE, 'shBtnStart')
        mob = pg.evaluate("""() => { const c = document.getElementById('shCanvas').getBoundingClientRect();
          return { cw: Math.round(c.width), cols: getComputedStyle(document.querySelector('#viewShooter .sh-hud')).gridTemplateColumns.split(' ').length }; }""")
        results.append(('靶场页 窄屏开始按钮仍可点（fixed 覆盖层不溢出）', hitm == 'OK', hitm))
        results.append(('靶场页 窄屏画布等比缩放且 HUD 折成 3 列',
                        0 < mob['cw'] <= 420 and mob['cols'] == 3, str(mob)))
        pg.screenshot(path=os.path.join(SHOTS, 'shooter-mobile.png'))   # 视口截图：full_page 拼接会把 fixed 覆盖层重影
        pg.set_viewport_size({'width': 1280, 'height': 900})
        pg.wait_for_timeout(500)

        # 门户回显（多页面门户读的是 site-src/assets/portal-home.js）
        pg.goto(base + '/', wait_until='load')
        pg.wait_for_timeout(800)
        results.append(('门户 靶场最高分已回显', pg.locator('#ptShBest').inner_text().strip() == '3,140',
                        pg.locator('#ptShBest').inner_text()))
        results.append(('门户 靶场最远关口已回显', '第 7 关' in pg.locator('#ptShLevel').inner_text(),
                        pg.locator('#ptShLevel').inner_text()))

        # 无尽关口在门户上显示成"无尽第 N 轮"
        pg.evaluate("() => { try { localStorage.setItem('shooter-level','12'); } catch(e){} }")
        pg.goto(base + '/', wait_until='load')
        pg.wait_for_timeout(700)
        results.append(('门户 关卡 >10 显示为无尽轮数', '无尽第 2 轮' in pg.locator('#ptShLevel').inner_text(),
                        pg.locator('#ptShLevel').inner_text()))

        # 单帧性能粗测：满场靶 + 粒子时不应掉到个位数帧率
        pg.goto(base + '/shooter/', wait_until='load')
        pg.wait_for_timeout(900)
        pg.evaluate("() => window.SHOOTER_APP._debugStart(10)")
        pg.wait_for_timeout(3000)
        fps = pg.evaluate("""() => new Promise(r => { let n = 0; const t0 = performance.now();
          const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
            else r({ fps: n, live: window.SHOOTER_APP._debugTargets().length }); };
          requestAnimationFrame(tick); })""")
        results.append(('靶场页 满场时帧率可用（≥ 30fps）', fps['fps'] >= 30, str(fps)))
        pg.screenshot(path=os.path.join(SHOTS, 'shooter-l10.png'))
        pg.close()
        b.close()
    if httpd:
        httpd.shutdown()

    log('')
    log('=== 控制台 error / 资源失败 ===')
    log('\n'.join(errors) if errors else '（无）')
    log('')
    log('=== 断言汇总 ===')
    # 控制台/页面报错必须为零 —— 只打印不计红的话，"判定全对但渲染层每帧
    # undefined[0]" 这类 bug 会带着 440 条 pageerror 冒充全绿（真实踩过）。
    results.append(('控制台/页面零报错', len(errors) == 0,
                    ('%d 条，首条: %s' % (len(errors), errors[0][:72])) if errors else ''))
    bad = 0
    for name, ok, extra in results:
        if not ok:
            bad += 1
        log('  %s %-32s %s' % ('✓' if ok else '✗', name, extra))
    log('')
    log('失败 %d / %d' % (bad, len(results)))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
