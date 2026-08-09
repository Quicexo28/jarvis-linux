import UIKit

/// Battery readings for the reporter and for the `JarvisNative.battery()` bridge.
///
/// `UIDevice` only reports anything once monitoring is switched on, and it
/// answers `-1` for a beat after that, so callers must tolerate a nil level
/// rather than posting a bogus 0% the first time the app wakes up.
enum Battery {
    static func enableMonitoring() {
        UIDevice.current.isBatteryMonitoringEnabled = true
    }

    /// 0–100, or nil while iOS has not sampled it yet.
    static var level: Int? {
        enableMonitoring()
        let raw = UIDevice.current.batteryLevel
        guard raw >= 0 else { return nil }
        return Int((raw * 100).rounded())
    }

    static var isCharging: Bool {
        enableMonitoring()
        switch UIDevice.current.batteryState {
        case .charging, .full: return true
        default: return false
        }
    }

    /// `{"level":87,"charging":true}` — the exact string the web bridge parses.
    static func snapshotJSON() -> String {
        guard let level else { return "" }
        return "{\"level\":\(level),\"charging\":\(isCharging ? "true" : "false")}"
    }
}
