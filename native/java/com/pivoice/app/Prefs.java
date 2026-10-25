package com.pivoice.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.UUID;
import org.json.JSONObject;

/** Private app preferences shared by the Activity and the reply receiver. */
final class Prefs {
    static final String TOKEN = "bridgeToken", NOTIFY = "notify", SOUND = "sound", OPEN_KEY = "openKey";
    static final String[] UI_KEYS = { "awake", "language", "engine", "read-language", "notify", "sound", "haptics", "notify-asked", "terminal-warned", "auto-send", "speech-service", "read-engine" };
    static boolean uiKey(String key) {
        for (String allowed : UI_KEYS) if (allowed.equals(key)) return true;
        return false;
    }
    static JSONObject uiValues(Context context) {
        JSONObject values = new JSONObject();
        for (String key : UI_KEYS) {
            SharedPreferences prefs = get(context);
            String value = prefs.getString("ui." + key, null);
            if (value == null && (key.equals(NOTIFY) || key.equals(SOUND)) && prefs.contains(key)) value = String.valueOf(prefs.getBoolean(key, true));
            try { if (value != null) values.put(key, value); } catch (Exception ignored) {}
        }
        return values;
    }
    private Prefs() {}

    static SharedPreferences get(Context context) {
        return context.getSharedPreferences("pi-voice", Context.MODE_PRIVATE);
    }

    /** Random per-install secret that marks notification taps as our own. */
    static synchronized String openKey(Context context) {
        SharedPreferences prefs = get(context);
        String key = prefs.getString(OPEN_KEY, null);
        if (key == null) { key = UUID.randomUUID().toString(); prefs.edit().putString(OPEN_KEY, key).apply(); }
        return key;
    }
}
