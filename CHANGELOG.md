# Changelog

## 3.0.0

- New transparent app icon combines the mathematical π symbol with a microphone. The app preserves its original framing; GitHub Pages uses tightly cropped 16px, 32px and 192px favicons for clearer browser tabs.
- Independent Termux host owns the app connection, session registry, and lifecycle. Every managed session, including the first, can close without interrupting other workers.
- Closing the last session leaves a connected empty screen; restarting the host reattaches surviving workers and preserves intentional closures.
- Stable session handles, process-instance checks, atomic lifecycle records, serialized capacity reservations, and idempotent launch/restore requests.
- Versioned notification targets and native UI preference migration for the new host origin. Upgrade APK and backend together; restart legacy workers explicitly.
- Send-button-only submission: Android Return inserts a newline, keyboard shortcuts do not submit, and speech transcripts remain in the draft for review. Legacy auto-send preferences are ignored.
- Review fixes cover invalid Restore requests, stale recovery metadata after conversation changes, storage failures, cancelled forwarding, uncertain tmux probes, and notification taps during startup.
- Regression coverage includes separate worker processes and real Pi/tmux operation continuity after closing the first session.

## 2.2.0 — Pi Voice app 2.2.0 (versionCode 7)

- **Renamed:** the Android app is now just **Pi Voice** (package `com.pivoice.app` is unchanged, so it updates in place). The APK file is now `pi-voice.apk`, and the app's version now follows the project version.
- **Reply notifications:** when a run ends with a new reply, the extension tells the app through a signed broadcast. While the app is in the background, Android shows a notification with the start of the reply; tapping it opens that session. Broadcasts are HMAC-signed with the bridge token and expire after 10 minutes, so other apps can't fake them. Android 13+ asks for permission the first time.
- **Reply chime:** while the app is open, a short synthesized chime plays when the current session or a background session finishes a reply.
- **Haptic feedback:** light vibrations for recording, sending, switching sessions, the pull-to-refresh threshold and replies, through Android's haptics (no permission; follows the system touch-vibration setting).
- **Settings → Replies & feedback:** separate switches for notifications, sound and haptics. Sound off also makes notifications silent.
- **Fixed: stuck on "Disconnected" after a parallel session was killed.** Endpoint records outlive a killed Pi, so the relay kept trying it and the app never fell back. The relay now checks that the target Pi is alive and reports a dead one as gone (410). It also names the target PID, so a different Pi that reused the port refuses to answer for it. The app falls back to the main session on 410 or 502.
- **Fixed: closing a busy session** let its task run to the end (Pi only quits once idle) and then wrote its record back, so it reappeared under Stopped earlier. Closing now stops the task first and never writes the record again.
- **Fixed: Restore could start two Pis on one conversation** after a lost acknowledgement or a slow start. The record is marked while a restore is in flight; retries join that launch, the row shows "Restoring…", and a lost acknowledgement is checked instead of re-sent.
- **Fixed: a recycled PID hid a stopped conversation.** Records now store the process start identity, and a PID owned by another app no longer counts as a running Pi.
- **Fixed:** tapping the current session while another one was loading did nothing; the "New reply" highlight in Sessions never showed (CSS selector); stay-awake was dropped after `/reload`.
- **Regression coverage:** executable Java checks for signatures and haptics with a test vector shared with Node, alert wiring in the extension, and frontend tests for reply detection, settings sync and opening a session from a notification; plus a test for each fix above.

Update with `git pull` and `npm run setup`, restart Pi once after its current reply, and install the 2.2.0 app (`npm run build:native`, then `npm run native:install`).

## 2.1.1 — native APK 0.1.5 (versionCode 6)

- **New always keeps the original running:** idle and busy sessions use the same parallel-Pi launch. Both remain in Sessions and you can switch back before a reply finishes. Draft text and images stay in the composer and are never auto-submitted on a switch. Failed/unsupported launches leave the original untouched; lost acknowledgements are discovered by request ID without a duplicate launch.
- **Open in Termux selects the attached Pi:** APK 0.1.5 requests Termux's switch-to-new-session action (`0`, not `1`, which keeps the old tab selected). Terminal detection explicitly selects Pi's own tmux socket. While switching, or when a backend cannot identify its terminal, the button is disabled instead of opening an unrelated tab; late responses from the previous session cannot change the selected terminal or connection status.
- **Terminal detection recovers:** a failed lookup is no longer cached for the lifetime of Pi. State, session-summary and Activity polls share one non-blocking probe, retry failures after a five-second cooldown, and cache a valid terminal. Missing metadata no longer claims that Pi was not started by the app. Regression tests cover slow/failed/thrown probes, recovery through both HTTP views and automatic button re-enabling.
- **Older backends:** About now also warns when the running Pi predates version reporting. Such a Pi needs a restart for parallel sessions and terminal targeting; replacing the page or APK alone cannot upgrade an already-running extension.
- **Regression coverage:** idle/busy/pending creation, round-trip switching with both sessions listed, late state/activity replies, lost launch acknowledgements and terminal targeting. Isolated real-Pi PTY tests exercise the production launcher, retry deduplication, relay/switch-back, close and exact tmux targets. RPC lifecycle tests use RPC `new_session`; the legacy in-place browser route remains covered in the real TUI test.

Reopen the app for the interface changes, restart Pi once **after its current reply finishes**, and install the same-key APK 0.1.5 (`npm run native:install`). A build is not an installed update. No live-session restart or Android installer is run automatically; selecting the attached Termux tab still needs an on-device check.

## 2.1.0

- **Pull to refresh:** pull down on the conversation (scrolled to the top) to re-sync it, the session list and an open Activity sheet with Pi. When Pi has stopped, the same gesture reconnects. It is built into the page, so no APK update is needed; sideways swipes, scrolled replies and open sheets are left alone.

Reopen the app to use it.

## 2.0.0 — native APK 0.1.4 (versionCode 5)

Pi Voice is now a native-app-only project.

- **Resume after Pi stops:** each voice-enabled Pi records which conversation it has open (`~/.pi/agent/voice/running/`). When the app has to start Pi again, the native host reopens that conversation in its own folder (`pi --session <file>`) instead of `pi -c` in the home folder. Parallel sessions that stopped are offered under **Sessions → Stopped earlier** with Restore or Dismiss; a banner points to them. The page only sends a process ID; session files are read from private state. Sessions closed from the app are not offered again.
- **Verified review fixes:** concurrent retries share one in-flight session launch; failed startup preserves recovery records, and older stopped conversations remain restorable. Recovery is retired only when a live replacement records the same conversation. Regression coverage includes a deliberately failed tmux startup, duplicate concurrent requests and running tests from inside native tmux.
- **Reconnect:** when Pi isn't running, the app shows **Reconnect**, and returning to the app restarts Pi once by itself. APK 0.1.4 adds the parameterless `reconnect()` bridge method, which re-runs the normal connection routine.
- **Removed:** the Chrome interface and its launchers: the `pi-voice` command (`launch.mjs`), the Termux:Widget shortcut (`install-shortcut.mjs`, `pi-voice --pin`), `/voice url`, the `--voice-open` flag, browser opening, the web app manifest and `ANDROID-LAUNCHER.md`. `npm run setup` now only registers the extension and removes the `pi-voice` links and widget script that earlier versions created (only files it can identify as its own). Remove the old home-screen shortcut yourself.
- **Docs:** README rewritten for the native app; native/README updated.

Run `git pull` and `npm run setup`, restart Pi once, and install APK 0.1.4 with `npm run native:install`.

## 1.9.0 — native APK 0.1.3 (versionCode 4)

- **Live activity:** the working line names Pi's current step ("bash · npm test", "Writing the reply…", "Waiting for you in Termux"). Tapping it, or the terminal button in the reply bar, opens an **Activity** sheet: each tool call with its arguments, duration and a live output tail, plus the reply being written. Finished steps collapse to one line; tap a step for its full output (last 4000 characters). Private model reasoning is never shown, only that a thinking step happened. The log covers the current run, is bounded and lives only in the running Pi's memory.
- **Open in Termux:** the Activity sheet opens Pi's actual terminal. In Pi Voice Native **0.1.3**, a Pi started by the native host or the New button is attached in a new Termux tab (`tmux -L pi-voice-native attach -t <session>`). The page can only name a validated session; the tmux command is fixed and runs without a shell. A one-time warning explains that Ctrl+C/Ctrl+D would stop Pi and Ctrl+B then D detaches. For other Pis the app opens Termux on its latest tab; Chrome offers to copy the attach command instead.
- **Regression coverage:** activity log unit tests (bounds, reset, reasoning never stored), extension event wiring, frontend label/sheet/terminal tests, executable Java checks for terminal targets and an updated native bridge contract.

Reopen the app for the Activity sheet. Restart Pi once (after the current response finishes) so it records activity. Install the same-key APK 0.1.3 (`npm run build:native`, then `npm run native:install`) for Open in Termux; older APKs explain the update instead.

## 1.8.0 — interface overhaul and parallel sessions

- **Redesigned interface** in a shadcn/ui-style system (Tailwind gray tokens, inline icons, no new dependencies). Compact top bar with session title and status dot; icon-only New, History and Settings buttons with 44px touch targets; chat-style question bubble; icon Stop and Read aloud controls; a single composer card with attach, clear, microphone and an arrow Send button that appears when there is a draft. Status messages fade out unless they are errors. Settings use switches; History, Settings and Sessions open as bottom sheets.
- **Native top spacing fixed:** the native shell already pads its WebView by the system bars, so the page no longer adds safe-area insets a second time there. No APK update is needed.
- **Parallel sessions:** New while Pi is busy starts another Pi in the native tmux server and switches to it; the busy one keeps running. A Sessions sheet lists running sessions, flags finished background replies and closes app-started ones. The page keeps one origin: its bridge relays authenticated requests by PID to other loopback bridges. Launchers ignore app-started sessions when choosing which Pi to open.
- **Settings → About** shows the Pi Voice version and the connected Pi's version, and notes when that Pi still runs an older Pi Voice backend that needs a restart.
- **Regression coverage:** relay/close/summary bridge tests, launch/idempotency/credential-free listing extension tests, launcher selection tests and frontend switching, background-finish, fallback and old-backend tests.

Refresh/reopen the frontend for the new interface. Restart Pi once (after the current response finishes) to enable parallel sessions; older backends keep working without them.

## 1.7.0 — native APK 0.1.2 (versionCode 3)

- **Optional Read aloud / Stop reading** beside Pi's latest completed reply. Nothing plays automatically, and playback makes no model request or chat submission.
- **Native Android TTS** with foreground/trusted-page checks, language/length validation, bounded Unicode-safe chunks, audio-focus handling, initialization/progress timeouts and cleanup on pause/navigation/destruction. Chrome uses browser synthesis where supported; older native shells request an APK update instead of relying on WebView synthesis.
- **Voice output settings** remember a separate reading language. Missing voices/service errors leave the reply/draft unchanged and permit manual retry. The selected Android/browser speech provider may process reply text online.
- **Speech-safe context changes:** starting the microphone, sending, switching replies/sessions or backgrounding stops playback; late callbacks cannot restart it. Markdown formatting/link destinations are omitted, descriptions remain, and code blocks are skipped.
- **Regression coverage:** browser/native playback simulations, cancellation/stale-event/timeout/language/error tests, UI recording/session/background guards, Markdown-to-speech checks and executable Java speech-chunk/Unicode checks. Build and isolated Pi integrations do not prove actual on-phone voice output.

Refresh/reopen the frontend for browser output. Native output requires the same-key APK **0.1.2** update (`npm run native:install`, after the current response finishes); Android asks for approval. No Pi backend restart is needed specifically for read aloud. No installer, voice playback or live-session restart is performed automatically.

## 1.6.1 — native APK 0.1.1 (versionCode 2)

Verified fixes from the first installed-native-app audit:

- **Native image previews:** WebView intercepts `data:` URLs as well as network requests. The original strict network-only interceptor rejected locally prepared JPEG thumbnails. The new executable request policy allows bounded JPEG subresources, while still rejecting data documents, HTML/SVG, file/content URLs and other network origins.
- **Session-scoped Stop Pi:** the frontend now sends the displayed session ID, and the backend rejects missing/stale IDs before calling Pi's abort API. An old tab can no longer stop a different session after a session switch.
- **Interrupted Android/Termux fallback speech:** switching apps cancels the owning HTTP request and suppresses late results/auto-send. Cancelling does not send a global recognizer-cancel request that could affect another tab.
- **Resilient launcher discovery:** both launchers now share authenticated, redirect-rejecting discovery and preserve records on temporary errors instead of permanently losing a running Pi endpoint.
- **Bounded discovery probes:** stale endpoint records could exhaust the bridge's 24-connection limit and hide the live Pi, potentially causing duplicate startup. Discovery now probes at most four records concurrently, leaving capacity for the chat and bootstrap.
- **Native reconnect guidance:** disconnected native chat points to the native app icon instead of Chrome-only startup instructions.

Regression coverage includes executable Java policy checks, browser simulations, real HTTP cancellation/connection-limit tests, and isolated real-Pi RPC and native PTY integrations. No provider/model requests are made by those integrations.

### Applying this update

Refresh/reopen the frontend for its changes. Restart Pi after the current response finishes for backend changes; see [Updating an existing installation](README.md#updating-an-existing-installation). Install the same-key APK update for the native image-policy change. An APK update and backend restart are deliberately not performed automatically while this chat is active.

Device status: native launch and embedded chat are user-confirmed. Real picker/thumbnail behavior in the updated APK, Android speech/permission edge cases, keyboard layout and long-running vendor background survival still need on-phone checks; there is no adb/UI automation in this environment.
