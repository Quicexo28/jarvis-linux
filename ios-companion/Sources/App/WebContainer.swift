import SwiftUI
import UIKit
import WebKit

/// The remote Jarvis GUI (`frontend/src/modes/remote/`) inside a `WKWebView`,
/// plus the `window.JarvisNative` bridge the page already knows from the Android
/// companion (`frontend/src/modes/remote/native.ts`).
///
/// **The bridge contract is synchronous and WebKit's is not.** `version()`,
/// `reporterRunning()`, `battery()` and `openMoonlight()` must return a value on
/// the spot, while `WKScriptMessageHandler` only ever delivers messages one way.
/// So the shim below keeps a plain JS object (`window.__jarvisState`) that native
/// code writes into with `evaluateJavaScript`, and the accessors read from it —
/// the page sees the same synchronous API it does on Android, and no change to
/// `native.ts` is needed.
struct WebContainer: UIViewRepresentable {
    let url: URL
    var onOpenSettings: () -> Void
    var onStartVoice: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onOpenSettings: onOpenSettings, onStartVoice: onStartVoice)
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "jarvisNative")
        controller.addUserScript(
            WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.scrollView.bounces = false
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        // `viewport-fit=cover` in the page only pays off if the shell lets the
        // content reach the physical edge; the safe-area insets then come from
        // env(safe-area-inset-*), exactly as on the Android build.
        web.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.web = web
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.onOpenSettings = onOpenSettings
        context.coordinator.onStartVoice = onStartVoice
        if web.url == nil { web.load(URLRequest(url: url)) }
    }

    // MARK: - bridge

    private static let bridgeScript = """
    (function () {
      var s = window.__jarvisState || (window.__jarvisState = {});
      if (s.version === undefined) s.version = '';
      if (s.reporter === undefined) s.reporter = false;
      if (s.battery === undefined) s.battery = '';
      if (s.moonlight === undefined) s.moonlight = 'error';
      function post(fn) {
        try { window.webkit.messageHandlers.jarvisNative.postMessage({ fn: fn }); } catch (e) {}
      }
      window.JarvisNative = {
        version: function () { return s.version; },
        reporterRunning: function () { return !!s.reporter; },
        battery: function () { return s.battery; },
        startVoice: function () { post('startVoice'); },
        openSettings: function () { post('openSettings'); },
        openMoonlight: function () { post('openMoonlight'); return s.moonlight; },
        platform: function () { return 'ios'; }
      };
    })();
    """

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        var onOpenSettings: () -> Void
        var onStartVoice: () -> Void
        weak var web: WKWebView?

        init(onOpenSettings: @escaping () -> Void, onStartVoice: @escaping () -> Void) {
            self.onOpenSettings = onOpenSettings
            self.onStartVoice = onStartVoice
        }

        func userContentController(
            _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any], let fn = body["fn"] as? String else { return }
            switch fn {
            case "openSettings": onOpenSettings()
            case "startVoice": onStartVoice()
            case "openMoonlight": Desktop.openMoonlight(uuid: nil)
            default: break
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pushState(into: webView)
        }

        /// Anything that is not http(s) belongs to another app (`moonlight:`,
        /// `tailscale:`, `mailto:`), so hand it to the system instead of trying
        /// to render it — the Android client makes the same split.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
                decisionHandler(.allow)
                return
            }
            if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
        }

        /// The page navigates the SAME view for pc-remote (its back button calls
        /// history.back()), so a `target=_blank` that opens no window would be a
        /// dead tap. Load it in place instead of dropping it.
        func webView(
            _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }

        func pushState(into webView: WKWebView) {
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            let reporter = Reporter.shared.isRunning
            let battery = Battery.snapshotJSON()
            let moonlight = Desktop.isMoonlightInstalled ? "launched" : "store"
            let js = """
            (function () {
              var s = window.__jarvisState || (window.__jarvisState = {});
              s.version = \(jsString(version));
              s.reporter = \(reporter ? "true" : "false");
              s.battery = \(jsString(battery));
              s.moonlight = \(jsString(moonlight));
            })();
            """
            webView.evaluateJavaScript(js)
        }

        private func jsString(_ raw: String) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: [raw])) ?? Data("[\"\"]".utf8)
            let text = String(data: data, encoding: .utf8) ?? "[\"\"]"
            return String(text.dropFirst().dropLast())
        }
    }
}
