import Foundation

/// A machine that can stream its desktop, as discovered by the backend.
///
/// The list is discovered, never configured: `/api/skills/desktop/remote` probes
/// the tailnet for Sunshine hosts and reports each one's `uniqueid`, so a machine
/// woken by Wake-on-LAN shows up on its own. Same contract the Android desktop
/// widget consumes.
struct DesktopTarget: Codable, Hashable, Identifiable {
    let label: String
    let host: String
    let uuid: String?

    var id: String { host.isEmpty ? label : host }

    /// A widget zone is about one launcher cell wide, so "Jarvis Main" would
    /// render as "Jarvis M…". First word only once the full name cannot fit.
    var shortLabel: String {
        label.count <= 9 ? label : String(label.split(separator: " ").first ?? "")
    }
}

enum DesktopHosts {
    /// Zones a widget can hold before the names stop fitting.
    static let maxSlots = 3

    /// Blocking-free fetch of the streamable machines. Returns nil (rather than
    /// an empty list) when the backend could not be reached, so callers can keep
    /// showing the cached names: the laptop being off says nothing about which
    /// machines exist.
    static func fetch(api: JarvisApi) async -> [DesktopTarget]? {
        guard let json = await api.getJSON("/api/skills/desktop/remote", timeout: 8),
              let hosts = json["sunshine"] as? [[String: Any]] else { return nil }

        return hosts.compactMap { entry in
            guard let host = entry["host"] as? String, !host.isEmpty else { return nil }
            let name = (entry["name"] as? String) ?? ""
            let uuid = (entry["uuid"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return DesktopTarget(label: name.isEmpty ? host : name, host: host, uuid: uuid)
        }
    }
}
