package de.quellfeed;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The system media card for the read-aloud player: pull down the status bar (or look at
 * the lock screen) and there is the article with play/pause, next/previous paragraph and
 * stop — the way every audio app on the platform does it.
 *
 * Written by hand for the same reason as ShareIntentPlugin: the web-standard route
 * (navigator.mediaSession over a silent looping <audio>) produces NOTHING inside a
 * Capacitor WebView on real devices. Android shows media controls for an app that owns a
 * {@link MediaSessionCompat} and posts a {@link androidx.media.app.NotificationCompat.MediaStyle}
 * notification tied to it — but the audio that is actually playing here belongs to the
 * TTS *engine's* process, so no session ever appears on our behalf. This plugin creates
 * both by hand and lets JS drive them.
 *
 * Two command paths lead back to JS, both funnelled into one 'mediaAction' event:
 *
 *   • the notification's buttons — PendingIntents onto a runtime-registered, unexported
 *     BroadcastReceiver (a manifest receiver is not needed for our own notification),
 *   • the MediaSession callback — what the lock screen, Bluetooth buttons and headsets
 *     talk to.
 *
 * Android 13+ gates notifications behind the runtime permission POST_NOTIFICATIONS.
 * requestNotificationPermission() asks once, from JS, on the first play. A refusal is a
 * quiet degradation: the session is still created (headset buttons keep working), only
 * the visible card is skipped — reading aloud itself never depends on any of this.
 *
 * Honest limitation, not solved here: this is a plain notification, NOT a foreground
 * service. The read-aloud queue lives in JS inside the WebView, and Android may pause
 * that WebView (and with it the queue) when the app leaves the foreground. The card then
 * still shows, but the buttons only take effect again once the WebView runs. Doing better
 * means a MediaSessionService owning playback natively — a much bigger rebuild.
 */
@CapacitorPlugin(
    name = "MediaControl",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = MediaControlPlugin.NOTIFICATIONS)
)
public class MediaControlPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";

    private static final String EVENT_ACTION = "mediaAction";
    private static final String CHANNEL_ID = "quell_read_aloud";
    private static final int NOTIFICATION_ID = 41;

    /** App-private broadcast the notification buttons fire; EXTRA carries which one. */
    private static final String ACTION_BROADCAST = "de.quellfeed.MEDIA_CONTROL";
    private static final String EXTRA_CONTROL = "control";

    private MediaSessionCompat session;
    private BroadcastReceiver buttonReceiver;

    private String title = "";
    private String source = "";
    private boolean playing = false;
    private boolean shown = false;

    /** The article's cover image — album art on the card, like every music app. */
    private android.graphics.Bitmap artwork;
    private String artworkUrl = "";

    /** Button/channel labels, sent along by JS so the card speaks the app's language. */
    private String labelPlay = "Play";
    private String labelPause = "Pause";
    private String labelStop = "Stop";
    private String labelNext = "Next";
    private String labelPrevious = "Previous";
    private String labelChannel = "Read aloud";

    // ── JS API ───────────────────────────────────────────────────────────────

    /** Creates (or refreshes) the media card. {title, source, playing, imageUrl?, labels?} */
    @PluginMethod
    public void show(PluginCall call) {
        title = call.getString("title", "");
        source = call.getString("source", "");
        playing = Boolean.TRUE.equals(call.getBoolean("playing", true));
        readLabels(call.getObject("labels", new JSObject()));

        String imageUrl = call.getString("imageUrl", "");
        if (!imageUrl.equals(artworkUrl)) {
            artworkUrl = imageUrl;
            artwork = null; // stale cover must not survive an article change
            if (!imageUrl.isEmpty()) loadArtwork(imageUrl);
        }

        getActivity().runOnUiThread(() -> {
            shown = true;
            ensureSession();
            render();
            call.resolve();
        });
    }

    /**
     * Fetches the cover off the main thread and re-renders when it arrives. The card is
     * shown immediately without it — a slow image must never delay the controls — and
     * every failure just means "no art", never an error.
     */
    private void loadArtwork(String url) {
        new Thread(() -> {
            android.graphics.Bitmap loaded = fetchBitmap(url);
            if (loaded == null || !url.equals(artworkUrl)) return; // failed, or superseded

            artwork = loaded;
            getActivity().runOnUiThread(() -> {
                if (shown && session != null) render();
            });
        }, "quell-artwork").start();
    }

    private android.graphics.Bitmap fetchBitmap(String url) {
        java.net.HttpURLConnection connection = null;
        try {
            connection = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setInstanceFollowRedirects(true);

            byte[] bytes;
            try (java.io.InputStream in = connection.getInputStream();
                 java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                // 5 MB cap: a cover any larger is a mistake, not a cover.
                while ((read = in.read(buffer)) != -1 && out.size() < 5 * 1024 * 1024) {
                    out.write(buffer, 0, read);
                }
                bytes = out.toByteArray();
            }

            // Two-pass decode: bounds first, then downsample to card size — decoding a
            // full-resolution hero image just to show 512px would waste real memory.
            android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);

            android.graphics.BitmapFactory.Options options = new android.graphics.BitmapFactory.Options();
            options.inSampleSize = 1;
            while (bounds.outWidth / (options.inSampleSize * 2) >= 512
                && bounds.outHeight / (options.inSampleSize * 2) >= 512) {
                options.inSampleSize *= 2;
            }
            return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Flips the card between playing and paused. {playing} */
    @PluginMethod
    public void update(PluginCall call) {
        Boolean nowPlaying = call.getBoolean("playing");
        if (nowPlaying != null) playing = nowPlaying;

        getActivity().runOnUiThread(() -> {
            if (shown) render();
            call.resolve();
        });
    }

    /** Takes the card down and releases the session. */
    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            teardown();
            call.resolve();
        });
    }

    /**
     * Asks for POST_NOTIFICATIONS where that is a runtime permission (Android 13+).
     * Resolves {granted: boolean} either way — the caller degrades, it never nags.
     */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (hasNotificationPermission()) {
            resolveGranted(call, true);
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        resolveGranted(call, hasNotificationPermission());
    }

    // ── Session and buttons ──────────────────────────────────────────────────

    private void ensureSession() {
        if (session != null) return;
        Context context = getContext();

        session = new MediaSessionCompat(context, "QuellReadAloud");
        session.setCallback(new MediaSessionCompat.Callback() {
            // The lock screen and headset path. Deliberately NOT toggling any state
            // here: JS owns the player, decides what "play" means right now, and
            // reports back through update() — a single source of truth.
            @Override public void onPlay() { emit("play"); }
            @Override public void onPause() { emit("pause"); }
            @Override public void onStop() { emit("stop"); }
            @Override public void onSkipToNext() { emit("next"); }
            @Override public void onSkipToPrevious() { emit("previous"); }
        });
        session.setActive(true);

        buttonReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                String control = intent.getStringExtra(EXTRA_CONTROL);
                if (control != null) emit(control);
            }
        };
        // NOT_EXPORTED: only PendingIntents created by this app may fire it.
        ContextCompat.registerReceiver(context, buttonReceiver, new IntentFilter(ACTION_BROADCAST), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private void emit(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        notifyListeners(EVENT_ACTION, data);
    }

    private PendingIntent buttonIntent(String control, int requestCode) {
        Intent intent = new Intent(ACTION_BROADCAST)
            .setPackage(getContext().getPackageName())
            .putExtra(EXTRA_CONTROL, control);
        // One requestCode per button — same code would collapse them into one intent.
        return PendingIntent.getBroadcast(getContext(), requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ── The card itself ──────────────────────────────────────────────────────

    private void render() {
        updateSessionState();
        postNotification();
    }

    private void updateSessionState() {
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, source);
        if (artwork != null) {
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        }
        session.setMetadata(metadata.build());

        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_STOP
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;

        session.setPlaybackState(
            new PlaybackStateCompat.Builder()
                .setActions(actions)
                // Position is unknown by nature — TTS has no timeline — so the state
                // carries none and the card shows no seek bar.
                .setState(
                    playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                    PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                    playing ? 1.0f : 0f
                )
                .build()
        );
    }

    @SuppressLint("MissingPermission") // guarded by hasNotificationPermission()
    private void postNotification() {
        Context context = getContext();
        if (!hasNotificationPermission()) return; // no permission — no card, no nagging

        ensureChannel(context);

        // Tapping the card body brings the app (and with it the article) back up.
        // singleTask in the manifest makes this a plain "come to front".
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(context, 10, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Action toggle = playing
            ? new NotificationCompat.Action(android.R.drawable.ic_media_pause, labelPause, buttonIntent("pause", 1))
            : new NotificationCompat.Action(android.R.drawable.ic_media_play, labelPlay, buttonIntent("play", 1));

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            // The themed-icon glyph doubles as the status bar icon: it is the one
            // monochrome vector the app already ships.
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(title)
            .setContentText(source)
            .setLargeIcon(artwork) // null is fine: the card simply has no cover
            .setContentIntent(content)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC) // the lock screen is the point
            .setSilent(true)
            .setShowWhen(false)
            .setOngoing(playing) // paused it may be swiped away; swiping means stop
            .setDeleteIntent(buttonIntent("stop", 4))
            .addAction(new NotificationCompat.Action(android.R.drawable.ic_media_previous, labelPrevious, buttonIntent("previous", 0)))
            .addAction(toggle)
            .addAction(new NotificationCompat.Action(android.R.drawable.ic_media_next, labelNext, buttonIntent("next", 2)))
            .addAction(new NotificationCompat.Action(android.R.drawable.ic_menu_close_clear_cancel, labelStop, buttonIntent("stop", 3)))
            .setStyle(
                new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2)
            );

        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
    }

    private void ensureChannel(Context context) {
        // IMPORTANCE_LOW: visible, but never a sound or a heads-up — it is a remote
        // control, not an alert. Re-creating the channel is how its name follows the
        // app language; everything else about an existing channel is untouched.
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, labelChannel, NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    private void teardown() {
        shown = false;
        NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);

        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        if (buttonReceiver != null) {
            try {
                getContext().unregisterReceiver(buttonReceiver);
            } catch (IllegalArgumentException ignored) {
                // Already unregistered — nothing left to do.
            }
            buttonReceiver = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        // The activity dies — the card must not outlive the player it controls.
        teardown();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return true; // not a runtime permission yet
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void resolveGranted(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private void readLabels(JSObject labels) {
        labelPlay = labels.getString("play", labelPlay);
        labelPause = labels.getString("pause", labelPause);
        labelStop = labels.getString("stop", labelStop);
        labelNext = labels.getString("next", labelNext);
        labelPrevious = labels.getString("previous", labelPrevious);
        labelChannel = labels.getString("channel", labelChannel);
    }
}
