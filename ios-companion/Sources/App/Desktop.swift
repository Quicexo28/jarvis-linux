import UIKit

/// Jumping into Moonlight.
///
/// On Android the desktop tile lands straight on a machine because
/// `com.limelight.ShortcutTrampoline` is exported and takes a `UUID` extra. iOS
/// has no such door: an app can only be reached through a registered URL scheme,
/// and moonlight-ios registers one without a documented host parameter. So the
/// ladder is: try the host-carrying form, fall back to fronting the app, and
/// finally offer the App Store — the same three outcomes the JS bridge already
/// speaks ("launched" | "store" | "error").
enum Desktop {
    private static let scheme = "moonlight"
    private static let storeUrl = URL(string: "https://apps.apple.com/app/moonlight-game-streaming/id1000551566")!

    static var isMoonlightInstalled: Bool {
        guard let url = URL(string: "\(scheme)://") else { return false }
        return UIApplication.shared.canOpenURL(url)
    }

    @discardableResult
    static func openMoonlight(uuid: String?) -> String {
        guard isMoonlightInstalled else {
            UIApplication.shared.open(storeUrl)
            return "store"
        }
        let candidates: [String]
        if let uuid, !uuid.isEmpty {
            candidates = ["\(scheme)://\(uuid)", "\(scheme)://"]
        } else {
            candidates = ["\(scheme)://"]
        }
        for raw in candidates {
            guard let url = URL(string: raw) else { continue }
            UIApplication.shared.open(url)
            return "launched"
        }
        return "error"
    }
}
