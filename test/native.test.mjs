import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseConnection, discoverConnections, waitForConnection } from '../native/connection.mjs';
import { runNativeHost } from '../native/host.mjs';
import { enableExternalApps } from '../native/setup.mjs';

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-native-'));
  await mkdir(join(directory, 'endpoints'), { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const token = 'ab'.repeat(32);
  const server = http.createServer((req, res) => {
    calls++;
    if (handler) return handler(req, res);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pid: 4567, sessionId: 'native-session' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = { pid: 4567, origin, token, url: 'https://example.invalid/do-not-use' };
  const path = join(directory, 'endpoints', '4567.json');
  await writeFile(path, JSON.stringify(endpoint), { mode: 0o600 });
  return { directory, endpoint, path, origin, token, server, calls: () => calls };
}

test('native discovery authenticates, checks PID and reconstructs URL instead of trusting discovery URL', async (t) => {
  const h = await fixture(t);
  const connections = await discoverConnections(h.directory);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].url, `${h.origin}/#${h.token}`);
  assert.equal(chooseConnection(connections).sessionId, 'native-session');
  assert.equal((await waitForConnection({ directory: h.directory, timeout: 50 })).pid, 4567);
});

test('discovery limits concurrent probes so stale records cannot exhaust the bridge connection cap', async (t) => {
  const h = await fixture(t, (_req, res) => setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pid: 4567, sessionId: 'native-session' }));
  }, 75));
  h.server.maxConnections = 24; // Same cap as the actual Pi bridge.
  await Promise.all(Array.from({ length: 40 }, (_, i) => {
    const pid = 4000 + i;
    return writeFile(join(h.directory, 'endpoints', `${pid}.json`), JSON.stringify({ ...h.endpoint, pid }));
  }));
  const connections = await discoverConnections(h.directory);
  assert.equal(connections.length, 1, 'A pile of stale records must not hide the live Pi and cause duplicate startup');
  assert.equal(connections[0].pid, 4567);
});

test('native discovery rejects malformed, non-loopback and mismatched records without deleting them', async (t) => {
  const h = await fixture(t);
  for (const changes of [{ pid: 9999 }, { origin: 'http://localhost:8765' }, { origin: 'http://127.0.0.1:999999' }, { token: 'invalid' }]) {
    await writeFile(h.path, JSON.stringify({ ...h.endpoint, ...changes }));
    assert.deepEqual(await discoverConnections(h.directory), []);
    await access(h.path);
  }
  await writeFile(h.path, '{not-yet-complete');
  assert.deepEqual(await discoverConnections(h.directory), []);
  await access(h.path);
  assert.equal(h.calls(), 0, 'Invalid discovery does not even make a request');
});

test('native discovery ignores stale state PID and never follows redirects with the bearer token', async (t) => {
  const mismatch = await fixture(t, (req, res) => res.end(JSON.stringify({ pid: 9999, sessionId: 'stale' })));
  assert.deepEqual(await discoverConnections(mismatch.directory), []);
  const redirect = await fixture(t, (req, res) => { res.writeHead(302, { Location: `${mismatch.origin}/api/state` }); res.end(); });
  assert.deepEqual(await discoverConnections(redirect.directory), []);
  assert.equal(mismatch.calls(), 1, 'The redirect destination was never fetched');
});

test('native startup refuses ambiguity instead of choosing or starting another Pi', async (t) => {
  assert.equal(chooseConnection([]), undefined);
  assert.throws(() => chooseConnection([{ pid: 1 }, { pid: 2 }]), /Several Pi sessions/);
  const h = await fixture(t);
  const reused = await runNativeHost({ directory: h.directory, pi: '/never-execute-this' });
  assert.deepEqual(reused, { reused: true });
});

test('native wait is bounded and does not create any Pi process itself', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-voice-native-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(waitForConnection({ directory, timeout: 25, interval: 5 }), /Pi did not become ready/);
});

test('native wait deadline includes stalled discovery probes and long polling intervals', async (t) => {
  const h = await fixture(t, () => {});
  for (let i = 0; i < 12; i++) {
    const pid = 5000 + i;
    await writeFile(join(h.directory, 'endpoints', `${pid}.json`), JSON.stringify({ ...h.endpoint, pid }));
  }
  const start = performance.now();
  await assert.rejects(waitForConnection({ directory: h.directory, timeout: 80, interval: 1000 }), /Pi did not become ready/);
  assert.ok(performance.now() - start < 800, 'The overall deadline must abort in-flight probes');
  assert.ok(h.calls() <= 4, 'Expired discovery must not probe the remaining records');

  await rm(join(h.directory, 'endpoints'), { recursive: true });
  const emptyStart = performance.now();
  await assert.rejects(waitForConnection({ directory: h.directory, timeout: 40, interval: 1000 }), /Pi did not become ready/);
  assert.ok(performance.now() - emptyStart < 800, 'The polling delay must respect the deadline');
});

test('native setup is explicit and preserves unrelated Termux properties and comments', () => {
  const contents = '# leave comments\nextra-keys = test\nallow-external-apps = false\n';
  assert.equal(enableExternalApps(contents), '# leave comments\nextra-keys = test\nallow-external-apps=true\n');
  assert.equal(enableExternalApps('allow-external-apps=true\n'), 'allow-external-apps=true\n');
  const appended = enableExternalApps('# allow-external-apps = false');
  assert.match(appended, /^# allow-external-apps = false\n/);
  assert.match(appended, /\nallow-external-apps=true\n$/);
});

test('native Android contract has fixed background commands, non-exported result receiver and speech-only JS bridge', async () => {
  const source = await readFile(new URL('../native/java/com/pivoice/app/MainActivity.java', import.meta.url), 'utf8');
  const manifest = await readFile(new URL('../native/AndroidManifest.xml', import.meta.url), 'utf8');
  const script = await readFile(new URL('../native/host.sh', import.meta.url), 'utf8');
  const methods = [...source.matchAll(/@JavascriptInterface public void (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(methods, ['speakText', 'stopReading', 'startSpeech', 'stopSpeech', 'abortSpeech']);
  assert.match(manifest, /android.intent.action.TTS_SERVICE/);
  assert.match(source, /replySpeaker\.shutdown\(\)/);
  assert.match(source, /replySpeaker\.stop\(\);\s+web.onPause\(\)/);
  assert.match(source, /getBundleExtra\("result"\)/, 'Match TermuxConstants, not an invented result key');
  assert.match(source, /RUN_COMMAND_BACKGROUND", true/);
  assert.match(source, /RUN_COMMAND_BACKGROUND_CUSTOM_LOG_LEVEL", "0"/);
  assert.match(source, /FLAG_ONE_SHOT/);
  assert.match(source, /new Intent\(this, ResultReceiver.class\)/);
  assert.match(source, /setWebContentsDebuggingEnabled\(false\)/);
  assert.match(source, /setAllowFileAccess\(false\)/);
  assert.match(source, /onShowFileChooser/);
  assert.match(source, /RequestPolicy\.allows\(origin, request\.getUrl\(\)\.toString\(\), request\.isForMainFrame\(\)\)/, 'Use the executable, tested request boundary for JPEG previews');
  assert.match(source, /onJsConfirm/);
  assert.match(source, /JSONObject.quote\(text/);
  assert.match(manifest, /receiver android:name=".ResultReceiver" android:exported="false"/);
  assert.doesNotMatch(manifest, /android.intent.action.VIEW|BROWSABLE|sharedUserId/);
  assert.match(script, /app-launch.lock/);
  assert.match(script, /flock" -n -E 0/);
});
