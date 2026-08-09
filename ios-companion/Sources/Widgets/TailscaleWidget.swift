import SwiftUI
import WidgetKit

/// Tailscale state, with an honest limit stated up front.
///
/// The Android tile *toggles* the tunnel, because Tailscale for Android exports
/// `IPNReceiver` and accepts a CONNECT_VPN broadcast. iOS has no such door: no
/// app may start another app's VPN, and there is no public intent for it. So this
/// tile reports and hands off — the state is read from the system (an address in
/// `100.64.0.0/10` exists only while the tunnel is up, no token and no network
/// round-trip), and tapping opens the Tailscale app so the user flips it there.
struct TailscaleEntry: TimelineEntry {
    let date: Date
    let connected: Bool
    let address: String?
}

struct TailscaleProvider: TimelineProvider {
    func placeholder(in context: Context) -> TailscaleEntry {
        TailscaleEntry(date: Date(), connected: true, address: "100.x.y.z")
    }

    func getSnapshot(in context: Context, completion: @escaping (TailscaleEntry) -> Void) {
        completion(current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TailscaleEntry>) -> Void) {
        completion(Timeline(entries: [current()], policy: .after(Date().addingTimeInterval(15 * 60))))
    }

    private func current() -> TailscaleEntry {
        let address = Tailscale.address()
        return TailscaleEntry(date: Date(), connected: address != nil, address: address)
    }
}

struct TailscaleWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "JarvisTailscale", provider: TailscaleProvider()) { entry in
            TailscaleWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    Color(red: 0.020, green: 0.027, blue: 0.051)
                }
        }
        .configurationDisplayName("Tailscale")
        .description("Si el túnel está arriba. Tócalo para abrir Tailscale.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct TailscaleWidgetView: View {
    let entry: TailscaleEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle()
                    .fill(entry.connected ? Color(red: 0.10, green: 0.85, blue: 0.55) : Color(red: 0.42, green: 0.47, blue: 0.55))
                    .frame(width: 10, height: 10)
                Text("Tailscale")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
            }
            Text(entry.connected ? "Conectado" : "Desconectado")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(entry.connected ? Color(red: 0.10, green: 0.85, blue: 0.55) : .white.opacity(0.6))
            if let address = entry.address {
                Text(address)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.45))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            } else {
                Text("Toca para abrir")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.45))
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(WidgetLink.tailscale)
    }
}
