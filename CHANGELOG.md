# Changelog

## 1.8.0 — interface overhaul and parallel sessions

- **Redesigned interface** in a shadcn/ui-style system (Tailwind gray tokens, inline icons, no new dependencies). Compact top bar with session title and status dot; icon-only New, History and Settings buttons with 44px touch targets; chat-style question bubble; icon Stop and Read aloud controls; a single composer card with attach, clear, microphone and an arrow Send button that appears when there is a draft. Status messages fade out unless they are errors. Settings use switches; History, Settings and Sessions open as bottom sheets.
- **Native top spacing fixed:** the native shell already pads its WebView by the system bars, so the page no longer adds safe-area insets a second time there. No APK update is needed.
- **Parallel sessions:** New while Pi is busy starts another Pi in the native tmux server and switches to it; the busy one keeps running. A Sessions sheet lists running sessions, flags finished background replies and closes app-started ones. The page keeps one origin: its bridge relays authenticated requests by PID to other loopback bridges. Launchers ignore app-started sessions when choosing which Pi to open.
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
