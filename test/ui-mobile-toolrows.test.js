'use strict';
// Phone app: tool calls read apart from the reply text: the tool's name in bold, the row light blue on a faint blue
// panel with a blue bar, a failed call red. Source-level checks on mobile.js / mobile.html (the page is not run here).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('a tool row puts the tool name in its own bold span and marks a failed call', () => {
  const m = read('mobile.js');
  assert.match(m, /const name = document\.createElement\('span'\);\s*name\.className = 'ftname';\s*name\.textContent = it\.tool;\s*line\.replaceChildren\(`\$\{mark\} `, name, it\.summary \? ` · \$\{clipText\(it\.summary, 80\)\}` : ''\);/);
  assert.match(m, /if \(failed\) it\.el\.classList\.add\('failed'\);/);
  assert.doesNotMatch(m, /line\.textContent = `\$\{mark\} \$\{it\.tool\}/, 'tool names are never put in as markup or plain one-line text');
});

test('tool calls are blue on a tinted panel; failed calls stay red (the rule comes last)', () => {
  const h = read('mobile.html');
  assert.match(h, /\.feed \{[^}]*border-left: 2px solid rgba\(61, 123, 255, 0\.65\); background: rgba\(61, 123, 255, 0\.07\);/);
  assert.match(h, /\.frow\.tool \.fline, \.ftool \{ color: #8AB4FF; \}/);
  assert.match(h, /\.ftname \{ font-weight: 600; color: #B5CEFF; \}/);
  const tool = h.indexOf('.frow.tool .fline, .ftool');
  const failed = h.indexOf('.frow.failed .fline, .frow.failed .ftname { color: var(--error); }');
  assert.ok(tool > 0 && failed > tool, 'the red rule follows the blue one, so a failed call wins');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v51'/);
});
