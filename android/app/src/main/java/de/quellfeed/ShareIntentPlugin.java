package de.quellfeed;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;

/**
 * Receives links shared into Quell Feed from Android's share sheet.
 *
 * Two delivery paths meet here:
 *
 *  - ARTICLES never reach MainActivity at all. ShareActivity (Theme.NoDisplay) takes the
 *    ACTION_SEND, queues the URL into SharedPreferences and shows a native toast — the
 *    app stays wherever it was, invisible. consumePending() below is how the web side
 *    collects that queue whenever the app is next in the foreground.
 *
 *  - FEED-looking links are forwarded to MainActivity as an explicit ACTION_SEND,
 *    because subscribing needs a screen. For those, the original repair still matters:
 *    `BridgeActivity.onNewIntent()` never calls `setIntent()`, so without the override
 *    below every plugin would keep reading the stale launch intent forever.
 *
 * Written by hand instead of using the `send-intent` plugin — its activity model
 * (finish() closes the hosting activity) and its reliance on getIntent() both broke the
 * first build; the details are in the git history of this file.
 *
 * An intent is CONSUMED when read: it is replaced with a plain launcher intent. Without
 * that, every later resume would hand out the same shared link again and re-save it.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

    private static final String EVENT_RECEIVED = "shareReceived";

    private static final String PENDING_STORE = "quell_shares";
    private static final String PENDING_KEY = "pending";

    /**
     * Appends a shared URL to the pending queue. Called by ShareActivity, which lives
     * and dies outside the Capacitor bridge — hence static, with its own context.
     */
    static void queuePendingShare(Context context, String url) {
        SharedPreferences store = context.getSharedPreferences(PENDING_STORE, Context.MODE_PRIVATE);
        JSONArray pending;
        try {
            pending = new JSONArray(store.getString(PENDING_KEY, "[]"));
        } catch (JSONException e) {
            pending = new JSONArray();
        }
        pending.put(url);
        store.edit().putString(PENDING_KEY, pending.toString()).apply();
    }

    /** The queued article URLs, oldest first. Reading them clears the queue. */
    @PluginMethod
    public void consumePending(PluginCall call) {
        SharedPreferences store = getContext().getSharedPreferences(PENDING_STORE, Context.MODE_PRIVATE);

        JSArray urls = new JSArray();
        try {
            JSONArray pending = new JSONArray(store.getString(PENDING_KEY, "[]"));
            for (int i = 0; i < pending.length(); i++) {
                urls.put(pending.getString(i));
            }
        } catch (JSONException e) {
            // A damaged queue is dropped rather than crashing every resume from then on.
        }
        store.edit().remove(PENDING_KEY).apply();

        JSObject result = new JSObject();
        result.put("urls", urls);
        call.resolve(result);
    }

    /** The shared text, or null. Reading it consumes it. */
    @PluginMethod
    public void consume(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", takeSharedText());
        call.resolve(result);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);

        // The repair. Everything downstream — our consume(), any other plugin — reads the
        // activity's intent, and without this it would keep reading the stale one.
        getActivity().setIntent(intent);

        if (isShare(intent)) {
            notifyListeners(EVENT_RECEIVED, new JSObject(), true);
        }
    }

    private String takeSharedText() {
        Intent intent = getActivity().getIntent();
        if (!isShare(intent)) return null;

        String text = intent.getStringExtra(Intent.EXTRA_TEXT);

        Intent consumed = new Intent(Intent.ACTION_MAIN);
        consumed.addCategory(Intent.CATEGORY_LAUNCHER);
        getActivity().setIntent(consumed);

        return text;
    }

    private boolean isShare(Intent intent) {
        return intent != null
            && Intent.ACTION_SEND.equals(intent.getAction())
            && "text/plain".equals(intent.getType());
    }
}
