#!/usr/bin/env bash
# setup-from-migration.sh
# Despliega el bundle de migración de Windows en esta máquina Linux.
# Ejecutar UNA VEZ después de install.sh con el zip generado por pack-migration.ps1.
#
#   bash scripts/linux/setup-from-migration.sh ~/jarvis-migration.zip
#
# El script preguntará la contraseña de owner para desbloquear la bóveda.

set -euo pipefail

BUNDLE="${1:-}"
JARVIS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
    echo "[setup] Uso: bash scripts/linux/setup-from-migration.sh <ruta/jarvis-migration.zip>"
    exit 1
fi

echo "[setup] Instalando migración desde: $BUNDLE"
echo "[setup] Directorio Jarvis: $JARVIS_DIR"

# ── Extraer bundle ────────────────────────────────────────────────────────────
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

unzip -q "$BUNDLE" -d "$TMP_DIR"
echo "[setup] Bundle extraído."

# ── Datos de Jarvis (vault + recordatorios) ───────────────────────────────────
DATA_DIR="$JARVIS_DIR/backend/data"
mkdir -p "$DATA_DIR"

if [[ -f "$TMP_DIR/jarvis-portable.enc" ]]; then
    cp "$TMP_DIR/jarvis-portable.enc" "$DATA_DIR/jarvis-portable.enc"
    echo "[setup] jarvis-portable.enc → $DATA_DIR/"
else
    echo "[error] jarvis-portable.enc no encontrado en el bundle."
    exit 1
fi

if [[ -f "$TMP_DIR/reminders.json" ]]; then
    cp "$TMP_DIR/reminders.json" "$DATA_DIR/reminders.json"
    echo "[setup] reminders.json → $DATA_DIR/"
fi

# ── Obsidian vault ────────────────────────────────────────────────────────────
if [[ -d "$TMP_DIR/Jarvis-Vault" ]]; then
    VAULT_DEST="$HOME/Jarvis-Vault"
    if [[ -d "$VAULT_DEST" ]]; then
        echo "[setup] Jarvis-Vault ya existe en $VAULT_DEST — fusionando (rsync)..."
        rsync -a --ignore-existing "$TMP_DIR/Jarvis-Vault/" "$VAULT_DEST/"
    else
        cp -r "$TMP_DIR/Jarvis-Vault" "$VAULT_DEST"
        echo "[setup] Jarvis-Vault → $VAULT_DEST"
    fi
    echo "[setup] Actualiza JARVIS_OBSIDIAN_VAULT en secrets.local.json si la ruta es distinta."
fi

# ── Desbloquear bóveda (secrets + voiceprint) ─────────────────────────────────
echo ""
echo "[setup] Desbloqueando bóveda portable (ingresa tu contraseña de owner)..."
cd "$JARVIS_DIR"
node backend/scripts/unlock.js

# ── Recargar y habilitar servicios ───────────────────────────────────────────
echo ""
echo "[setup] Recargando servicios systemd..."
systemctl --user daemon-reload

echo "[setup] Iniciando servicios Jarvis..."
for svc in jarvis-backend jarvis-stt jarvis-tts jarvis-wake jarvis-ui; do
    systemctl --user start "$svc" 2>/dev/null && echo "  → started $svc" || echo "  [warn] $svc no pudo iniciar (¿install.sh corrió primero?)"
done

echo ""
echo "[setup] Iniciando bots Telegram..."
for svc in jarvis-jarvisbot jarvis-cloudbot jarvis-notifier; do
    systemctl --user start "$svc" 2>/dev/null && echo "  → started $svc" || echo "  [warn] $svc no pudo iniciar"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Migración completa."
echo ""
echo " Verifica estado:"
echo "   systemctl --user status jarvis-backend"
echo "   systemctl --user status jarvis-jarvisbot"
echo ""
echo " Logs:"
echo "   journalctl --user -u jarvis-backend -f"
echo "   journalctl --user -u jarvis-jarvisbot -f"
echo ""
echo " Si el voiceprint no funciona, re-enrola en Linux:"
echo "   cd backend/voice/python"
echo "   .venv/bin/python make_owner_voiceprint.py"
echo "   cd ../.. && node backend/scripts/make-portable.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
