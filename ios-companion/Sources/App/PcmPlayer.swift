import AVFoundation
import Foundation

/// Plays the backend's TTS stream.
///
/// `POST /api/jarvis/tts` answers with raw float32 little-endian mono PCM as XTTS
/// produces it (the WS variant is the one that plays on the laptop; this one
/// hands the audio to the caller). XTTS synthesises faster than realtime, so the
/// buffers are scheduled as they arrive and the reply starts almost at once.
///
/// The subtle part is the same one the Android player had to solve: a chunked
/// HTTP body hands over an arbitrary number of bytes, so a float32 sample
/// routinely straddles two reads. The leftover 1–3 bytes are CARRIED to the front
/// of the next chunk — dropping them shifts every sample after it and turns the
/// voice into noise.
final class PcmPlayer {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private var carry = Data()
    private var running = false

    /// `onLevel` feeds the hologram, so the core pulses with Jarvis's own voice.
    var onLevel: ((Float) -> Void)?

    init(sampleRate: Double = 24_000) {
        format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false
        )!
    }

    func start() throws {
        guard !running else { return }
        carry.removeAll(keepingCapacity: true)
        try AudioSession.configureForPlayback()
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.prepare()
        try engine.start()
        node.play()
        running = true
    }

    /// Feed one HTTP chunk. Safe to call with any byte count, including 1.
    func feed(_ chunk: Data) {
        guard running else { return }
        carry.append(chunk)
        let usable = carry.count - (carry.count % 4)
        guard usable > 0 else { return }

        let payload = carry.prefix(usable)
        carry.removeFirst(usable)

        let frames = usable / 4
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(frames)

        var peak: Float = 0
        payload.withUnsafeBytes { raw in
            // The stream is little-endian float32 and every iOS device is
            // little-endian, so the bytes map straight onto Float. Loaded
            // unaligned: `Data` gives no 4-byte alignment guarantee once a
            // previous chunk has been consumed off the front of the buffer.
            for i in 0..<frames {
                let sample = raw.loadUnaligned(fromByteOffset: i * 4, as: Float32.self)
                channel[i] = sample
                let magnitude = abs(sample)
                if magnitude > peak { peak = magnitude }
            }
        }
        node.scheduleBuffer(buffer, completionHandler: nil)
        onLevel?(min(1, peak * 1.6))
    }

    /// Let whatever is already queued finish playing.
    func finish() {
        guard running else { return }
        running = false
        node.stop()
        engine.stop()
        engine.detach(node)
        onLevel?(0)
    }

    /// Cut it off now (barge-in).
    func stop() {
        guard running else { return }
        running = false
        node.stop()
        engine.stop()
        engine.detach(node)
        carry.removeAll()
        onLevel?(0)
    }
}

/// One place that owns the audio session, because dictation and playback want
/// contradictory categories and whoever configures last wins.
enum AudioSession {
    static func configureForPlayback() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
    }

    static func configureForRecording() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord, mode: .measurement,
            options: [.defaultToSpeaker, .allowBluetooth, .duckOthers]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
