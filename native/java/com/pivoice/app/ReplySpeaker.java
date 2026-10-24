package com.pivoice.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Handler;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.List;
import java.util.Locale;

/** Foreground-only TTS; the Activity checks trusted-page/user-facing state. */
final class ReplySpeaker {
    interface Events { void emit(String id, String kind, String detail); }
    private final Context context;
    private final Handler handler;
    private final Events events;
    private final AudioManager audio;
    private final AudioAttributes attributes;
    private final AudioFocusRequest focus;
    private TextToSpeech engine;
    private boolean ready, disposed, focusHeld;
    private int generation;
    private String id, text, language, lastUtterance;
    private Runnable timeout;

    ReplySpeaker(Context context, Handler handler, Events events) {
        this.context = context.getApplicationContext(); this.handler = handler; this.events = events;
        audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attributes).setOnAudioFocusChangeListener(change -> { if (change < 0) fail("interrupted"); }, handler).build();
    }

    void speak(String request, String value, String locale) {
        stop();
        if (disposed) return;
        if (request == null || !request.matches("[a-fA-F0-9-]{36}") || value == null || value.trim().isEmpty() || value.length() > 32000) {
            if (request != null) events.emit(request, "error", "text-limit");
            return;
        }
        id = request; text = value;
        language = locale != null && locale.matches("[a-zA-Z0-9-]{2,35}") ? locale : "en-US";
        if (engine != null && ready) { begin(); return; }
        watchdog(request, 15000);
        if (engine != null) return; // Initialization is already in flight.
        final int attempt = ++generation;
        try {
            // Post even an immediate failure: the constructor may invoke onInit
            // before the engine field has been assigned.
            engine = new TextToSpeech(context, status -> handler.post(() -> {
                if (disposed || generation != attempt) return;
                ready = status == TextToSpeech.SUCCESS;
                if (!ready) { fail("unavailable"); closeEngine(); return; }
                engine.setAudioAttributes(attributes);
                engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utterance) { handler.post(() -> {
                        if (owns(utterance)) { watchdog(id, 180000); events.emit(id, "progress", ""); }
                    }); }
                    @Override public void onDone(String utterance) { handler.post(() -> {
                        if (owns(utterance) && utterance.equals(lastUtterance)) stop();
                    }); }
                    @Override public void onError(String utterance) { handler.post(() -> {
                        if (owns(utterance)) { fail("unavailable"); closeEngine(); }
                    }); }
                });
                begin();
            }));
        } catch (RuntimeException error) { fail("unavailable"); closeEngine(); }
    }

    private boolean owns(String utterance) { return id != null && utterance != null && utterance.startsWith(id + "/"); }

    private void begin() {
        if (id == null || !ready || engine == null || disposed) return;
        try {
            int available = engine.setLanguage(Locale.forLanguageTag(language));
            if (available < 0) { fail("language"); return; }
            if (audio == null || audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { fail("audio-busy"); return; }
            focusHeld = true;
            List<String> parts = SpeechText.chunks(text, Math.min(1000, TextToSpeech.getMaxSpeechInputLength()));
            lastUtterance = id + "/" + (parts.size() - 1);
            watchdog(id, 180000);
            events.emit(id, "start", "");
            for (int i = 0; i < parts.size(); i++) {
                if (engine.speak(parts.get(i), i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, null, id + "/" + i) == TextToSpeech.ERROR) {
                    fail("unavailable"); closeEngine(); return;
                }
            }
        } catch (RuntimeException error) { fail("unavailable"); closeEngine(); }
    }

    private void watchdog(String request, long delay) {
        if (timeout != null) handler.removeCallbacks(timeout);
        timeout = () -> { if (request.equals(id)) { fail("unavailable"); closeEngine(); } };
        handler.postDelayed(timeout, delay);
    }

    void stop(String request) { if (request != null && request.equals(id)) stop(); }
    void stop() { finish(null); }
    private void fail(String code) { finish(code); }
    private void finish(String error) {
        String previous = id;
        id = null; text = null; language = null; lastUtterance = null;
        if (timeout != null) handler.removeCallbacks(timeout);
        timeout = null;
        try { if (engine != null) engine.stop(); } catch (RuntimeException ignored) {}
        try { if (focusHeld && audio != null) audio.abandonAudioFocusRequest(focus); } catch (RuntimeException ignored) {}
        focusHeld = false;
        if (previous != null) {
            if (error != null) events.emit(previous, "error", error);
            events.emit(previous, "end", "");
        }
    }
    private void closeEngine() {
        generation++; ready = false;
        TextToSpeech previous = engine; engine = null;
        if (previous != null) { try { previous.shutdown(); } catch (RuntimeException ignored) {} }
    }
    void shutdown() { disposed = true; stop(); closeEngine(); }
}
