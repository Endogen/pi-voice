package com.pivoice.app;

public final class EngineChoiceChecks {
    private static int checks;
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
    public static void main(String[] args) {
        for (String allowed : new String[] { "com.google.android.tts", "org.woheller69.ttsengine", "a.b" }) check(EngineChoice.validPackage(allowed), "Package rejected: " + allowed);
        for (String denied : new String[] { null, "", "tts", ".com.x", "com..x", "com.x/", "com.x;rm", "com.x y", "1com.x", "com.x\n", "ｃom.x" }) check(!EngineChoice.validPackage(denied), "Package accepted: " + denied);
        for (String allowed : new String[] {
            "com.google.android.googlequicksearchbox/com.google.android.voicesearch.serviceapi.GoogleRecognitionService",
            "org.woheller69.whisperplus/.RecognitionService", "com.example/Inner$Service",
        }) check(EngineChoice.validComponent(allowed), "Component rejected: " + allowed);
        for (String denied : new String[] { null, "com.x", "/com.x.Service", "com.x//y", "com.x/y z", "com.x/y;z", "com.x/../y", "com.x/" + new String(new char[400]).replace('\0', 'a') }) {
            check(!EngineChoice.validComponent(denied), "Component accepted: " + denied);
        }
        check("default".equals(EngineChoice.recognizer(null)), "Missing service is the default");
        check("default".equals(EngineChoice.recognizer("anything else")), "Unknown service is the default");
        check("on-device".equals(EngineChoice.recognizer("on-device")), "On-device is accepted");
        check("com.x/.S".equals(EngineChoice.recognizer("com.x/.S")), "A component is accepted");
        System.out.println("Native speech-engine choices passed " + checks + " executable Java checks.");
    }
}
