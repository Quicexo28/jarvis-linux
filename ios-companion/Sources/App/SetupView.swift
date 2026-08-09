import CoreLocation
import SwiftUI
import UIKit

/// Pairing and permissions — the iOS twin of `SetupActivity`.
///
/// Pairing is one paste: the QR link carries both the URL and the token, and the
/// backend accepts that same token for the GUI and for the ingest endpoints, so
/// there is nothing else to type.
struct SetupView: View {
    var onSaved: () -> Void

    @State private var pairing: String = Config.baseUrl.isEmpty
        ? ""
        : "\(Config.baseUrl)/?token=\(Config.token)"
    @State private var device: String = Config.device
    @State private var intervalMin: Double = Double(Config.intervalMin)
    @State private var reporterEnabled: Bool = Config.reporterEnabled
    @State private var probe: String?
    @State private var probing = false
    @StateObject private var reporter = Reporter.shared

    var body: some View {
        Form {
            Section {
                TextField("https://…:8443/?token=…", text: $pairing, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .lineLimit(1...4)
                TextField("Nombre del dispositivo", text: $device)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Emparejamiento")
            } footer: {
                Text("Pega el enlace del QR de Jarvis. Trae la dirección y el token juntos.")
            }

            Section {
                Toggle("Reportar en segundo plano", isOn: $reporterEnabled)
                HStack {
                    Text("Cada")
                    Slider(value: $intervalMin, in: 5...120, step: 5)
                    Text("\(Int(intervalMin)) min").monospacedDigit()
                }
                permissionRow
            } header: {
                Text("Reporte periódico")
            } footer: {
                Text(reporterFooter)
            }

            Section {
                Button {
                    Task { await probeBackend() }
                } label: {
                    HStack {
                        Text("Probar conexión")
                        if probing { Spacer(); ProgressView() }
                    }
                }
                .disabled(probing || pairing.isEmpty)

                if let probe {
                    Text(probe).font(.footnote).foregroundStyle(.secondary)
                }

                Button("Guardar") { save() }
                    .disabled(pairing.isEmpty)
            }

            Section {
                LabeledContent("Estado", value: reporter.isRunning ? "Reportando" : "Detenido")
                LabeledContent("Último reporte", value: lastReportText)
                LabeledContent("Versión", value: appVersion)
            }
        }
        .navigationTitle("Jarvis")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - pieces

    @ViewBuilder
    private var permissionRow: some View {
        switch reporter.authorization {
        case .authorizedAlways:
            Label("Ubicación: Siempre", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .authorizedWhenInUse:
            Button {
                reporter.requestAuthorization()
            } label: {
                Label("Cambiar a «Siempre»", systemImage: "exclamationmark.triangle.fill")
            }
            .foregroundStyle(.orange)
        case .denied, .restricted:
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("Ubicación bloqueada — abrir Ajustes", systemImage: "xmark.circle.fill")
            }
            .foregroundStyle(.red)
        default:
            Button {
                reporter.requestAuthorization()
            } label: {
                Label("Permitir ubicación", systemImage: "location.circle")
            }
        }
    }

    private var reporterFooter: String {
        switch reporter.authorization {
        case .authorizedAlways:
            return "iOS no tiene servicios en primer plano: la app se mantiene viva con una sesión de ubicación, así que verás la flecha en la barra de estado. Es el precio de reportar con la app cerrada."
        case .authorizedWhenInUse:
            return "Con «Mientras se usa» solo reporta con la app abierta. Cambia a «Siempre» para que siga con la pantalla apagada."
        default:
            return "Sin permiso de ubicación solo se reporta la batería cuando abras la app."
        }
    }

    private var lastReportText: String {
        guard let date = reporter.lastReport else { return "—" }
        let fmt = RelativeDateTimeFormatter()
        fmt.locale = Locale(identifier: "es")
        return fmt.localizedString(for: date, relativeTo: Date())
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    // MARK: - actions

    private func save() {
        let parsed = Config.parsePairing(pairing)
        Config.save(
            baseUrl: parsed.base,
            token: parsed.token ?? Config.token,
            device: device,
            intervalMin: Int(intervalMin)
        )
        Config.reporterEnabled = reporterEnabled
        onSaved()
    }

    /// `/health` is public, so a failure here means the network or the laptop —
    /// never the token. Worth separating: the two look identical from the phone.
    private func probeBackend() async {
        probing = true
        defer { probing = false }
        let parsed = Config.parsePairing(pairing)
        let api = JarvisApi(base: parsed.base, token: parsed.token ?? Config.token)
        if await api.health() {
            let authed = await api.getJSON("/api/mobile/token") != nil
            probe = authed
                ? "Backend OK y token aceptado."
                : "Backend OK, pero el token no sirve. Vuelve a copiar el QR."
        } else {
            probe = "No responde. Revisa Tailscale y que el portátil esté encendido."
        }
    }
}
