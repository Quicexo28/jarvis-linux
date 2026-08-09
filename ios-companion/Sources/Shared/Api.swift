import Foundation

/// Tiny HTTP client for the Jarvis backend. Mirrors `Api.kt`: failures are logged
/// and swallowed, because the phone is off-network constantly and neither the
/// reporter nor a widget timeline may throw because of it.
///
/// It is a value, not a singleton, because a widget extension may have to run
/// with credentials the app never handed it (no App Group on a free Apple ID —
/// see `Config`), so it carries its own base URL and token.
struct JarvisApi {
    let base: String
    let token: String

    /// Credentials from the app's own store.
    static var shared: JarvisApi { JarvisApi(base: Config.baseUrl, token: Config.token) }

    var isConfigured: Bool { base.hasPrefix("http") }

    /// POST a JSON body to an ingest path (e.g. `/api/mobile/ctx/battery`),
    /// stamping the device name the way `Api.post` does on Android.
    @discardableResult
    func postContext(_ path: String, _ body: [String: Any]) async -> Bool {
        var payload = body
        payload["device"] = Config.device
        guard let (_, code) = await request(path, method: "POST", json: payload, timeout: 10) else { return false }
        return (200..<300).contains(code)
    }

    /// POST JSON and decode the answer, for the endpoints whose *reply* matters
    /// (`/api/jarvis/turn`). Unlike `postContext` it injects no device field.
    func postJSON(_ path: String, _ body: [String: Any], timeout: TimeInterval = 60) async -> [String: Any]? {
        guard let (data, code) = await request(path, method: "POST", json: body, timeout: timeout),
              (200..<300).contains(code) else { return nil }
        return decode(data)
    }

    func getJSON(_ path: String, timeout: TimeInterval = 8) async -> [String: Any]? {
        guard let (data, code) = await request(path, method: "GET", json: nil, timeout: timeout),
              (200..<300).contains(code) else { return nil }
        return decode(data)
    }

    /// Is the backend reachable? `/health` is public (no token), so a failure here
    /// means the network or the laptop, never the pairing.
    func health(timeout: TimeInterval = 5) async -> Bool {
        guard let (_, code) = await request("/health", method: "GET", json: nil, timeout: timeout) else { return false }
        return (200..<300).contains(code)
    }

    func makeRequest(_ path: String, method: String, json: [String: Any]?, timeout: TimeInterval) -> URLRequest? {
        guard isConfigured, let url = URL(string: base + path) else { return nil }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return req
    }

    private func request(
        _ path: String, method: String, json: [String: Any]?, timeout: TimeInterval
    ) async -> (Data, Int)? {
        guard let req = makeRequest(path, method: method, json: json, timeout: timeout) else { return nil }
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(code) { NSLog("[jarvis] \(method) \(path) -> \(code)") }
            return (data, code)
        } catch {
            NSLog("[jarvis] \(method) \(path) failed: \(error.localizedDescription)")
            return nil
        }
    }

    private func decode(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}
