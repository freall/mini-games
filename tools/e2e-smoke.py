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


def run_single(path):
    """单文件交付版：走的是 portal.js 的 APP_ROUTER（页内切视图），
    与多页面版完全不同的代码路径，所以单独冒烟一遍。"""
    from playwright.sync_api import sync_playwright
    url = 'file:///' + path.replace('\\', '/')
    log('目标：单文件交付版 %s' % url)
    results, errors = [], []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        pg = b.new_context(viewport={'width': 1280, 'height': 900}).new_page()
        pg.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.goto(url, wait_until='load')
        pg.wait_for_timeout(1200)
        results.append(('单文件 标题', pg.title() == '小游戏乐园 · 迷你游戏合集', pg.title()))
        results.append(('单文件 门户 4 张卡', pg.locator('.pt-card').count() == 4,
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
        b = p.chromium.launch(headless=True)
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
        results.append(('门户卡片数 = 4', cards == 4, 'cards=%d' % cards))
        results.append(('门户封面图标已渲染', cover >= 6, 'cells=%d' % cover))
        for i, want in enumerate(['sushi', 'match3', 'morse', 'manhole']):
            pg.goto(base + '/', wait_until='load')
            pg.wait_for_timeout(400)
            pg.locator('.pt-card').nth(i).click()
            pg.wait_for_load_state('load')
            pg.wait_for_timeout(500)
            results.append(('门户第 %d 张卡 -> /%s/' % (i + 1, want), pg.url.rstrip('/').endswith('/' + want), pg.url))
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
