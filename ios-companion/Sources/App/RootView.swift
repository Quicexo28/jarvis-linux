import SwiftUI
import UIKit

/// Shell of the app: the paired WebView, or the pairing screen when there is no
/// backend yet. Same split as `MainActivity` + `SetupActivity` on Android — the
/// remote GUI is the app, and native code only covers what a web view cannot do.
struct RootView: View {
    @State private var configured = Config.isConfigured
    @State private var showSetup = false
    @State private var showVoice = false
    @StateObject private var reporter = Reporter.shared

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if configured, let url = Config.webUrl {
                WebContainer(
                    url: url,
                    onOpenSettings: { showSetup = true },
                    onStartVoice: { showVoice = true }
                )
                .ignoresSafeArea(.container, edges: .bottom)
            } else {
                SetupView(onSaved: { refresh() })
            }
        }
        .sheet(isPresented: $showSetup) {
            NavigationStack {
                SetupView(onSaved: {
                    showSetup = false
                    refresh()
                })
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cerrar") { showSetup = false }
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showVoice) {
            VoiceOverlay(onClose: { showVoice = false })
        }
        .onOpenURL { url in handle(url) }
        .onAppear { drainPendingAction() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            drainPendingAction()
        }
        .preferredColorScheme(.dark)
    }

    /// A widget cannot call into its container: it can only open a URL, and that
    /// URL is delivered to the app, which then does what the tile promised. Same
    /// shape as the invisible trampoline activity the Android widgets go through.
    private func handle(_ url: URL) {
        switch url.host {
        case "voice":
            showVoice = true
        case "tailscale":
            UIApplication.shared.open(Tailscale.appUrl)
        case "desktop":
            let uuid = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "uuid" })?.value
            Desktop.openMoonlight(uuid: uuid)
        case "settings":
            showSetup = true
        default:
            break
        }
    }

    private func drainPendingAction() {
        switch PendingAction.take() {
        case .voice: showVoice = true
        case .tailscale: UIApplication.shared.open(Tailscale.appUrl)
        case nil: break
        }
    }

    private func refresh() {
        configured = Config.isConfigured
        if configured && Config.reporterEnabled {
            reporter.start()
        } else {
            reporter.stop()
        }
    }
}
