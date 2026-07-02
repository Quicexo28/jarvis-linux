#!/bin/bash
# Genera owner_voiceprint.enc desde los WAVs en samples/speaker/santiago/
# Uso: ./create-voiceprint.sh [speaker_name]

SPEAKER="${1:-santiago}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/../backend/voice/python/.venv"
SAMPLES="$HERE/../backend/voice/samples/speaker/$SPEAKER"
ENC_OUT="$HERE/../backend/voice/python/owner_voiceprint.enc"

WAV_COUNT=$(ls "$SAMPLES"/*.wav 2>/dev/null | wc -l)
if [ "$WAV_COUNT" -lt 3 ]; then
    echo "Error: necesitas al menos 3 muestras WAV en $SAMPLES (tienes $WAV_COUNT)"
    exit 1
fi

echo "Generando voiceprint desde $WAV_COUNT muestras de '$SPEAKER'..."

"$VENV/bin/python" - <<PYEOF
import json, os, sys, subprocess
from pathlib import Path
import numpy as np

HERE    = Path("$HERE")
SAMPLES = Path("$SAMPLES")
ENC_OUT = Path("$ENC_OUT")
SPEAKER = "$SPEAKER"

# Usar el mismo encoder que stt_service (SPEAKER_ENCODER=ecapa|resemblyzer)
sys.path.insert(0, str(HERE / "../backend/voice/python"))
from speaker_id import make_encoder, filter_consistent
from resemblyzer import preprocess_wav
import numpy as _np

encoder = make_encoder(os.environ.get("SPEAKER_ID_DEVICE", "cpu"))
print(f"Encoder: {encoder.name} (dim={encoder.dim})")

wavs = sorted(SAMPLES.glob("*.wav"))
print(f"Procesando {len(wavs)} archivos WAV...")

raw_embs, labels = [], []
for w in wavs:
    try:
        wav = preprocess_wav(w)
        emb = encoder.embed(wav)
        emb = emb / (_np.linalg.norm(emb) + 1e-9)
        raw_embs.append(emb)
        labels.append(w.name)
        print(f"  {w.name}: OK (dim={len(emb)})")
    except Exception as e:
        print(f"  {w.name}: ERROR - {e}")

# Excluir refs inconsistentes (eco/ruido aprendido) antes de cifrar.
filtered = filter_consistent(raw_embs, encoder.ref_floor, labels)
embeddings = [e.tolist() for e in filtered]

if len(embeddings) < 3:
    print("Error: no se pudieron procesar suficientes muestras")
    sys.exit(1)

# Obtener machine key
r = subprocess.run(
    ["secret-tool", "lookup", "service", "jarvis-linux", "account", "machine-key"],
    capture_output=True, text=True
)
hex_key = r.stdout.strip()
if len(hex_key) != 64:
    fallback = Path.home() / ".config" / "jarvis" / "machine.key"
    if fallback.exists():
        hex_key = fallback.read_text().strip()
    else:
        print("Error: no se encontró la machine key")
        sys.exit(1)

key = bytes.fromhex(hex_key)

# Cifrar con AES-256-GCM
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

payload = json.dumps({
    "version": 2,
    "speaker": SPEAKER,
    "encoder": encoder.name,
    "dim": encoder.dim,
    "threshold": encoder.default_threshold,
    "embeddings": embeddings,
}).encode()

iv = os.urandom(12)
enc = Cipher(algorithms.AES(key), modes.GCM(iv), backend=default_backend()).encryptor()
ct = enc.update(payload) + enc.finalize()
tag = enc.tag  # 16 bytes

ENC_OUT.write_bytes(iv + ct + tag)
print(f"\nVoiceprint guardado: {ENC_OUT}")
print(f"  Speaker : {SPEAKER}")
print(f"  Encoder : {encoder.name}")
print(f"  Muestras: {len(embeddings)}")
print(f"  Threshold: {encoder.default_threshold}")
PYEOF
