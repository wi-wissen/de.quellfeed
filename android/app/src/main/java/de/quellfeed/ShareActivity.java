package de.quellfeed;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Receives ACTION_SEND so that MainActivity does not have to.
 *
 * Sharing an article used to bring the whole app visibly to the front, save the link,
 * and background itself again — a flash of app the user never asked to see. This
 * activity is the fix: Theme.NoDisplay plus finish() inside onCreate() means Android
 * never draws a single frame of it.
 *
 * An article link is QUEUED (SharedPreferences, see ShareIntentPlugin.PENDING_*) and
 * confirmed with a native toast; the app imports the queue the next time it is actually
 * in the foreground. A link that looks like a FEED still opens the app on the subscribe
 * screen — subscribing is a decision, and a decision needs a screen.
 *
 * The two classifiers below deliberately mirror src/utils/shareTarget.js (URL_PATTERN,
 * looksLikeFeedUrl). Keep them in step: this side decides whether the app opens, the JS
 * side decides what the app does once open.
 */
public class ShareActivity extends Activity {

    private static final Pattern URL_PATTERN =
        Pattern.compile("https?://[^\\s<>\"')\\]]+", Pattern.CASE_INSENSITIVE);

    private static final Pattern FEED_PATH =
        Pattern.compile("(^|/)(feed|feeds|rss|atom)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern FEED_FILE =
        Pattern.compile("\\.(xml|rss|atom)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern FEED_QUERY =
        Pattern.compile("[?&]feed=", Pattern.CASE_INSENSITIVE);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            handleShare(getIntent());
        } finally {
            // Theme.NoDisplay REQUIRES finishing before onResume — not finishing is an
            // AndroidRuntimeException, so this must hold on every path.
            finish();
        }
    }

    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;

        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String url = extractUrl(text);

        if (url == null) {
            toast(getString(R.string.share_no_link));
            return;
        }

        if (looksLikeFeed(url)) {
            Intent open = new Intent(this, MainActivity.class);
            open.setAction(Intent.ACTION_SEND);
            open.setType("text/plain");
            open.putExtra(Intent.EXTRA_TEXT, text);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(open);
            return;
        }

        ShareIntentPlugin.queuePendingShare(getApplicationContext(), url);
        toast(getString(R.string.share_saved));
    }

    private void toast(String text) {
        // Application context, because this activity is gone before the toast fades.
        Toast.makeText(getApplicationContext(), text, Toast.LENGTH_SHORT).show();
    }

    /** Mirror of extractSharedUrl() in shareTarget.js. */
    static String extractUrl(String text) {
        if (text == null) return null;
        Matcher matcher = URL_PATTERN.matcher(text);
        if (!matcher.find()) return null;
        // Trailing punctuation from a sentence the URL was embedded in.
        return matcher.group().replaceAll("[.,;:!?]+$", "");
    }

    /** Mirror of looksLikeFeedUrl() in shareTarget.js. */
    static boolean looksLikeFeed(String url) {
        android.net.Uri uri = android.net.Uri.parse(url);

        String path = uri.getPath() == null ? "" : uri.getPath().replaceAll("/+$", "");
        String query = uri.getEncodedQuery() == null ? "" : "?" + uri.getEncodedQuery();

        if (path.isEmpty()) return true; // bare domain — "I want the whole site"
        if (FEED_FILE.matcher(path).find()) return true;
        if (FEED_PATH.matcher(path).find()) return true;
        return FEED_QUERY.matcher(query).find();
    }
}
