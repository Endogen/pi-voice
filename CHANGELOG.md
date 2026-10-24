# Changelog

## 2.0.0 — native APK 0.1.4 (versionCode 5)

Pi Voice is now a native-app-only project.

- **Resume after Pi stops:** each voice-enabled Pi records which conversation it has open (`~/.pi/agent/voice/running/`). When the app has to start Pi again, the native host reopens that conversation in its own folder (`pi --session <file>`) instead of `pi -c` in the home folder. Parallel sessions that stopped are offered under **Sessions → Stopped earlier** with Restore or Dismiss; a banner points to them. The page only sends a process ID; session files are read from private state. Sessions closed from the app are not offered again.
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
