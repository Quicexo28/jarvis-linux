import AppIntents
import Foundation

/// Siri / Shortcuts entry point.
///
/// This is the closest iOS gets to the Android build's `ACTION_ASSIST` filter:
/// Siri cannot be replaced, but an App Shortcut makes "Oye Siri, hablar con
/// Jarvis" open the voice overlay directly, with no tap and no app switching.
struct TalkToJarvisIntent: AppIntent {
    static var title: LocalizedStringResource = "Hablar con Jarvis"
    static var description = IntentDescription("Abre el holograma y escucha una orden.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        PendingAction.set(.voice)
        return .result()
    }
}

struct JarvisShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToJarvisIntent(),
            phrases: [
                "Hablar con \(.applicationName)",
                "Pregúntale a \(.applicationName)",
                "Oye \(.applicationName)",
            ],
            shortTitle: "Hablar",
            systemImageName: "waveform"
        )
    }
}

/// What the app should do the next time a scene comes up.
///
/// Needed because an intent (and a cold launch from a widget) can run before any
/// view exists; the flag survives that gap, and the URL callback does not have to.
enum PendingAction: String {
    case voice
    case tailscale

    private static let key = "pendingAction"

    static func set(_ action: PendingAction) {
        Config.store.set(action.rawValue, forKey: key)
    }

    /// Reads and clears — an action must fire exactly once.
    static func take() -> PendingAction? {
        guard let raw = Config.store.string(forKey: key) else { return nil }
        Config.store.removeObject(forKey: key)
        return PendingAction(rawValue: raw)
    }
}
