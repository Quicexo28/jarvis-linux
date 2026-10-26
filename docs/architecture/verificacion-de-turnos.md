# Verificación de turnos

> Extraído de CLAUDE.md. Detalle de referencia: leer antes de tocar esta zona.

### Verificación de turnos (¿de verdad pasó?)

`lib/verifier.js` comprueba, DESPUÉS de que la respuesta salió a TTS (coste cero en latencia), que lo dicho coincide con lo que ocurrió. Generaliza el antiguo `enforceDisplayClaim` de `speech.js`, que cubría un solo síntoma (enlaces dichos en voz sin tarjeta). Cuatro chequeos, en este orden, y **como mucho UN correctivo por turno** (Jarvis no puede hablar encima de sí mismo). El veredicto se guarda en la columna `verdict` de `turns` y sale agregado en `/api/jarvis/stats` (`byVerdict`). Kill switch `JARVIS_VERIFY=0`; el de display sigue siendo `JARVIS_ENFORCE_DISPLAY=0`.

- **A. Honestidad ante el fallo** — si alguna tool devolvió `is_error`, ¿la respuesta lo admite (`tool_error_reported`) o lo tapó (`false_success`)? Este es el peor modo de fallo de un asistente de voz y era invisible: la palabra del modelo era la única evidencia que producía un turno.
- **B. Postcondiciones** — para tools que "salieron bien", se consulta el estado REAL por el skill bus: `open_view` → `view_current` coincide, `timer.start`/`chrono.start` → la lista tiene algo, `timer.cancel(all)` → la lista quedó vacía, `show_display` → llegó al backend. **Devolver `null` significa "no comprobable" y NUNCA es fallo** (renderer caído, sin input): un turno inverificable no puede reportarse como mentira. `requestClient` devuelve el objeto INTERIOR (`{timers:[]}`, `{mode:'plan3d'}`), no el `{ok,result}` de la ruta HTTP.
- **C. Reglas de display** — las de siempre, movidas tal cual. **Van ANTES del chequeo D**: una respuesta que nombra una herramienta también parece una afirmación de acción, y con el orden inverso el chequeo genérico tapaba al específico (visto en vivo: la recomendación de navegador se clasificó `unbacked_claim` en vez de `display_missing`).
- **D. Afirmación sin respaldo** — la respuesta dice que hizo algo y no se llamó ninguna tool.

Lo que NO es obvio:

- **Una tool que falla y el modelo REMONTA no es una mentira.** Visto en vivo: `Bash` fue rechazada (está deshabilitada para la sesión), el modelo cayó a `run_terminal`, obtuvo la respuesta y la contó bien — y la primera versión lo calificó `false_success`. Disparar el correctivo ahí le diría al señor que algo falló cuando no falló, que es peor que el fallo que evita. `recovered()` mira la ÚLTIMA llamada del turno: si la acción final salió bien, la respuesta se apoya en ese éxito. Veredicto propio `tool_error_recovered` para que siga siendo visible en las estadísticas.
- **El texto de un turno correctivo SE DESCARTA — nadie lo pronuncia.** No existe primitiva `speak` en `frontend/src/skills/primitives.ts`, así que el backend no puede hacer hablar al renderer. Por eso los correctivos NUNCA se redactan como "dile la verdad al señor" (esa frase se perdería): ordenan una ACCIÓN con efecto real — reintentar la tool, o `show_display` con el mensaje. Verificado en vivo: `[verify] tool without UI action` → `[tool] display_show -> ok`. Una primitiva `speak` es la mejora natural, y es trabajo de frontend.
- **Los clasificadores corren sobre texto SIN TILDES en minúsculas** (`normalizeReply`). Misma trampa que las wake phrases: `\b` solo entiende ASCII, así que sobre "Falló al guardar" no hay frontera tras la "ó" y `/\bfall[óo]\b/` no casaba — la respuesta HONESTA se habría calificado de mentira.
- **Los participios pasados son también adjetivos.** "Firefox es de código **abierto**" disparó `unbacked_claim` en la primera versión. Ahora los participios solo cuentan en respuestas cortas (≤60 caracteres, o sea confirmaciones secas); los verbos en primera persona ("abrí", "apagué") valen a cualquier longitud. Casos reales de journald en `tests/verifier.unit.test.js`.
- **La verificación se dispara desde el WRAPPER, no desde el pipeline interno**: necesita `ctx.turnId`, que solo existe después de `recordTurn`. Lanzarla desde dentro competía con la asignación del id y el veredicto se perdía.
- El arnés `npm run eval:voice` espera al veredicto antes de aserciar, exige `verdict: "ok"` en los casos con tool, y **falla SIEMPRE ante `false_success` o `unbacked_claim`**, se hayan declarado o no.

