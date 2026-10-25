package com.pivoice.app;

/** Pending notification navigation. Only a matching page acknowledgement consumes it. */
final class SessionOpenRequest {
    String handle, sessionId;

    static boolean validHandle(String value) {
        return value != null && value.matches("[a-zA-Z0-9-]{8,80}");
    }

    static boolean validSessionId(String value) {
        return value != null && value.matches("[a-zA-Z0-9-]{1,128}");
    }

    boolean take(String nextHandle, String nextSessionId, boolean trusted) {
        if (!trusted || !validHandle(nextHandle) || (nextSessionId != null && !validSessionId(nextSessionId))) return false;
        handle = nextHandle;
        sessionId = nextSessionId;
        return true;
    }

    boolean matches(String shownHandle, String shownSessionId) {
        return handle != null && handle.equals(shownHandle) && (sessionId == null || sessionId.equals(shownSessionId));
    }

    boolean complete(String shownHandle, String shownSessionId) {
        if (!matches(shownHandle, shownSessionId)) return false;
        handle = null;
        sessionId = null;
        return true;
    }

    static String tag(String handle, String sessionId) {
        return sessionId == null || sessionId.isEmpty() ? handle : handle + ":" + sessionId;
    }
}
