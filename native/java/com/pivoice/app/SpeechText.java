package com.pivoice.app;

import java.util.ArrayList;
import java.util.List;

/** Bounded TTS chunks; never lose whitespace or split a surrogate pair. */
final class SpeechText {
    static List<String> chunks(String text, int limit) {
        if (limit < 2) throw new IllegalArgumentException("Invalid speech chunk size");
        List<String> parts = new ArrayList<>();
        for (int start = 0; start < text.length();) {
            int end = Math.min(start + limit, text.length());
            if (end < text.length() && Character.isHighSurrogate(text.charAt(end - 1)) && Character.isLowSurrogate(text.charAt(end))) end--;
            if (end < text.length()) {
                int pause = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf(' ', end - 1));
                if (pause > start + limit / 2) end = pause + 1;
            }
            parts.add(text.substring(start, end));
            start = end;
        }
        return parts;
    }
}
