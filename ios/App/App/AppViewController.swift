import UIKit
import Capacitor

/**
 * Registers the app's hand-written plugins with the Capacitor bridge.
 *
 * Why this subclass exists — VERIFIED against @capacitor/ios 6 (CapacitorBridge.swift,
 * registerPlugins()): Capacitor 6 does NOT discover plugins by scanning the ObjC
 * runtime anymore. It loads exactly the classes listed in `packageClassList` inside
 * the bundled capacitor.config.json — a list `npx cap sync` REGENERATES from the
 * installed npm plugins on every run, which would silently drop any local class added
 * there by hand. The CAP_PLUGIN ObjC macro alone therefore no longer registers
 * anything either; it only provides the CAPBridgedPlugin conformance that our Swift
 * classes declare directly. The supported way for app-local plugins is this:
 * capacitorDidLoad() + registerPluginInstance(), wired up via Main.storyboard's
 * customClass.
 *
 * The Android equivalent is MainActivity.registerPlugin(...) — same idea, same moment.
 */
class AppViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShareIntentPlugin())
        bridge?.registerPluginInstance(MediaControlPlugin())
    }
}
