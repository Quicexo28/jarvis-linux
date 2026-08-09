import AVFoundation
import Foundation
import Speech

/// One-shot dictation with `SFSpeechRecognizer`.
///
/// It exists for the same reason the Android companion ships its own recognizer:
/// the web view has no `SpeechRecognition` API, so a page inside the shell cannot
/// listen. Locale is es-CO, matching the wake/STT stack on the laptop.
///
/// Endpointing is ours, not Apple's: `SFSpeechRecognizer` will happily keep a
/// session open long after the user stopped talking, so a silence timer closes
/// the turn once no new transcription has arrived for `silenceWindow`.
final class Dictation {
    enum Failure: Error {
        case unauthorized(String)
        case unavailable
    }

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "es-CO"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var latest = ""
    private var stopped = false

    /// How long the user may pause before the turn is considered finished.
    var silenceWindow: TimeInterval = 1.2

    var onPartial: ((String) -> Void)?
    var onLevel: ((Float) -> Void)?
    var onFinal: ((String) -> Void)?
    var onError: ((String) -> Void)?

    /// Both permissions, in the order iOS wants them.
    static func requestPermissions() async -> Result<Void, Failure> {
        let speech = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard speech == .authorized else {
            return .failure(.unauthorized("Falta permiso de reconocimiento de voz."))
        }
        let mic = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
        guard mic else { return .failure(.unauthorized("Falta permiso de micrófono.")) }
        return .success(())
    }

    func start() {
        guard let recognizer, recognizer.isAvailable else {
            onError?("El dictado no está disponible ahora mismo.")
            return
        }
        stopped = false
        latest = ""

        do {
            try AudioSession.configureForRecording()
        } catch {
            onError?("No se pudo abrir el micrófono.")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            self?.onLevel?(Self.rms(buffer))
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            onError?("No se pudo abrir el micrófono.")
            cleanup()
            return
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.latest = result.bestTranscription.formattedString
                self.onPartial?(self.latest)
                self.armSilenceTimer()
                if result.isFinal { self.finish() }
            }
            if error != nil {
                // A cancelled session reports an error too; only surface it when
                // nothing at all was heard, otherwise deliver what we got.
                if self.latest.isEmpty && !self.stopped {
                    self.onError?("No se escuchó nada.")
                    self.cleanup()
                } else {
                    self.finish()
                }
            }
        }
        armSilenceTimer()
    }

    /// Stop listening and deliver whatever was heard.
    func finish() {
        guard !stopped else { return }
        stopped = true
        let text = latest.trimmingCharacters(in: .whitespacesAndNewlines)
        cleanup()
        if text.isEmpty {
            onError?("No se escuchó nada.")
        } else {
            onFinal?(text)
        }
    }

    /// Abandon the turn without delivering anything.
    func cancel() {
        stopped = true
        cleanup()
    }

    private func armSilenceTimer() {
        silenceTimer?.invalidate()
        let timer = Timer(timeInterval: silenceWindow, repeats: false) { [weak self] _ in
            self?.finish()
        }
        RunLoop.main.add(timer, forMode: .common)
        silenceTimer = timer
    }

    private func cleanup() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        if engine.isRunning {
            engine.stop()
        }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        onLevel?(0)
    }

    private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0] else { return 0 }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<frames {
            let sample = channel[i]
            sum += sample * sample
        }
        return min(1, (sum / Float(frames)).squareRoot() * 6)
    }
}
