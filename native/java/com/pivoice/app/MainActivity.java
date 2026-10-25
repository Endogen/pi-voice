package com.pivoice.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.lang.ref.WeakReference;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.UUID;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String HOME = "/data/data/com.termux/files/home";
    private static final String PREFIX = "/data/data/com.termux/files/usr";
    private static final String ROOT = HOME + "/pi-voice";
    private static final String RUN_PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final int COMMAND_PERMISSION = 10, MICROPHONE_PERMISSION = 11, FILE_PICKER = 12, NOTIFICATION_PERMISSION = 13;
    static final String EXTRA_HANDLE = "com.pivoice.app.HANDLE", EXTRA_SESSION_ID = "com.pivoice.app.SESSION_ID", EXTRA_OPEN_KEY = "com.pivoice.app.OPEN_KEY";
    private static WeakReference<MainActivity> active = new WeakReference<>(null);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private LinearLayout panel;
    private TextView message;
    private ProgressBar progress;
    private Button retry, appSettings, termux;
    private WebView web;
    private PendingIntent connectionResult;
    private String nonce, connectionUrl;
    private volatile String origin;
    private boolean pageReady, loadFailed, destroyed, resumed;
    private ValueCallback<Uri[]> fileCallback;
    private SpeechRecognizer recognizer;
    private String speechId, speechLanguage;
    private ReplySpeaker replySpeaker;
    private final SessionOpenRequest openRequest = new SessionOpenRequest();
    private int openDeliveryAttempts;

    /** True while the chat is on screen; the page then handles reply alerts itself. */
    static boolean inForeground() {
        MainActivity activity = active.get();
        return activity != null && activity.resumed && !activity.destroyed;
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        active = new WeakReference<>(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        createViews();
        // Saved state, including an already-consumed request, takes precedence
        // over the original launch Intent (which Android may retain for the task).
        if (state != null) openRequest.take(state.getString(EXTRA_HANDLE), state.getString(EXTRA_SESSION_ID), true);
        else takeOpenRequest(getIntent());
        connect();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Never consume commands, paths, URLs or credentials from exported input.
        // The only extra honoured is a session to show, from our own notification.
        takeOpenRequest(intent);
        connect();
    }

    private void takeOpenRequest(Intent intent) {
        String handle = intent == null ? null : intent.getStringExtra(EXTRA_HANDLE);
        String sessionId = intent == null ? null : intent.getStringExtra(EXTRA_SESSION_ID);
        String key = intent == null ? null : intent.getStringExtra(EXTRA_OPEN_KEY);
        // A plain launcher intent must not erase an earlier notification tap.
        if (openRequest.take(handle, sessionId, key != null && key.equals(Prefs.openKey(this)))) openDeliveryAttempts = 0;
    }

    private void openRequestedSession() {
        if (openRequest.handle == null || !resumed || !trustedPage() || panel.getVisibility() != View.GONE || openDeliveryAttempts >= 20) return;
        openDeliveryAttempts++;
        String handle = openRequest.handle, sessionId = openRequest.sessionId;
        String script = "typeof window.__piVoiceOpenSession === 'function' && window.__piVoiceOpenSession("
            + JSONObject.quote(handle) + "," + JSONObject.quote(sessionId == null ? "" : sessionId) + ") === true";
        // Keep the request through WebView pauses, reloads and Activity recreation.
        // Acceptance is not completion: notificationHandled acknowledges the render.
        web.evaluateJavascript(script, accepted -> {
            if (!"true".equals(accepted) && openRequest.matches(handle, sessionId)) {
                handler.postDelayed(this::openRequestedSession, 250);
            }
        });
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString(EXTRA_HANDLE, openRequest.handle);
        state.putString(EXTRA_SESSION_ID, openRequest.sessionId);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void createViews() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17, 24, 39));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return insets;
            });
        } else root.setFitsSystemWindows(true);
        setContentView(root);
        web = new WebView(this);
        replySpeaker = new ReplySpeaker(this, handler, this::emitPlayback);
        web.setSaveEnabled(false);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Only user-picked content:// images.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(false);
        android.webkit.CookieManager.getInstance().setAcceptCookie(false);
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.addJavascriptInterface(new SpeechBridge(), "PiVoiceAndroid");
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new LocalChrome());
        web.setDownloadListener((url, ua, disposition, mime, length) -> Toast.makeText(this, "Downloads are disabled in the native shell.", Toast.LENGTH_SHORT).show());
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(24), dp(28), dp(24));
        panel.setBackgroundColor(Color.rgb(17, 24, 39));
        ImageView icon = new ImageView(this);
        icon.setImageResource(com.pivoice.app.R.drawable.icon);
        panel.addView(icon, new LinearLayout.LayoutParams(dp(96), dp(96)));
        TextView title = new TextView(this);
        title.setText("Pi Voice"); title.setTextSize(28); title.setTextColor(Color.WHITE);
        title.setGravity(Gravity.CENTER); title.setPadding(0, dp(14), 0, dp(18));
        panel.addView(title);
        progress = new ProgressBar(this);
        progress.setIndeterminateTintList(ColorStateList.valueOf(Color.rgb(146, 180, 255)));
        panel.addView(progress, new LinearLayout.LayoutParams(dp(38), dp(38)));
        message = new TextView(this);
        message.setTextColor(Color.rgb(203, 213, 225)); message.setTextSize(16);
        message.setGravity(Gravity.CENTER); message.setPadding(0, dp(20), 0, dp(20));
        panel.addView(message);
        retry = button("Connect", true, () -> connect());
        appSettings = button("App permissions", false, () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        termux = button("Open Termux", false, () -> {
            Intent launch = getPackageManager().getLaunchIntentForPackage("com.termux");
            if (launch != null) startActivity(launch);
        });
        root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    }

    // Pill buttons in the page's colours instead of the platform's default style.
    private Button button(String text, boolean primary, Runnable action) {
        Button button = new Button(this); button.setText(text);
        button.setAllCaps(false); button.setTextSize(15); button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setStateListAnimator(null);
        GradientDrawable shape = new GradientDrawable();
        shape.setCornerRadius(dp(24));
        shape.setColor(primary ? Color.rgb(243, 244, 246) : Color.TRANSPARENT);
        if (!primary) shape.setStroke(dp(1), Color.rgb(55, 65, 81));
        button.setTextColor(primary ? Color.rgb(17, 24, 39) : Color.rgb(243, 244, 246));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Color.argb(48, 147, 180, 255)), shape, null));
        button.setPadding(dp(24), 0, dp(24), 0);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(264), dp(48));
        params.topMargin = dp(10);
        button.setOnClickListener(view -> action.run()); panel.addView(button, params);
        return button;
    }

    private AlertDialog.Builder dialog() {
        return new AlertDialog.Builder(this, com.pivoice.app.R.style.PiDialog);
    }

    private void loading(String text) {
        panel.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
        retry.setVisibility(View.GONE); appSettings.setVisibility(View.GONE); termux.setVisibility(View.GONE);
        message.setText(text);
    }

    private void showError(String text) {
        nonce = null;
        if (connectionResult != null) { connectionResult.cancel(); connectionResult = null; }
        panel.setVisibility(View.VISIBLE); progress.setVisibility(View.GONE);
        retry.setText("Try again"); retry.setVisibility(View.VISIBLE);
        appSettings.setVisibility(View.VISIBLE); termux.setVisibility(View.VISIBLE);
        message.setText(text);
    }

    private void connect() {
        if (destroyed) return;
        cancelSpeech("aborted");
        replySpeaker.stop();
        if (connectionResult != null) connectionResult.cancel();
        nonce = null;
        loading("Connecting to Termux…");
        try { getPackageManager().getPackageInfo("com.termux", 0); }
        catch (PackageManager.NameNotFoundException error) {
            showError("Termux is required. Keep the existing Termux installation and Pi Voice project. Do not uninstall it to install this app."); return;
        }
        if (checkSelfPermission(RUN_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{RUN_PERMISSION}, COMMAND_PERMISSION); return;
        }
        nonce = UUID.randomUUID().toString();
        String attempt = nonce;
        Intent receiver = new Intent(this, ResultReceiver.class).setAction("com.pivoice.app.RESULT").putExtra("nonce", attempt);
        int flags = PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_CANCEL_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        connectionResult = PendingIntent.getBroadcast(this, 0, receiver, flags);
        try {
            // The first task runs the independent host; the short second task
            // returns the connection. Neither asks Termux to open its Activity.
            startService(command(PREFIX + "/bin/bash", new String[]{ROOT + "/native/host.sh"}, null));
            ComponentName started = startService(command(PREFIX + "/bin/node", new String[]{ROOT + "/native/bootstrap.mjs"}, connectionResult));
            if (started == null) throw new IllegalStateException();
            loading("Starting or reconnecting to Pi…\nYour conversation opens here.");
            handler.postDelayed(() -> {
                if (attempt.equals(nonce)) showError("No reply from Termux. Enable allow-external-apps=true in ~/.termux/termux.properties, grant this app ‘Run commands in Termux’, and retry.");
            }, 45000);
        } catch (RuntimeException error) {
            showError("Termux could not start the background command. Grant ‘Run commands in Termux’ in App permissions and enable allow-external-apps=true in Termux, then retry.");
        }
    }

    private Intent command(String path, String[] arguments, PendingIntent result) {
        Intent intent = new Intent("com.termux.RUN_COMMAND");
        intent.setClassName("com.termux", "com.termux.app.RunCommandService");
        intent.putExtra("com.termux.RUN_COMMAND_PATH", path);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arguments);
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND_CUSTOM_LOG_LEVEL", "0");
        intent.putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "Pi Voice native connection");
        if (result != null) intent.putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", result);
        return intent;
    }

    static void receiveResult(Intent intent) {
        MainActivity activity = active.get();
        if (activity == null || activity.destroyed || activity.nonce == null || !activity.nonce.equals(intent.getStringExtra("nonce"))) return;
        activity.nonce = null; activity.connectionResult = null;
        Bundle result = intent.getBundleExtra("result");
        if (result == null || result.getInt("err", -1) != -1 || result.getInt("exitCode", -1) != 0) {
            activity.showError("Termux could not complete the connection task. Check allow-external-apps=true and the native helper files in ~/pi-voice/native/."); return;
        }
        try {
            String output = result.getString("stdout", "");
            if (output.length() > 8192) throw new IllegalArgumentException();
            JSONObject data = new JSONObject(output);
            if (data.has("error")) { activity.showError(data.getString("error")); return; }
            String url = data.getString("url");
            URI parsed = new URI(url);
            if (!"http".equals(parsed.getScheme()) || !"127.0.0.1".equals(parsed.getHost()) || parsed.getPort() < 1 || parsed.getPort() > 65535 || parsed.getUserInfo() != null || !"/".equals(parsed.getRawPath()) || parsed.getRawQuery() != null || parsed.getRawFragment() == null || !parsed.getRawFragment().matches("[a-f0-9]{64}")) throw new IllegalArgumentException();
            String origin = "http://127.0.0.1:" + parsed.getPort();
            if (!url.equals(origin + "/#" + parsed.getRawFragment())) throw new IllegalArgumentException();
            // Lets signed reply broadcasts be verified while the app is closed.
            Prefs.get(activity).edit().putString(Prefs.TOKEN, parsed.getRawFragment()).apply();
            if (url.equals(activity.connectionUrl) && activity.pageReady) { activity.panel.setVisibility(View.GONE); activity.openRequestedSession(); return; }
            activity.openConnection(url, origin);
        } catch (Exception error) { activity.showError("Termux returned an invalid connection. No page was opened. Tap Try again."); }
    }

    // Capture only known UI settings before an origin transition. Never copy
    // credentials or arbitrary storage. Keep an unsent draft/attachments on
    // their current page instead of silently discarding them during upgrade.
    private void openConnection(String url, String nextOrigin) {
        if (trustedPage() && !nextOrigin.equals(origin)) {
            String capture = "JSON.stringify({values:Object.fromEntries(" + new org.json.JSONArray(java.util.Arrays.asList(Prefs.UI_KEYS)).toString()
                + ".map(k=>[k,localStorage.getItem('pi-voice-'+k)])),draft:!!document.getElementById('draft')?.value,images:!document.getElementById('attachments')?.hidden})";
            web.evaluateJavascript(capture, encoded -> {
                try {
                    String raw = new org.json.JSONTokener(encoded).nextValue().toString();
                    JSONObject saved = new JSONObject(raw);
                    JSONObject values = saved.getJSONObject("values");
                    android.content.SharedPreferences.Editor editor = Prefs.get(this).edit();
                    for (String key : Prefs.UI_KEYS) {
                        if (!values.isNull(key)) {
                            String value = values.getString(key);
                            if (value.length() <= 128) editor.putString("ui." + key, value);
                        }
                    }
                    editor.apply();
                    if (saved.optBoolean("draft") || saved.optBoolean("images")) {
                        panel.setVisibility(View.GONE);
                        dialog().setTitle("Keep your draft")
                            .setMessage("Copy or finish your draft and attachments on this page, then tap Reconnect to finish updating Pi Voice.")
                            .setPositiveButton("OK", null).show();
                        return;
                    }
                    loadConnection(url, nextOrigin);
                } catch (Exception error) { showError("Could not preserve page settings. Finish any draft before reopening Pi Voice."); }
            });
        } else loadConnection(url, nextOrigin);
    }

    private void loadConnection(String url, String nextOrigin) {
        if (destroyed) return;
        origin = nextOrigin; connectionUrl = url; pageReady = false; loadFailed = false;
        loading("Opening your local chat…"); web.loadUrl(url);
        handler.postDelayed(() -> {
            if (!destroyed && url.equals(connectionUrl) && !pageReady && !loadFailed) {
                loadFailed = true; web.stopLoading(); showError("The local chat took too long to load. Tap Try again.");
            }
        }, 20000);
    }

    private boolean trusted(Uri url) {
        return origin != null && "http".equals(url.getScheme()) && ("http://" + url.getEncodedAuthority()).equals(origin);
    }

    private boolean trustedPage() {
        return !destroyed && pageReady && web.getUrl() != null && trusted(Uri.parse(web.getUrl()));
    }

    private final class LocalClient extends WebViewClient {
        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            pageReady = false; openDeliveryAttempts = 0;
            replySpeaker.stop();
        }
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (trusted(url) && "/".equals(url.getPath())) return false;
            // External links never inherit our JS bridge or run automatically.
            if (request.isForMainFrame() && request.hasGesture() && ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) && !"127.0.0.1".equals(url.getHost())) {
                // Stays native: page content must not be able to fake leaving the app.
                dialog().setTitle("Open external link?").setMessage(url.getHost() + "\n\nThis leaves Pi Voice and opens your browser.")
                    .setPositiveButton("Open", (dialog, which) -> { try { startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (RuntimeException ignored) {} })
                    .setNegativeButton("Cancel", null).show();
            }
            return true;
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (RequestPolicy.allows(origin, request.getUrl().toString(), request.isForMainFrame())) return null;
            return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
        @Override public void onPageFinished(WebView view, String url) {
            if (!destroyed && !loadFailed && trusted(Uri.parse(url)) && "/".equals(Uri.parse(url).getPath())) {
                pageReady = true; panel.setVisibility(View.GONE);
                web.evaluateJavascript("window.__piVoiceRestorePreferences && window.__piVoiceRestorePreferences(" + Prefs.uiValues(MainActivity.this).toString() + ")", null);
                openRequestedSession();
            }
        }
        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && trusted(request.getUrl())) { loadFailed = true; pageReady = false; showError("The local chat could not load. Tap Try again to reconnect to Pi."); }
        }
        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && trusted(request.getUrl())) { loadFailed = true; pageReady = false; showError("The local chat returned an error. Tap Try again."); }
        }
    }

    private final class LocalChrome extends WebChromeClient {
        @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        @Override public boolean onJsConfirm(WebView view, String url, String text, JsResult result) {
            if (!trustedPage()) { result.cancel(); return true; }
            // Current pages ask with their own dialog; this serves older pages.
            dialog().setTitle("Pi Voice").setMessage(text)
                .setPositiveButton("Continue", (dialog, which) -> result.confirm())
                .setNegativeButton("Cancel", (dialog, which) -> result.cancel())
                .setOnCancelListener(dialog -> result.cancel()).show();
            return true;
        }
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (!trustedPage()) { callback.onReceiveValue(null); return true; }
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
            picker.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/jpeg", "image/png", "image/webp"});
            picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { startActivityForResult(picker, FILE_PICKER); }
            catch (RuntimeException error) { fileCallback.onReceiveValue(null); fileCallback = null; }
            return true;
        }
        @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
            return true; // Do not put chat or credential-bearing messages in logcat.
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != FILE_PICKER || fileCallback == null) return;
        ValueCallback<Uri[]> callback = fileCallback; fileCallback = null;
        ArrayList<Uri> selected = new ArrayList<>();
        if (result == RESULT_OK && data != null && trustedPage()) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() <= 4) {
                for (int i = 0; i < clip.getItemCount(); i++) selected.add(clip.getItemAt(i).getUri());
            } else if (clip == null && data.getData() != null) selected.add(data.getData());
            else Toast.makeText(this, "Choose at most four images.", Toast.LENGTH_SHORT).show();
        }
        for (Uri uri : selected) {
            if (uri == null || !"content".equals(uri.getScheme())) { callback.onReceiveValue(null); return; }
        }
        callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
    }

    // Intentionally no command, URL, token, filesystem or navigation methods.
    // JavaScript gets native speech, haptics, reply-alert preferences and two
    // fixed actions: restart Pi through the normal connection routine, and show
    // Pi's terminal.
    public final class SpeechBridge {
        @JavascriptInterface public void setUiPreference(String key, String value) {
            if (!Prefs.uiKey(key) || value == null || value.length() > 128) return;
            handler.post(() -> { if (trustedPage()) Prefs.get(MainActivity.this).edit().putString("ui." + key, value).apply(); });
        }
        @JavascriptInterface public void speakText(String id, String text, String language) {
            if (id == null || !id.matches("[a-fA-F0-9-]{36}")) return;
            handler.post(() -> {
                if (!trustedPage()) return;
                if (!resumed || !web.hasWindowFocus()) { emitPlayback(id, "error", "interrupted"); return; }
                cancelSpeech("aborted");
                replySpeaker.speak(id, text, language);
            });
        }
        @JavascriptInterface public void stopReading(String id) {
            handler.post(() -> { if (trustedPage()) replySpeaker.stop(id); });
        }
        @JavascriptInterface public void startSpeech(String id, String language) {
            if (id == null || !id.matches("[a-fA-F0-9-]{36}")) return;
            handler.post(() -> {
                if (!trustedPage()) return;
                if (!resumed || !web.hasWindowFocus()) { emitSpeech(id, "error", "aborted"); emitSpeech(id, "end", ""); return; }
                replySpeaker.stop();
                cancelSpeech("aborted"); speechId = id;
                speechLanguage = language != null && language.matches("[a-zA-Z0-9-]{2,35}") ? language : "en-US";
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE_PERMISSION);
                else beginSpeech();
            });
        }
        @JavascriptInterface public void stopSpeech(String id) {
            handler.post(() -> {
                if (!trustedPage() || id == null || !id.equals(speechId)) return;
                if (recognizer != null) {
                    recognizer.stopListening();
                    handler.postDelayed(() -> { if (id.equals(speechId)) cancelSpeech("no-speech"); }, 8000);
                }
            });
        }
        @JavascriptInterface public void abortSpeech(String id) {
            handler.post(() -> { if (trustedPage() && id != null && id.equals(speechId)) cancelSpeech("aborted"); });
        }
        @JavascriptInterface public void haptic(String kind) {
            final int constant = Haptics.constant(kind, Build.VERSION.SDK_INT);
            if (constant < 0) return;
            // Follows Android's touch-feedback setting; needs no permission.
            handler.post(() -> { if (trustedPage() && resumed) web.performHapticFeedback(constant); });
        }
        @JavascriptInterface public void setReplyAlerts(boolean notify, boolean sound, boolean ask) {
            Prefs.get(MainActivity.this).edit().putBoolean(Prefs.NOTIFY, notify).putBoolean(Prefs.SOUND, sound).apply();
            if (!notify || !ask || Build.VERSION.SDK_INT < 33) return;
            handler.post(() -> {
                if (trustedPage() && resumed && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION);
                }
            });
        }
        @JavascriptInterface public String replyAlertStatus() {
            NotificationManager manager = getSystemService(NotificationManager.class);
            boolean allowed = manager != null && manager.areNotificationsEnabled()
                && (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
            return allowed ? "on" : "off";
        }
        @JavascriptInterface public void notificationHandled(String handle, String sessionId, boolean opened) {
            if (!SessionOpenRequest.validHandle(handle) || (sessionId != null && !sessionId.isEmpty() && !SessionOpenRequest.validSessionId(sessionId))) return;
            handler.post(() -> {
                if (!trustedPage() || !resumed || panel.getVisibility() != View.GONE) return;
                if (openRequest.complete(handle, sessionId)) {
                    // Do not replay the original notification after recreation.
                    Intent intent = getIntent();
                    if (intent != null) {
                        intent.removeExtra(EXTRA_HANDLE); intent.removeExtra(EXTRA_SESSION_ID); intent.removeExtra(EXTRA_OPEN_KEY);
                    }
                }
                if (opened) {
                    NotificationManager notifications = getSystemService(NotificationManager.class);
                    if (notifications != null) notifications.cancel(SessionOpenRequest.tag(handle, sessionId), 0);
                }
            });
        }
        @JavascriptInterface public void reconnect() {
            // Same as tapping the app icon: start or resume Pi via Termux. No
            // arguments: what to resume comes from Pi's private state only.
            handler.post(() -> {
                if (!trustedPage() || !resumed || nonce != null) return;
                connect();
            });
        }
        @JavascriptInterface public void openTerminal(String session) {
            final String name = TerminalTarget.session(session);
            if (name == null) return;
            handler.post(() -> {
                if (!trustedPage() || !resumed || !web.hasWindowFocus()) return;
                cancelSpeech("aborted");
                replySpeaker.stop();
                if (!name.isEmpty()) {
                    // Show the tab attached to THIS Pi, not Termux's existing
                    // tab. SESSION_ACTION is a String: 0 selects the new session
                    // and opens the Activity; 1 would keep the old tab selected.
                    // Also bring Termux forward from our foreground Activity
                    // (Android may block a background service opening it).
                    Intent attach = command(PREFIX + "/bin/tmux", TerminalTarget.attachArguments(name), null);
                    attach.putExtra("com.termux.RUN_COMMAND_BACKGROUND", false);
                    attach.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
                    attach.putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "Pi terminal");
                    try { startService(attach); }
                    catch (RuntimeException error) { Toast.makeText(MainActivity.this, "Termux could not open Pi's terminal. Check ‘Run commands in Termux’.", Toast.LENGTH_LONG).show(); return; }
                }
                Intent launch = getPackageManager().getLaunchIntentForPackage("com.termux");
                if (launch == null) { Toast.makeText(MainActivity.this, "Termux is not installed.", Toast.LENGTH_SHORT).show(); return; }
                try { startActivity(launch); } catch (RuntimeException ignored) {}
            });
        }
    }

    private void emitPlayback(String id, String kind, String detail) {
        if (!trustedPage()) return;
        String script = "window.__piVoiceNativePlayback && window.__piVoiceNativePlayback(" + JSONObject.quote(id) + "," + JSONObject.quote(kind) + "," + JSONObject.quote(detail == null ? "" : detail) + ")";
        web.evaluateJavascript(script, null);
    }

    private void emitSpeech(String id, String kind, String text) {
        if (!trustedPage()) return;
        String script = "window.__piVoiceNativeSpeech && window.__piVoiceNativeSpeech(" + JSONObject.quote(id) + "," + JSONObject.quote(kind) + "," + JSONObject.quote(text == null ? "" : text) + ")";
        web.evaluateJavascript(script, null);
    }

    private void beginSpeech() {
        if (speechId == null || recognizer != null || !resumed) return;
        if (!trustedPage() || !SpeechRecognizer.isRecognitionAvailable(this)) { cancelSpeech("service-not-allowed"); return; }
        final String id = speechId;
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rms) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int type, Bundle params) {}
                @Override public void onError(int error) {
                    if (!id.equals(speechId)) return;
                    String code = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "not-allowed" : error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "no-speech" : error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT ? "network" : error == SpeechRecognizer.ERROR_AUDIO ? "audio-capture" : "service-not-allowed";
                    cancelSpeech(code);
                }
                @Override public void onResults(Bundle results) {
                    if (!id.equals(speechId)) return;
                    emitSpeech(id, "result", firstResult(results)); cancelSpeech(null);
                }
                @Override public void onPartialResults(Bundle results) {
                    if (id.equals(speechId)) emitSpeech(id, "partial", firstResult(results));
                }
            });
            Intent request = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            request.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            request.putExtra(RecognizerIntent.EXTRA_LANGUAGE, speechLanguage);
            request.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            request.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            recognizer.startListening(request);
            handler.postDelayed(() -> { if (id.equals(speechId)) cancelSpeech("no-speech"); }, 60000);
        } catch (RuntimeException error) { cancelSpeech("service-not-allowed"); }
    }

    private String firstResult(Bundle results) {
        ArrayList<String> matches = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return matches == null || matches.isEmpty() ? "" : matches.get(0);
    }

    private void cancelSpeech(String error) {
        if (speechId == null) return;
        String id = speechId; speechId = null;
        SpeechRecognizer previous = recognizer; recognizer = null;
        if (previous != null) { previous.cancel(); previous.destroy(); }
        if (error != null) emitSpeech(id, "error", error);
        emitSpeech(id, "end", "");
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        boolean granted = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
        if (request == COMMAND_PERMISSION) {
            if (granted) connect();
            else showError("Allow ‘Run commands in Termux’ in this app’s permissions, then tap Try again. This is a broad permission; grant it only to an app you trust.");
        } else if (request == MICROPHONE_PERMISSION) {
            if (granted) beginSpeech(); else cancelSpeech("not-allowed");
        } else if (request == NOTIFICATION_PERMISSION && trustedPage()) {
            web.evaluateJavascript("window.__piVoiceAlerts && window.__piVoiceAlerts()", null);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true; web.onResume(); web.resumeTimers();
        openDeliveryAttempts = 0;
        // A notification is retired only when its conversation is actually shown.
        // Other sessions' notifications must remain independently tappable.
        openRequestedSession();
        // Permission results can arrive before the Activity regains foreground.
        if (speechId != null && recognizer == null && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) beginSpeech();
    }

    @Override protected void onPause() {
        resumed = false;
        // Never auto-send speech interrupted by switching apps or picking a file.
        if (recognizer != null) cancelSpeech("aborted");
        replySpeaker.stop();
        web.onPause(); web.pauseTimers();
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (trustedPage()) {
            // Let a web dialog close first; otherwise leave the app, not its Pi.
            web.evaluateJavascript("(function(){var d=document.querySelector('dialog[open]');if(d){d.close();return true;}return false;})()", value -> {
                if (!"true".equals(value)) MainActivity.super.onBackPressed();
            });
        } else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        cancelSpeech("aborted");
        replySpeaker.shutdown();
        destroyed = true;
        if (active.get() == this) active.clear();
        if (connectionResult != null) connectionResult.cancel();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        handler.removeCallbacksAndMessages(null);
        web.removeJavascriptInterface("PiVoiceAndroid"); web.stopLoading(); root.removeView(web); web.destroy();
        // Do not kill Pi or remove any launcher/session when the Activity closes.
        super.onDestroy();
    }
}
