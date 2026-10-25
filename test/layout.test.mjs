import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Stylesheet contract checks, not a substitute for browser/device layout checks.
const css = (await readFile(new URL('../public/style.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
function rule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing rule: ${selector}`);
  return css.slice(start + selector.length + 2, css.indexOf('}', start));
}
function value(body, property) {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body)?.[1].trim();
}

test('mobile composer has matching 12px side gutters and a 20px bottom gap plus safe areas', () => {
  assert.equal(value(rule('.workspace'), 'padding'),
    'calc(var(--inset-top) + 4px) calc(var(--inset-right) + 12px) calc(var(--inset-bottom) + 20px) calc(var(--inset-left) + 12px)');
  assert.equal(value(rule('.workspace'), 'height'), '100vh');
  assert.match(rule('.workspace'), /height: 100dvh;/, 'Keyboard and viewport resizing remain supported');
});

test('reply text adds 4px on each side for symmetric 16px mobile text gutters', () => {
  assert.equal(value(rule('.answer-pane'), 'padding'), '0 4px 16px');
  assert.equal(value(rule('.answer-pane'), 'overflow'), 'auto', 'Long replies keep their own scroll area');
});

test('native system insets are not counted a second time in CSS', () => {
  const native = rule(':root.native');
  for (const side of ['top', 'right', 'bottom', 'left']) assert.equal(value(native, `--inset-${side}`), '0px');
  assert.match(css, /--inset-bottom: env\(safe-area-inset-bottom, 0px\)/, 'The standalone browser still applies safe areas');
});

test('small phones keep the mobile gutters while wide screens keep their 24px gutters', () => {
  const narrow = css.slice(css.indexOf('@media (max-width: 350px)'), css.indexOf('@media (max-height: 480px)'));
  assert.doesNotMatch(narrow, /\.workspace\b/, 'Narrow phones must not shrink the requested side padding');
  const wide = css.slice(css.indexOf('@media (min-width: 700px)'), css.indexOf('@media (max-width: 350px)'));
  assert.match(wide, /padding-left: calc\(var\(--inset-left\) \+ 24px\)/);
  assert.match(wide, /padding-right: calc\(var\(--inset-right\) \+ 24px\)/);
});
