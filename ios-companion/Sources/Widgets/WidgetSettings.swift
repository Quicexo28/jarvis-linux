import AppIntents
import Foundation

/// Per-widget pairing, and the reason it exists.
///
/// A widget extension is a separate process: the only way it can read the app's
/// token is through an App Group container, and App Groups require a **paid**
/// Apple Developer membership — a free Apple ID cannot provision that
/// entitlement, and a build that demanded it would fail to sign in SideStore.
///
/// So the resolution order is: use the shared store when it actually is shared
/// (paid team, App Group in the entitlements), otherwise fall back to what the
/// user pasted into this widget's own configuration (long-press → Editar widget).
/// The day the project moves to a paid account, the field simply stops being
/// necessary and nothing else changes.
struct JarvisWidgetConfig: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Jarvis"
    static var description = IntentDescription(
        "Si el widget aparece sin datos, pega aquí el mismo enlace del QR que usaste en la app."
    )

    @Parameter(title: "Enlace de emparejamiento")
    var pairing: String?

    init() {}

    init(pairing: String?) {
        self.pairing = pairing
    }
}

extension JarvisWidgetConfig {
    /// Credentials this widget should talk to the backend with, or nil when it
    /// has none and should render its "configure me" face.
    var api: JarvisApi? {
        if Config.isConfigured {
            return JarvisApi.shared
        }
        guard let pairing, !pairing.isEmpty else { return nil }
        let parsed = Config.parsePairing(pairing)
        guard parsed.base.hasPrefix("http") else { return nil }
        return JarvisApi(base: parsed.base, token: parsed.token ?? "")
    }
}

/// Deep links back into the app. A widget cannot run app code — it can only open
/// a URL, and iOS delivers it to the containing app.
enum WidgetLink {
    static let voice = URL(string: "jarvis://voice")!
    static let tailscale = URL(string: "jarvis://tailscale")!
    static let settings = URL(string: "jarvis://settings")!

    static func desktop(_ target: DesktopTarget) -> URL {
        var comps = URLComponents()
        comps.scheme = "jarvis"
        comps.host = "desktop"
        comps.queryItems = [URLQueryItem(name: "host", value: target.host)]
        if let uuid = target.uuid {
            comps.queryItems?.append(URLQueryItem(name: "uuid", value: uuid))
        }
        return comps.url ?? voice
    }
}
