#!/usr/bin/env bash
set -euo pipefail

JARVIS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
echo "[jarvis-install] Installing from: $JARVIS_DIR"

# ── System packages ──────────────────────────────────────────────────────────
echo "[jarvis-install] Installing system packages via pacman..."
sudo pacman -S --needed --noconfirm \
  nodejs npm \
  python python-pip \
  chromium \
  git \
  portaudio

# ── Node.js dependencies ─────────────────────────────────────────────────────
echo "[jarvis-install] Installing backend Node.js dependencies..."
cd "$JARVIS_DIR/backend" && npm install

echo "[jarvis-install] Installing frontend Node.js dependencies..."
cd "$JARVIS_DIR/frontend" && npm install

# ── Build frontend ────────────────────────────────────────────────────────────
echo "[jarvis-install] Building frontend..."
cd "$JARVIS_DIR/frontend" && npm run build

# ── Python virtual environment ────────────────────────────────────────────────
VENV="$JARVIS_DIR/backend/voice/python/.venv"
echo "[jarvis-install] Creating Python venv at $VENV..."
python -m venv "$VENV"

echo "[jarvis-install] Installing Python dependencies..."
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install -r "$JARVIS_DIR/backend/voice/python/requirements.txt"

# openWakeWord (in requirements.txt via extras; install explicitly for onnxruntime pull-in)
"$VENV/bin/pip" install "openWakeWord>=0.6.0"

# ── Config directory ──────────────────────────────────────────────────────────
CONFIG_DIR="$HOME/.config/jarvis"
echo "[jarvis-install] Creating config dir at $CONFIG_DIR..."
mkdir -p "$CONFIG_DIR"

# ── systemd user services ─────────────────────────────────────────────────────
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

echo "[jarvis-install] Installing systemd user services..."
# NOTE: service files use %h which is the native systemd home-directory specifier.
# systemd expands it automatically — no sed replacement needed.
# This assumes Jarvis is cloned to ~/jarvis-linux (i.e. %h/jarvis-linux).
for svc in jarvis-backend jarvis-stt jarvis-tts jarvis-wake jarvis-ui; do
  cp "$JARVIS_DIR/scripts/linux/$svc.service" "$SYSTEMD_DIR/$svc.service"
  echo "  → $svc.service"
done

systemctl --user daemon-reload

for svc in jarvis-backend jarvis-stt jarvis-tts jarvis-wake jarvis-ui; do
  systemctl --user enable "$svc"
  echo "  → enabled $svc"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Installation complete."
echo ""
echo " To start Jarvis now:"
echo "   systemctl --user start jarvis-backend"
echo "   systemctl --user start jarvis-stt"
echo "   systemctl --user start jarvis-tts"
echo "   systemctl --user start jarvis-ui"
echo ""
echo " On next login all services start automatically."
echo " Logs: journalctl --user -u jarvis-backend -f"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
