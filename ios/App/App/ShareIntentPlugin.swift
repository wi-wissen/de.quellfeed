import Foundation
import Capacitor
import UIKit

/**
 * Receives links shared into Quell Feed from the iOS share sheet — the counterpart of
 * android/app/src/main/java/de/quellfeed/ShareIntentPlugin.java, with the same JS
 * method names, so src/utils/shareTarget.js does not branch beyond its platform check.
 *
 * The share sheet itself is served by the QuellShare extension (ios/App/QuellShare),
 * a separate process that cannot talk to this plugin directly. The handover channel
 * is the App Group `group.de.quellfeed` (UserDefaults(suiteName:)), and the protocol
 * mirrors Android's two delivery paths:
 *
 *  - ARTICLES are appended by the extension to the `pendingShares` array and the app
 *    is NOT opened — the user stays where they were. consumePending() below is how
 *    the web side collects that queue whenever the app is next in the foreground
 *    (App.vue already calls it on every appStateChange).
 *
 *  - FEED-looking links are stored in `pendingFeedText` and the extension then tries
 *    to open the app via de.quellfeed://share, because subscribing needs a screen.
 *    When the app becomes active with a feed text waiting, this plugin fires the same
 *    'shareReceived' event Android fires from handleOnNewIntent, and consume() hands
 *    the text over — CONSUMING it, so a later resume cannot re-deliver it. If opening
 *    the app from the extension fails (see ShareViewController — the mechanism is a
 *    documented-workaround, not API), the text simply waits for the next manual
 *    launch: nothing is lost, only the automatic foregrounding.
 *
 * The suite name and both keys are deliberately mirrored in
 * ios/App/QuellShare/ShareViewController.swift — keep them in step. They are not in a
 * shared source file because the extension must not depend on Capacitor and the pbxproj
 * surgery for cross-target files is exactly the kind of by-hand fragility this repo
 * avoids.
 */
@objc(ShareIntentPlugin)
public class ShareIntentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareIntentPlugin"
    public let jsName = "ShareIntent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "consume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePending", returnType: CAPPluginReturnPromise)
    ]

    static let appGroup = "group.de.quellfeed"
    static let pendingKey = "pendingShares"
    static let feedKey = "pendingFeedText"

    private static let eventReceived = "shareReceived"

    private var observer: NSObjectProtocol?

    override public func load() {
        // A feed share may arrive while the app is merely backgrounded; the extension
        // then foregrounds us and this is the moment to tell JS. Cold starts need no
        // event: listenForSharedLinks() calls consume() once at startup anyway.
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            let store = UserDefaults(suiteName: ShareIntentPlugin.appGroup)
            if store?.string(forKey: ShareIntentPlugin.feedKey) != nil {
                // Retained until consumed — the listener may not be attached yet.
                self.notifyListeners(ShareIntentPlugin.eventReceived, data: [:], retainUntilConsumed: true)
            }
        }
    }

    deinit {
        if let observer = observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// The shared feed text, or null. Reading it consumes it — same contract as Android.
    @objc func consume(_ call: CAPPluginCall) {
        let store = UserDefaults(suiteName: ShareIntentPlugin.appGroup)
        let text = store?.string(forKey: ShareIntentPlugin.feedKey)
        store?.removeObject(forKey: ShareIntentPlugin.feedKey)

        // NSNull, not a bare optional: the bridge serializes it as a JS null, which is
        // what the Android side returns when nothing was shared.
        if let text = text {
            call.resolve(["text": text])
        } else {
            call.resolve(["text": NSNull()])
        }
    }

    /// The queued article URLs, oldest first. Reading them clears the queue.
    @objc func consumePending(_ call: CAPPluginCall) {
        let store = UserDefaults(suiteName: ShareIntentPlugin.appGroup)
        // A damaged queue (wrong type) comes back empty rather than crashing every
        // resume from then on — the same recovery Android chose for broken JSON.
        let urls = store?.stringArray(forKey: ShareIntentPlugin.pendingKey) ?? []
        store?.removeObject(forKey: ShareIntentPlugin.pendingKey)

        call.resolve(["urls": urls])
    }
}
