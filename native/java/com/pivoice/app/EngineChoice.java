package com.pivoice.app;

/** Which speech-engine identifiers from the page may reach Android APIs. */
final class EngineChoice {
    static final String DEFAULT = "default", ON_DEVICE = "on-device";

    private EngineChoice() {}

    // Only these shapes are accepted: a package name, or "package/class".
    static boolean validPackage(String id) {
        return id != null && id.length() <= 200 && id.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+");
    }

    static boolean validComponent(String id) {
        if (id == null || id.length() > 400) return false;
        int slash = id.indexOf('/');
        return slash > 0 && validPackage(id.substring(0, slash)) && id.substring(slash + 1).matches("\\.?[A-Za-z0-9_$]+(\\.[A-Za-z0-9_$]+)*");
    }

    /** What startSpeech may request: the phone default, on-device, or a component. */
    static String recognizer(String id) {
        return ON_DEVICE.equals(id) || validComponent(id) ? id : DEFAULT;
    }
}
