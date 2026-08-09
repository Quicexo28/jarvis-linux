import Foundation

/// App configuration: backend base URL, pairing token, reported device name and
/// the reporting interval. Mirrors `Config.kt` in the Android companion so both
/// clients pair the same way — a single paste of the QR link.
///
/// One token does both jobs: it authenticates the WebView against the remote UI
/// and the background reporter against the mobile ingest endpoints (the backend
/// accepts `JARVIS_WEB_TOKEN` on both).
///
/// **Storage is two-tier on purpose.** A widget extension can only read the
/// containing app's defaults through an App Group, and App Groups need a *paid*
/// Apple Developer membership — a free Apple ID cannot provision that
/// entitlement, and SideStore would fail to sign a build that demands it. So the
/// suite is attempted and silently degrades to the app-local store; the widgets
/// carry their own configuration for that case (see `WidgetSettings`).
enum Config {
    /// Effective only once the app is signed with a paid team that owns this group.
    static let appGroup = "group.com.jarvis.companion"

    private static let deviceFallback = "iphone"

    static var store: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    static var baseUrl: String {
        get { normalizeBase(store.string(forKey: "baseUrl") ?? "") }
        set { store.set(normalizeBase(newValue), forKey: "baseUrl") }
    }

    static var token: String {
        get { (store.string(forKey: "token") ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        set { store.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "token") }
    }

    /// Lowercase slug the backend files the readings under. Validated, because it
    /// becomes a key in `mobile-context.json`.
    static var device: String {
        get {
            let raw = (store.string(forKey: "device") ?? deviceFallback)
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            let ok = raw.range(of: "^[a-z0-9_-]{1,24}$", options: .regularExpression) != nil
            return ok ? raw : deviceFallback
        }
        set { store.set(newValue, forKey: "device") }
    }

    static var intervalMin: Int {
        get {
            let v = store.object(forKey: "intervalMin") as? Int ?? 15
            return min(max(v, 1), 240)
        }
        set { store.set(min(max(newValue, 1), 240), forKey: "intervalMin") }
    }

    /// Whether the user opted into background reporting at all.
    static var reporterEnabled: Bool {
        get { store.object(forKey: "reporterEnabled") as? Bool ?? true }
        set { store.set(newValue, forKey: "reporterEnabled") }
    }

    static var isConfigured: Bool {
        baseUrl.hasPrefix("http") && !token.isEmpty
    }

    /// URL the WebView loads: the remote app, already authenticated.
    static var webUrl: URL? {
        guard isConfigured else { return nil }
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
        return URL(string: "\(baseUrl)/?token=\(encoded)&ui=mobile")
    }

    static func save(baseUrl: String, token: String, device: String, intervalMin: Int) {
        self.baseUrl = baseUrl
        self.token = token
        self.device = device
        self.intervalMin = intervalMin
    }

    private static func normalizeBase(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// Split a pasted pairing URL into (baseUrl, token). Accepts the QR URL
    /// (`https://host:8443/?token=abc&ui=full`), a bare backend URL, or either
    /// with trailing slashes. Token is nil when the URL carries none.
    static func parsePairing(_ input: String) -> (base: String, token: String?) {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.hasPrefix("http"), let comps = URLComponents(string: raw), let host = comps.host else {
            return (normalizeBase(raw), nil)
        }
        let scheme = comps.scheme ?? "http"
        let port = comps.port.map { ":\($0)" } ?? ""
        let token = comps.queryItems?.first(where: { $0.name == "token" })?.value
        return ("\(scheme)://\(host)\(port)", token)
    }
}
