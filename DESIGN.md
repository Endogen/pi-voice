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

## Model selection

Model switching belongs to the connected Pi session, not the global app configuration. Keep it under **Settings → Connected Pi** rather than adding another top-bar control. A native select, provider groups, text filter, capability summary and explicit confirmation stay usable on mobile with accessible labels, a live status and 44px controls.

`src/model-picker.js` owns only picker state and presentation. The existing authenticated host forwards explicit session/instance-targeted requests; `models.mjs` validates provider/ID pairs against that worker's canonical Pi registry and calls Pi's session-scoped `setModel`. Endpoint URLs, credentials, headers and provider implementations never become picker metadata. Pi remains responsible for authentication, history conversion, tools and reasoning compatibility; no new provider or runtime plugin framework is needed.

Do not silently change providers, drop draft images, replace the conversation, persist a new global default or retry an uncertain mutation. Invalidate late results when the process/conversation target changes. Block conflicting app controls during a selection and confirm authoritative Pi state after a response or timeout. Clearly separate configured availability from a healthy running inference endpoint. Downloading models and managing local server lifecycles are separate future features, not model-picker responsibilities.

## Quality constraints

`src/sessions.js` owns session selection, launch/restore/close actions, notification routing, session-list polling and its sheet. Its state and injected UI callbacks make lifecycle changes explicit. `src/polling.js` serializes state requests, rejects stale session generations and guarantees a fresh request after model mutations; `src/app.js` applies current state to the conversation. The browser bundle remains a local script with no runtime npm dependencies.

Node VM tests cover detailed state transitions; Playwright exercises the actual HTML, CSS, native select/dialog behavior, image decoding and request races through the production authenticated HTTP boundary. Chromium's phone viewport emulates layout and touch, not Android power management or native speech.

Failed assistant attempts are retained, including empty replies and partial text. Show their error and let users decide how to continue; while Pi is still retrying, show that it is working. Never invent a successful reply or replay a prompt on reconnect.

- Safe-area insets, dynamic viewport units, mobile keyboard resize, minimum 44px touch controls.
- Clear working, waiting, disconnected and listening states. Do not reveal private model reasoning.
- Reduced-motion preference gets a static visible indicator rather than no indicator.
- Native dialogs support Escape, focus management, internal scrolling and explicit Close controls.
- Do not reset answer scroll on unchanged polling. History remains newest-first, including Markdown.
- Wake lock protects CPU wakefulness, not against force stop, low memory or Android vendor battery policies. No browser screen wake lock: the display is allowed to sleep.
