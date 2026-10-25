# Pi Voice — the Android app

Package `com.pivoice.app`, label **Pi Voice**. This document covers how the app works, its security model and how to build it. For installing and using Pi Voice, see the [main README](../README.md). Signed APKs and checksums are on [GitHub Releases](https://github.com/Endogen/pi-voice/releases).

## What the app does

- An app-drawer/home-screen entry with a native loading screen and explicit error/retry controls.
- Fixed **background** Termux commands start, resume or reuse Pi without opening a Termux window.
- The chat interface served by the Pi extension opens **inside Android WebView**, without a browser address bar. It needs an up-to-date Android System WebView.
- Speech uses **Android SpeechRecognizer**; **Read aloud** uses Android **TextToSpeech**, starts only when tapped and stops on pause, recording or session changes. A native document picker serves the paperclip; confirmation dialogs and Android Back are integrated.
- From the page, the app can restart Pi (**Reconnect**) and show Pi's terminal in Termux (**Open in Termux**).
- Haptic feedback uses `View.performHapticFeedback`: no permission, and it follows Android's touch-vibration setting.
- **Reply notifications:** when a run ends with a new reply, the extension in Termux sends an explicit broadcast (`am broadcast -n com.pivoice.app/.ReplyReceiver`) with a versioned session handle, PID, title and a plain-text excerpt. The receiver shows a notification only if the chat isn't on screen and notifications are on in Settings; otherwise the page plays its own chime. Channels: **Replies** (with sound) and **Replies (silent)**, chosen by the app's Sound setting. Opening the app clears reply notifications.
- Rotation keeps the WebView and draft. Tapping the icon again reuses a ready connection without reloading the page. WebView timers pause in the background.

The chat interface is shared with the extension rather than rebuilt as native widgets. Pi and model calls run in Termux. The app is a small local shell, not a cloud client, boot service, wake-word listener or a guarantee that Android keeps Pi alive.

## One-time installation

First follow the [installation steps](../README.md#installation) for the extension; installing the APK alone is not sufficient. This preview expects standard Termux paths, the project at `~/pi-voice`, and managed Pi at `~/.pi/agent/bin/pi`.

Either build the APK below, or download **both** `pi-voice.apk` and `pi-voice.apk.sha256` from [Releases](https://github.com/Endogen/pi-voice/releases) into `~/pi-voice/native/out/` (create this directory). From that directory run `sha256sum -c pi-voice.apk.sha256`; use trusted source/builds, because this app requests broad Termux access. The checksum catches download corruption, not a maliciously replaced release. Source checkout/build does not enable external commands or install the APK automatically.

When Pi is idle, run in the **Termux shell**:

```sh
cd ~/pi-voice
npm run native:install -- --enable
```

This explicitly:

1. Backs up `~/.termux/termux.properties`, enables `allow-external-apps=true` while preserving other properties, and requests a settings reload.
2. Opens Android's installer for `native/out/pi-voice.apk`. You must approve installation. If asked, allow Termux to install this local APK; that install-source permission can be disabled afterward.

Open the **Pi Voice** app and grant **Run commands in Termux** when Android asks. The microphone permission is requested only on first Speak. These are separate permissions. If the custom command permission was previously denied, use **App permissions** on the error screen; some phones list it under additional permissions.

**Security warning:** RUN_COMMAND is a broad shell permission, not scoped by Android to our bootstrap. `allow-external-apps=true` makes the interface available to apps that hold that permission. Only grant it to trusted apps. The native app itself exposes no arbitrary-command entry point and accepts no paths/URLs/commands from incoming launcher intents.

To inspect without changing anything: `npm run native:setup`. To enable without opening the installer: `npm run native:setup -- --enable`. No command is needed for ordinary daily launches after setup.

The APK is configured for this phone's standard Termux home/prefix and `~/pi-voice` project location. Installing only the APK on another phone does not install the backend, tmux or scripts. Keep Termux, the project and its installed Pi runtime in place. A custom RUN_COMMAND app does **not** need Termux's signing certificate: never uninstall/re-sign Termux for this.

## Host, sessions, and recovery

`host.sh` holds `~/.pi/agent/voice/app-launch.lock` for the independent host's full lifetime. The long-running Node host is a registered Termux background task, including when all conversations have closed. `bootstrap.mjs` separately verifies the host's authenticated `/api/health` response against its private identity and returns its URL through the one-use PendingIntent. Workers are never bootstrap candidates.

Every app-created session uses the same launcher and receives a durable managed handle, a fresh process instance ID, and a private tmux terminal named `pi-voice-` plus eight hex characters. The host serializes lifecycle decisions and reserves capacity before starting a process. Its versioned registry records selection, conversation references, request IDs, and intentional closure. The extension handles only its own Pi; there is no worker-to-worker relay.

Closing the first Pi has exactly the same effect as closing any other managed Pi. Other workers and the host keep running. Closing the last leaves New/Restore available, with a separate Stop Pi Voice service action. Shutdown is acknowledged as Closing until process exit is confirmed. Manual Pis remain external; incompatible old workers require an explicit restart after their task finishes.

Host recovery reconciles surviving workers and pending launches before starting anything new. Saved conversations can be restored under the same handle and a new instance ID. An intentional close stays closed after restart. Pi owns the conversation history; unsaved work, pending prompts, and memory-only state do not survive a process loss.

Reconnect runs the same two fixed background RUN_COMMAND requests as app launch. Open in Termux sends a foreground request to attach to that worker's validated tmux session. It uses session action `"0"` to select the new Termux tab. The app exposes no arbitrary command or URL input. Closing/swiping away the Android app does not stop the host or Pi.

The host keeps its reserved origin across restarts. A port conflict is an error, not a silent change of origin. Only a fresh installation chooses an available host port. `host-endpoint.json` contains host discovery; `host-state.json` is the private atomic registry; per-process endpoint/running files describe workers.

Upgrade the APK and checkout together for 3.x. Legacy running workers are shown as incompatible without acquiring ownership; restart them explicitly. Stopped legacy histories are imported without changing Pi's files. When the old WebView still exists, the new APK transfers only allowlisted UI preferences and blocks an origin transition with a draft/images present. It cannot read browser-only settings from an already-destroyed old page. Notification targets now use a signed, versioned handle instead of selecting a recycled PID.

Termux must still be allowed to keep its foreground-service notification/background activity. The host does not acquire a wake lock for an empty screen; workers retain their existing wake-lock leases. This architecture cannot prevent Android force-stop, low-memory termination, or reboot. Device lifecycle and battery behavior remain release checks.

## WebView security

- No exported deep links or command parameters; only the normal launcher Activity is exported. The PendingIntent result receiver is not exported and results are correlated to the current random attempt.
- Host discovery validates role, protocol version, PID and instance identity with bearer-authenticated `/api/health`, rejects redirects and non-literal-loopback origins, and reconstructs the URL instead of trusting discovery's URL field. It does not delete endpoint files on transient failure.
- Only the verified `http://127.0.0.1:<port>` origin may load network resources inside WebView. Bounded `data:image/jpeg;base64,` subresources are also allowed for locally prepared attachment thumbnails; data documents, HTML/SVG, other origins and local file URLs remain blocked. User-initiated external HTTP(S) links require confirmation and open outside it; file/intent/javascript navigation and downloads are blocked. Existing server authentication/CSP/Markdown protections remain in force.
- `ReplyReceiver` is exported so Termux can reach it, and it trusts nothing unsigned: each broadcast carries an HMAC-SHA256 over notification version, session handle, PID, time, title and text, keyed with the bridge token the app stored privately when it connected. Unsigned, altered, oversized or older-than-10-minute broadcasts are dropped. Tapping a notification passes only a validated, JSON-quoted session handle to the page, and only together with a random per-install key that other apps don't know.
- The JS bridge has an allowlisted `setUiPreference` method plus `startSpeech`, `stopSpeech`, `abortSpeech`, `speakText`, `stopReading`, `haptic`, `setReplyAlerts`, `replyAlertStatus`, `reconnect` and `openTerminal`; no general shell, filesystem, credential or navigation interface. `reconnect()` takes no arguments and only re-runs the fixed connection routine; what to resume comes from Pi Voice's private state. `openTerminal(session)` accepts only `pi-voice` or `pi-voice-` plus 8 hex characters (checked by executable Java tests), and an empty name only opens Termux. Both require the loaded local page in the foreground; `reconnect()` never overlaps a running attempt. Calls require the loaded local page; starting recognition or playback also requires foreground/window focus. Callbacks quote all strings as JSON and use per-request IDs. Interrupted speech cannot auto-send. Playback text is bounded, languages validated, utterances chunked, engine initialization/progress timed out and audio focus released on stop. Pause/navigation stops playback; Activity destruction also shuts down the TTS engine.
- Android WebRTC/geolocation permissions are denied. Mic permission is used through the native recognizer. The document picker grants only user-selected `content://` images; broad photo/storage permissions are not requested. Cookies, file access and WebView remote debugging are disabled. No analytics, token logs or cloud proxy are added.
- WebView preferences, including its bridge token, are private app storage. The APK contains no token or model API key.

## Build on Termux

Native dependencies: Termux **OpenJDK 21**, `aapt` (also supplies zipalign), `d8`, `apksigner`, `tmux`; no Gradle, emulator or Android Studio required. Java source compiles as Java 8, min Android **26**, target/compile **35**; tested build device Android **16 / API 36**.

For a fresh build environment:

```sh
pkg install openjdk-21 aapt d8 apksigner tmux curl unzip
mkdir -p native/tools
curl -fL https://dl.google.com/android/repository/platform-35_r02.zip -o native/tools/platform-35_r02.zip
printf '0bb560a90a7a2cbd0dd8348224d518b638fe7949  native/tools/platform-35_r02.zip\n' | sha1sum -c -
unzip -p native/tools/platform-35_r02.zip android-35/android.jar > native/tools/android.jar
npm run build:native
```

The checksum/size are from Google's [SDK repository metadata](https://dl.google.com/android/repository/repository2-3.xml); the API 35 platform archive size is **64,273,788 bytes**. SDK use is subject to the [Android SDK terms](https://developer.android.com/studio/terms). An existing platform jar can be provided via `ANDROID_JAR=/path/to/android.jar`. Tools/provenance are local development files, not packaged inside the APK.

`native/build.mjs` first runs the executable pure-Java request-policy, terminal-target, reply-alert/haptics and speech-chunk checks, then packages resources, compiles/dexes Java, aligns, signs, verifies the signature/alignment, and writes `out/pi-voice.apk.sha256`. The local signing key/password live outside the project in **`~/.pi/agent/voice-native-signing/`** with private permissions. They are never published. A fresh local build generates **your own** key, so it cannot update a release APK signed by the maintainer without uninstalling that companion first (its private WebView preferences are then lost; Termux/Pi data is separate). Do not uninstall Termux. Keep a private key backup if you want future self-built updates to retain the same identity. Never commit/share that folder. A regular update can install over this companion app without touching Termux or its data; bump `versionCode` for future releases. The APK is not signed with Termux's key and does not need to be.

`out/`, `tools/`, and generated PNG resources are ignored by native's `.gitignore`. Build tools/platform files add development storage; the APK itself is small because it reuses the installed WebView provider and local frontend.

### Build on GitHub Actions

The manually dispatched **Android release build** workflow (`.github/workflows/android-build.yml`) tests the checked-out commit and builds it on Ubuntu with Node 22, Java 21 and Android SDK 35. It uploads only the APK, its SHA-256 checksum and `BUILD-INFO.txt` with the source commit and build URL:

```sh
gh workflow run android-build.yml --ref main
gh run list --workflow android-build.yml
# Use the successful run's ID:
gh run download RUN_ID --dir /path/to/downloads
```

The CI build uses an **ephemeral signing key**, never the maintainer's key. Its APK is a build artifact, not an in-place update for an existing release installation. Before publishing a release, verify the downloaded checksum, re-sign the APK locally with the existing private maintainer key, verify its certificate against the previous release, and regenerate `pi-voice.apk.sha256`. Publish that signed APK, the new checksum and the build provenance together. Neither a private signing key nor its password belongs in GitHub, an artifact or a release.

## Verification and remaining device checks

```sh
npm test                 # Interface, bridge and extension tests + native contracts
npm run test:integration  # Real installed Pi in isolated RPC mode; images/new session
npm run test:native       # Real installed Pi in a detached tmux PTY; cold/reuse/new/exit
npm run test:native:policy # Executable Java checks: request isolation, terminal targets, reply alerts
npm run test:native:speech # Executable Java checks: bounded speech chunks and Unicode
npm run build:native      # Build, sign, verify signature and zip alignment
```

The native integration uses a unique tmux server and temporary Pi state; it makes no provider requests and does not change real wake locks or user sessions. Unit tests cover discovery validation, redirect rejection, multiple external sessions, timeouts, crash recovery, close intent, launch reservations, explicit properties editing and the native speech adapter including interruptions and duplicate callbacks. Read-aloud tests cover explicit start/stop, chunk sequencing, stale callbacks, backgrounding, microphone exclusion, session/reply changes, language errors, old-APK handling and engine timeouts.

**Device status:** previous releases confirmed the RUN_COMMAND connection and chatting on the development phone. The independent-host release has passed desktop tests with real Pi/tmux and Android Java compilation, but has not yet been validated on a phone. Build-time Java checks cover the request boundary, terminal-target validation, reply-alert signatures, the haptics mapping and speech chunking. The Android classes (`MainActivity`, `ReplyReceiver`) need the Android SDK to compile, which `npm run build:native` provides. Still to check on a device: host supervision after the first/last Pi exits, empty-host battery behavior, preference migration, reply notifications arriving from Termux's `am` and the permission prompt, haptic feedback strength, Termux tab creation for Open in Termux, Reconnect after Android stopped Termux, the image picker and thumbnails, text-to-speech voices and audio focus, Android speech recognition, permission edge cases, keyboard layout, and how long a given vendor keeps Pi running in the background.

Primary platform contracts: [RUN_COMMAND interface](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent), [Termux constants](https://github.com/termux/termux-app/blob/v0.119.0-beta.3/termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java), [WebView JS-bridge security](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges), [SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer), [TextToSpeech](https://developer.android.com/reference/android/speech/tts/TextToSpeech).
