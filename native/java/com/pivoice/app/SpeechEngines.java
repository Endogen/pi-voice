package com.pivoice.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.provider.Settings;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Speech services and text-to-speech engines installed on the phone, for example
 * a Whisper-based recognizer or a Piper voice engine. The app never downloads or
 * runs models itself; it only lets Android route to what the user installed.
 */
final class SpeechEngines {
    static final String DEFAULT = EngineChoice.DEFAULT, ON_DEVICE = EngineChoice.ON_DEVICE;

    private SpeechEngines() {}

    static String recognizers(Context context) {
        JSONArray list = new JSONArray();
        ComponentName preferred = null;
        try {
            // Not a public setting on every Android version; only used as a label.
            String value = Settings.Secure.getString(context.getContentResolver(), "voice_recognition_service");
            if (value != null) preferred = ComponentName.unflattenFromString(value);
        } catch (RuntimeException ignored) {}
        for (ResolveInfo info : services(context, new Intent(RecognitionService.SERVICE_INTERFACE))) {
            ComponentName component = new ComponentName(info.serviceInfo.packageName, info.serviceInfo.name);
            put(list, component.flattenToString(), label(context, info), component.equals(preferred));
        }
        if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) put(list, ON_DEVICE, "Android on-device recognition", false);
        return list.toString();
    }

    static String synthesizers(Context context) {
        JSONArray list = new JSONArray();
        String preferred = null;
        try { preferred = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.TTS_DEFAULT_SYNTH); }
        catch (RuntimeException ignored) {}
        for (ResolveInfo info : services(context, new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE))) {
            put(list, info.serviceInfo.packageName, label(context, info), info.serviceInfo.packageName.equals(preferred));
        }
        return list.toString();
    }

    static boolean installedRecognizer(Context context, String id) {
        for (ResolveInfo info : services(context, new Intent(RecognitionService.SERVICE_INTERFACE))) {
            if (new ComponentName(info.serviceInfo.packageName, info.serviceInfo.name).flattenToString().equals(id)) return true;
        }
        return false;
    }

    static boolean installedSynthesizer(Context context, String id) {
        for (ResolveInfo info : services(context, new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE))) {
            if (info.serviceInfo.packageName.equals(id)) return true;
        }
        return false;
    }

    private static List<ResolveInfo> services(Context context, Intent intent) {
        try {
            List<ResolveInfo> found = context.getPackageManager().queryIntentServices(intent, PackageManager.MATCH_ALL);
            return found == null ? Collections.<ResolveInfo>emptyList() : found;
        } catch (RuntimeException error) { return Collections.emptyList(); }
    }

    private static String label(Context context, ResolveInfo info) {
        CharSequence text = info.loadLabel(context.getPackageManager());
        String label = text == null ? "" : text.toString().trim();
        if (label.isEmpty()) label = info.serviceInfo.packageName;
        return label.length() > 80 ? label.substring(0, 80) : label;
    }

    private static void put(JSONArray list, String id, String label, boolean preferred) {
        for (int i = 0; i < list.length(); i++) if (id.equals(list.optJSONObject(i).optString("id"))) return;
        try { list.put(new JSONObject().put("id", id).put("label", label).put("default", preferred)); }
        catch (JSONException ignored) {}
    }
}
