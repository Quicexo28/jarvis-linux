import SwiftUI

/// The Jarvis hologram — same shape as the desktop's `voice-halo` and as
/// `ui/Holo.kt` on Android: white-to-cyan core, blue bloom, breathing rings.
///
/// Built out of plain SwiftUI shapes rather than `Canvas` because the very same
/// view is archived into a WidgetKit timeline entry, and the shape primitives are
/// the ones guaranteed to survive that trip. It also means the icon on the home
/// screen and the thing that answers inside the voice overlay are literally the
/// same drawing at different phases, which is what the Android version buys too.
enum HoloState {
    case online, offline, listening, thinking, speaking

    /// Idle/listening/speaking share the cyan identity; only motion and caption
    /// differ. Amber while the brain thinks, matching `voice-halo--processing`.
    var core: Color {
        switch self {
        case .online, .listening, .speaking: return Color(red: 0.40, green: 0.99, blue: 1.00)
        case .thinking: return Color(red: 1.00, green: 0.97, blue: 0.88)
        case .offline: return Color(red: 0.56, green: 0.63, blue: 0.72)
        }
    }

    var ring: Color {
        switch self {
        case .online, .listening, .speaking: return Color(red: 0.00, green: 0.90, blue: 1.00)
        case .thinking: return Color(red: 1.00, green: 0.84, blue: 0.00)
        case .offline: return Color(red: 0.24, green: 0.29, blue: 0.36)
        }
    }

    var glow: Color {
        switch self {
        case .online, .listening, .speaking: return Color(red: 0.00, green: 0.35, blue: 1.00)
        case .thinking: return Color(red: 1.00, green: 0.60, blue: 0.00)
        case .offline: return Color(red: 0.09, green: 0.13, blue: 0.18)
        }
    }

    var text: Color {
        switch self {
        case .thinking: return Color(red: 1.00, green: 0.97, blue: 0.88)
        case .offline: return Color(red: 0.36, green: 0.42, blue: 0.50)
        default: return Color(red: 0.90, green: 0.93, blue: 0.97)
        }
    }
}

struct HoloDisc: View {
    var state: HoloState = .online
    /// 0…1, wraps: rotates the arcs. Animate it to make the thing breathe.
    var phase: Double = 0
    /// 0…1 audio level: swells the core and the bloom.
    var level: Double = 0
    var label: String? = "JARVIS"
    var caption: String? = nil
    /// Paint the rounded dark card behind it (widget yes, overlay no).
    var card: Bool = true

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let lvl = min(max(level, 0), 1)

            // Label and caption live at the bottom, so the disc is centred in what
            // is left; otherwise the hologram sits visibly low in a square widget.
            let labelSize: CGFloat = 10
            let captionSize: CGFloat = 9
            let textBlock: CGFloat = (label != nil ? labelSize + 6 : 0) + (caption != nil ? captionSize + 3 : 0)

            let center = CGPoint(x: w / 2, y: (h - textBlock) / 2 + (card ? 2 : 0))
            let base = min(w, h - textBlock) * 0.5
            let rCore = base * 0.20 * (1 + lvl * 0.45)
            let rMid = base * 0.60
            let rOuter = base * 0.86
            let turn = phase * 360

            ZStack {
                if card { cardBackground }

                bloom(center: center, radius: rOuter * 1.35, lvl: lvl)
                horizon(center: center, radius: rOuter, turn: turn)
                ticks(center: center, rMid: rMid, turn: turn)
                rings(center: center, rMid: rMid, rOuter: rOuter, turn: turn)
                coreDisc(center: center, r: rCore)
                scanlines(center: center, radius: rOuter)
                textBlockView(width: w, height: h, labelSize: labelSize, captionSize: captionSize)
            }
        }
    }

    // MARK: - pieces

    private var cardBackground: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.055, green: 0.086, blue: 0.125),
                                 Color(red: 0.020, green: 0.027, blue: 0.051)],
                        startPoint: .top, endPoint: .bottom
                    )
                )
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Color(red: 0.106, green: 0.149, blue: 0.208), lineWidth: 1)
        }
    }

    /// Outer bloom: the "hologram is projected into the air" cue.
    private func bloom(center: CGPoint, radius: CGFloat, lvl: Double) -> some View {
        Circle()
            .fill(
                RadialGradient(
                    stops: [
                        .init(color: state.glow.opacity(0.34 + lvl * 0.22), location: 0),
                        .init(color: state.glow.opacity(0.10), location: 0.55),
                        .init(color: state.glow.opacity(0), location: 1),
                    ],
                    center: .center, startRadius: 0, endRadius: radius
                )
            )
            .frame(width: radius * 2, height: radius * 2)
            .position(center)
    }

    /// Faint dashed horizon ring.
    private func horizon(center: CGPoint, radius: CGFloat, turn: Double) -> some View {
        Circle()
            .stroke(
                state.ring.opacity(0.22),
                style: StrokeStyle(lineWidth: 1, dash: [2, 4], dashPhase: turn * 0.4)
            )
            .frame(width: radius * 2, height: radius * 2)
            .position(center)
    }

    /// 36 marks, every sixth longer. Cheap, and it is what makes the thing read
    /// as an instrument instead of a glowing dot.
    private func ticks(center: CGPoint, rMid: CGFloat, turn: Double) -> some View {
        ZStack {
            tickPath(center: center, rMid: rMid, turn: turn, long: false)
                .stroke(state.ring.opacity(0.20), lineWidth: 1.2)
            tickPath(center: center, rMid: rMid, turn: turn, long: true)
                .stroke(state.ring.opacity(0.45), lineWidth: 1.2)
        }
    }

    private func tickPath(center: CGPoint, rMid: CGFloat, turn: Double, long: Bool) -> Path {
        var path = Path()
        for i in 0..<36 where (i % 6 == 0) == long {
            let angle = (Double(i) * 10 + turn * 0.25) * .pi / 180
            let r1 = rMid * 1.18
            let r2 = r1 + (long ? 5 : 2.5)
            let dx = CGFloat(cos(angle))
            let dy = CGFloat(sin(angle))
            path.move(to: CGPoint(x: center.x + r1 * dx, y: center.y + r1 * dy))
            path.addLine(to: CGPoint(x: center.x + r2 * dx, y: center.y + r2 * dy))
        }
        return path
    }

    /// Mid ring plus the counter-rotating arcs that carry the motion.
    private func rings(center: CGPoint, rMid: CGFloat, rOuter: CGFloat, turn: Double) -> some View {
        ZStack {
            Circle()
                .stroke(state.ring.opacity(0.30), lineWidth: 1.4)
                .frame(width: rMid * 2, height: rMid * 2)
                .position(center)

            arc(center: center, radius: rMid, from: turn, sweep: 84)
                .stroke(state.ring.opacity(0.95), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
            arc(center: center, radius: rMid, from: turn + 180, sweep: 40)
                .stroke(state.ring.opacity(0.45), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))

            arc(center: center, radius: rOuter, from: -turn * 1.6, sweep: 26)
                .stroke(state.core.opacity(0.55), style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
            arc(center: center, radius: rOuter, from: -turn * 1.6 + 150, sweep: 60)
                .stroke(state.ring.opacity(0.30), style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
        }
    }

    private func arc(center: CGPoint, radius: CGFloat, from: Double, sweep: Double) -> Path {
        var path = Path()
        path.addArc(
            center: center, radius: radius,
            startAngle: .degrees(from), endAngle: .degrees(from + sweep),
            clockwise: false
        )
        return path
    }

    /// Core: white centre bleeding into the accent, plus its own tight bloom.
    private func coreDisc(center: CGPoint, r: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [state.core.opacity(0.55), state.core.opacity(0)],
                        center: .center, startRadius: 0, endRadius: r * 2.6
                    )
                )
                .frame(width: r * 5.2, height: r * 5.2)
                .position(center)

            Circle()
                .fill(
                    RadialGradient(
                        stops: [
                            .init(color: .white, location: 0),
                            .init(color: state.core, location: 0.45),
                            .init(color: state.ring, location: 1),
                        ],
                        center: UnitPoint(x: 0.35, y: 0.35), startRadius: 0, endRadius: r * 1.15
                    )
                )
                .frame(width: r * 2, height: r * 2)
                .position(center)
        }
    }

    /// The cheapest "this is a projection" cue.
    private func scanlines(center: CGPoint, radius: CGFloat) -> some View {
        var path = Path()
        var y = center.y - radius
        while y < center.y + radius {
            path.move(to: CGPoint(x: center.x - radius, y: y))
            path.addLine(to: CGPoint(x: center.x + radius, y: y))
            y += 4
        }
        return path
            .stroke(state.ring.opacity(0.07), lineWidth: 0.8)
            .clipShape(
                Circle()
                    .path(in: CGRect(x: center.x - radius, y: center.y - radius,
                                     width: radius * 2, height: radius * 2))
            )
    }

    private func textBlockView(
        width: CGFloat, height: CGFloat, labelSize: CGFloat, captionSize: CGFloat
    ) -> some View {
        VStack(spacing: 3) {
            if let label {
                Text(label)
                    .font(.system(size: labelSize, weight: .bold))
                    .tracking(3)
                    .foregroundStyle(state.text.opacity(state == .offline ? 0.55 : 0.9))
            }
            if let caption {
                Text(caption)
                    .font(.system(size: captionSize))
                    .tracking(0.4)
                    .lineLimit(1)
                    .foregroundStyle(state.text.opacity(0.75))
            }
        }
        .frame(width: width, alignment: .center)
        .position(x: width / 2, y: height - (card ? 18 : 10))
    }
}
