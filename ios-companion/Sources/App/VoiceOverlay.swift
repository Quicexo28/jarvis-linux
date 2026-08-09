import SwiftUI
import WidgetKit

/// The voice turn: listen → ask the brain → speak the answer.
///
/// It is the same brain the chat uses (`/api/jarvis/turn`, persistent session
/// with MCP tools), so an order given by voice here can actually do things,
/// unlike a one-shot prompt. The hologram is the state indicator — cyan while
/// listening or speaking, amber while thinking — exactly as on the tablet.
@MainActor
final class VoiceTurn: ObservableObject {
    @Published var state: HoloState = .online
    @Published var caption: String = "Toca para hablar"
    @Published var body: String = ""
    @Published var level: Double = 0

    private let dictation = Dictation()
    private var player: PcmPlayer?
    private var stream: StreamingPost?

    init() {
        dictation.onPartial = { [weak self] text in
            Task { @MainActor in self?.body = text }
        }
        dictation.onLevel = { [weak self] level in
            Task { @MainActor in self?.level = Double(level) }
        }
        dictation.onFinal = { [weak self] text in
            Task { @MainActor in await self?.ask(text) }
        }
        dictation.onError = { [weak self] reason in
            Task { @MainActor in self?.fail(reason) }
        }
    }

    func begin() async {
        guard Config.isConfigured else {
            fail("Empareja la app con Jarvis primero.")
            return
        }
        switch await Dictation.requestPermissions() {
        case .failure(let error):
            fail(errorText(error))
        case .success:
            state = .listening
            caption = "Escuchando…"
            body = ""
            dictation.start()
        }
    }

    /// Tap while it talks = barge-in; tap while idle = new turn.
    func tapped() async {
        switch state {
        case .speaking:
            player?.stop()
            stream?.cancel()
            await begin()
        case .listening:
            dictation.finish()
        default:
            await begin()
        }
    }

    func end() {
        dictation.cancel()
        player?.stop()
        stream?.cancel()
        AudioSession.deactivate()
    }

    private func ask(_ text: String) async {
        state = .thinking
        caption = "Pensando…"
        body = text

        let answer = await JarvisApi.shared.postJSON("/api/jarvis/turn", ["message": text], timeout: 60)
        // The overlay just learned whether the laptop answers; the tiles should
        // agree with what the user was told.
        WidgetStatus.write(backendOnline: answer != nil)
        WidgetCenter.shared.reloadAllTimelines()

        guard let reply = (answer?["reply"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !reply.isEmpty else {
            fail("Jarvis no respondió.")
            return
        }
        speak(reply)
    }

    private func speak(_ reply: String) {
        state = .speaking
        caption = "Hablando…"
        body = reply

        let api = JarvisApi.shared
        guard let request = api.makeRequest(
            "/api/jarvis/tts", method: "POST", json: ["text": reply, "lang": "es"], timeout: 60
        ) else {
            idle()
            return
        }

        let stream = StreamingPost(
            onChunk: { [weak self] data in
                Task { @MainActor in self?.player?.feed(data) }
            },
            onFinish: { [weak self] _ in
                Task { @MainActor in
                    self?.player?.finish()
                    self?.idle()
                }
            }
        )
        // The rate is announced in the headers; the player's format is fixed at
        // build time, so it can only be created once the answer is known.
        stream.onResponse = { [weak self] response in
            let rate = Double(response.value(forHTTPHeaderField: "X-Sample-Rate") ?? "") ?? 24_000
            Task { @MainActor in self?.startPlayer(rate: rate) }
        }
        self.stream = stream
        stream.start(request)
    }

    private func startPlayer(rate: Double) {
        let player = PcmPlayer(sampleRate: rate)
        player.onLevel = { [weak self] level in
            Task { @MainActor in self?.level = Double(level) }
        }
        try? player.start()
        self.player = player
    }

    private func idle() {
        state = .online
        caption = "Toca para hablar"
        level = 0
        player = nil
        stream = nil
    }

    private func fail(_ reason: String) {
        state = .offline
        caption = reason
        level = 0
    }

    private func errorText(_ error: Dictation.Failure) -> String {
        switch error {
        case .unauthorized(let message): return message
        case .unavailable: return "El dictado no está disponible."
        }
    }
}

struct VoiceOverlay: View {
    var onClose: () -> Void
    @StateObject private var turn = VoiceTurn()

    var body: some View {
        ZStack {
            Color.black.opacity(0.92).ignoresSafeArea()

            VStack(spacing: 24) {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                    let seconds = context.date.timeIntervalSinceReferenceDate
                    HoloDisc(
                        state: turn.state,
                        phase: (seconds / 6).truncatingRemainder(dividingBy: 1),
                        level: turn.level,
                        label: "JARVIS",
                        caption: turn.caption,
                        card: false
                    )
                }
                .frame(width: 260, height: 260)
                .contentShape(Rectangle())
                .onTapGesture { Task { await turn.tapped() } }

                if !turn.body.isEmpty {
                    ScrollView {
                        Text(turn.body)
                            .font(.callout)
                            .foregroundStyle(.white.opacity(0.85))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                    }
                    .frame(maxHeight: 180)
                }

                Button("Cerrar") {
                    turn.end()
                    onClose()
                }
                .foregroundStyle(.white.opacity(0.6))
            }
        }
        .task { await turn.begin() }
        .onDisappear { turn.end() }
        .preferredColorScheme(.dark)
    }
}
