package com.pivoice.app;

/** Pure-Java check for the only terminal the page may ask Termux to show. */
final class TerminalTarget {
    private TerminalTarget() {}

    /** Returns "" to just open Termux, a fixed tmux session name, or null to refuse. */
    static String session(String value) {
        if (value == null || value.isEmpty()) return "";
        // Only the native host's own sessions: "pi-voice" or "pi-voice-" + 8 hex.
        if (!value.startsWith("pi-voice")) return null;
        String rest = value.substring("pi-voice".length());
        if (rest.isEmpty()) return value;
        if (rest.length() != 9 || rest.charAt(0) != '-') return null;
        for (int i = 1; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return null;
        }
        return value;
    }

    /** Fixed tmux arguments: no shell, no user-controlled options. */
    static String[] attachArguments(String session) {
        return new String[] {"-L", "pi-voice-native", "attach-session", "-t", "=" + session};
    }
}
