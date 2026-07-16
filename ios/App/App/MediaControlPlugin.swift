import Foundation
import Capacitor
import MediaPlayer

/**
 * The system media card for the read-aloud player — iOS side.
 *
 * Mirror of android/app/src/main/java/de/quellfeed/MediaControlPlugin.java: the same
 * JS API (show/update/hide/requestNotificationPermission) and the same 'mediaAction'
 * event vocabulary (play|pause|stop|next|previous), so src/utils/mediaSession.js does
 * not branch beyond its platform check.
 *
 * On iOS the pieces are MPNowPlayingInfoCenter (what the lock screen and Control
 * Center show) and MPRemoteCommandCenter (the buttons and headset commands coming
 * back). There is no notification and therefore no permission: unlike Android 13+,
 * requestNotificationPermission() resolves {granted: true} unconditionally.
 *
 * HONEST LIMITATION, unverified without a device: iOS only displays Now Playing info
 * for an app whose AVAudioSession is active in the 'playback' category. The audio
 * here is produced by the TTS plugin, which does set category 'playback' (see
 * DEFAULT_CATEGORY in src/utils/speech.js) — but whether the session the TTS plugin
 * owns is enough for OUR Now Playing info to appear on the lock screen can only be
 * confirmed on a real iPhone. Everything degrades quietly if it is not: reading
 * aloud never depends on the card.
 *
 * The Android plugin takes translated button labels; iOS draws its own system
 * controls, so `labels` is accepted and ignored. The optional `imageUrl` (album art
 * on the Android card) is accepted and ignored too, for now: MPMediaItemPropertyArtwork
 * would need an image download + resize here, which nobody can verify without a
 * device — the honest first version shows title and source only.
 */
@objc(MediaControlPlugin)
public class MediaControlPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MediaControlPlugin"
    public let jsName = "MediaControl"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationPermission", returnType: CAPPluginReturnPromise)
    ]

    private static let eventAction = "mediaAction"

    private var title = ""
    private var source = ""
    private var playing = false
    private var shown = false

    /// The registered command handlers, kept so hide() can unhook exactly them.
    private var commandTargets: [(MPRemoteCommand, Any)] = []

    // ── JS API ───────────────────────────────────────────────────────────────

    /// Creates (or refreshes) the Now Playing entry. {title, source, playing, labels?}
    @objc func show(_ call: CAPPluginCall) {
        title = call.getString("title") ?? ""
        source = call.getString("source") ?? ""
        playing = call.getBool("playing") ?? true
        // `labels` intentionally unread — iOS renders system-localized controls.

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            self.shown = true
            self.bindCommands()
            self.render()
            call.resolve()
        }
    }

    /// Flips between playing and paused. {playing}
    @objc func update(_ call: CAPPluginCall) {
        if let nowPlaying = call.getBool("playing") {
            playing = nowPlaying
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            if self.shown { self.render() }
            call.resolve()
        }
    }

    /// Takes the Now Playing entry down and unhooks the remote commands.
    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.teardown()
            call.resolve()
        }
    }

    /**
     * Same method name as Android, where POST_NOTIFICATIONS is a runtime permission.
     * Now Playing needs no permission on iOS, so this resolves granted immediately —
     * the JS caller (mediaSession.js) stays platform-agnostic.
     */
    @objc func requestNotificationPermission(_ call: CAPPluginCall) {
        call.resolve(["granted": true])
    }

    // ── Remote commands ──────────────────────────────────────────────────────

    private func bindCommands() {
        guard commandTargets.isEmpty else { return }
        let center = MPRemoteCommandCenter.shared()

        // Deliberately NOT toggling any state here: JS owns the player, decides what
        // "play" means right now, and reports back through update() — a single source
        // of truth, exactly like the Android MediaSession callback.
        bind(center.playCommand) { "play" }
        bind(center.pauseCommand) { "pause" }
        // Headsets and some surfaces send only a toggle; translate it using the last
        // state JS reported, so the event vocabulary stays play|pause.
        bind(center.togglePlayPauseCommand) { [weak self] in
            (self?.playing ?? false) ? "pause" : "play"
        }
        bind(center.stopCommand) { "stop" }
        bind(center.nextTrackCommand) { "next" }
        bind(center.previousTrackCommand) { "previous" }
    }

    private func bind(_ command: MPRemoteCommand, action: @escaping () -> String) {
        command.isEnabled = true
        let target = command.addTarget { [weak self] _ in
            self?.emit(action())
            return .success
        }
        commandTargets.append((command, target))
    }

    private func emit(_ action: String) {
        notifyListeners(MediaControlPlugin.eventAction, data: ["action": action])
    }

    // ── The card itself ──────────────────────────────────────────────────────

    private func render() {
        let info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: source,
            // TTS has no timeline, so no duration and no elapsed time — iOS then
            // shows no seek bar, mirroring PLAYBACK_POSITION_UNKNOWN on Android.
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0
        ]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    private func teardown() {
        shown = false
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        for (command, target) in commandTargets {
            command.removeTarget(target)
        }
        commandTargets = []
    }
}
