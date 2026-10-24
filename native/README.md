# Pi Voice Native — optional Android shell

**Experimental preview:** package `com.pivoice.app`, label **Pi Voice Native**. This is a separate launcher app, not a replacement for your existing **Pi Voice** pinned shortcut. Keep that shortcut as a fallback. Source lives here; signed preview APKs/checksums are on [GitHub Releases](https://github.com/Endogen/pi-voice/releases), not committed build caches.

## What it improves

- A normal app-drawer/home-screen entry with the existing microphone artwork.
- A native dark loading screen and spinner while connecting; explicit failure/retry controls rather than a blank page.
- Fixed **background** Termux commands start/reuse Pi without requesting a Termux terminal window.
- The existing chat opens **inside Android WebView**. It does not launch a Chrome tab or display a browser address bar. It still needs an installed, up-to-date Android WebView provider.
- Primary speech uses **Android SpeechRecognizer**, not Chrome's Web Speech API. **Read aloud** uses Android **TextToSpeech**, starts only when tapped and stops on pause/microphone/session changes. A native document/image picker supports the paperclip; confirmation dialogs and Android Back are integrated.
- Ordinary rotation keeps the current WebView/draft. Tapping the app again reuses a ready connection without reloading its draft. WebView timers pause when the Activity is backgrounded.

The chat UI is deliberately reused, not rewritten as native widgets. Pi/model calls still run in Termux. This is a small local companion, not a new cloud client, boot service, wake-word listener or guaranteed background-survival mechanism.

## One-time installation

First follow [source/backend setup](../README.md#install-from-source); installing the APK alone is not sufficient. This preview expects standard Termux paths, the project at `~/pi-voice`, and managed Pi at `~/.pi/agent/bin/pi`.

Either build the APK below, or download **both** `pi-voice-native.apk` and `pi-voice-native.apk.sha256` from [Releases](https://github.com/Endogen/pi-voice/releases) into `~/pi-voice/native/out/` (create this directory). From that directory run `sha256sum -c pi-voice-native.apk.sha256`; use trusted source/builds, because this app requests broad Termux access. The checksum catches download corruption, not a maliciously replaced release. Source checkout/build does not enable external commands or install the APK automatically.

When Pi is idle, run in the **Termux shell**:

```sh
cd ~/pi-voice
npm run native:install -- --enable
```

This explicitly:

1. Backs up `~/.termux/termux.properties`, enables `allow-external-apps=true` while preserving other properties, and requests a settings reload.
2. Opens Android's installer for `native/out/pi-voice-native.apk`. You must approve installation. If asked, allow Termux to install this local APK; that install-source permission can be disabled afterward.

Open **Pi Voice Native** and grant **Run commands in Termux** when Android asks. The microphone permission is requested only on first Speak. These are separate permissions. If the custom command permission was previously denied, use **App permissions** on the error screen; some phones list it under additional permissions.

**Security warning:** RUN_COMMAND is a broad shell permission, not scoped by Android to our bootstrap. `allow-external-apps=true` makes the interface available to apps that hold that permission. Only grant it to trusted apps. The native app itself exposes no arbitrary-command entry point and accepts no paths/URLs/commands from incoming launcher intents.

To inspect without changing anything: `npm run native:setup`. To enable without opening the installer: `npm run native:setup -- --enable`. No command is needed for ordinary daily launches after setup.

The APK is configured for this phone's standard Termux home/prefix and `~/pi-voice` project location. Installing only the APK on another phone does not install the backend, tmux or scripts. Keep Termux, the project and its installed Pi runtime in place. A custom RUN_COMMAND app does **not** need Termux's signing certificate: never uninstall/re-sign Termux for this.

## Existing shortcut and conversations

- Neither the native app nor its setup removes/replaces `~/.shortcuts/Pi Voice`, its artwork, or Termux:Widget. The single-icon shortcut remains the Chrome fallback.
- Both routes share `~/.pi/agent/voice/app-launch.lock`, so simultaneous startup is serialized. Native startup first discovers authenticated live Pi sessions; it reuses one, refuses ambiguity, and otherwise starts `pi -c` in your home directory. It does not start a second model client or silently choose between multiple sessions.
- A Pi started by the native route is available to the existing shortcut too: tapping that shortcut discovers it and opens the same chat in Chrome.
- Chrome and the native WebView have **separate local preferences/storage**. Native auto-send starts off. They connect to the same Pi/session files; no chat migration is needed. To use another session when several exist, close extras or use `/voice` in Termux to open the desired session in Chrome.
- Closing/swiping away the native Activity does **not** quit Pi. Android may still kill it. Explicitly force-stopping Termux stops the backend and may require opening Termux once before another launch.

## Host and recovery

The app sends two fixed RUN_COMMAND requests:

1. `bash ~/pi-voice/native/host.sh`: holds the same kernel lock as the old launcher, discovers/reuses a bridge, or starts normal interactive Pi inside the private tmux server `pi-voice-native`, session `pi-voice`. A long-lived Node supervisor remains a **registered Termux background task** while that terminal exists. This keeps Pi tracked by Termux's foreground service; merely detaching tmux and returning would leave an unmanaged orphan. It never uses `--voice-open`.
2. `node ~/pi-voice/native/bootstrap.mjs`: waits for authenticated discovery with a deadline and returns the exact loopback URL through a one-use explicit PendingIntent to the non-exported result receiver. It does not wait for Pi to exit.

Both use `RUN_COMMAND_BACKGROUND=true`. The short result task must not be replaced with the long-running Pi command. The connection credential stays private: do not manually run/record bootstrap stdout, which contains the token. Per-command stdout/stderr logging is disabled; avoid verbose Termux debugging while handling credentials.

To reach the managed Pi terminal for extension questions, tools needing interaction, `/model`, `/resume`, or shutdown:

```sh
tmux -L pi-voice-native attach -t pi-voice
```

Detach without stopping Pi with **Ctrl+B, then D**. To quit that Pi, press **Ctrl+D at an empty Pi prompt**; its host task and startup lock are released. The native error screen also has **Open Termux**. Do not kill all Termux processes to fix this app.

Termux must be allowed to keep its foreground-service notification/background activity. Keep **Keep Termux awake** enabled if desired; battery cost and Android/vendor restrictions still apply. A native shell cannot bypass force-stop, low memory, reboot, battery optimization or mandatory Android permission screens. Mic/audio may be processed online by the selected Android recognition service; no offline guarantee is made. This app records no audio itself. Text/images still go to your configured model provider when sent. Native read-aloud uses the selected Android text-to-speech engine: it may process reply text online, so choose an offline voice if needed. It needs no microphone permission and never auto-plays. Configure its separate language in **Settings → Voice output**; use media volume and Android's TTS settings to manage voices.

## WebView security

- No exported deep links or command parameters; only the normal launcher Activity is exported. The PendingIntent result receiver is not exported and results are correlated to the current random attempt.
- Discovery validates PID/session identity with bearer-authenticated `/api/state`, rejects redirects and non-literal-loopback origins, and reconstructs the URL instead of trusting discovery's URL field. It does not delete endpoint files on transient failure.
- Only the verified `http://127.0.0.1:<port>` origin may load network resources inside WebView. Bounded `data:image/jpeg;base64,` subresources are also allowed for locally prepared attachment thumbnails; data documents, HTML/SVG, other origins and local file URLs remain blocked. User-initiated external HTTP(S) links require confirmation and open outside it; file/intent/javascript navigation and downloads are blocked. Existing server authentication/CSP/Markdown protections remain in force.
- The speech-only JS bridge has `startSpeech`, `stopSpeech`, `abortSpeech`, `speakText` and `stopReading`; no shell, filesystem, credential or general navigation interface. Calls require the loaded local page; starting recognition or playback also requires foreground/window focus. Callbacks quote all strings as JSON and use per-request IDs. Interrupted speech cannot auto-send. Playback text is bounded, languages validated, utterances chunked, engine initialization/progress timed out and audio focus released on stop. Pause/navigation stops playback; Activity destruction also shuts down the TTS engine.
- Android WebRTC/geolocation permissions are denied. Mic permission is used through the native recognizer. The document picker grants only user-selected `content://` images; broad photo/storage permissions are not requested. Cookies, file access and WebView remote debugging are disabled. No analytics, token logs or cloud proxy are added.
- WebView preferences, including its bridge token, are private app storage, like Chrome's own separate profile. The APK contains no token or model API key.

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

`native/build.mjs` first runs the executable pure-Java request-policy and speech-chunk checks, then packages resources, compiles/dexes Java, aligns, signs, verifies the signature/alignment, and writes `out/pi-voice-native.apk.sha256`. The local signing key/password live outside the project in **`~/.pi/agent/voice-native-signing/`** with private permissions. They are never published. A fresh local build generates **your own** key, so it cannot update a release APK signed by the maintainer without uninstalling that companion first (its private WebView preferences are then lost; Termux/Pi data is separate). Do not uninstall Termux. Keep a private key backup if you want future self-built updates to retain the same identity. Never commit/share that folder. A regular update can install over this companion app without touching Termux or its data; bump `versionCode` for future releases. The APK is not signed with Termux's key and does not need to be.

`out/`, `tools/`, and generated PNG resources are ignored by native's `.gitignore`. Build tools/platform files add development storage; the APK itself is small because it reuses the installed WebView provider and local frontend.

## Verification and remaining device checks

```sh
npm test                 # Existing launcher/UI/bridge regressions + native contracts
npm run test:integration  # Real installed Pi in isolated RPC mode; images/new session
npm run test:native       # Real installed Pi in a detached tmux PTY; cold/reuse/new/exit
npm run test:native:policy # Executable Java checks: JPEG previews and request isolation
npm run test:native:speech # Executable Java checks: bounded speech chunks and Unicode
npm run build:native      # Build, sign, verify signature and zip alignment
```

The native integration uses a unique tmux server and temporary Pi state; it makes no provider requests, does not open Chrome and does not change real wake locks/user sessions. Unit tests cover discovery validation, redirect rejection, ambiguity, timeout, explicit properties editing and the native speech JS adapter including interruptions/duplicate callbacks. Read-aloud tests cover explicit start/stop, browser/native dispatch, chunk sequencing, stale callbacks, backgrounding, microphone exclusion, session/reply changes, language errors, missing old-APK support and engine timeouts. Tests also check the old single-icon launcher.

**Device status:** the user has confirmed launching and chatting through the installed native app, exercising the RUN_COMMAND connection and embedded WebView. APK **0.1.2 / versionCode 3** adds native read-aloud and includes the earlier attachment-preview fix. Request boundaries and Unicode speech chunking have executable Java checks, but actual picker/thumbnail display and real TTS voice/initialization/audio-focus behavior still need checking after installing the update. Permission edge cases, detailed WebView layout/keyboard, real Android recognition, app-icon retaps/process death and sustained vendor background behavior remain to be checked. No adb/UI automation or screenshot test is available from this Termux session. Building/signing and real PTY tests do not prove these device UI paths. Try those with the new icon while keeping the already-working old icon.

Primary platform contracts: [RUN_COMMAND interface](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent), [Termux constants](https://github.com/termux/termux-app/blob/v0.119.0-beta.3/termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java), [WebView JS-bridge security](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges), [SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer), [TextToSpeech](https://developer.android.com/reference/android/speech/tts/TextToSpeech).
