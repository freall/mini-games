# -*- coding: utf-8 -*-
"""site/ 多页面站点端到端冒烟测试（无头 Chromium + Playwright）

为什么留着它：多页面改造期间，正是这个脚本抓出了「消消乐开始界面被
overflow:hidden 裁剪、开始按钮不可见也点不到」的 P0 —— 静态自检
（verify-site.mjs）只查结构，查不出这种"结构齐全但视觉上根本点不到"的问题。

依赖：pip install playwright && playwright install chromium
用法：python tools/e2e-smoke.py
      python tools/e2e-smoke.py --url https://freall.github.io/mini-games   # 也可以直接打线上
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


# 元素是否"真的能点到"：尺寸非零 + 在视口内 + elementFromPoint 命中的是它自己/后代
HITTABLE = """(id) => {
  const e = document.getElementById(id);
  if (!e) return 'MISSING';
  const r = e.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return 'ZERO_SIZE';
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return 'OFF_VIEWPORT ' + cx + ',' + cy;
  const t = document.elementFromPoint(cx, cy);
  if (!t) return 'NO_HIT';
  const inside = (t === e) || e.contains(t) || t.contains(e);
  return inside ? 'OK' : 'COVERED_BY ' + t.tagName + '#' + (t.id || '') + '.' + t.className;
}"""


def main():
    from playwright.sync_api import sync_playwright

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
        results.append(('门户卡片数 = 2', cards == 2, 'cards=%d' % cards))
        results.append(('门户封面图标已渲染', cover >= 6, 'cells=%d' % cover))
        for i, want in enumerate(['sushi', 'match3']):
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
        b.close()
    if httpd:
        httpd.shutdown()

    log('')
    log('=== 控制台 error / 资源失败 ===')
    log('\n'.join(errors) if errors else '（无）')
    log('')
    log('=== 断言汇总 ===')
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
