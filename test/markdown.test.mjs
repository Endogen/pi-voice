import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({});
for (const file of ['vendor/markdown-it/markdown-it.min.js', 'src/markdown.js']) {
  vm.runInContext(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), context);
}
const render = (text) => context.PiVoiceMarkdown.render(text);

test('renders headings, emphasis, strikethrough, rules and line breaks', () => {
  const html = render('# Title\n\n## Section\n\n**bold** *italic* ~~done~~\nnext line\n\n---');
  for (const part of ['<h1>Title</h1>', '<h2>Section</h2>', '<strong>bold</strong>', '<em>italic</em>', '<s>done</s>', '<br>', '<hr>']) {
    assert.ok(html.includes(part), part);
  }
});

test('renders ordered, nested and unordered lists plus blockquotes', () => {
  const html = render('1. First\n2. Second\n   - Nested\n\n> quoted\n>\n> **bold quote**');
  for (const part of ['<ol>', '<ul>', '<li>Nested</li>', '<blockquote>', '<strong>bold quote</strong>']) {
    assert.ok(html.includes(part), part);
  }
});

test('preserves fenced and inline code and escapes code HTML', () => {
  const html = render('Run `echo "hi"`:\n\n```html\n<script>alert("x")</script>\n  indented\n```');
  assert.match(html, /<code>echo &quot;hi&quot;<\/code>/);
  assert.match(html, /<pre><code class="language-html">/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;\n  indented\n/);
  assert.equal(html.includes('<script>'), false);
});

test('renders wide tables with CSP-compatible alignment and a scroll container', () => {
  const html = render('| Left | Center | Right |\n| :--- | :---: | ---: |\n| **yes** | `code` | 3 |');
  assert.match(html, /<div class="table-scroll"><table>/);
  assert.match(html, /<th class="align-left">Left<\/th>/);
  assert.match(html, /<th class="align-center">Center<\/th>/);
  assert.match(html, /<td class="align-right">3<\/td>/);
  assert.match(html, /<strong>yes<\/strong>/);
  assert.equal(html.includes('style='), false);
  assert.match(html, /<\/table><\/div>/);
});

test('renders disabled task checkboxes only for list-item markers', () => {
  const html = render('- [x] Finished\n- [ ] Pending\n  - [X] Nested\n\n[x] Not a list');
  assert.equal((html.match(/class="task-list-item"/g) || []).length, 3);
  assert.equal((html.match(/<input /g) || []).length, 3);
  assert.equal((html.match(/type="checkbox" checked disabled/g) || []).length, 2);
  assert.equal((html.match(/type="checkbox" disabled/g) || []).length, 1);
  assert.match(html, /<p>\[x\] Not a list<\/p>/);
});

test('supports safe explicit, automatic and email links without leaking a referrer', () => {
  const html = render('[Docs](https://example.com/docs "Documentation") and https://example.org\n\n[Mail](mailto:test@example.com)');
  assert.match(html, /href="https:\/\/example.com\/docs" title="Documentation" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/example.org"/);
  assert.match(html, /href="mailto:test@example.com"/);
  assert.equal((html.match(/<a /g) || []).length, 3);
  assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 3);
});

test('rejects JavaScript, encoded protocols, Android intents, files and data links', () => {
  for (const url of [
    'javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'jav&#x61;script:alert%281%29',
    'vbscript:msgbox%281%29', 'file:///data/data/com.termux/files/home/secret',
    'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,AAAA',
    'intent://example/#Intent;scheme=test;end', 'content://contacts/people',
  ]) {
    const html = render(`[tap](${url})`);
    assert.equal(html.includes('<a '), false, url);
    assert.equal(html.includes('href='), false, url);
  }
});

test('escapes raw scripts, SVG, iframes, forms and event-handler markup', () => {
  for (const text of [
    '<script>globalThis.stolen = true</script>',
    '<img src=x onerror="alert(1)">',
    '<svg onload="alert(1)"><a xlink:href="javascript:alert(1)">x</a></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<form action="/api/abort"><button>stop</button></form>',
    '<a href="javascript:alert(1)">click</a>',
  ]) {
    const html = render(text);
    assert.equal(/<(?:script|img|svg|iframe|form|button|a)\b/i.test(html), false, text);
    assert.ok(html.includes('&lt;'), text);
  }
  assert.equal(context.stolen, undefined);
});

test('never turns images into network requests and escapes their alt text', () => {
  for (const url of ['https://tracker.example/pixel', '/api/abort', 'data:image/png;base64,AAAA']) {
    const html = render(`![<svg onload=alert(1)>](${url})`);
    assert.equal(html.includes('<img'), false, url);
    assert.equal(html.includes('src='), false, url);
    assert.equal(html.includes('<svg'), false, url);
    assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
    if (!url.startsWith('data:')) assert.match(html, /class="image-alt">\[Image:/);
    else assert.equal(html.includes('class="image-alt"'), false, 'data URLs are rejected before image rendering');
  }
});

test('handles incomplete Markdown and deep nesting without throwing', () => {
  for (const text of ['', '**incomplete', '```js\nconst x = 1;', '[broken](https://', `${'> '.repeat(100)}deep`, '['.repeat(16000)]) {
    assert.equal(typeof render(text), 'string');
  }
});
