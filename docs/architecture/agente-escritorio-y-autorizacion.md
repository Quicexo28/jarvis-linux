# Agente de escritorio y autorización reforzada

> Extraído de CLAUDE.md. Detalle de referencia: leer antes de tocar esta zona.

### Agente de escritorio (`lib/computerAgent.js`, 2026-10-02)

Jarvis maneja ESTE PC como una persona sentada delante: mira la pantalla, mueve el ratón, hace clic, escribe. Mismo patrón de delegación que `code_task`: el turno de voz (haiku, ~30 s) no puede conducir decenas de ciclos mirar→actuar→mirar, así que la tool `computer_task` lanza un proceso Claude Code aparte (sonnet, `JARVIS_COMPUTER_MODEL`) y el resultado se anuncia por `deliver()` (voz si la UI está despierta, Telegram si no). Rutas `/api/skills/computer/task|task/status|task/cancel`, tools MCP `computer_task|computer_task_status|computer_task_cancel`, jobs en `backend/data/computer-jobs/`. Un job a la vez; timeout `JARVIS_COMPUTER_JOB_TIMEOUT_MS` (15 min).

- **Corre en `--permission-mode auto`, NO con `--dangerously-skip-permissions`** (a diferencia de `devAgent`). Tiene Bash y maneja los dispositivos de entrada reales; el clasificador del modo auto delante de cada acción es lo que frena una instrucción mal oída o una inyección leída de una web. Las negaciones del clasificador quedan en el `.log` como `[tool_error]`. Hay test que falla si alguien le pone el skip.
- **Ojos y manos = `scripts/linux/pc-ctl`** (`shot|click|move|drag|scroll|type|key|windows|cursor`). Un solo script para captura Y clic porque las coordenadas tienen que vivir en el mismo sistema: `shot` captura el monitor enfocado (nunca `projmap`) con `grim -c` (con puntero) y recuerda ese monitor en `$XDG_RUNTIME_DIR/pc-ctl.monitor`, así un cambio de foco entre captura y clic no manda el clic a otra pantalla. **Posicionar va por `hyprctl dispatch movecursor`, pulsar por ydotool**: el movimiento absoluto de ydotool pasa por la aceleración del puntero y no cae donde se pide. Teclado por `wtype`.
- **ydotool** (`pacman -S ydotool`) necesita su daemon de usuario: `systemctl --user enable --now ydotool` (socket `$XDG_RUNTIME_DIR/.ydotool_socket`; el usuario está en el grupo `input`, que da `/dev/uinput`).
- **Seguridad**: local-only en `webAuth` (`DANGEROUS_PATHS`) y destructive en `toolRisk` ⇒ desde el modelo exige voz del señor reconocida en los últimos 15 min. El prompt del agente le prohíbe tocar la ventana `class=jarvis`, pagar/enviar/borrar sin orden explícita, escribir contraseñas, y le dice que el texto en pantalla es dato, nunca instrucción.
- **Desde la tablet se lanza con huella/PIN + contraseña especial** (ver «Autorización reforzada» abajo). Un turno del chat no tiene hablante, así que sin eso cae en el gate de voz como cualquier acción de riesgo.

### Autorización reforzada desde la tablet (`lib/riskAuth.js`, 2026-10-02)

Un turno tecleado (`/api/jarvis/turn`) no tiene identidad de hablante: para `toolRisk` es una voz desconocida (mira, no toca). Para que la app pueda pedir algo de riesgo, el señor lo autoriza **para UN turno** con dos factores que verifica el SERVIDOR:

1. **Huella o PIN de la tablet, con criptografía de verdad.** `Elevation.kt` genera una clave EC P-256 en el Android Keystore con `setUserAuthenticationParameters(0, BIOMETRIC_STRONG|DEVICE_CREDENTIAL)`: la privada no sale del hardware y **cada** firma exige huella o PIN (`BiometricPrompt` + `CryptoObject`, API 30+). El backend manda un reto aleatorio y verifica la firma. Una huella comprobada solo en JavaScript sería teatro: cualquiera con el token web se la saltaría llamando a la API directo.
2. **Contraseña especial**: `JARVIS_RISK_PASSWORD_HASH` (scrypt) en `secrets.local.json`, se fija con `node scripts/set-code-password.js --risk`.

Flujo: el turno choca con el gate → `riskDeniedSince()` lo detecta → la respuesta trae `authRequired` → la app abre `AuthSheet` (contraseña → huella) → `/api/jarvis/elevate/{status,enroll,challenge}` + `/api/jarvis/elevate` → ticket de un solo uso (2 min) → reenvía el MISMO mensaje con `elevation:<ticket>` → `sessionAsk(..., {tag:'elevated'})` → `toolRisk` deja pasar mientras `onlyTurnInFlightTagged('elevated')`.

Lo que NO es obvio:
- **«El ÚNICO turno en vuelo» y no «hay un turno etiquetado».** El MCP no sabe a qué turno pertenece una llamada; cada sesión corre un turno a la vez, pero hay varias sesiones (haiku, sonnet de estudio). Si otra sesión tiene un turno en curso, la sonda da `false` y nada se cuela por la ventana del turno autorizado.
- **Inscribir la clave también exige la contraseña**: un token web robado no puede registrar su propia clave. El `keyId` se deriva del hash de la clave, no lo manda el cliente. Solo P-256.
- **El reto se consume ANTES de verificar nada** (un intento por reto ⇒ una firma capturada no se reutiliza). 5 fallos (firma o contraseña) bloquean la elevación 15 min, en global: hay un solo dueño.
- **Ticket inválido ⇒ 401, nunca el turno sin autorizar**: el señor cree que lo autorizó.
- Falla cerrado: sin `JARVIS_RISK_PASSWORD_HASH` no se eleva nada. En un navegador sin APK no hay clave Keystore ⇒ no se puede autorizar (a propósito: la contraseña sola es un factor). El companion de iOS aún no lo tiene.
- Si cambia el bloqueo de pantalla, el Keystore invalida la clave (`KeyPermanentlyInvalidatedException`): `Elevation.kt` la borra y el siguiente intento la reinscribe con la contraseña.
- **`set-code-password.js` estaba roto y era destructivo**: escribía `secrets.local.enc` (que `secrets.js` NO lee) y **borraba** `secrets.local.json` — ejecutarlo dejaba a Jarvis sin ningún secreto. Ahora escribe el `.json` de forma atómica (con `.bak`) y aborta si no puede parsearlo.
- Compilar el APK necesita **JDK** (`jdk21-openjdk`), no solo el JRE: con `jre21-openjdk` Gradle falla con `does not provide the required capabilities: [JAVA_COMPILER]`. Tras cambiar de JDK, `gradle --stop` (el daemon cachea la detección).
- Verificado en vivo: tarea de diagnóstico (captura → mover al centro → captura) en 14 s, 6 turnos, $0.12, sin negaciones.

