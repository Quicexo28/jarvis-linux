import AppIntents
import SwiftUI
import WidgetKit

/// The Jarvis tile: the hologram, plus whether the laptop is answering.
///
/// Tapping it does NOT open the app's web view — it opens the voice overlay, the
/// same choice the Android widget makes. The point of a home-screen Jarvis is to
/// talk to him in one tap; the full GUI is one more tap away from there.
struct HoloEntry: TimelineEntry {
    let date: Date
    let online: Bool
    let configured: Bool
}

struct HoloProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> HoloEntry {
        HoloEntry(date: Date(), online: true, configured: true)
    }

    func snapshot(for configuration: JarvisWidgetConfig, in context: Context) async -> HoloEntry {
        await entry(for: configuration)
    }

    func timeline(for configuration: JarvisWidgetConfig, in context: Context) async -> Timeline<HoloEntry> {
        let entry = await entry(for: configuration)
        // Widget refreshes are budgeted by iOS; asking for 15 minutes is asking
        // for the most it will realistically grant without wasting the budget.
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60)))
    }

    private func entry(for configuration: JarvisWidgetConfig) async -> HoloEntry {
        guard let api = configuration.api else {
            return HoloEntry(date: Date(), online: false, configured: false)
        }
        // `/health` is public, so this asks about the laptop and never about the
        // token — which is exactly the question the tile is answering.
        let online = await api.health(timeout: 6)
        return HoloEntry(date: Date(), online: online, configured: true)
    }
}

struct HoloWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "JarvisHolo",
            intent: JarvisWidgetConfig.self,
            provider: HoloProvider()
        ) { entry in
            HoloWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(
                        colors: [Color(red: 0.055, green: 0.086, blue: 0.125),
                                 Color(red: 0.020, green: 0.027, blue: 0.051)],
                        startPoint: .top, endPoint: .bottom
                    )
                }
        }
        .configurationDisplayName("Jarvis")
        .description("Holograma con el estado del portátil. Tócalo para hablar.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct HoloWidgetView: View {
    let entry: HoloEntry

    var body: some View {
        HoloDisc(
            state: entry.configured ? (entry.online ? .online : .offline) : .offline,
            phase: 0.12,
            level: 0,
            label: "JARVIS",
            caption: caption,
            card: false
        )
        .widgetURL(entry.configured ? WidgetLink.voice : WidgetLink.settings)
    }

    private var caption: String {
        if !entry.configured { return "sin emparejar" }
        return entry.online ? "en línea" : "sin conexión"
    }
}
