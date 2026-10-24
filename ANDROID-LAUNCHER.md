# Pi Voice: Android launch options

## Keep the already-working single-icon shortcut

The large white **Termux widget** is a script list, not the only launcher
Termux:Widget offers. The plugin's `com.termux.widget/.TermuxCreateShortcutActivity`
can pin one script with Pi Voice's microphone artwork:

```sh
pi-voice --pin
```

Choose **Pi Voice**, then approve Android's Add prompt. This route has been
validated during development. It remains the reliable fallback.
It runs the same cold-start/resume script as the widget, not just a browser
bookmark. The launcher may add a small Termux badge; it is not an app-drawer entry.

Do not remove the current shortcut, Termux, Termux:Widget or saved sessions when
trying the optional native app. Its separate package does not overwrite them.

## A separate native shell is now built

An experimental **Pi Voice Native** APK provides background startup, a loading
animation and embedded chat without a Chrome tab. Download the preview/checksum
from [Releases](https://github.com/Endogen/pi-voice/releases), or build it from
`native/` source. Local output: **`native/out/pi-voice-native.apk`** — package
`com.pivoice.app`.

It shows a native connecting/error screen, invokes two fixed background
RUN_COMMAND tasks, and loads the existing authenticated chat inside WebView.
It includes Android SpeechRecognizer, a native document/image picker, web
confirmation dialogs and Back handling. Reusing the web UI avoids duplicating
chat/session/attachment logic as native widgets.

**Installation, security, host recovery, build instructions and honest validation
limits are in [native/README.md](native/README.md).** The APK is built and its
signature/alignment checked; real isolated Pi-in-tmux startup/reuse/New-session/
exit tests pass. Installation and actual Android permission/WebView/speech/
background behavior still need an on-phone check. It is not yet a proven
replacement for the working shortcut.

### Why background mode needs more than an Intent

The existing Pi launcher expects an interactive terminal. Setting
`RUN_COMMAND_BACKGROUND=true` on that unchanged command does not supply a PTY.
The new native route instead runs normal Pi in a private tmux terminal. A
long-lived **registered Termux background task** supervises it; simply detaching
tmux and immediately returning would leave it outside Termux's task tracking.
A separate short bootstrap returns readiness through an explicit PendingIntent.

Both launchers share the same kernel startup lock and authenticate discovery
before reuse. Fast retaps should not create another Pi, and multiple live
sessions produce an explicit ambiguity error rather than choosing one silently.
The old icon can open a native-started Pi in Chrome. No `--voice-open` is passed
by the native host, so it does not request a Chrome launch itself.

### Available routes

| Route | Appearance | Starts stopped Pi? | Trade-offs |
| --- | --- | --- | --- |
| Termux:Widget pinned script | One microphone icon | Yes, existing launcher | Already liked; possible shortcut badge/brief Termux UI; opens Chrome |
| Termux:Widget dynamic shortcut | Long-press plugin app, drag script | Yes, with prepared script | Same shortcut limitations; no advantage over our pinned icon |
| Chrome/PWA home icon | App-like icon | No, not by itself | Cannot run Termux commands while its localhost server is stopped |
| Tasker/Termux:Tasker launcher | Task shortcut | Feasible | Extra apps/configuration; unnecessary here |
| **Pi Voice Native shell** | Real home/app-drawer entry | Implemented via background Termux tasks | Built; embedded WebView/loading UI; broad permission setup; device validation pending |
| Full native chat rewrite | Native UI widgets | Feasible through Termux integration | Much larger maintenance cost; not needed for these launch benefits |

## Why not theme the old list widget?

Its black header, white background and text colors are hardcoded in upstream
Android resources. Web CSS cannot restyle it. Resizing can reduce empty space,
but rebuilding/signing a Termux plugin merely for styling is not worthwhile when
a supported single-icon shortcut exists.

## Security and Android limits

- RUN_COMMAND is broad shell access as the Termux user. The native app requires
  both `allow-external-apps=true` and a runtime grant. Setup changes that setting
  **only on explicit `--enable`**, with a backup. Android installation/permission
  approvals cannot be done silently by this assistant.
- The native shell accepts no commands/URLs from exported launcher input. Its
  result receiver is non-exported; the JS bridge is speech-only. See the native
  README for origin/navigation/credential restrictions.
- A RUN_COMMAND client does not need Termux's signing key, unlike shared-UID
  Termux plugins. Never uninstall/re-sign Termux to install our companion.
- User-initiated launch from a visible Activity is not a blanket exemption from
  Android background restrictions. Termux keeps its foreground-service
  notification; native startup cannot bypass force-stop, low-memory kills,
  reboot, OnePlus battery policy or mandatory permission screens.
- An installed WebView provider is still needed, though no Chrome tab is opened.
  Speech services may require internet. Pi/model history and provider behavior
  remain unchanged; no new cloud service or model client is introduced.

## Device/build environment

Development used Android **16 / API 36**, Termux **0.119.0-beta.3** (GitHub
build), with Termux:Widget installed. Single-icon
pinning was the first improvement; subsequent native work installed Termux JDK,
aapt/d8/apksigner and tmux tools and downloaded Google's API 35 platform jar.
The APK targets API 35, min 26, and is signed with a private local companion key,
not Termux's certificate. Building did not install the APK, grant runtime
permissions or enable external commands. The existing pinned script/icon are
not replaced by native builds or setup.

## Primary sources

- [Termux:Widget README: launcher/dynamic shortcuts](https://github.com/termux/termux-widget#setup-instructions)
- [Official shortcut Activity](https://github.com/termux/termux-widget/blob/master/app/src/main/java/com/termux/widget/TermuxCreateShortcutActivity.java)
- [Hardcoded list-widget layout](https://github.com/termux/termux-widget/blob/master/app/src/main/res/layout/widget_layout.xml)
- [RUN_COMMAND interface and requirements](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent)
- [Exact installed-version command/result constants](https://github.com/termux/termux-app/blob/v0.119.0-beta.3/termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java)
- [Android foreground-service start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [WebView native-bridge risks](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)
