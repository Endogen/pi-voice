package com.pivoice.app;
import java.util.List;

public final class SpeechTextChecks {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Speech check " + checks); }
    private static void verify(String text, int limit) {
        List<String> chunks = SpeechText.chunks(text, limit);
        check(String.join("", chunks).equals(text));
        for (String chunk : chunks) {
            check(!chunk.isEmpty() && chunk.length() <= limit);
            check(!Character.isHighSurrogate(chunk.charAt(chunk.length() - 1)));
            check(!Character.isLowSurrogate(chunk.charAt(0)));
        }
    }
    public static void main(String[] args) {
        check(SpeechText.chunks("", 1000).isEmpty());
        check(SpeechText.chunks("Hello", 1000).get(0).equals("Hello"));
        verify("Hello.\n\nEine Antwort auf Deutsch.  More words.\n", 20);
        verify("abcdefghij\uD83D\uDE00\uD83D\uDE00abcdefghij", 11);
        verify(String.join("", java.util.Collections.nCopies(16000, "\uD83D\uDE00")), 1000);
        verify(String.join("", java.util.Collections.nCopies(4000, "hello! ")), 1000);
        verify("\uD83D\uDE00abc", 2);
        try { SpeechText.chunks("a", 1); throw new AssertionError("Expected invalid limit rejection"); }
        catch (IllegalArgumentException expected) { checks++; }
        System.out.println("Native speech text checks passed: " + checks);
    }
}
