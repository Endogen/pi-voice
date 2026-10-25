# Background operation and interrupted tasks

Pi runs in Termux, independently of Pi Voice's WebView. The page intentionally pauses when hidden; that should stop UI polling, not the agent. Termux already hosts its execution tasks in a foreground service. Adding another service to the Pi Voice APK would not transfer Pi's processes into it or exempt Termux from Android's policies. [Termux service implementation](https://github.com/termux/termux-app/blob/master/app/src/main/java/com/termux/app/TermuxService.java).

## What Pi Voice does

- The independent host and tmux workers survive closing the page and can reattach after the app returns.
- Keep Termux awake requests Termux's shared wake lock. The app now saves this preference in private Termux storage (`voice/wake-settings.json`), so cold-started workers can acquire it without waiting for the page. The default is enabled on Termux, disabled on desktop; an explicit saved opt-out wins.
- The app setting applies to the current worker and future workers. Existing other workers keep their own leases. `/voice sleep` remains a current-worker override and survives runtime reload; it does not change the saved app default.
- Before each agent run, an enabled worker reissues the lock request to recover from a previous failure or an externally released lock. A failed request is reported. There is no constant keepalive loop.
- Shared leases prevent one worker from unlocking another. The last lease releases the shared lock on normal shutdown.
- Empty failed or aborted replies are preserved and shown, including the provider's reported error. Pi's own retries remain its responsibility. Pi Voice never sends an automatic “continue” message, since a partially completed task may already have changed files or run commands.

A successful wake-lock command means the lock was **requested**, not that Android guarantees CPU or network availability. The independent empty host does not hold a worker lease.

## Distinguish a dead process from a failed turn

On the reported OnePlus 15 / OxygenOS 16, a visible app that returns to idle and needs a new message is also consistent with a failed provider request. It does not, by itself, prove Android killed Pi. Earlier Pi Voice versions hid empty failed assistant messages, obscuring this distinction.

After installing the backend changes, keep the new error text visible before sending another message. For a repeatable check, run this in a second Termux terminal before locking the phone, then again after the interruption:

```sh
cd ~/pi-voice
npm run diagnose --silent
```

The read-only JSON report omits tokens, credentials, prompts, replies, raw provider errors and filesystem paths. Compare the same worker handle in both reports:

| Observation | What it tells you |
| --- | --- |
| Same worker `instanceId`, idle, `lastReplyOutcome: "error"` | The process survived and a model attempt failed. Read the displayed error to investigate network/provider failures. |
| Same instance, still busy | Work is still active or blocked; inspect Activity and the terminal. A sleep/network stall is possible. |
| Different worker instance or a stopped worker | The old process ended or was restarted. This alone does not identify who killed it. |
| `hostReachable: false` | The host is currently unreachable; this is not proof of a kill. |
| `wakeLockRequestFailed: true` | The backend could not acquire/reassert the lock. Inspect Settings for the error. |

Select the same session for both reports. They are snapshots, not a continuous Android process monitor. A `signal 9` message in Termux is useful evidence of termination; diagnosing the killer needs Android system logs.

## Android and OnePlus checks beyond the app battery setting

1. Confirm the unrestricted/background exception applies to **Termux**, which owns Pi's CPU and provider connection, as well as Pi Voice. Check that Termux's ongoing service notification remains present.
2. Search OxygenOS Settings for **Sleep standby optimization**. This is a separate idle power feature; OnePlus documents it as reducing background notifications during sleep. Consider disabling it for a controlled screen-off test. The official manual available for this assessment is OxygenOS 14; exact menu names and placement on OxygenOS 16 may differ. [OnePlus manual](https://service.oneplus.com/content/dam/support/user-manuals/common/OxygenOS_14.0_User_Manual.pdf).
3. Android Doze restricts network access and wake locks. The battery-optimization exemption permits network and partial wake locks during Doze, but is not immunity from all restrictions. [Android Doze documentation](https://developer.android.com/training/monitoring-device-state/doze-standby).
4. Android also documents **Low Power Standby**, which can disable network access and ignore wake locks even for foreground services. Do not assume a visible notification or battery exemption solves every idle restriction. [PowerManager documentation](https://developer.android.com/reference/android/os/PowerManager#isLowPowerStandbyEnabled()).
5. If logs show child-process killing, consult Termux's phantom-process guidance. Android can kill excessive child processes or CPU-heavy workloads separately from battery optimization. Avoid blanket developer-setting changes based only on an idle UI; fewer parallel workers and tool processes reduce pressure. [Termux's Android limitations](https://github.com/termux/termux-app#readme).

Neither a browser heartbeat, fake audio playback, a second app service, nor automatically resending chat messages is a reliable fix for these system restrictions. For workloads that must finish despite the phone being suspended or powered off, execution needs an always-on machine; that would be a separate architecture from this on-device app.

## Validation on the phone

Run a task with observable progress, keep the awake setting enabled, record diagnostics, and leave the phone unplugged with the screen off. After several minutes, inspect the error/Activity and record diagnostics again **before** asking Pi to continue. Repeat with the separate sleep optimization disabled. This compares one setting at a time.

Developers with an attached test device can additionally use Android's documented Doze procedure (`adb shell dumpsys deviceidle force-idle`, followed by `adb shell dumpsys deviceidle unforce` and `adb shell dumpsys battery reset`). Test real screen-off idle too: forced AOSP Doze does not reproduce every OEM rule. Do not perform this during an important task. No device settings are changed by Pi Voice's tests or diagnostic command.

Desktop tests verify wake preference persistence, retries, shared leases, failed-turn visibility and browser recovery. They cannot certify OxygenOS survival, native speech, or real provider connectivity during device idle.
