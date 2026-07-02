#!/bin/bash
# Record a voice sample for speaker enrollment.
# Usage:
#   ./record-voice-sample.sh [speaker_name] [sample_number]   # one 5s sample
#   ./record-voice-sample.sh --session [speaker_name]         # guided multi-condition session
#
# Multi-condition matters: voice embeddings capture the channel (distance to
# mic, loudness, time of day), not just the voice. Enrolling 5 conditions makes
# recognition robust where single-condition enrollment fails (far from mic,
# whispering, background noise).
# Output: backend/voice/samples/speaker/<name>/sample_<n>.wav

SESSION=0
if [ "$1" = "--session" ]; then
    SESSION=1
    shift
fi

SPEAKER="${1:-santiago}"
OUTDIR="$(dirname "$0")/../backend/voice/samples/speaker/$SPEAKER"
mkdir -p "$OUTDIR"

next_n() {
    local last
    last=$(ls "$OUTDIR"/sample_*.wav 2>/dev/null | grep -oP 'sample_\K[0-9]+' | sort -n | tail -1)
    echo $(( ${last:-0} + 1 ))
}

record_one() {
    local n="$1" secs="${2:-5}"
    local out
    out="$OUTDIR/sample_$(printf '%02d' "$n").wav"
    arecord -f S16_LE -r 16000 -c 1 -d "$secs" "$out"
    local size
    size=$(stat -c%s "$out" 2>/dev/null || echo 0)
    if [ "$size" -gt 1000 ]; then
        echo "Guardado: $out ($(numfmt --to=iec "$size"))"
        return 0
    fi
    rm -f "$out"
    echo "Error: la grabación está vacía o falló"
    return 1
}

if [ "$SESSION" = "1" ]; then
    CONDITIONS=(
        "NORMAL, cerca del micrófono (~50 cm). Habla con tu voz de siempre."
        "LEJOS del micrófono (2-3 metros). Habla con volumen normal."
        "VOZ BAJA, cerca del micrófono. Como hablando de noche."
        "VOZ ALTA / proyectada, distancia media. Como llamando desde otra parte del cuarto."
        "CON RUIDO de fondo (música baja, TV o ventilador). Distancia normal."
    )
    echo "Sesión de enrollment multi-condición para '$SPEAKER' (5 muestras de 5s)."
    echo "Frase sugerida (varíala un poco cada vez):"
    echo "  'Jarvis, soy $SPEAKER. Abre el plano, pon un temporizador y sube el volumen.'"
    echo ""
    for cond in "${CONDITIONS[@]}"; do
        echo "── Condición: $cond"
        read -rp "   Enter cuando estés listo... "
        record_one "$(next_n)" 5 || exit 1
        echo ""
    done
    echo "Sesión completa. Muestras totales: $(ls "$OUTDIR"/*.wav | wc -l)"
    echo "Regenera el voiceprint:  ./scripts/create-voiceprint.sh $SPEAKER"
    echo "Y recarga el STT:        curl -X POST http://localhost:8790/speaker-id/reload"
    exit 0
fi

N="${2:-$(next_n)}"
echo "Grabando muestra $N para '$SPEAKER'"
echo "Habla durante 5 segundos... (Ctrl+C para cancelar)"
echo ""
echo "Frases sugeridas:"
echo "  - 'Jarvis, ¿cómo estás? Soy Santiago, tu dueño.'"
echo "  - 'Buenos días Jarvis, prepara el resumen del día.'"
echo "  - 'Jarvis activa el modo noche y pon un temporizador de diez minutos.'"
echo ""

sleep 1
record_one "$N" 5 || exit 1
echo "Muestras totales para '$SPEAKER': $(ls "$OUTDIR"/*.wav | wc -l)"
