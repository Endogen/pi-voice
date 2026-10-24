# Pi Voice: pocket conversation workspace

Reference: Anthropic `frontend-design` skill, read from the official anthropics/skills repository on 2026-07-03. This is a functional phone tool, not a marketing page. No fonts, images or scripts fetched from a CDN.

## Plan and review

- **Palette:** ink `#101723`, panel `#192333`, raised `#233148`, quiet text `#b0bed2`, blue `#b1c9ff`, status mint `#94d8bc`. Blue keeps continuity with the existing microphone icon. Mint communicates ready/working state, not decoration.
- **Type:** Android's native system sans for legible small-screen text; monospace only for code. Reply text 16px with 1.55 line height, titles 18px, controls/metadata 13–15px. No downloaded font or uppercase label system.
- **Layout:** one bounded viewport with three rows: compact app/status bar; question-and-answer stage; bottom voice composer. Left-align conversation content. Put metadata, speech configuration and older exchanges in separate native modal sheets. Do not put settings before the answer.
- **Distinctive element:** voice interaction is anchored by the bottom Speak control and an animated three-dot working signal beside the reply heading. No decorative animation or gradient panels.

```
+ Pi Voice / Ready          History  Settings +
| You asked                                  |
| latest question                            |
| Pi's reply             thinking dots / Stop |
|                                            |
| reply, with Markdown                       |
| (only this pane scrolls for long replies)   |
+--------------------------------------------+
| editable two-line draft                clear|
| Speak          listening state         Send |
| short confirmation / actionable error      |
+--------------------------------------------+
```

Critique before implementation: a conventional stack of cards pushed the entire conversation below the fold. Simply reducing fonts would make it harder to read without solving that structure. Replace that stack with a viewport workspace, eliminate always-visible metadata and repeated instructional copy, and preserve readable type/touch targets. Keep blue branding rather than changing to a fashionable unrelated palette. Long questions/answers must remain readable: use bounded internal scrolling rather than truncation or falsely promising arbitrary content fits on one screen.

## Quality constraints

- Safe-area insets, dynamic viewport units, mobile keyboard resize, minimum 44px touch controls.
- Clear working, waiting, disconnected and listening states. Do not reveal private model reasoning.
- Reduced-motion preference gets a static visible indicator rather than no indicator.
- Native dialogs support Escape, focus management, internal scrolling and explicit Close controls.
- Do not reset answer scroll on unchanged polling. History remains newest-first, including Markdown.
- Wake lock protects CPU wakefulness, not against force stop, low memory or Android vendor battery policies. No browser screen wake lock: the display is allowed to sleep.
