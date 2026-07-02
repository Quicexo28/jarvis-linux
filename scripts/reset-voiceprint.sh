#!/bin/bash
# Re-enrola la huella de voz del dueño DESDE CERO.
#
# Qué hace:
#   1. Respalda el voiceprint cifrado viejo y las muestras WAV aprendidas.
#   2. Borra el seed hardcodeado (owner_voiceprint.enc) + todas las WAV viejas.
#   3. Graba N muestras nuevas y limpias con tu voz.
#   4. Regenera owner_voiceprint.enc SOLO con las muestras nuevas.
#   5. Recarga el servicio STT para que use la huella nueva.
#
# Uso: ./reset-voiceprint.sh [speaker_name] [num_muestras]
#   speaker_name  default: santiago
#   num_muestras  default: 6   (mínimo 3)

set -e

SPEAKER="${1:-santiago}"
N_SAMPLES="${2:-6}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
SAMPLES="$ROOT/backend/voice/samples/speaker/$SPEAKER"
ENC="$ROOT/backend/voice/python/owner_voiceprint.enc"
STT_URL="${STT_URL:-http://localhost:8790}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/backend/voice/samples/_voiceprint-backup-$STAMP"

if [ "$N_SAMPLES" -lt 3 ]; then
    echo "Error: necesitas al menos 3 muestras (pediste $N_SAMPLES)"
    exit 1
fi

echo "==> Re-enrolamiento de voz para '$SPEAKER' ($N_SAMPLES muestras)"
echo ""

# --- 1 + 2: respaldar y borrar lo viejo ------------------------------------
mkdir -p "$BACKUP"
if [ -f "$ENC" ]; then
    cp "$ENC" "$BACKUP/owner_voiceprint.enc.old"
    rm -f "$ENC"
    echo "  Seed viejo respaldado en $BACKUP y borrado."
fi
if [ -d "$SAMPLES" ] && ls "$SAMPLES"/*.wav >/dev/null 2>&1; then
    cp "$SAMPLES"/*.wav "$BACKUP"/ 2>/dev/null || true
    rm -f "$SAMPLES"/*.wav
    echo "  Muestras WAV viejas respaldadas y borradas."
fi
mkdir -p "$SAMPLES"
echo ""

# --- 3: grabar muestras nuevas ---------------------------------------------
for i in $(seq 1 "$N_SAMPLES"); do
    echo "--- Muestra $i de $N_SAMPLES ---"
    "$HERE/record-voice-sample.sh" "$SPEAKER" "$i"
    echo ""
done

# --- 4: regenerar voiceprint -----------------------------------------------
echo "==> Generando huella nueva..."
"$HERE/create-voiceprint.sh" "$SPEAKER"

# --- 5: recargar STT --------------------------------------------------------
echo ""
echo "==> Recargando speaker-id en STT..."
if curl -fsS -X POST "$STT_URL/speaker-id/reload" >/dev/null 2>&1; then
    echo "  STT recargado. Huella nueva activa."
else
    echo "  No pude recargar vía API. Reinicia manual: systemctl --user restart jarvis-stt"
fi
echo ""
echo "Listo. Respaldo viejo en: $BACKUP"
