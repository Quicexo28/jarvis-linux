import Foundation

/// Tailscale state, read from the SYSTEM rather than from Tailscale.
///
/// There is no API to ask the iOS client whether it is up, so the tunnel is
/// inferred exactly as the Android companion does it: an address inside the
/// CGNAT range `100.64.0.0/10` exists on a live interface only while the tunnel
/// is connected. That keeps a widget honest with no round-trip and no token.
///
/// The other half of the Android tile does NOT port: there `IPNReceiver` accepts
/// a CONNECT_VPN broadcast, and iOS has no equivalent — an app cannot start
/// another app's VPN. So the tile reports and hands off; tapping opens Tailscale.
enum Tailscale {

    /// The tailnet IPv4 of this device, or nil when the tunnel is down.
    static func address() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }

        var found: String?
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let ptr = cursor {
            let ifa = ptr.pointee
            cursor = ifa.ifa_next

            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let flags = Int32(ifa.ifa_flags)
            guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0 else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let ok = getnameinfo(
                sa, socklen_t(sa.pointee.sa_len),
                &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST
            )
            guard ok == 0 else { continue }
            let ip = String(cString: host)
            if isCgnat(ip) {
                found = ip
                break
            }
        }
        return found
    }

    static var isConnected: Bool { address() != nil }

    /// `100.64.0.0/10` — the range Tailscale hands out, and nothing else on a
    /// phone uses it. Checked by octet so no extra parsing dependency is needed.
    static func isCgnat(_ ip: String) -> Bool {
        let parts = ip.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 100 && parts[1] >= 64 && parts[1] <= 127
    }

    /// Tailscale registers this scheme; opening it brings the client to the front
    /// so the user can flip the switch themselves.
    static let appUrl = URL(string: "tailscale://")!
}
