#!/usr/bin/env python3
"""Interface-style contrast check: every page of the app and the panels inside the main pages, in every interface style
(Engineering, Broadsheet House, Quiet Page), desktop (1440 px) and phone (390 px), against WCAG AA:
text 4.5:1 (3:1 for large text: 24 px, or 18.66 px bold); form fields' edge 3:1 against what is behind them (1.4.11).
Hidden and disabled elements and emoji-only text are skipped.

Run it against a running Maestro you are signed in to (Python 3 with Playwright and Firefox):
  python3 scripts/ui-contrast-check.py --base http://127.0.0.1:3000 --cookies <Mozilla-format cookie jar> [--out report.json]
Exit 0 when Broadsheet House and Quiet Page have no violation at all and Engineering has none beyond the list in
scripts/ui-contrast-engineering-baseline.json (today's Engineering, kept as it is by decision; that list may only
shrink). --write-baseline rewrites the list from this run (Engineering only)."""
import argparse, http.cookiejar, json, os, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--base', required=True)
ap.add_argument('--cookies', required=True)
ap.add_argument('--out', default='')
ap.add_argument('--styles', default='engineering,broadsheet,quiet')
ap.add_argument('--only', default='', help='comma-separated scene names')
ap.add_argument('--write-baseline', action='store_true')
args = ap.parse_args()
base, jarp = args.base.rstrip('/'), args.cookies
styles = [s for s in args.styles.split(',') if s]
BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ui-contrast-engineering-baseline.json')
jar = http.cookiejar.MozillaCookieJar(jarp)
jar.load(ignore_discard=True, ignore_expires=True)
host = base.split('//', 1)[-1].split('/', 1)[0].split(':', 1)[0]
cookies = [{'name': c.name, 'value': c.value, 'domain': host, 'path': c.path or '/'} for c in jar]

OPEN_D = "(() => { const e = [...document.querySelectorAll('[data-agent]')].find(x => x.dataset.agent === 'maestro'); if (e) e.click(); })()"
OPEN_P = "(() => { const e = [...document.querySelectorAll('div,span,b')].find(x => x.children.length === 0 && x.textContent.trim() === 'Maestro'); if (e) e.click(); })()"
PAGES = [
    ('main', '/', 'desktop', ''), ('mobile', '/mobile', 'phone', ''),
    # panels inside the main pages (Files, scheduler, Recall, Guide, Security, Settings incl. the security check, the phone menu and sheets)
    ('main-settings', '/', 'desktop', "openSettings(); setTimeout(() => { for (const d of document.querySelectorAll('#st-groups details.st-group')) d.open = true; }, 1500)"),
    ('main-files', '/', 'desktop', 'openFilesPanel()'), ('main-scheduler', '/', 'desktop', 'openSchedulePanel()'),
    ('main-chat-recall', '/', 'desktop', OPEN_D + '; setTimeout(() => openRecallPanel(), 2500)'),
    ('main-guide', '/', 'desktop', "document.querySelector('[data-tab=\\'guide\\']').click()"),
    ('main-security', '/', 'desktop', 'openSecurityDialog()'),
    ('mobile-menu', '/mobile', 'phone', "document.getElementById('agents-menu-btn').click()"),
    ('mobile-chat', '/mobile', 'phone', OPEN_P), ('mobile-files', '/mobile', 'phone', 'openFilesSheet()'),
    ('mobile-security', '/mobile', 'phone', 'openSecuritySheet()'), ('mobile-profile', '/mobile', 'phone', 'openProfileSheet()'),
    ('mobile-recall', '/mobile', 'phone', OPEN_P + '; setTimeout(() => openRecallSheet(), 2500)'),
    ('agent-settings', '/agent-settings.html?agent=maestro', 'both', ''), ('users', '/users.html', 'both', ''),
    ('changes', '/changes.html', 'both', ''), ('help', '/help.html', 'both', ''), ('local-models', '/local-models.html', 'both', ''),
    ('modules', '/modules.html', 'both', ''), ('tiger-team', '/tiger-team.html', 'both', ''), ('recordings', '/recordings.html', 'both', ''),
    ('welcome', '/welcome.html', 'both', ''), ('login', '/login.html', 'both-anon', ''),
]

CHECK = r"""() => {
  const parse = (s) => { const m = s && s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, under) => { const a = top.a; return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 }; };
  const lum = (c) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // the colour behind an element: its own and its ancestors' backgrounds, composited, over white
  const behind = (el, includeSelf) => {
    const layers = [];
    for (let e = includeSelf ? el : el.parentElement; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let col = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i], col);
    return col;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.1) return false; }
    return true;
  };
  const key = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.'); const p = el.parentElement; return (p ? (p.id ? '#' + p.id : p.tagName.toLowerCase()) + ' > ' : '') + s; };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'OPTION'].includes(el.tagName)) continue;
    const ctrl = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName);
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || (/^(INPUT|TEXTAREA)$/.test(el.tagName) && el.value && el.type !== 'hidden' && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'range' && el.type !== 'color') || (el.tagName === 'SELECT');
    if (!ownText && !ctrl) continue;
    if (el.disabled || el.closest('[disabled],[aria-disabled="true"]') || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const shown = (el.value || [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('')).trim();
    const emojiOnly = shown && /^[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F\u200D\s]+$/u.test(shown);   // an emoji draws its own colours
    if (ownText && !emojiOnly) {
      const fg = parse(cs.color); if (!fg) continue;
      const bg = behind(el, true), col = fg.a < 1 ? over(fg, bg) : fg;
      const size = parseFloat(cs.fontSize), boldish = parseInt(cs.fontWeight, 10) >= 700;
      const need = size >= 24 || (size >= 18.66 && boldish) ? 3 : 4.5;
      const r = ratio(col, bg);
      if (r < need) bad.push({ kind: 'text', el: key(el), text: (el.value || el.textContent || '').trim().slice(0, 40), ratio: Math.round(r * 100) / 100, need, fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` });
    }
    // A field's edge (WCAG 1.4.11): inputs people type in, selects and text areas. A button is identified by its text.
    const field = el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(hidden|checkbox|radio|range|color|button|submit|reset|image|file)$/.test(el.type));
    if (field) {
      const outside = behind(el, false), own = behind(el, true);
      const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const bc = parse(cs.borderTopColor), edge = bw > 0 && bc && bc.a > 0 ? over(bc, outside) : null;
      const r = Math.max(edge ? ratio(edge, outside) : 1, ratio(own, outside));
      const visibleKind = el.tagName === 'BUTTON' || el.type === 'button' || el.type === 'submit';
      // a text-like button with no edge at all is a link-styled button: its text is the control
      if (r < 3 && !(visibleKind && ownText && (!edge || ratio(edge, outside) < 1.05) && ratio(own, outside) < 1.05)) {
        if (!(el.type === 'checkbox' || el.type === 'radio' || el.type === 'range' || el.type === 'color')) bad.push({ kind: 'edge', el: key(el), text: (el.value || el.textContent || el.placeholder || '').trim().slice(0, 30), ratio: Math.round(r * 100) / 100, need: 3, border: cs.borderTopColor, bg: cs.backgroundColor });
      }
    }
  }
  return { bad, look: document.documentElement.dataset.look || '' };
}"""

ONLY = [x for x in args.only.split(',') if x]
if ONLY:
    PAGES = [p for p in PAGES if p[0] in ONLY]
res = {}
with sync_playwright() as pw:
    b = pw.firefox.launch()
    for style in styles:
        for name, path, which, act in PAGES:
            kinds = ['desktop'] if which == 'desktop' else ['phone'] if which == 'phone' else ['desktop', 'phone']
            for kind in kinds:
                ctx = b.new_context(viewport={'width': 1440, 'height': 900} if kind == 'desktop' else {'width': 390, 'height': 844})
                if which != 'both-anon':
                    ctx.add_cookies(cookies)
                ctx.add_init_script(f"try {{ localStorage.setItem('mmLook', {style!r}); }} catch (e) {{}}")
                pg = ctx.new_page()
                pg.on('dialog', lambda d: d.dismiss())
                try:
                    pg.goto(base + path, wait_until='domcontentloaded', timeout=20000)
                    time.sleep(4)
                    if act:
                        if which != 'both-anon':
                            try: pg.wait_for_function("() => typeof hubMe !== 'undefined' ? !!(hubMe && hubMe.user) : !!window.hubMe", timeout=15000)
                            except Exception: pass
                        pg.evaluate('() => { ' + act + ' }')
                        time.sleep(5)
                    r = pg.evaluate(CHECK)
                    r['url'] = pg.url.replace(base, '')
                except Exception as e:
                    r = {'error': str(e)[:200], 'bad': []}
                res[f'{style}|{name}|{kind}'] = r
                ctx.close()
    b.close()
if args.out:
    json.dump(res, open(args.out, 'w'), indent=1)

def vkey(scene, v):   # what a violation is, without its exact ratio (fonts render slightly differently between machines)
    return f"{scene}|{v['kind']}|{v['el']}|{v.get('text', '')}"

known = set()
if os.path.exists(BASELINE):
    known = set(json.load(open(BASELINE)).get('violations', []))
eng_now = sorted({vkey(k.split('|', 1)[1], v) for k, r in res.items() if k.startswith('engineering|') for v in r.get('bad', [])})
if args.write_baseline:
    json.dump({'about': 'Engineering (today\'s interface style, kept as it is) fails these WCAG AA checks; the list may only shrink.', 'violations': eng_now}, open(BASELINE, 'w'), indent=1)
    print(f'wrote {len(eng_now)} Engineering violations to {BASELINE}')

fail = 0
for k, r in sorted(res.items()):
    style, scene = k.split('|', 1)
    if r.get('error'):
        print(f'ERROR {k}: {r["error"]}'); fail += 1; continue
    for v in r.get('bad', []):
        if style == 'engineering' and vkey(scene, v) in known:
            continue
        fail += 1
        print(f"FAIL {k}: {v['kind']} {v['el']} '{v.get('text', '')}' {v['ratio']}:1 (needs {v['need']}) {v.get('fg', v.get('border'))} on {v['bg']}")
print(f"{len(res)} scene runs; Engineering known violations: {len(known)}; failures: {fail}")
sys.exit(1 if fail else 0)
