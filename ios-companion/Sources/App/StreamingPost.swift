import Foundation

/// A POST whose response body is consumed as it arrives.
///
/// `URLSession.data(for:)` would buffer the whole TTS reply before a single
/// sample reached the speaker, which throws away the head start XTTS gives by
/// synthesising faster than realtime. `AsyncBytes` streams but iterates a byte at
/// a time — 96 kB/s of float32 audio makes that a bad trade. So this is the plain
/// delegate form: chunks land in `onChunk` exactly as the network hands them over.
final class StreamingPost: NSObject, URLSessionDataDelegate {
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private let onChunk: (Data) -> Void
    private let onFinish: (Error?) -> Void
    private var finished = false

    /// Called once with the response headers, before any chunk. The backend
    /// announces the PCM rate in `X-Sample-Rate`.
    var onResponse: ((HTTPURLResponse) -> Void)?

    init(onChunk: @escaping (Data) -> Void, onFinish: @escaping (Error?) -> Void) {
        self.onChunk = onChunk
        self.onFinish = onFinish
        super.init()
    }

    func start(_ request: URLRequest) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: request)
        self.task = task
        task.resume()
    }

    func cancel() {
        task?.cancel()
        session?.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        onChunk(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        finished = true
        onFinish(error)
        session.finishTasksAndInvalidate()
    }

    /// Anything that is not a 2xx has a body that is an error message, not audio,
    /// so stop before it gets fed to the speaker as noise.
    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let http = response as? HTTPURLResponse
        let code = http?.statusCode ?? 0
        if (200..<300).contains(code) {
            if let http { onResponse?(http) }
            completionHandler(.allow)
        } else {
            NSLog("[jarvis] tts stream -> \(code)")
            completionHandler(.cancel)
        }
    }
}
