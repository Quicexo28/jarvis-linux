import AppIntents
import SwiftUI
import WidgetKit

/// One pill holding EVERY machine that can stream, one tappable zone each.
///
/// Same product call as on Android: not one widget per machine — both of them in
/// the same tile, and no configuration screen, because the list is discovered
/// (`/api/skills/desktop/remote` probes the tailnet for Sunshine hosts and
/// reports each one's `uniqueid`). A machine woken by Wake-on-LAN shows up on its
/// own, and with the laptop off the cached names are still there.
struct DesktopEntry: TimelineEntry {
    let date: Date
    let targets: [DesktopTarget]
    let configured: Bool
}

struct DesktopProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> DesktopEntry {
        DesktopEntry(
            date: Date(),
            targets: [
                DesktopTarget(label: "Jarvis Main", host: "100.0.0.1", uuid: nil),
                DesktopTarget(label: "main", host: "100.0.0.2", uuid: nil),
            ],
            configured: true
        )
    }

    func snapshot(for configuration: JarvisWidgetConfig, in context: Context) async -> DesktopEntry {
        await entry(for: configuration)
    }

    func timeline(for configuration: JarvisWidgetConfig, in context: Context) async -> Timeline<DesktopEntry> {
        let entry = await entry(for: configuration)
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60)))
    }

    private func entry(for configuration: JarvisWidgetConfig) async -> DesktopEntry {
        guard let api = configuration.api else {
            return DesktopEntry(date: Date(), targets: [], configured: false)
        }
        if let fresh = await DesktopHosts.fetch(api: api) {
            let capped = Array(fresh.prefix(DesktopHosts.maxSlots))
            WidgetStatus.saveTargets(capped)
            return DesktopEntry(date: Date(), targets: capped, configured: true)
        }
        // Unreachable laptop says nothing about which machines exist — keep the
        // cached names rather than blanking the tile.
        return DesktopEntry(date: Date(), targets: WidgetStatus.targets(), configured: true)
    }
}

struct DesktopWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "JarvisDesktop",
            intent: JarvisWidgetConfig.self,
            provider: DesktopProvider()
        ) { entry in
            DesktopWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    Color(red: 0.020, green: 0.027, blue: 0.051)
                }
        }
        .configurationDisplayName("Escritorio")
        .description("Una zona por máquina: abre Moonlight en la que toques.")
        .supportedFamilies([.systemMedium])
    }
}

struct DesktopWidgetView: View {
    let entry: DesktopEntry

    var body: some View {
        if !entry.configured {
            unconfigured
        } else if entry.targets.isEmpty {
            Link(destination: WidgetLink.voice) {
                zoneLabel(title: "Escritorio", subtitle: "sin máquinas")
            }
        } else {
            HStack(spacing: 0) {
                ForEach(Array(entry.targets.enumerated()), id: \.element.id) { index, target in
                    if index > 0 {
                        Rectangle()
                            .fill(Color.white.opacity(0.10))
                            .frame(width: 1)
                            .padding(.vertical, 10)
                    }
                    Link(destination: WidgetLink.desktop(target)) {
                        zoneLabel(title: target.shortLabel, subtitle: "Moonlight")
                    }
                }
            }
        }
    }

    private var unconfigured: some View {
        Link(destination: WidgetLink.settings) {
            zoneLabel(title: "Jarvis", subtitle: "sin emparejar")
        }
    }

    private func zoneLabel(title: String, subtitle: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: "display")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(Color(red: 0.00, green: 0.90, blue: 1.00).opacity(0.85))
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(subtitle)
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.45))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }
}
