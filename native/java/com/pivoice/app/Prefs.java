package com.pivoice.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.UUID;

/** Private app preferences shared by the Activity and the reply receiver. */
final class Prefs {
    static final String TOKEN = "bridgeToken", NOTIFY = "notify", SOUND = "sound", OPEN_KEY = "openKey";
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
