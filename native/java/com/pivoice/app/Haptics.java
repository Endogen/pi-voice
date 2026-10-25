package com.pivoice.app;

/** Pure-Java mapping from the page's feedback kinds to HapticFeedbackConstants. */
final class Haptics {
    private Haptics() {}

    /** Returns -1 for unknown kinds. CONFIRM/REJECT exist from Android 11 (API 30). */
    static int constant(String kind, int sdk) {
        if (kind == null) return -1;
        switch (kind) {
            case "tap": return 1;                        // VIRTUAL_KEY
            case "toggle": return 3;                     // KEYBOARD_TAP
            case "tick": return 4;                       // CLOCK_TICK
            case "confirm": return sdk >= 30 ? 16 : 1;   // CONFIRM, else VIRTUAL_KEY
            case "reject": return sdk >= 30 ? 17 : 0;    // REJECT, else LONG_PRESS
            default: return -1;
        }
    }
}
