# Pi Voice: pocket conversation workspace

Reference: Anthropic `frontend-design` skill (read 2026-07-03); the 1.8 overhaul follows shadcn/ui's design language. This is a functional phone tool, not a marketing page. No fonts, images or scripts fetched from a CDN.

## Plan and review (1.8 overhaul)

- **System:** shadcn/ui-style tokens rather than the library itself. The app is a zero-dependency page served by the independent host in Termux; React/Next.js would add a build chain and runtime weight for no user benefit. CSS variables mirror shadcn's roles (background, surface, border, muted, primary, ring, destructive) on Tailwind's gray scale. `--bg` is `#111827`, matching the native shell's root view so the status-bar area blends in. Icons are inline 24px stroke SVGs in the Lucide style.
- **Accent:** brand blue `#93b4ff` for focus, the π mark, reading and fresh-reply badges. Status colours carry meaning only: emerald ready, amber working (pulsing), red disconnected/recording/stop.
- **Type:** system sans; reply text 16px/1.6, titles 15–17px, metadata 12–13px. Settings section headings are small uppercase labels, as in shadcn forms.
- **Layout:** one bounded viewport, three rows. The top bar is a session switcher (status dot, title, folder, count badge) plus three icon buttons with 44px targets. The stage shows the latest question as a right-aligned bubble and Pi's reply below a slim toolbar (π mark, thinking state, Stop or Read aloud icon). The composer is a single rounded card: textarea on top; attach, clear, contextual hint, microphone and Send in one row.
- **Distinctive element:** voice-first composer. With an empty draft, the microphone is the primary filled button and Send is hidden. Once there is text or an image, Send becomes primary and the microphone steps back. Recording turns the card border and microphone red, with a pulsing ring.

```
+ ● Session title  ②  ⇕          +   ↺   ⚙  +
|                      [ latest question  ] |
| π  ••• Pi is thinking…               ■    |
|                                            |
| reply, with Markdown                       |
| (only this pane scrolls for long replies)  |
+--------------------------------------------+
| fading status / persistent error           |
| ╭ Ask Pi anything…                       ╮ |
| ╰ 📎 ×   hint                     🎤  ↑  ╯ |
+--------------------------------------------+
```

Critique of 1.7: double top inset in the native WebView (the shell already pads for system bars, and WebView reported safe-area insets as well); text buttons crowding the bar; a composer of three loosely related rows plus two lines of helper text. 1.8 removes the duplicate inset in native mode, folds every control into icon buttons with accessible labels and tooltips, shows helper text only when it says something (listening, auto-send, images), and lets confirmations fade.

**Sessions:** an independent Termux host serves the UI and manages every app-created Pi equally. Workers expose only their own conversation operations. Stable handles identify sessions; process-instance and conversation checks protect commands. The app retains one origin when the first or last session closes, and shows a connected empty state with New/Restore. External Pi processes remain selectable without granting the app shutdown ownership.

## Quality constraints

- Safe-area insets, dynamic viewport units, mobile keyboard resize, minimum 44px touch controls.
- Clear working, waiting, disconnected and listening states. Do not reveal private model reasoning.
- Reduced-motion preference gets a static visible indicator rather than no indicator.
- Native dialogs support Escape, focus management, internal scrolling and explicit Close controls.
- Do not reset answer scroll on unchanged polling. History remains newest-first, including Markdown.
- Wake lock protects CPU wakefulness, not against force stop, low memory or Android vendor battery policies. No browser screen wake lock: the display is allowed to sleep.
