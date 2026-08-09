import Foundation

/// The little bits of state the home-screen tiles need but should not go on the
/// network for: whether the laptop answered last time the app talked to it, and
/// the last discovered machine list.
///
/// It writes into `Config.store`, which is the App Group suite when the build is
/// signed by a team that owns one and the app's own defaults otherwise. On the
/// free-Apple-ID path the widget therefore reads nothing here and falls back to
/// its own configuration — see `WidgetSettings`. Nothing crashes either way,
/// which is the point: the same binary has to work under both signing stories.
enum WidgetStatus {
    private static let onlineKey = "widget.backendOnline"
    private static let onlineAtKey = "widget.backendOnlineAt"
    private static let targetsKey = "widget.desktopTargets"

    static func write(backendOnline: Bool) {
        Config.store.set(backendOnline, forKey: onlineKey)
        Config.store.set(Date().timeIntervalSince1970, forKey: onlineAtKey)
    }

    /// Nil when nothing was ever written, or when the reading is too old to mean
    /// anything (the app may not have run in days).
    static func backendOnline(maxAge: TimeInterval = 3600) -> Bool? {
        let at = Config.store.double(forKey: onlineAtKey)
        guard at > 0, Date().timeIntervalSince1970 - at < maxAge else { return nil }
        return Config.store.bool(forKey: onlineKey)
    }

    static func saveTargets(_ targets: [DesktopTarget]) {
        guard let data = try? JSONEncoder().encode(targets) else { return }
        Config.store.set(data, forKey: targetsKey)
    }

    static func targets() -> [DesktopTarget] {
        guard let data = Config.store.data(forKey: targetsKey),
              let list = try? JSONDecoder().decode([DesktopTarget].self, from: data) else { return [] }
        return list
    }
}
