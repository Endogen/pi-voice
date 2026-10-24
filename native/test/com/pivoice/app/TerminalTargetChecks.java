package com.pivoice.app;

public final class TerminalTargetChecks {
    private static int checks;
    private static void check(String expected, String value) {
        String actual = TerminalTarget.session(value);
        if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError("Terminal target failed for " + value + ": expected " + expected + ", got " + actual);
        checks++;
    }
    public static void main(String[] args) {
        check("", null);
        check("", "");
        check("pi-voice", "pi-voice");
        check("pi-voice-0a1b2c3d", "pi-voice-0a1b2c3d");
        for (String denied : new String[] {
            "pi-voice-0A1B2C3D", "pi-voice-0a1b2c3", "pi-voice-0a1b2c3d4", "pi-voice-0a1b2c3g", "pi-voice_0a1b2c3d",
            "pi-voice;rm -rf ~", "pi-voice -L other", "-t pi-voice", "other", "pi-voicex", "pi-voice-", "=pi-voice", "pi-voice\n", "ｐi-voice"
        }) check(null, denied);
        String[] attach = TerminalTarget.attachArguments("pi-voice");
        if (attach.length != 5 || !"=pi-voice".equals(attach[4]) || !"pi-voice-native".equals(attach[1])) throw new AssertionError("Unexpected tmux arguments");
        checks++;
        System.out.println("Native terminal target passed " + checks + " executable Java checks.");
    }
}
