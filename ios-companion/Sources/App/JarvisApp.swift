import BackgroundTasks
import SwiftUI
import UIKit

/// Entry point.
///
/// A `UIApplicationDelegate` still exists alongside the SwiftUI scene on purpose:
/// when iOS relaunches this app in the background because the device moved
/// (significant-location-change), no scene is created — only
/// `didFinishLaunching` runs. Starting the reporter from `.onAppear` would mean
/// the phone reports nothing until the user next opens the app by hand, which is
/// exactly the case the background report exists for.
@main
struct JarvisApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    static let refreshTaskId = "com.jarvis.companion.refresh"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskId, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            Self.handleRefresh(task)
        }

        if Config.isConfigured && Config.reporterEnabled {
            Reporter.shared.start()
        }
        return true
    }

    /// Opportunistic backup path. iOS decides when (or whether) this runs, so it
    /// is never the primary mechanism — the location session is. It costs nothing
    /// to also take the free tick when the system offers one.
    private static func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh()
        let work = Task {
            await Reporter.shared.reportNow(reason: "bgtask")
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }

    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: TimeInterval(Config.intervalMin * 60))
        try? BGTaskScheduler.shared.submit(request)
    }
}
