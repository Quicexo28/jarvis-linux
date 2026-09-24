use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Workspace donde vive la ventana de Jarvis cuando está despierta.
///
/// Por defecto el 1, en la pantalla del portátil. `JARVIS_UI_WORKSPACE` lo
/// cambia — p. ej. `name:proj`, el workspace de la salida headless `projmap`
/// que Sunshine emite al proyector: así Jarvis se ve en la PARED y el panel del
/// portátil queda libre.
///
/// Es env y no una regla de Hyprland a propósito: la ventana se mueve sola con
/// `hyprctl` en cada wake/sleep, así que cualquier `windowrule` que intentara
/// colocarla perdía la carrera y fallaba en silencio.
const DEFAULT_WORKSPACE: &str = "1";

fn ui_workspace() -> String {
    std::env::var("JARVIS_UI_WORKSPACE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_WORKSPACE.to_string())
}

/// Workspace de destino para esta llamada.
///
/// El frontend manda uno explícito porque solo él sabe si el proyector está
/// encendido AHORA. Con el proyector apagado, mandar la ventana a `projmap`
/// (que es headless y existe siempre) la volvía invisible en los dos sitios: ni
/// en la pared, ni en el portátil. Sin argumento se usa el de env.
fn target_workspace(requested: Option<String>) -> String {
    requested
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(ui_workspace)
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) {
    window.hide().ok();
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
fn show_window(window: tauri::WebviewWindow) {
    window.show().ok();
}

#[tauri::command]
fn focus_window(window: tauri::WebviewWindow, workspace: Option<String>) {
    // Al dormir, la ventana se va fuera de vista (ver `dormant_window`), así que
    // despertar sin traerla de vuelta la dejaría escondida. Siempre aterriza en
    // su workspace, venga el wake de donde venga (doble aplauso, wake-bus, Super+J).
    let ws = target_workspace(workspace);
    std::process::Command::new("hyprctl")
        .args(["dispatch", "movetoworkspacesilent", &format!("{ws},title:Jarvis")])
        .status().ok();
    // Solo se arrastra la vista del usuario cuando Jarvis comparte pantalla con
    // él. En modo proyector vive en su propio monitor (headless `projmap`), y
    // saltar allí dejaría el portátil mirando una salida que no se ve.
    if ws == DEFAULT_WORKSPACE {
        std::process::Command::new("hyprctl")
            .args(["dispatch", "workspace", &ws])
            .status().ok();
    }
    window.show().ok();
    window.set_focus().ok();
}

// Only show+focus if the active Hyprland workspace matches `workspace`.
// Used by clap detection so it only wakes Jarvis when the user is already on workspace 1.
#[tauri::command]
fn show_if_workspace(window: tauri::WebviewWindow, workspace: i64) -> bool {
    // En modo proyector el gate no aplica: Jarvis tiene monitor propio, así que
    // un aplauso debe despertarlo esté el usuario donde esté. Mantener la
    // comprobación lo haría inservible salvo estando en el workspace 1.
    if ui_workspace() != DEFAULT_WORKSPACE {
        window.show().ok();
        window.set_focus().ok();
        return true;
    }
    let active = std::process::Command::new("hyprctl")
        .args(["activeworkspace", "-j"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["id"].as_i64());

    match active {
        Some(id) if id == workspace => {
            window.show().ok();
            window.set_focus().ok();
            true
        }
        _ => false,
    }
}

// Show or hide the PTT overlay window. Called from AwakeApp when pttActive changes.
// The overlay is a separate transparent window that floats over all Hyprland workspaces.
#[tauri::command]
fn set_ptt_overlay(app: tauri::AppHandle, visible: bool) {
    if let Some(w) = app.get_webview_window("ptt-overlay") {
        if visible {
            w.show().ok();
            // Pin + place via hyprctl using REAL pixel geometry. Tauri's
            // primary_monitor() math is unreliable on Wayland/Hyprland (returns a
            // wrong logical height), so we anchor bottom-center from hyprctl monitors.
            std::thread::spawn(|| {
                // Overlay pixel size — small, bottom-center.
                const OW: i64 = 340;
                const OH: i64 = 120;
                const MARGIN: i64 = 24;

                let json = |args: &[&str]| -> Option<serde_json::Value> {
                    std::process::Command::new("hyprctl")
                        .args(args)
                        .output()
                        .ok()
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                };

                // Focused monitor geometry (real pixels) — query once.
                let mon = json(&["monitors", "-j"]).and_then(|v| {
                    let arr = v.as_array()?;
                    let m = arr.iter().find(|m| m["focused"].as_bool() == Some(true))
                        .or_else(|| arr.first())?;
                    Some((
                        m["x"].as_i64()?, m["y"].as_i64()?,
                        m["width"].as_i64()?, m["height"].as_i64()?,
                    ))
                });

                // Hyprland re-centers the floating window when it maps the surface,
                // which races with our placement. Re-apply pin/resize/move several
                // times over ~700ms so the final state wins regardless of map timing.
                for delay in [80u64, 200, 350, 550, 750] {
                    std::thread::sleep(std::time::Duration::from_millis(delay));

                    // (address, already_pinned) for the overlay window.
                    let found = json(&["clients", "-j"]).and_then(|v| {
                        v.as_array()?.iter().find_map(|c| {
                            if c["title"].as_str()? == "JarvisOverlay" {
                                Some((
                                    c["address"].as_str()?.to_string(),
                                    c["pinned"].as_bool().unwrap_or(false),
                                ))
                            } else {
                                None
                            }
                        })
                    });

                    if let Some((a, pinned)) = found {
                        // pin is a toggle — only fire it when not already pinned.
                        if !pinned {
                            std::process::Command::new("hyprctl").args(["dispatch", "pin", &a]).output().ok();
                        }
                        std::process::Command::new("hyprctl")
                            .args(["dispatch", "resizewindowpixel",
                                   &format!("exact {} {},address:{}", OW, OH, a)])
                            .output().ok();
                        if let Some((mx, my, mw, mh)) = mon {
                            let x = mx + (mw - OW) / 2;
                            let y = my + mh - OH - MARGIN;
                            std::process::Command::new("hyprctl")
                                .args(["dispatch", "movewindowpixel",
                                       &format!("exact {} {},address:{}", x, y, a)])
                                .output().ok();
                        }
                    }
                }
            });
        } else {
            w.hide().ok();
        }
    }
}

#[tauri::command]
fn dormant_window(_window: tauri::WebviewWindow, workspace: Option<String>) {
    // En modo proyector la ventana NO se esconde: ese monitor es suyo y nada más
    // se ve ahí, así que apartarla dejaría la pared en un escritorio vacío. Solo
    // cuando comparte pantalla con el usuario hay que quitarla de en medio.
    if target_workspace(workspace) != DEFAULT_WORKSPACE {
        return;
    }
    std::process::Command::new("hyprctl")
        .args(["dispatch", "movetoworkspacesilent", "special:jarvis,title:Jarvis"])
        .spawn().ok();
}

/// Muestra u oculta la ventana de la pared, colocandola en el monitor del
/// proyector.
///
/// El workspace se pasa desde el frontend (igual que en `focus_window`): solo el
/// llama sabe si el proyector esta encendido AHORA, y mandar la ventana a una
/// salida headless apagada la haria invisible sin ningun error.
#[tauri::command]
fn set_wall(app: tauri::AppHandle, visible: bool, workspace: Option<String>) {
    let Some(w) = app.get_webview_window("wall") else { return };
    if !visible {
        w.hide().ok();
        return;
    }
    w.show().ok();
    let ws = target_workspace(workspace);
    // `movetoworkspacesilent` NO roba el foco ni cambia lo que ve el usuario en
    // el portatil, que es justo el objetivo: el grafico aparece en la pared sin
    // interrumpir lo que esta haciendo.
    std::process::Command::new("hyprctl")
        .args(["dispatch", "movetoworkspacesilent", &format!("{ws},title:JarvisWall")])
        .status().ok();
    // Nada de `dispatch fullscreen`: ese dispatch NO acepta selector de ventana,
    // actua sobre la ENFOCADA — y aqui la pared se muestra sin robar foco, asi
    // que acababa poniendo a pantalla completa lo que el usuario tuviera abierto
    // en el portatil. El tamaño de la pared lo fija la windowrule `jarvis-wall`
    // de scripts/linux/hyprland-jarvis.conf.
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single registration with handler — never register the same plugin twice
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // Super+J — wake Jarvis.
                    // Hyprland bind moves window to workspace 1; we focus + emit.
                    // Also use eval() as fallback in case Tauri IPC isn't ready.
                    if shortcut.mods == Modifiers::SUPER
                        && shortcut.key == Code::KeyJ
                        && event.state() == ShortcutState::Pressed
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            window.set_focus().ok();
                            window.eval("window.__jarvisWake && window.__jarvisWake()").ok();
                        }
                        app.emit("jarvis:wake", ()).ok();
                    }
                    // PTT (NitroSense key, evdev 425) is handled by Hyprland keybind
                    // → POST /api/skills/voice/ptt-start|stop → skill bus → pttActive store.
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![hide_window, show_window, focus_window, show_if_workspace, open_devtools, set_ptt_overlay, dormant_window, set_wall])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Intercept close (Super+W / killactive): send to special workspace instead
                // of hiding, so WebKit JS keeps running for wake-bus and clap detection.
                // Leaving it in place does NOT work: DORMANT paints nothing and WebKitGTK
                // never clears a transparent window, so the last awake frame stays frozen
                // on screen (and eats clicks).
                api.prevent_close();
                std::process::Command::new("hyprctl")
                    .args(["dispatch", "movetoworkspacesilent", "special:jarvis,title:Jarvis"])
                    .spawn().ok();
                window.emit("jarvis:sleep", ()).ok();
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Register Super+J global shortcut (wake)
            let wake_shortcut = Shortcut::new(Some(Modifiers::SUPER), Code::KeyJ);
            app.global_shortcut().register(wake_shortcut)?;

            // PTT overlay window — small transparent canvas, bottom-center.
            // Hyprland pins it to all workspaces via windowrule { match:title = JarvisOverlay; pin = 1 }.
            let overlay_w = 340.0f64;
            let overlay_h = 120.0f64;
            let (ox, oy) = app.primary_monitor()
                .ok()
                .flatten()
                .map(|m| {
                    let sf = m.scale_factor();
                    let pw = m.size().width  as f64 / sf;
                    let ph = m.size().height as f64 / sf;
                    (pw / 2.0 - overlay_w / 2.0, ph - overlay_h - 48.0)
                })
                .unwrap_or((860.0, 800.0)); // fallback: ~centered on 1920×1080

            tauri::WebviewWindowBuilder::new(
                app,
                "ptt-overlay",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("JarvisOverlay")
            .inner_size(overlay_w, overlay_h)
            .position(ox, oy)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible(false)
            .build()?;

            // Ventana de la PARED: el visor 3D a pantalla completa en el proyector.
            //
            // Es una ventana aparte y no un modo de la principal porque el punto
            // es que Jarvis siga en el portatil mientras el grafico se proyecta.
            // Nace oculta y en el workspace del monitor headless; `set_wall`
            // la muestra cuando hay algo que ensenar.
            tauri::WebviewWindowBuilder::new(
                app,
                "wall",
                tauri::WebviewUrl::App("index.html?window=wall".into()),
            )
            .title("JarvisWall")
            .inner_size(1920.0, 1080.0)
            .decorations(false)
            // OCULTA al arrancar: si no, la pared nace en negro y ahi se queda
            // hasta que alguien despierte a Jarvis, porque quien la esconde es
            // `useWall3dMirror` y ese hook vive en AwakeApp.
            //
            // Hubo una version que la creaba visible culpando a WebKit de no
            // correr los efectos en ventanas ocultas. Era falso: lo que rompia
            // era el ACL de Tauri (faltaba `wall` en capabilities), que hacia
            // fallar `tauriListen` sin instalar el listener. Con el ACL puesto,
            // oculta funciona — el listener se registra y el saludo
            // WALL_READY_EVENT llega igual.
            .visible(false)
            .build()?;

            // On Linux/WebKit2GTK: auto-allow all permission requests (microphone, camera).
            // Without this, getUserMedia silently fails — WebKit has no browser chrome to
            // show a permission prompt inside a kiosk-style Tauri window.
            #[cfg(target_os = "linux")]
            for label in ["main", "ptt-overlay", "wall"] {
                if let Some(window) = app.get_webview_window(label) {
                    window.with_webview(move |webview| {
                        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                        let wv = webview.inner();
                        // console.* → stdout → journalctl. Sin esto el webview es una
                        // caja negra en producción (no hay devtools en el binario release).
                        if let Some(settings) = WebViewExt::settings(&wv) {
                            settings.set_enable_write_console_messages_to_stdout(true);
                        }
                        wv.connect_permission_request(|_, request| {
                            request.allow();
                            true
                        });
                        // WebKitWebProcess can die (observed: SIGSEGV inside WebKit's
                        // PipeWire client during getUserMedia). Tauri survives with a
                        // frozen window and no JS running — wake-bus, clap detection and
                        // gestures all dead until someone notices. Exit instead so
                        // systemd (Restart=on-failure) brings the whole UI back clean.
                        wv.connect_web_process_terminated(move |_, reason| {
                            eprintln!(
                                "[jarvis] WebKitWebProcess terminated ({reason:?}) on '{label}' — exiting for systemd restart"
                            );
                            std::process::exit(101);
                        });
                    })?;
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
