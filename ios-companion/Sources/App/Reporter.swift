import CoreLocation
import Foundation
import UIKit
import WidgetKit

/// Feeds Jarvis the ambient signals the tablet already sends: battery level +
/// charging, coarse location, and presence.
///
/// **Why it is built around location and not a timer.** iOS has no foreground
/// service; `ReporterService.kt`'s "run forever and tick every N minutes" has no
/// counterpart. What iOS does offer is a live location session: with Always
/// authorization and the `location` background mode, the process keeps running
/// with the app closed, so an ordinary `Timer` inside it keeps firing — and if
/// iOS still terminates the app, significant-location-change relaunches it as
/// soon as the phone moves cells. `BGAppRefreshTask` is registered too, but only
/// as a free extra: the system grants it whenever it feels like it.
///
/// The cost is honest and visible: an always-on location session shows the arrow
/// in the status bar and spends battery. That was the explicit trade chosen over
/// event-only reporting, which is nearly free but goes silent for hours when the
/// phone sits still.
final class Reporter: NSObject, ObservableObject {
    static let shared = Reporter()

    @Published private(set) var isRunning = false
    @Published private(set) var lastReport: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var backendOnline = false

    private let manager = CLLocationManager()
    private var timer: Timer?
    private var lastFix: CLLocation?
    /// Mirror of the app's foreground state, kept by the lifecycle notifications.
    /// Reading `UIApplication.shared` instead would drag main-actor isolation into
    /// every background code path here for no extra information.
    private var appActive = true

    private override init() {
        super.init()
        manager.delegate = self
        // Coarse on purpose: Jarvis wants "is he home", not a track. A tighter
        // accuracy would multiply the battery cost for no extra signal.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 50
        manager.pausesLocationUpdatesAutomatically = false
        manager.activityType = .other
    }

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }

    // MARK: - lifecycle

    func start() {
        guard Config.isConfigured else { return }
        Battery.enableMonitoring()
        observeSystemEvents()
        requestAuthorization()
        startLocation()
        startTimer()
        AppDelegate.scheduleRefresh()
        isRunning = true
        Task { await reportNow(reason: "start") }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        isRunning = false
    }

    /// Escalates the prompt: iOS refuses to show the Always dialog before the
    /// user has granted When In Use, so asking for Always first silently does
    /// nothing on a fresh install.
    func requestAuthorization() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
    }

    private func startLocation() {
        let status = manager.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else { return }
        // Setting this before authorization exists throws; and it is what keeps
        // the process alive once the screen locks.
        manager.allowsBackgroundLocationUpdates = (status == .authorizedAlways)
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
        if status == .authorizedAlways {
            // The relaunch path: iOS restarts a terminated app for this.
            manager.startMonitoringSignificantLocationChanges()
        }
    }

    private func startTimer() {
        timer?.invalidate()
        let interval = TimeInterval(Config.intervalMin * 60)
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { await self?.reportNow(reason: "tick") }
        }
        t.tolerance = interval * 0.2
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func observeSystemEvents() {
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(batteryChanged),
            name: UIDevice.batteryStateDidChangeNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(becameActive),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(wentBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil
        )
        // Device locked: the closest iOS gets to Android's ACTION_SCREEN_OFF.
        center.addObserver(
            self, selector: #selector(wentBackground),
            name: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil
        )
    }

    @objc private func batteryChanged() { Task { await reportBattery() } }

    @objc private func becameActive() {
        appActive = true
        Task { await reportPresence(true) }
    }

    @objc private func wentBackground() {
        appActive = false
        Task { await reportPresence(false) }
    }

    // MARK: - reporting

    /// One full round. `reason` only shows up in the log — the backend keeps its
    /// own timestamps.
    func reportNow(reason: String) async {
        guard Config.isConfigured, Config.reporterEnabled else { return }
        let reachable = await reportBattery()
        await reportLocation()
        await reportPresence(appActive)

        await MainActor.run {
            self.backendOnline = reachable
            self.lastReport = Date()
            self.lastError = reachable ? nil : "El backend no respondió."
        }
        // The battery POST already proved whether the laptop answers, so the
        // home-screen tiles ride along on this tick instead of probing on their
        // own schedule — same trick as the Android reporter.
        WidgetStatus.write(backendOnline: reachable)
        WidgetCenter.shared.reloadAllTimelines()
        NSLog("[jarvis] report(\(reason)) online=\(reachable)")
    }

    @discardableResult
    private func reportBattery() async -> Bool {
        let snapshot = await MainActor.run { (level: Battery.level, charging: Battery.isCharging) }
        guard let level = snapshot.level else { return await JarvisApi.shared.health() }
        return await JarvisApi.shared.postContext(
            "/api/mobile/ctx/battery",
            ["level": level, "charging": snapshot.charging]
        )
    }

    private func reportPresence(_ foreground: Bool) async {
        guard Config.isConfigured else { return }
        await JarvisApi.shared.postContext("/api/mobile/ctx/presence", ["foreground": foreground])
    }

    private func reportLocation() async {
        guard let fix = lastFix ?? manager.location else { return }
        // A fix from an hour ago says nothing about where he is now, and posting
        // it would move the "last seen" marker for free.
        guard Date().timeIntervalSince(fix.timestamp) < 30 * 60 else { return }
        await JarvisApi.shared.postContext("/api/mobile/ctx/location", [
            "lat": fix.coordinate.latitude,
            "lon": fix.coordinate.longitude,
            "accuracy": fix.horizontalAccuracy,
            "source": "ios",
        ])
    }
}

extension Reporter: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        startLocation()
        if manager.authorizationStatus == .authorizedWhenInUse {
            // Second half of the escalation, now that the first prompt is answered.
            manager.requestAlwaysAuthorization()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last else { return }
        lastFix = fix
        // A significant-location-change relaunch arrives here with no scene and
        // no timer, so this callback is the only chance to report the move.
        if !appActive {
            Task { await reportNow(reason: "move") }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[jarvis] location failed: \(error.localizedDescription)")
    }
}
