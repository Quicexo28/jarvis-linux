#!/usr/bin/env bash
set -euo pipefail

JARVIS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
echo "[jarvis-install] Installing from: $JARVIS_DIR"

# ── System packages ──────────────────────────────────────────────────────────
# Core runtime + the tools the PC-control service uses (ydotool for Wayland
# input, xdotool/wmctrl for X11, xdg-utils for app launching).
echo "[jarvis-install] Installing system packages via pacman..."
sudo pacman -S --needed --noconfirm \
  nodejs npm \
  python python-pip \
  chromium \
  git \
  portaudio \
  ydotool xdotool wmctrl xdg-utils

# Optional system packages — installed only if present in the repos, never fatal:
#   cloudflared : public HTTPS tunnel so the mobile QR works off-LAN (also in AUR)
# NVIDIA/CUDA (for GPU STT) is left to you — see the README "GPU" section.
echo "[jarvis-install] (optional) trying cloudflared for the QR tunnel..."
sudo pacman -S --needed --noconfirm cloudflared 2>/dev/null \
  || echo "  cloudflared not in repos — install from AUR (yay -S cloudflared) for off-LAN QR. Skipping (LAN/Tailscale still work)."

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
"$VENV/bin/pip" install --upgrade pip

# PyTorch FIRST, from the CUDA 11.8 wheels (matches the RTX 3050 / Ampere). For a
# CPU-only machine, override: JARVIS_TORCH_INDEX=https://download.pytorch.org/whl/cpu
TORCH_INDEX="${JARVIS_TORCH_INDEX:-https://download.pytorch.org/whl/cu118}"
echo "[jarvis-install] Installing torch + torchaudio from: $TORCH_INDEX"
"$VENV/bin/pip" install torch torchaudio --index-url "$TORCH_INDEX"

echo "[jarvis-install] Installing Python dependencies..."
"$VENV/bin/pip" install -r "$JARVIS_DIR/backend/voice/python/requirements.txt"

# openWakeWord (optional voice wake; clap/hotkey wake works without it)
"$VENV/bin/pip" install "openWakeWord>=0.6.0" pyaudio aiohttp

# ── Config directory ──────────────────────────────────────────────────────────
CONFIG_DIR="$HOME/.config/jarvis"
echo "[jarvis-install] Creating config dir at $CONFIG_DIR..."
mkdir -p "$CONFIG_DIR"

# ── systemd user services ─────────────────────────────────────────────────────
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

# NOTE: service files use %h (systemd's home-directory specifier) — no sed needed.
# This assumes Jarvis is cloned to ~/jarvis-linux (i.e. %h/jarvis-linux).
# Core services are always enabled. The Telegram bots exit cleanly when their
# tokens aren't set, and PC control degrades gracefully — all safe to enable.
CORE_SVCS="jarvis-backend jarvis-stt jarvis-tts jarvis-wake jarvis-ui"
EXTRA_SVCS="jarvis-cloudbot jarvis-jarvisbot jarvis-pccontrol"

echo "[jarvis-install] Installing systemd user services..."
for svc in $CORE_SVCS $EXTRA_SVCS; do
  cp "$JARVIS_DIR/scripts/linux/$svc.service" "$SYSTEMD_DIR/$svc.service"
  echo "  → $svc.service"
done

systemctl --user daemon-reload

for svc in $CORE_SVCS $EXTRA_SVCS; do
  systemctl --user enable "$svc"
  echo "  → enabled $svc"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Installation complete."
echo ""
echo " To start Jarvis now:"
echo "   systemctl --user start jarvis-backend jarvis-stt jarvis-tts jarvis-ui"
echo ""
echo " On next login all services start automatically."
echo " Logs: journalctl --user -u jarvis-backend -f"
echo ""
echo " NEXT STEPS (optional):"
echo "   • Secrets/tokens  → create backend/data/secrets.local.json (see README)."
echo "   • Self-coding pw  → cd backend && npm run set-code-password"
echo "   • Owner voice     → cd backend/voice/python && .venv/bin/python make_owner_voiceprint.py"
echo "   • PC-control input on Wayland needs the ydotoold daemon + /dev/uinput"
echo "     access:  sudo systemctl enable --now ydotool   (and add yourself to the"
echo "     'input' group, or set up a udev rule for uinput). X11 uses xdotool, no daemon."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
