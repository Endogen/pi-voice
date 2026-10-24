# Pi Voice for Termux

A lightweight home-screen app: **tap the launcher → speak → review transcription → send to Pi**. Replies appear in Chrome, or in the optional **Pi Voice Native** app's embedded WebView. Attach screenshots/photos with the paperclip, with optional typed or spoken questions. Tap **Read aloud** to listen to a completed answer. The existing Chrome launcher needs no APK build; the optional native companion adds a loading screen and background startup. No extra npm dependencies, public server, speech API key or root access is required.

## Install from source

This is an extension for an **already-installed/configured Pi coding agent**, not a standalone model client. You need Termux, Node **22.19+**, `flock` (Termux `util-linux`) and a compatible Pi runtime; development was verified against Pi **1.4.0**. The launchers expect `pi` on PATH. The optional native host additionally expects the managed Pi launcher at `~/.pi/agent/bin/pi` and the project at `~/pi-voice` under standard Termux paths.

```sh
# Install git / nodejs-lts / util-linux through Termux if not already present.
# Install/configure Pi separately before these steps.
git clone https://github.com/Endogen/pi-voice.git ~/pi-voice
cd ~/pi-voice
npm run setup
export PATH="$HOME/.local/bin:$PATH"  # Add to your shell profile if needed.
```

`npm run setup` registers the auto-discovered extension and launcher symlinks. It refuses to overwrite unrelated files, does not install Pi or request Android permissions, and leaves existing home icons alone. Keep the checkout in place. No `npm install` is required: the browser bundle, artwork and licensed Markdown parser are included.

Restart Pi, then enter `/voice`. To prepare the optional Termux:Widget icon, run `pi-voice --pin` as described below. Native APK setup is separate. The [Releases page](https://github.com/Endogen/pi-voice/releases) contains the experimental signed native APK and checksum; the full source/build instructions are in [native/README.md](native/README.md).

## One-tap startup — no manual Termux/Pi launch

Use a **Termux:Widget launcher shortcut**, not the Chrome-only shortcut. Android can start Termux through its native plugin; an offline Chrome page cannot start the stopped local server that would serve it.

**One-time setup:**

1. Install **Termux:Widget from the same source/signing family as Termux**. For GitHub Termux, use **[GitHub Releases](https://github.com/termux/termux-widget/releases)**; for F-Droid Termux, use its matching F-Droid plugin. Do not mix GitHub/F-Droid/Play Store plugins. Do not uninstall Termux to resolve a mismatch (that would delete its private data).
2. Run **`pi-voice --pin`** in Termux. It prepares/updates the private script and microphone icon, then opens the plugin's **single-shortcut picker**. Select **Pi Voice** and approve Android's **Add** prompt. This creates **one microphone icon**, not the large white Termux list widget. No Pi restart is needed for this setup command. Alternative: `cd ~/pi-voice && npm run install:shortcut -- --pin`.
3. Test the new icon, then remove the old list widget and Chrome-only shortcut **from the home screen**. Keep Termux and Termux:Widget installed. The launcher may add a small Termux shortcut badge; this is not a separate app-drawer entry.
4. If tapping waits for a Termux notification instead of starting automatically, allow **Android Settings → Apps → Termux → Display over other apps**. Android 10+ can otherwise block a plugin from bringing up the terminal. Keep Termux battery/background activity unrestricted as described below.

After setup, just tap **Pi Voice**:

- If one voice-enabled Pi is running, it opens that conversation in Chrome.
- Otherwise it starts Termux/Pi, continues the most recent saved session **in your home directory** (`pi -c`), and opens Chrome when the bridge is ready. With no saved session, Pi starts a new one.
- Fast repeated taps do not start duplicate app-managed Pi processes. A failed start releases its kernel-managed lock, including after an Android process kill/reboot.
- If several Pi sessions are running, it refuses to guess which conversation you want; use `/voice` in the desired one.

Termux may appear briefly while starting. Pi still runs locally in Termux while you use the app; the change removes the **manual startup sequence**, not the backend dependency. Termux must stay installed, and Android permissions/battery policies still apply. No boot-time service or always-running public server is added. A force-stopped Termux may need to be opened once to clear Android's stopped-app restriction. Speech/model services may still need internet access.

The large list widget hardcodes its header/background in Android resources; changing our web CSS cannot restyle it. Prefer the single-icon shortcut. A separate **Pi Voice Native** APK is now built as an optional next step; it does not replace this shortcut. See **[Android launcher options](ANDROID-LAUNCHER.md)** and **[native app setup/security/testing](native/README.md)**.

Official plugin setup and Android foreground restrictions: [Termux:Widget documentation](https://github.com/termux/termux-widget#setup-instructions).

## Optional native Android app — no Chrome tab

An experimental signed **Pi Voice Native** APK is available from [GitHub Releases](https://github.com/Endogen/pi-voice/releases). Download it and its checksum into `~/pi-voice/native/out/` (create that directory first), or build it with `npm run build:native` using the prerequisites in `native/README.md`. Verify the download with `sha256sum -c pi-voice-native.apk.sha256` from that directory. It provides a normal app icon, a native loading spinner, background Termux/Pi startup and the same chat inside WebView. Android speech and an image picker are integrated. The already-working **Pi Voice** shortcut stays intact and still opens Chrome; both routes reuse the same Pi and share the startup lock.

Once the backend is set up and the APK is at that path, install from the **Termux shell**:

```sh
cd ~/pi-voice
npm run native:install -- --enable
```

This explicitly backs up/updates Termux's `allow-external-apps=true` setting and opens Android's APK installer; approve installation, then open **Pi Voice Native** and grant **Run commands in Termux**. Approve microphone access when first using Speak. **RUN_COMMAND is a broad shell permission: grant it only to trusted apps.** Cloning/building does not enable this security setting, install the APK or approve runtime permissions.

The small native shell still requires Termux, the project scripts and an Android WebView provider. It cannot bypass force-stop, low-memory kills or vendor battery restrictions. Native launch and embedded chat have been confirmed on the development phone. Permission edge cases, the actual image picker/preview and Android speech still need targeted on-phone checks; APK signing, unit tests and real background PTY integration are verified. Keep the old icon as a fallback. Full details and recovery: **[native/README.md](native/README.md)**.

## Updating an existing installation

```sh
cd ~/pi-voice
git pull --ff-only
npm run setup
npm run build
```

Do not run a newer native APK against older helper scripts; update the checkout too. Preserve the signing key privately when building APK updates. Restart Pi after backend changes; do not interrupt a running response.

**For frontend changes:** refresh/reopen the Chrome page, or close and reopen the native Activity (Back out of the chat, then tap its icon). The running bridge serves the updated frontend files immediately, with `Cache-Control: no-store`.

**When using the native app:** finish the current response and open Termux. If Pi was started by the native background host, attach with `tmux -L pi-voice-native attach -t pi-voice`. If the native app reused an already-running Pi, return to that original Pi terminal instead; there may be no native tmux session. At an empty Pi prompt press **Ctrl+D** to quit it (not merely detach). Then tap **Pi Voice Native** to resume the saved conversation with the updated backend; the existing Chrome shortcut remains untouched. If the APK itself changed, install the verified, same-signing-key update first with `npm run native:install`; Android asks you to approve it. APK 0.1.1 adds the image-preview request-policy fix; APK **0.1.2** also adds native read-aloud playback. Do not install/restart while a response is running.

**For the Chrome launcher / image attachments, the New session button and automatic wake-lock management:** restart Pi once after the current response finishes. At an empty Pi prompt press **Ctrl+D**, then run this in the **Termux shell**, in the same working directory:

```sh
pi-voice --new -c
```

This continues the most recent saved Pi session and opens the app. A full restart matters: Node may retain cached native `.mjs` backend imports across `/reload`. Until restarted, the new interface still works, but image attachments, New session and automatic stay-awake controls explain that their backend support needs a restart. The attachment capability check prevents an old backend from silently sending a caption without its images.

For first installation only, `/reload` followed by `/voice` inside Pi loads the extension. If Chrome does not open, use `/voice url` and open that private link yourself. Never share it.

## Using the interface

1. Tap the **microphone** button, grant microphone permission, speak a short message and pause.
2. Review/edit the words in the bottom composer, then tap the **arrow** (Send). The arrow appears once there is something to send.
3. To send each utterance automatically, open **Settings** (sliders icon) and enable **Send automatically after speech**. It is off by default because a misheard instruction can cause real actions.
4. Tap **+** (New session) in the top bar. While Pi is idle, this replaces the connected session after a confirmation; the app clears the current view/draft only after the new session is ready. Your previous conversation remains saved in Pi (unless started with `--no-session`, which the dialog warns about). **While Pi is still working**, New instead starts a second Pi beside it and switches to it; the busy one keeps running (see [Parallel sessions](#parallel-sessions)).
5. Tap the **speaker** icon beside Pi’s completed reply to listen; tap the square to stop. In **Settings → Voice output**, choose a read-aloud language such as `en-US` or `de-DE`. It never plays automatically.
6. For one-tap cold startup, use the **Termux:Widget Pi Voice** icon described above. Chrome's **Add to Home screen** alone cannot start a stopped Pi.

The screen is a compact workspace rather than a long scrolling website:

- Your latest **question and reply** share the main view; the composer remains at the bottom.
- Animated dots and **Pi is thinking…** indicate generation/tool work. **Sending…** appears immediately while a prompt is submitted; queued follow-ups get a separate label. Reduced-motion users get static dots instead.
- Short exchanges fit in the available viewport. Arbitrarily long text cannot all fit at once: **long replies scroll inside the reply pane**, and long questions have their own bounded area. Hide the keyboard for more reading space.
- The top bar shows the session's title, a status dot (green ready, amber working, red disconnected) and its folder. Tap it to open **Sessions**. The icon buttons are New session, History and Settings.
- **History** opens older messages in a bottom sheet, still newest-first. **Settings** holds speech, stay-awake and session information rather than pushing replies below the fold.
- Unchanged polling does not recreate the answer or reset your reading position. History Markdown is rendered only when its sheet is opened.
- On a hardware keyboard, **Ctrl+Enter / Cmd+Enter** sends; Enter alone remains a newline.

The app shows completed user/assistant messages, not token-by-token streaming. The working indicator remains visible during generation and tool use. Tool output and interactive extension prompts stay in Termux.

**Use the Termux:Widget Pi Voice icon for cold startup, or the optional native app after its one-time setup.** A Chrome-only shortcut still needs an already-running Pi. Both use the same web chat UI; the native APK embeds it rather than rebuilding it as native widgets.

From a Termux shell:

```sh
pi-voice              # Open the one running voice-enabled Pi, or start a fresh Pi
pi-voice --app        # Same as the one-tap launcher: reuse Pi, otherwise continue with -c
pi-voice --pin        # Open single-icon setup: choose Pi Voice, then confirm Add
pi-voice --new        # Start a new Pi and open the app
pi-voice --new -c     # Continue the most recent saved session and open the app
```

If several Pi sessions are running, use `/voice` inside the specific session you want. Check its name, working directory and model in **Settings → Connected Pi**.

## Parallel sessions

Tap the session title in the top bar to see every running voice-enabled Pi and switch between them. A number beside the title counts running sessions; it turns blue when a background session finishes a reply. Switching never moves your draft into another conversation silently: the composer stays as typed, and the bridge rejects a prompt addressed to a session that is no longer shown.

- **New while Pi is working** starts another Pi in the same folder, in the background tmux server used by the native app (`tmux -L pi-voice-native`). It needs `tmux` (`pkg install tmux`). Up to 4 sessions can run at once; each uses its own memory and model requests.
- Sessions started this way show a **×** in the Sessions sheet. Closing one quits that Pi; its conversation stays saved. A Pi you started yourself in a terminal (and the session serving the app window) is never closed from the app.
- The app keeps one connection: the bridge it was opened from relays requests to the other local bridges (same private token, loopback only). The native APK needs no update for this. Restart Pi once after updating so all bridges support switching.
- The launchers ignore app-started sessions when picking which Pi to open, so a parallel session never makes startup ambiguous. If you started several Pi processes yourself, they still refuse to guess.

## Reading Pi’s answer aloud

**Read aloud** appears beside the latest completed reply, not while Pi is working. Tap it once to listen; it becomes **Stop reading** while playing. Replies never autoplay or resume after returning to the app. Reading does not submit another prompt or make a model/API request.

- **Pi Voice Native:** install the same-key **APK 0.1.2 / versionCode 3** update with `npm run native:install` after this response finishes, then approve Android's installer and reopen the app. Earlier APKs explain the upgrade in Settings rather than trying unreliable WebView browser speech. Do not uninstall Termux or the companion app to apply a same-key update.
- **Chrome:** refresh the frontend and use the browser's speech synthesis when available. A Pi backend restart is **not needed specifically for read aloud**; the feature changes the frontend and native shell, not the bridge.
- Choose **Settings → Voice output → Read-aloud language**, e.g. `en-US` or `de-DE`. This is separate from microphone recognition language and is remembered on the device. Install a matching voice in Android's text-to-speech settings if one is missing; check media volume if playback is silent. Available voices/pronunciation depend on the selected engine.

Markdown is converted to spoken text: formatting and link destinations are removed, image descriptions remain, and code blocks are announced as omitted rather than reading commands aloud. Long replies are split into bounded utterances without splitting Unicode surrogate pairs. A reading is limited to 32000 characters; oversize or unavailable speech fails with an explanation, without modifying the answer or draft.

Playback stops when you start the microphone, send a question, start/switch sessions or replies, or leave the app. The native shell also stops on pause, navigation/reconnect or audio-focus loss and releases its audio resources when destroyed. This prevents recording Pi's own voice into another prompt. Error/timeout/cancellation callbacks from an older reading cannot restart it or stop a newer one.

**Privacy:** this app does not record speech playback or upload it to a Pi Voice service. However, your selected Android/browser text-to-speech provider **may process the reply online**. There is no offline guarantee; choose/install an offline voice if sensitive content must stay on-device. Native output uses Android `TextToSpeech` and does not require microphone permission.

## Attaching screenshots and photos

1. Tap the **paperclip** beside the draft and choose JPEG, PNG or WebP images using Android's file/photo picker. The picker controls which gallery/file/camera options are offered.
2. Review the thumbnails. Tap **×** on a thumbnail to remove it, or use **Clear draft and images** to discard the entire unsent draft.
3. Optionally type a question or tap **Speak** to add one. Image-only messages also work.
4. Tap **Send**. With images attached, speech auto-send is deliberately suppressed: images require an explicit Send action (or Ctrl/Cmd+Enter).

The selected Pi model must advertise **image input**. Text-only models are rejected with an explanation, not sent a caption with the image silently dropped. Change models in Pi if necessary. This uses Pi's native structured image content and the existing authenticated local bridge—no image-hosting service, separate model client or public upload server.

**Limits:** up to **4 images** per message; originals up to **15 MiB each** and **40 megapixels**. Chrome decodes them with EXIF orientation, scales the longest edge to at most **2048 px**, and re-encodes as JPEG at quality 0.9, with transparency flattened to white. This removes the original file metadata and reduces payload size; image detail can be lost, so crop dense screenshots to the relevant area. Prepared uploads are limited to **3 MiB per image / 8 MiB total**, within a 12 MiB JSON request cap. SVG, GIF, HEIC, video and arbitrary file attachments are not supported; convert to JPEG/PNG/WebP first.

**Privacy and cost:** previews/prepared attachments stay in browser memory until you send them; they are not placed in local storage or uploaded merely by selecting files. Sending shares the prepared image with your configured model provider and normally saves it in Pi's session history (except `--no-session`). Original filenames are not included. Visible secrets still need redacting—metadata removal does not hide faces, passwords or document contents. Vision input can increase latency, token use/cost and session-file size.

Failures keep the text and images for review/manual retry, with the same deduplicated message ID while unchanged. Successful submission clears the composer previews. **New** clears unsent images only after the fresh session is confirmed. Chat history shows an image-count marker, not full image thumbnails; the polling API never retransmits stored base64 image data. Unsent images are not restored after refreshing/closing the page.

## Keeping Termux awake

This version automatically requests **Termux's CPU wake lock** when you open `/voice`, launch Pi with `--voice-open`, or connect the web app with **Keep Termux awake** enabled (the default).

- It stays requested while that voice-enabled Pi session runs, including when the browser is backgrounded or the display sleeps. This is **not** a browser screen wake lock; the display can turn off normally.
- Turn it off under **Settings → Keep Pi available**, or enter `/voice sleep` inside Pi. `/voice awake` enables it without opening the browser.
- `/voice stop` closes the bridge and releases its managed lock. Normal Pi shutdown/reload also releases it. Reopening `/voice` requests it again; the browser applies your saved checkbox preference after connecting.
- Multiple Pi Voice sessions cooperate through private lease files, so closing one does not unlock another active Pi Voice session. Dead processes and mismatched process-start identities are pruned on subsequent management operations.
- **All Termux sessions share one Android wake lock.** Unrelated manually acquired locks cannot be distinguished from ours. Releasing the last managed Pi Voice lock can also release a manually acquired Termux lock. Keep stay-awake on if another Termux job needs it, or manage that shared policy manually.
- A wake lock consumes battery and prevents CPU sleep; **it does not guarantee Android will keep Pi alive**. It cannot prevent force stop, low-memory killing, reboot or vendor battery policies. Set **Android Settings → Apps → Termux → Battery → Unrestricted** / allow background activity. Keep Termux's notification enabled. Some vendors also need an autostart/background exemption.
- If Pi crashes and a lock remains requested, release it from Termux with `termux-wake-unlock`. You can also manually acquire it with `termux-wake-lock`. Do not release it while other Termux jobs depend on it.

The settings status reports command success/failure; it is not an independent Android-kernel or battery-policy guarantee. The commands are provided by `termux-tools`, not by browser microphone permissions.

## Speech options

- **Pi Voice Native:** the primary option automatically uses Android SpeechRecognizer, with the native app's microphone permission and Speech language setting. No Chrome speech API is required; Termux:API remains an optional fallback.
- **Browser speech (recommended in Chrome):** use Chrome. Set the language in Settings, e.g. `en-US` or `de-DE`.
- **Android via Termux:API:** select this fallback if browser speech fails. Install the matching Termux:API Android plugin and its command-line client (`pkg install termux-api`) if you want this fallback. Grant **Termux:API → Microphone** permission if needed. Its language/defaults are separate from the browser language setting.
- **Keyboard dictation:** tap the draft box and use your Android keyboard's microphone, then Send. This also works when direct browser speech is unavailable.

This is push-to-talk, not a background listener or wake-word assistant. Transcription/offline support depends on the browser/Android recognition service. Pi replies can be read aloud on request using **Read aloud**; they never play automatically.

## How it connects and renders

The installed extension attaches to the existing Pi runtime with `pi.sendUserMessage(...)`; it does not run another model client or paste terminal keystrokes. If Pi is busy, prompts are queued as follow-ups. Speech is plain user text, never an executable shell/slash command. A session-ID check prevents accidental submission into a switched session.

The app polls every 1.5 seconds while visible. Replies render safe Markdown: headings, emphasis, strikethrough, nested lists, tasks, quotes, links, inline/fenced code and tables. Wide code/tables scroll inside their containers. User transcripts remain literal text. The bundled MIT-licensed markdown-it parser requires no CDN or npm install. Raw HTML is escaped, unsafe URL schemes are blocked, links use `noopener noreferrer`, and model-generated Markdown images show alt text without network requests. Only explicitly selected local image attachments get previews; the CSP permits their data URLs without permitting remote image hosts.

**New** creates a real, empty Pi session in the same process/working directory; it is not a model prompt and does not launch another Pi process. It is disabled while Pi is working, follow-ups are queued, a message is sending, speech is recording, or images are being prepared: wait, or use Stop Pi first. Repeated taps are guarded, session IDs prevent stale tabs/retries from switching another session, and the bridge keeps its port/token across replacement so the same browser tab reconnects. Auto-send turns off for the new session; the saved stay-awake preference is reapplied. Cancelling/failure keeps the draft. If acknowledgement is lost, the browser watches for the new session instead of automatically repeating the action.

**Stop Pi** requests cancellation for the session shown in the app; an old tab cannot stop a different session after a switch. It cannot undo completed actions. A failed HTTP submission keeps the draft. Retries of the same message are deduplicated while that bridge runs; after restarting Pi, check the conversation before retrying an unconfirmed submission.

## Privacy and security

- The bridge listens only on **127.0.0.1**, normally port **8765**. Concurrent Pi instances get different ports.
- API calls require a random 256-bit token. Host/Origin/Fetch Metadata checks block cross-site and DNS-rebinding requests. A narrow exception lets Android open the public app page; it never bypasses API protection.
- The `/voice` link carries a credential in its URL fragment. The app removes it from the address bar and stores it in local storage. **Do not share it.** Trusted software running as your Termux user can also read that credential.
- Text and explicitly sent image attachments are submitted to Pi/your model provider. Selected images are decoded/re-encoded locally before sending; no third-party image host is used. **Chrome/Android speech services may process your audio online.** This app stores no audio and adds no transcription service.
- Submitted prompts enter normal Pi history and can authorize real commands/file changes, exactly like typed prompts. Review-before-send is safer.

State lives privately in `~/.pi/agent/voice/` (or `$PI_CODING_AGENT_DIR/voice/`). To rotate credentials, stop all Pi instances, delete `~/.pi/agent/voice/token`, restart and reconnect with `/voice`. An old shortcut may need the new connection link.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `/voice` unknown | `/reload` for first installation, or restart Pi. |
| Browser does not open | `/voice url`, then open the private link manually in Chrome. |
| Chrome says cross-site requests are not allowed on launch | Restart Pi with `pi-voice --new -c` to load the fixed backend; `/reload` can retain cached imports. API protection stays enabled. |
| App disconnected | Tap the new Termux:Widget **Pi Voice** shortcut to reopen/restart. A Chrome-only icon cannot start the backend. If the new launcher is not installed, use `/voice` in Pi or `pi-voice --app` in Termux. |
| Attach images, New session or wake settings ask for a restart | Follow Updating an existing installation above. Frontend updates alone cannot replace the running backend. |
| Images are rejected | Select a vision-capable model in Pi; use JPEG/PNG/WebP within the limits above. Crop large screenshots or send fewer images. |
| New is disabled | Wait for Pi/sending/queued work to finish, stop a recording, or use Stop Pi and wait until Pi is idle. It is also disabled while disconnected or a new session is starting. |
| Termux stops in the background | Enable Keep Termux awake and unrestricted battery/background activity. Wake locks do not prevent every Android process kill. |
| Microphone denied | Android Settings → Apps → Pi Voice Native / Chrome / Termux:API → Permissions → Microphone, depending on your selected interface/engine; Chrome also has site permissions. |
| Native app cannot start/connect | Follow `native/README.md`: enable external commands explicitly, grant Run commands in Termux, check helper files/battery settings, then Try again. Keep using the old icon if needed. |
| Browser speech unavailable/network error | Try Chrome, Android fallback, or keyboard dictation. Check recognition service and connectivity. |
| Wrong speech language | Change Browser speech language. Android fallback has separate defaults. |
| Long reply does not fit | Scroll inside the reply pane, hide the keyboard, or use History. The outer page intentionally stays fixed. |
| Shortcut points at an old session/port | The Termux:Widget launcher discovers the current port. Replace old Chrome-only shortcuts; with several sessions, use `/voice` in the desired one. |
| Large ugly Termux list widget | Run `pi-voice --pin`, choose Pi Voice and approve Add for a single microphone icon; remove the list widget after testing. |
| Shortcut picker does not appear | Open Termux once and retry `pi-voice --pin`; check Termux:Widget is installed. Android/your launcher must confirm pinning. |
| New icon does nothing / waits for notification | Check Termux:Widget is installed from the same source as Termux, refresh its widget, and allow Termux **Display over other apps**. Open Termux once if it was explicitly force-stopped. |

## Development and verification

Design guidance: Anthropic's [frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md), consulted for the phone-specific hierarchy, restrained motion, legible type and accessible controls. The compact token/layout plan is in `DESIGN.md`.

- `~/pi-voice/setup.mjs`: register the extension/launcher commands from a fresh checkout without changing Android permissions.
- `~/pi-voice/launch.mjs`: endpoint discovery, resume-on-demand app mode and duplicate-start locking.
- `~/pi-voice/install-shortcut.mjs`: private Termux:Widget launcher script/icon setup and official single-icon picker (no APK install).
- `~/pi-voice/ANDROID-LAUNCHER.md`: launcher comparison and Android limitations.
- `~/pi-voice/native/`: Java/WebView companion, fixed background host/bootstrap, APK builder, explicit opt-in setup and native integration test; see its README.
- `~/.shortcuts/Pi Voice`: installed foreground launcher; `~/.shortcuts/icons/Pi Voice.png`: its icon.
- `~/pi-voice/extension.mjs`: Pi lifecycle/session integration and voice commands.
- `~/pi-voice/bridge.mjs`: local authenticated HTTP and Android speech fallback.
- `~/pi-voice/image-attachments.mjs`: shared upload limits, base64/type/signature validation; limits are embedded into the browser bundle at build time.
- `~/pi-voice/wake-lock.mjs`: serialized Termux wake-lock/lease management.
- `~/pi-voice/src/app.js`: editable browser logic; `src/markdown.js`: safe renderer.
- `~/pi-voice/vendor/markdown-it/`: pinned parser, license and provenance.
- `~/pi-voice/public/`: generated JS, editable HTML/CSS, manifest/icons.
- `~/pi-voice/build.mjs`: zero-dependency browser bundler.
- `~/.pi/agent/extensions/pi-voice.ts`: auto-discovered extension entry point.
- `~/.pi/agent/bin/pi-voice` and `~/.local/bin/pi-voice`: launcher symlinks.

```sh
cd ~/pi-voice
npm run install:shortcut # Prepare/update the Termux:Widget script and icon
pi-voice --pin           # Prepare resources and open Android's single-icon picker
npm run build          # Required after changing src/ JavaScript
npm test               # Bundle freshness + automated unit/HTTP/UI simulation tests
npm run test:integration
npm run test:native    # Isolated real Pi inside a background tmux PTY
npm run test:native:policy # Executable Java WebView request-policy checks; requires JDK
npm run test:native:speech # Executable Java speech chunk/Unicode checks; requires JDK
npm run build:native   # Optional APK; needs native tools/platform jar (native/README.md)
npm run native:setup   # Show external-command setting without changing it
```

The integration smoke test starts the installed Pi in an isolated temporary RPC session and checks extension registration, session identity, UI serving, HTTP authentication, wake-lock route wiring, two real new-session operations through the browser API, stale-action rejection, unchanged port/token, native text+image/image-only delivery and graceful shutdown. A test-only input extension captures/consumes image prompts before a provider request, so it makes **no model/API calls** and does not change the device's real wake lock. Unit tests simulate command success/failure, multi-session ownership and cleanup without touching the shared Android wake lock. Launcher tests use fake Pi/browser/Android executables and real file locking to check cold resume, running-session reuse, rapid repeated taps, failure/retry, single-icon setup without starting Pi/browser, Android error reporting and a minimal plugin environment without shell-profile initialization.

Launcher tests resolve tools from `PATH`. The four checks requiring real `flock` are explicitly skipped when it is unavailable (for example on macOS); run the complete suite in Termux/Linux to cover kernel locking. Shortcut generation, permissions, overwrite protection and shell syntax are still checked. For a Pi installed elsewhere, run the RPC integration with `PI_VOICE_TEST_PI=/absolute/path/to/pi PI_VOICE_TEST_EXTENSION="$PWD/extension.mjs" npm run test:integration`.

The native PTY integration separately verifies a real Pi cold start, authenticated discovery, repeated-launch reuse, New session in normal TUI mode, stable URL and clean host exit. It uses a unique tmux server and temporary state, without Chrome, provider calls, real wake-lock changes or user-session changes. The APK builder checks signature and zip alignment.

**Validation limits:** speech-to-Pi and the improved pinned icon have been confirmed during development. Automated tests validate browser logic/Markdown HTML, HTTP behavior and installed Pi integration. This Termux environment has no headless browser or adb/UI automation, so there is no pixel-level Chrome/WebView screenshot test. Image preparation is exercised with mocked decoding/canvas APIs; actual Android picker/canvas and real-model vision quality still need an on-phone check. The native launch/RUN_COMMAND connection and embedded chat are user-confirmed on the development phone. The updated image-request boundary has executable Java regression checks; its actual picker/thumbnail display still needs checking in the updated APK. Native microphone recognition, read-aloud voice playback/initialization/audio focus, permission edge cases, keyboard/layout, repeated icon taps, process death and sustained vendor background survival need targeted device checks. The native installer helper opens Android's approval UI only when explicitly requested; it does not approve installation or runtime permissions.
