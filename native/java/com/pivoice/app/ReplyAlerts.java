package com.pivoice.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Pure-Java checks for "Pi replied" broadcasts from the extension in Termux. */
final class ReplyAlerts {
    static final long MAX_AGE_MS = 10 * 60 * 1000L;
    static final int MAX_TITLE = 120, MAX_TEXT = 400;
    private ReplyAlerts() {}

    /** HMAC-SHA256 with the bridge token over all fields, as lowercase hex. */
    static String signature(String token, String handle, int pid, long time, String title, String text) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(("2\n" + handle + "\n" + pid + "\n" + time + "\n" + title + "\n" + text).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format("%02x", b & 0xff));
            return hex.toString();
        } catch (Exception error) { return null; }
    }

    /** Only the extension holding this app's bridge token can raise a notification. */
    static boolean verify(String token, String signature, String handle, int pid, long time, String title, String text, long now) {
        if (token == null || !token.matches("[a-f0-9]{64}") || signature == null || !signature.matches("[a-f0-9]{64}")) return false;
        if (handle == null || !handle.matches("[a-zA-Z0-9-]{8,80}") || pid < 1 || title == null || text == null || title.length() > MAX_TITLE || text.length() > MAX_TEXT) return false;
        if (Math.abs(now - time) > MAX_AGE_MS) return false;
        String expected = signature(token, handle, pid, time, title, text);
        return expected != null && MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), signature.getBytes(StandardCharsets.US_ASCII));
    }
}
