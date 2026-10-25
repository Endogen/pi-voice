package com.pivoice.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

// Exported so the extension in Termux can reach it with an explicit broadcast.
// Every broadcast must carry a fresh HMAC made with this app's bridge token.
public final class ReplyReceiver extends BroadcastReceiver {
    static final String ACTION = "com.pivoice.app.REPLY";
    static final String CHANNEL = "replies", SILENT_CHANNEL = "replies-silent";

    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        SharedPreferences prefs = Prefs.get(context);
        int pid = intent.getIntExtra("pid", 0);
        long time = intent.getLongExtra("time", 0);
        String title = intent.getStringExtra("title"), text = intent.getStringExtra("text");
        if (!ReplyAlerts.verify(prefs.getString(Prefs.TOKEN, null), intent.getStringExtra("signature"), pid, time, title, text, System.currentTimeMillis())) return;
        // While the app is open the page plays its own chime and haptics.
        if (MainActivity.inForeground() || !prefs.getBoolean(Prefs.NOTIFY, true)) return;
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        ensureChannels(manager);
        String channel = prefs.getBoolean(Prefs.SOUND, true) ? CHANNEL : SILENT_CHANNEL;
        Intent open = new Intent(context, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .putExtra(MainActivity.EXTRA_PID, pid).putExtra(MainActivity.EXTRA_OPEN_KEY, Prefs.openKey(context))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(context, pid, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification hidden = new Notification.Builder(context, channel).setSmallIcon(R.drawable.notify).setContentTitle("Pi replied").build();
        String heading = title.isEmpty() ? "Pi replied" : title;
        Notification notification = new Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.notify).setColor(0xFF93B4FF)
            .setContentTitle(heading).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(hidden)
            .setAutoCancel(true).setContentIntent(tap).setWhen(time).setShowWhen(true)
            .build();
        // One notification per session: a newer reply replaces the older one.
        manager.notify(pid, notification);
    }

    static void ensureChannels(NotificationManager manager) {
        NotificationChannel replies = new NotificationChannel(CHANNEL, "Replies", NotificationManager.IMPORTANCE_DEFAULT);
        replies.setDescription("When Pi finishes a reply while Pi Voice is in the background.");
        NotificationChannel silent = new NotificationChannel(SILENT_CHANNEL, "Replies (silent)", NotificationManager.IMPORTANCE_LOW);
        silent.setDescription("Reply notifications without sound, used when Sound is off in Pi Voice.");
        manager.createNotificationChannel(replies);
        manager.createNotificationChannel(silent);
    }
}
