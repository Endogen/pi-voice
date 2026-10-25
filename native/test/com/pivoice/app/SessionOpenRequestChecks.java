package com.pivoice.app;

public final class SessionOpenRequestChecks {
    private static int checks;
    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
        checks++;
    }
    public static void main(String[] args) {
        SessionOpenRequest request = new SessionOpenRequest();
        check(request.take("session-first", "conversation-one", true), "authenticated notification accepted");
        check(!request.take(null, null, false), "launcher is not a navigation request");
        check(request.matches("session-first", "conversation-one"), "launcher does not erase a pending tap");
        check(!request.take("session-second", "conversation-two", false), "foreign intent cannot redirect a tap");
        check(!request.take("bad;script", "conversation-two", true), "handle validated");
        check(!request.take("session-second", "bad\nidentity", true), "conversation validated");
        // Saving/restoring these fields mirrors Activity recreation while the page loads.
        SessionOpenRequest restored = new SessionOpenRequest();
        check(restored.take(request.handle, request.sessionId, true), "pending request survives recreation");
        check(!restored.complete("session-first", "replacement-conversation"), "same worker with another conversation cannot acknowledge");
        check(restored.matches("session-first", "conversation-one"), "failed acknowledgement preserves target");
        check(restored.take("session-second", "conversation-two", true), "newest notification wins");
        check(!restored.complete("session-first", "conversation-one"), "late acknowledgement cannot consume newer target");
        check(restored.complete("session-second", "conversation-two"), "matching render consumes target");
        check(restored.handle == null && restored.sessionId == null, "completed request will not replay");
        check(restored.take("legacy-session", null, true), "legacy handle-only notifications remain supported");
        check(restored.complete("legacy-session", "conversation-one"), "legacy acknowledgement accepted");
        check(!SessionOpenRequest.tag("session-first", "conversation-one").equals(SessionOpenRequest.tag("session-first", "conversation-two")), "different conversations have independent notifications and PendingIntents");
        check("legacy-session".equals(SessionOpenRequest.tag("legacy-session", null)), "legacy notification tag preserved");
        System.out.println("Native notification routing passed " + checks + " executable Java checks.");
    }
}
