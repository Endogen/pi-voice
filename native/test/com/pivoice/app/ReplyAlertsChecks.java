package com.pivoice.app;

public final class ReplyAlertsChecks {
    private static int checks;
    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
        checks++;
    }
    public static void main(String[] args) {
        String token = "abababababababababababababababababababababababababababababababab";
        long time = 1700000000000L;
        String text = "All 12 pass — ünïcode.";
        // Same vector as test/notify.test.mjs: Node and Java must agree.
        String expected = "94bfbad76a05b36bff7212fc919f9c4e9ee73911f628684e31afd74b36b6d13d";
        check(expected.equals(ReplyAlerts.signature(token, "session-handle", 4321, time, "Fix tests", text)), "signature matches the extension");
        check(ReplyAlerts.verify(token, expected, "session-handle", 4321, time, "Fix tests", text, time + 1000), "fresh signed alert");
        check(!ReplyAlerts.verify(token, expected, "other-handle", 4321, time, "Fix tests", text, time), "handle is signed");
        check(!ReplyAlerts.verify(token, expected, "bad;script", 4321, time, "Fix tests", text, time), "invalid handles are rejected");
        check(!ReplyAlerts.verify(token, expected, "session-handle", 4322, time, "Fix tests", text, time), "pid is signed");
        check(!ReplyAlerts.verify(token, expected, "session-handle", 4321, time, "Fix tests!", text, time), "title is signed");
        check(!ReplyAlerts.verify(token, expected, "session-handle", 4321, time, "Fix tests", text + " ", time), "text is signed");
        check(!ReplyAlerts.verify(token, expected, "session-handle", 4321, time, "Fix tests", text, time + ReplyAlerts.MAX_AGE_MS + 1), "stale alerts are dropped");
        check(!ReplyAlerts.verify("cd" + token.substring(2), expected, "session-handle", 4321, time, "Fix tests", text, time), "another token fails");
        check(!ReplyAlerts.verify(null, expected, "session-handle", 4321, time, "Fix tests", text, time), "no stored token");
        check(!ReplyAlerts.verify(token, null, "session-handle", 4321, time, "Fix tests", text, time), "unsigned");
        check(!ReplyAlerts.verify(token, expected.toUpperCase(), "session-handle", 4321, time, "Fix tests", text, time), "only lowercase hex");
        check(!ReplyAlerts.verify(token, expected, "session-handle", 0, time, "Fix tests", text, time), "invalid pid");
        StringBuilder long_ = new StringBuilder();
        for (int i = 0; i <= ReplyAlerts.MAX_TEXT; i++) long_.append('x');
        check(!ReplyAlerts.verify(token, ReplyAlerts.signature(token, "session-handle", 1, time, "", long_.toString()), "session-handle", 1, time, "", long_.toString(), time), "bounded text");
        check(Haptics.constant("tap", 26) == 1 && Haptics.constant("toggle", 26) == 3 && Haptics.constant("tick", 26) == 4, "basic haptics");
        check(Haptics.constant("confirm", 30) == 16 && Haptics.constant("confirm", 29) == 1, "confirm falls back before Android 11");
        check(Haptics.constant("reject", 30) == 17 && Haptics.constant("reject", 29) == 0, "reject falls back before Android 11");
        check(Haptics.constant("buzz", 36) == -1 && Haptics.constant(null, 36) == -1, "unknown kinds are ignored");
        System.out.println("Native reply alerts and haptics passed " + checks + " executable Java checks.");
    }
}
