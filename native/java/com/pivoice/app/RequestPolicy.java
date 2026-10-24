package com.pivoice.app;

import java.net.URI;

/** Pure-Java request boundary, exercised on a JVM as well as used by WebView. */
final class RequestPolicy {
    private static final String JPEG = "data:image/jpeg;base64,";
    private RequestPolicy() {}

    static boolean allows(String origin, String url, boolean mainFrame) {
        if (origin == null || url == null) return false;
        // WebView also intercepts data URLs. These are the in-memory JPEGs made
        // by our picker, not network requests. Never permit them as documents,
        // or allow arbitrary HTML/SVG/file URLs through this exception.
        if (!mainFrame && url.startsWith(JPEG)) {
            int length = url.length() - JPEG.length();
            if (length == 0 || length > 4 * 1024 * 1024) return false;
            for (int i = JPEG.length(); i < url.length(); i++) {
                char c = url.charAt(i);
                if (!(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '+' && c != '/' && c != '=') return false;
            }
            return true;
        }
        try {
            URI request = new URI(url);
            return "http".equals(request.getScheme()) && origin.equals("http://" + request.getRawAuthority())
                && (!mainFrame || "/".equals(request.getPath()));
        } catch (Exception invalid) { return false; }
    }
}
