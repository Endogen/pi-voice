package com.pivoice.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Non-exported; only our one-shot explicit PendingIntent grants access. A fresh
// nonce prevents an old result from replacing a newer connection attempt.
public final class ResultReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent != null && "com.pivoice.app.RESULT".equals(intent.getAction())) {
            MainActivity.receiveResult(intent);
        }
    }
}
