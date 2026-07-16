import UIKit

/**
 * The iOS share sheet entry for Quell Feed — the counterpart of
 * android/app/src/main/java/de/quellfeed/ShareActivity.java, and like it built around
 * one idea: sharing an ARTICLE must not drag the whole app onto the screen.
 *
 * This extension runs in its own process, without Capacitor and without the WebView.
 * It takes the shared URL or text, classifies it with the same rules as everywhere
 * else, and then:
 *
 *  - ARTICLE → appended to the `pendingShares` queue in the App Group
 *    `group.de.quellfeed` and confirmed with a small self-drawn pill ("Gespeichert" /
 *    "Saved") over the translucent extension view, which then dismisses itself. iOS
 *    extensions cannot post a system toast, and the SLComposeServiceView compose sheet
 *    would be a form for a share that needs no input — so the pill is the whole UI.
 *    The main app imports the queue on its next foreground (App.vue, appStateChange).
 *
 *  - FEED → stored in `pendingFeedText`, then the extension asks iOS to open
 *    de.quellfeed://share so the app can show the subscribe screen. Opening the host
 *    app from a share extension is NOT official API: `extensionContext.open` is
 *    documented for Today widgets only, and the fallback below — walking the responder
 *    chain to the hosting UIApplication and performing `openURL:` — is the workaround
 *    the community has shipped for years (Bitwarden and friends). Both are tried; both
 *    may fail on future iOS versions; UNVERIFIED here without a device. The design
 *    survives failure: the text is persisted BEFORE the open attempt, so the next
 *    manual app launch still delivers it (ShareIntentPlugin.consume()) — only the
 *    automatic foregrounding is lost.
 *
 * The classifiers deliberately mirror src/utils/shareTarget.js (URL_PATTERN,
 * looksLikeFeedUrl) and ShareActivity.java. Keep all three in step. The App Group
 * suite and key names mirror ios/App/App/ShareIntentPlugin.swift.
 */
class ShareViewController: UIViewController {

    private static let appGroup = "group.de.quellfeed"
    private static let pendingKey = "pendingShares"
    private static let feedKey = "pendingFeedText"

    /// How long the confirmation pill stays before the sheet closes itself.
    private static let confirmSeconds = 0.9

    // ── Lifecycle ────────────────────────────────────────────────────────────

    override func viewDidLoad() {
        super.viewDidLoad()
        // Translucent, so the pill floats over a dimmed host app instead of a blank
        // white sheet nobody asked for.
        view.backgroundColor = UIColor.black.withAlphaComponent(0.2)
        loadSharedText { [weak self] text in
            DispatchQueue.main.async { self?.handleShare(text) }
        }
    }

    private func handleShare(_ text: String?) {
        guard let text = text, let url = ShareViewController.extractUrl(text) else {
            confirmAndClose(localized("Kein Link gefunden", "No link found"))
            return
        }

        let store = UserDefaults(suiteName: ShareViewController.appGroup)

        if ShareViewController.looksLikeFeed(url) {
            // Persist FIRST — the open attempt below is best-effort (see file header).
            store?.set(text, forKey: ShareViewController.feedKey)
            openMainApp()
            // Close quickly; if the app opened, this sheet is already behind it.
            complete(after: 0.4)
            return
        }

        var pending = store?.stringArray(forKey: ShareViewController.pendingKey) ?? []
        pending.append(url)
        store?.set(pending, forKey: ShareViewController.pendingKey)

        confirmAndClose(localized("Gespeichert", "Saved"))
    }

    // ── Reading the shared item ──────────────────────────────────────────────

    /**
     * The share sheet hands over either a URL item or plain text (Safari sends a URL,
     * most apps send "Page title https://…"). Both funnel into one string, which the
     * same regex as everywhere else then mines.
     */
    private func loadSharedText(_ completion: @escaping (String?) -> Void) {
        let attachments = (extensionContext?.inputItems as? [NSExtensionItem])?
            .compactMap { $0.attachments }
            .flatMap { $0 } ?? []

        if let urlProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier("public.url") }) {
            urlProvider.loadItem(forTypeIdentifier: "public.url", options: nil) { item, _ in
                completion((item as? URL)?.absoluteString ?? (item as? String))
            }
            return
        }

        if let textProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier("public.plain-text") }) {
            textProvider.loadItem(forTypeIdentifier: "public.plain-text", options: nil) { item, _ in
                completion(item as? String)
            }
            return
        }

        completion(nil)
    }

    // ── Classification (mirrors shareTarget.js / ShareActivity.java) ─────────

    /// Mirror of extractSharedUrl() in shareTarget.js.
    static func extractUrl(_ text: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: "https?://[^\\s<>\"')\\]]+",
            options: [.caseInsensitive]
        ) else { return nil }

        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let matchRange = Range(match.range, in: text) else { return nil }

        // Trailing punctuation from a sentence the URL was embedded in.
        var url = String(text[matchRange])
        while let last = url.last, ".,;:!?".contains(last) {
            url.removeLast()
        }
        return url.isEmpty ? nil : url
    }

    /// Mirror of looksLikeFeedUrl() in shareTarget.js.
    static func looksLikeFeed(_ url: String) -> Bool {
        guard let components = URLComponents(string: url) else { return false }

        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }

        if path.isEmpty { return true } // bare domain — "I want the whole site"

        let lower = path.lowercased()
        if lower.hasSuffix(".xml") || lower.hasSuffix(".rss") || lower.hasSuffix(".atom") {
            return true
        }
        let lastSegment = lower.split(separator: "/").last.map(String.init) ?? ""
        if ["feed", "feeds", "rss", "atom"].contains(lastSegment) {
            return true
        }

        let query = components.percentEncodedQuery?.lowercased() ?? ""
        return query.hasPrefix("feed=") || query.contains("&feed=")
    }

    // ── Opening the main app (feed links) ────────────────────────────────────

    private func openMainApp() {
        guard let url = URL(string: "de.quellfeed://share") else { return }

        // Attempt 1: the official call — documented for Today widgets, known to be a
        // no-op in share extensions on most iOS versions, but free to try.
        extensionContext?.open(url) { [weak self] opened in
            if !opened {
                DispatchQueue.main.async { self?.openViaResponderChain(url) }
            }
        }
    }

    /// Attempt 2: the long-lived community workaround — find the hosting
    /// UIApplication in the responder chain and perform the pre-iOS-10 `openURL:`.
    private func openViaResponderChain(_ url: URL) {
        let selector = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector), current is UIApplication {
                _ = current.perform(selector, with: url)
                return
            }
            responder = current.next
        }
    }

    // ── Confirmation pill ────────────────────────────────────────────────────

    /// The extension has no access to the app's i18n; two languages are what the app
    /// ships, so two literals are what the pill knows.
    private func localized(_ de: String, _ en: String) -> String {
        return Locale.preferredLanguages.first?.hasPrefix("de") == true ? de : en
    }

    private func confirmAndClose(_ message: String) {
        let pill = UIView()
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        pill.layer.cornerRadius = 18
        pill.translatesAutoresizingMaskIntoConstraints = false

        let label = UILabel()
        label.text = message
        label.textColor = .white
        label.font = UIFont.preferredFont(forTextStyle: .subheadline)
        label.translatesAutoresizingMaskIntoConstraints = false

        pill.addSubview(label)
        view.addSubview(pill)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: pill.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -10),
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -20),
            pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pill.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])

        complete(after: ShareViewController.confirmSeconds)
    }

    private func complete(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }
}
