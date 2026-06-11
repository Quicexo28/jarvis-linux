#!/usr/bin/env bash
set -euo pipefail

JARVIS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
echo "[jarvis-install] Installing from: $JARVIS_DIR"

# systemd units reference %h/jarvis-linux — warn if the clone lives elsewhere.
if [ "$JARVIS_DIR" != "$HOME/jarvis-linux" ]; then
  echo "[jarvis-install] WARNING: repo is at $JARVIS_DIR but the systemd services"
  echo "                 expect \$HOME/jarvis-linux. Move/clone it there or edit the units."
fi

# ── System packages ──────────────────────────────────────────────────────────
echo "[jarvis-install] Installing system packages via pacman..."
sudo pacman -S --needed --noconfirm \
  nodejs npm \
  python python-pip \
  chromium \
  git \
  curl \
  ffmpeg \
  libsndfile \
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

# Torch first, picking the right wheel index: CUDA when an NVIDIA driver is
# active (XTTS runs on GPU), CPU-only otherwise (much smaller download).
if command -v nvidia-smi &> /dev/null && nvidia-smi &> /dev/null; then
  echo "[jarvis-install] NVIDIA GPU detected — installing torch with CUDA 12.1..."
  "$VENV/bin/pip" install "torch>=2.1.0" "torchaudio>=2.1.0" --index-url https://download.pytorch.org/whl/cu121
else
  echo "[jarvis-install] No NVIDIA GPU — installing CPU-only torch..."
  "$VENV/bin/pip" install "torch>=2.1.0" "torchaudio>=2.1.0" --index-url https://download.pytorch.org/whl/cpu
fi

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

# ── Hyprland integration (window rules + Ctrl+Alt+J wake bind) ───────────────
HYPR_CONF="$HOME/.config/hypr/hyprland.conf"
if [ -f "$HYPR_CONF" ]; then
  SOURCE_LINE="source = $JARVIS_DIR/scripts/linux/hyprland-jarvis.conf"
  if ! grep -qF "hyprland-jarvis.conf" "$HYPR_CONF"; then
    printf '\n# Jarvis assistant (window rules + wake hotkey)\n%s\n' "$SOURCE_LINE" >> "$HYPR_CONF"
    echo "[jarvis-install] Added Jarvis source line to $HYPR_CONF"
  else
    echo "[jarvis-install] Hyprland config already sources hyprland-jarvis.conf — skipped"
  fi
else
  echo "[jarvis-install] No Hyprland config found at $HYPR_CONF — skipping window rules/hotkey"
fi

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
