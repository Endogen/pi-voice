package com.pivoice.app;

public final class RequestPolicyChecks {
    private static int checks;
    private static void check(boolean expected, String origin, String url, boolean mainFrame) {
        boolean actual = RequestPolicy.allows(origin, url, mainFrame);
        if (actual != expected) throw new AssertionError("Request boundary failed for " + url.substring(0, Math.min(url.length(), 90)) + ": expected " + expected + ", got " + actual);
        checks++;
    }
    public static void main(String[] args) {
        String origin = "http://127.0.0.1:8765";
        check(true, origin, origin + "/", true);
        check(true, origin, origin + "/app.js", false);
        check(true, origin, origin + "/api/state", false);
        check(false, origin, origin + "/api/state", true);
        check(true, origin, "data:image/jpeg;base64,YQ==", false);
        check(false, origin, "data:image/jpeg;base64,YQ==", true);
        for (String denied : new String[] {
            "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,YQ==",
            "data:image/png;base64,YQ==", "data:image/jpeg;base64,", "data:image/jpeg;base64,<script>",
            "https://external.example/image.jpg", "http://127.0.0.1:8766/app.js",
            "http://127.0.0.1:8765@external.example/app.js", "http://external.example@127.0.0.1:8765/",
            "http://127.0.0.1:8765.evil.example/", "file:///private", "content://photos/1", "javascript:alert(1)", "not a URL"
        }) check(false, origin, denied, false);
        check(false, null, origin + "/", false);
        StringBuilder huge = new StringBuilder("data:image/jpeg;base64,");
        for (int i = 0; i <= 4 * 1024 * 1024; i++) huge.append('A');
        check(false, origin, huge.toString(), false);
        System.out.println("Native request policy passed " + checks + " executable Java checks.");
    }
}
