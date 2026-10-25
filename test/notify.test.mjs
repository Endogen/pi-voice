import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerpt, replySignature, sendReplyAlert } from '../notify.mjs';

const token = 'ab'.repeat(32);

test('reply signatures match the native receiver', () => {
  // Same vector as native/test/com/pivoice/app/ReplyAlertsChecks.java.
  assert.equal(replySignature(token, { handle: 'session-handle', pid: 4321, time: 1700000000000, title: 'Fix tests', text: 'All 12 pass — ünïcode.' }),
    '94bfbad76a05b36bff7212fc919f9c4e9ee73911f628684e31afd74b36b6d13d');
});

test('notification text is a short plain excerpt of the Markdown reply', () => {
  assert.equal(excerpt('## Done\n\n- **Commit:** `06b5deb` pushed.\n- See [the PR](https://example.com/1).\n\n```sh\nnpm test\n```\nAll *good*.'),
    'Done Commit: 06b5deb pushed. See the PR. All good.');
  assert.equal(excerpt('x'.repeat(500), 240).length, 240);
  assert.ok(excerpt('x'.repeat(500), 240).endsWith('…'));
  assert.equal(excerpt('line\u0000one\u0007two'), 'line one two');
});

test('alerts go through Termux am with fixed arguments, only on Android', () => {
  const calls = [];
  const run = (...args) => calls.push(args);
  const env = { PREFIX: '/data/data/com.termux/files/usr' };
  assert.equal(sendReplyAlert({ token, handle: 'session-handle', pid: 77, title: 'Fix\ntests', text: '**Done**', time: 5, env, run }), true);
  const [command, args, options] = calls[0];
  assert.equal(command, '/data/data/com.termux/files/usr/bin/am');
  assert.deepEqual(args.slice(0, 7), ['broadcast', '-f', '32', '-n', 'com.pivoice.app/.ReplyReceiver', '-a', 'com.pivoice.app.REPLY']);
  const extra = (name) => args[args.indexOf(name) + 1];
  assert.deepEqual([extra('pid'), extra('time'), extra('title'), extra('text')], ['77', '5', 'Fix tests', 'Done']);
  assert.equal(extra('signature'), replySignature(token, { handle: 'session-handle', pid: 77, time: 5, title: 'Fix tests', text: 'Done' }));
  assert.equal(options.timeout, 15000);
  assert.equal(sendReplyAlert({ token, handle: 'session-handle', pid: 1, title: '', text: '', env, run }), true);
  assert.equal(calls[1][1][calls[1][1].indexOf('text') + 1], 'Reply ready.', 'am needs a non-empty value');
  assert.equal(sendReplyAlert({ token, handle: 'session-handle', pid: 1, title: 't', text: 't', env: { PREFIX: '/usr/local' }, run }), false);
  assert.equal(sendReplyAlert({ token: 'short', pid: 1, title: 't', text: 't', env, run }), false);
  assert.equal(calls.length, 2);
});
