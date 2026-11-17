'use strict';
// lib/ui-file-card.js: the shared download-card helper (desktop and phone pages).
const test = require('node:test');
const assert = require('node:assert');
const H = require('../lib/ui-file-card.js');

// A small fake of a rendered message: only querySelectorAll / closest / getAttribute / textContent are used.
const a = (href, { pre = false, img = false } = {}) => ({ getAttribute: (n) => (n === 'href' ? href : null), closest: (s) => (pre && s === 'pre' ? {} : null), querySelectorAll: (s) => (img && s === 'img' ? [{}] : []) });
const code = (text, { pre = false } = {}) => ({ textContent: text, closest: (s) => (pre && s === 'pre' ? {} : null) });
const msg = (anchors = [], codes = []) => ({ querySelectorAll: (s) => (s === 'a[href]' ? anchors : s === 'code' ? codes : []) });

test('candidatesFrom: download links and absolute paths in links and inline code', () => {
  const out = H.candidatesFrom(msg(
    [a('/api/files/download?agent=helper&path=out%2Freport.pdf'), a('/api/files/download?owner=mine&path=a.txt'), a('/srv/share/notes/plan.md')],
    [code('/srv/share/data.csv'), code(' /srv/share/trim.txt ')],
  ));
  assert.deepStrictEqual(out.map((c) => c.item), [
    { path: 'out/report.pdf', agent: 'helper' }, { path: 'a.txt', owner: 'mine' }, { abs: '/srv/share/notes/plan.md' },
    { abs: '/srv/share/data.csv' }, { abs: '/srv/share/trim.txt' },
  ]);
  assert.ok(out.every((c) => c.key && c.anchorEl));
});

test('candidatesFrom: skips pre blocks, other origins, javascript:/data:, folders without an extension, prose in code', () => {
  const out = H.candidatesFrom(msg(
    [a('/srv/x/in-pre.txt', { pre: true }), a('https://example.com/api/files/download?path=a.txt'), a('//evil.example/x/y.txt'),
      a('javascript:/x/y.txt'), a('data:text/plain,/a/b.txt'), a('/srv/share/folder'), a('/srv/share/pic.png', { img: true }), a('mailto:/a/b.txt')],
    [code('/srv/x/in-pre.txt', { pre: true }), code('cat /srv/x/a.txt'), code('/srv/x/folder'), code('/srv/x/ok-1.txt')],
  ));
  assert.deepStrictEqual(out.map((c) => c.item), [{ abs: '/srv/x/ok-1.txt' }]);
});

test('candidatesFrom: a link to an image file gets a card, a link wrapping the picture does not', () => {
  const out = H.candidatesFrom(msg([a('/srv/share/chart.png'), a('/srv/share/inline.png', { img: true })]));
  assert.deepStrictEqual(out.map((c) => c.item), [{ abs: '/srv/share/chart.png' }]);
});

test('candidatesFrom: de-duplicates by key and caps at 12', () => {
  const dup = H.candidatesFrom(msg([a('/srv/a.txt'), a('/srv/a.txt')], [code('/srv/a.txt')]));
  assert.strictEqual(dup.length, 1);
  const many = Array.from({ length: 20 }, (_, i) => a(`/srv/f${i}.txt`));
  assert.strictEqual(H.candidatesFrom(msg(many, [code('/srv/z.txt')])).length, 12);
  assert.deepStrictEqual(H.candidatesFrom(null), []);
});

test('kindOf, iconOf (no variation selector), formatSize', () => {
  assert.strictEqual(H.kindOf('a.PNG'), 'image'); assert.strictEqual(H.kindOf('r.pdf'), 'pdf'); assert.strictEqual(H.kindOf('s.mp3'), 'audio');
  assert.strictEqual(H.kindOf('v.mp4'), 'video'); assert.strictEqual(H.kindOf('z.zip'), 'archive'); assert.strictEqual(H.kindOf('n.md'), 'text');
  assert.strictEqual(H.kindOf('noext'), 'other'); assert.strictEqual(H.kindOf('x.bin'), 'other');
  for (const k of ['image', 'pdf', 'audio', 'video', 'archive', 'text', 'other', 'bogus']) {
    const i = H.iconOf(k);
    assert.ok(i && !/\uFE0F/.test(i), 'icon for ' + k + ' has no variation selector');
  }
  assert.notStrictEqual(H.iconOf('image'), '\u{1F5BC}');
  assert.strictEqual(H.formatSize(512), '512 B'); assert.strictEqual(H.formatSize(1229), '1.2 KB');
  assert.strictEqual(H.formatSize(9.4 * 1024 * 1024), '9.4 MB'); assert.strictEqual(H.formatSize(1.1 * 1024 ** 3), '1.1 GB');
});

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const result = (o) => ({ ok: true, name: 'report.pdf', size: 2048, mime: 'application/pdf', kind: 'pdf', path: 'out/report.pdf', download: '/api/files/download?agent=helper&path=out%2Freport.pdf', inline: '/api/files/download?agent=helper&path=out%2Freport.pdf&inline=1', ...o });

test('cardHtml: escapes a hostile name (also inside attributes)', () => {
  const html = H.cardHtml(result({ name: '<img src=x onerror=1>.png', kind: 'image', path: '<b>/"q".png' }), { esc, phone: false });
  assert.ok(!/<img src=x/.test(html), 'the name is not markup');
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;.png'));
  const quoted = H.cardHtml(result({ name: 'a" onclick="x.pdf' }), { esc, phone: false });
  assert.ok(!/download="a" onclick/.test(quoted), 'a quote cannot leave the attribute');
  assert.ok(!/\sonclick=["']/.test(quoted), 'no real attribute was injected (the quotes stay entities)');
});

test('cardHtml: desktop link vs phone button, preview, folder and size', () => {
  const d = H.cardHtml(result(), { esc, phone: false });
  assert.match(d, /<a class="fc-download" href="\/api\/files\/download\?agent=helper&amp;path=out%2Freport\.pdf|<a class="fc-download" href="\/api\/files\/download\?agent=helper&path=/);
  assert.ok(/ download="report\.pdf"/.test(d) && !/<button/.test(d));
  assert.ok(/class="fc-preview-link"[^>]*target="_blank"[^>]*rel="noopener"|href="[^"]*inline=1"[^>]*target="_blank" rel="noopener"/.test(d), 'PDF Preview opens a new tab');
  assert.ok(d.includes('2.0 KB') && d.includes('out'), 'size and folder shown');
  const p = H.cardHtml(result(), { esc, phone: true });
  assert.ok(/<button type="button" class="fc-download" data-download="[^"]+" data-name="report\.pdf" data-size="2048" data-mime="application\/pdf">Download<\/button>/.test(p));
  assert.ok(!/<a class="fc-download"/.test(p));
  const img = H.cardHtml(result({ name: 'p.png', kind: 'image', mime: 'image/png' }), { esc, phone: false });
  assert.ok(/<img class="fc-preview" loading="lazy" src="[^"]*inline=1/.test(img) && /160px/.test(img));
});

test('cardHtml: no inline URL (svg, html) means no preview; a failed result gives nothing; only hub URLs are linked', () => {
  const svg = H.cardHtml(result({ name: 'd.svg', kind: 'image', inline: null }), { esc, phone: false });
  assert.ok(!/<img class="fc-preview"/.test(svg) && /fc-download/.test(svg));
  const html = H.cardHtml(result({ name: 'p.html', kind: 'text', inline: null }), { esc, phone: false });
  assert.ok(!/fc-preview/.test(html));
  assert.strictEqual(H.cardHtml({ ok: false, error: 'not found' }, { esc }), '');
  assert.ok(!/javascript:/.test(H.cardHtml(result({ download: 'javascript:alert(1)' }), { esc })));
});

test('resolveBatch: one POST for the whole message, then cached', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const items = JSON.parse(opts.body).items;
    return { ok: true, json: async () => ({ ok: true, items: items.map((it, i) => (it.abs && it.abs.includes('missing') ? { ok: false, error: 'not found' } : { ok: true, name: 'n' + i, size: 1, path: 'p', download: '/api/files/download?path=p', inline: null })) }) };
  };
  const cands = [{ key: 'a:/t1/one.txt', item: { abs: '/t1/one.txt' } }, { key: 'a:/t1/missing.txt', item: { abs: '/t1/missing.txt' } }, { key: 'a:/t1/two.txt', item: { abs: '/t1/two.txt' } }];
  const res = await H.resolveBatch(fetchFn, cands);
  assert.strictEqual(calls.length, 1, 'one request for three items');
  assert.strictEqual(calls[0].url, '/api/files/resolve');
  assert.strictEqual(calls[0].opts.method, 'POST'); assert.strictEqual(calls[0].opts.credentials, 'same-origin');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body).items.length, 3);
  assert.deepStrictEqual(res.map((r) => r.ok), [true, false, true]);
  const again = await H.resolveBatch(fetchFn, [cands[0], cands[2]]);
  assert.strictEqual(calls.length, 1, 'cached results make no request');
  assert.deepStrictEqual(again.map((r) => r.ok), [true, true]);
  await H.resolveBatch(fetchFn, [cands[1], { key: 'a:/t1/new.txt', item: { abs: '/t1/new.txt' } }]);
  assert.strictEqual(calls.length, 2); assert.strictEqual(JSON.parse(calls[1].opts.body).items.length, 2, 'only the uncached items are sent (a not-found is asked again)');
});

test('resolveBatch: a network or server failure never throws', async () => {
  const r1 = await H.resolveBatch(async () => { throw new Error('down'); }, [{ key: 'a:/t2/x.txt', item: { abs: '/t2/x.txt' } }]);
  assert.deepStrictEqual(r1.map((r) => r.ok), [false]);
  const r2 = await H.resolveBatch(async () => ({ ok: false, status: 500, json: async () => ({}) }), [{ key: 'a:/t2/y.txt', item: { abs: '/t2/y.txt' } }]);
  assert.deepStrictEqual(r2.map((r) => r.ok), [false]);
  let called = false;
  assert.deepStrictEqual(await H.resolveBatch(async () => { called = true; }, []), []); assert.strictEqual(called, false, 'no items, no request');
});
