#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# Jarvis + Omarchy one-script setup for a fresh CachyOS install.
#
#   git clone https://github.com/quicexo28/jarvis-linux ~/jarvis-linux
#   cd ~/jarvis-linux && ./setup.sh
#
# The script is idempotent and runs in phases, detecting what is already done:
#   Phase 1 — Omarchy on CachyOS (Hyprland desktop). Ends in a reboot:
#             log into Hyprland and run ./setup.sh again to continue.
#   Phase 2 — Claude CLI (Jarvis answers through `claude --print`).
#   Phase 3 — Jarvis itself: deps, Python venv, systemd user services,
#             Hyprland window rules + Ctrl+Alt+J wake hotkey.
#   Phase 4 — NVIDIA quality-of-life: Chromium VA-API decode flags.
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$SCRIPT_DIR" != "$HOME/jarvis-linux" ]; then
  echo "WARNING: this repo is at $SCRIPT_DIR but the systemd services expect"
  echo "         \$HOME/jarvis-linux. Clone/move it there for autostart to work."
fi

step() { echo ""; echo "━━━ $1 ━━━"; }

# ── Phase 1: Omarchy on CachyOS ──────────────────────────────────────────────
step "Phase 1/4: Omarchy desktop"
if [ -d "$HOME/.local/share/omarchy" ]; then
  echo "Omarchy already installed — skipping."
else
  echo "Omarchy not found. Installing Omarchy-on-CachyOS now (interactive)."
  echo "When it finishes, REBOOT, log into Hyprland, then run ./setup.sh again."
  echo ""
  chmod +x "$SCRIPT_DIR/scripts/omarchy/"*.sh
  "$SCRIPT_DIR/scripts/omarchy/install-omarchy-on-cachyos.sh"
  echo ""
  echo "Omarchy installation finished. Reboot, log into Hyprland, and run"
  echo "  cd ~/jarvis-linux && ./setup.sh"
  echo "to continue with Claude CLI + Jarvis."
  exit 0
fi

# ── Phase 2: Claude CLI ──────────────────────────────────────────────────────
step "Phase 2/4: Claude CLI"
if command -v claude &> /dev/null; then
  echo "Claude CLI already installed: $(claude --version 2>/dev/null || echo ok)"
else
  if command -v yay &> /dev/null; then
    echo "Installing claude-code from AUR..."
    yay -S --needed --noconfirm claude-code || INSTALL_NPM=1
  else
    INSTALL_NPM=1
  fi
  if [ "${INSTALL_NPM:-}" = "1" ]; then
    echo "Installing @anthropic-ai/claude-code via npm..."
    sudo pacman -S --needed --noconfirm nodejs npm
    sudo npm install -g @anthropic-ai/claude-code
  fi
fi

# ── Phase 3: Jarvis ──────────────────────────────────────────────────────────
step "Phase 3/4: Jarvis assistant"
chmod +x "$SCRIPT_DIR/scripts/linux/install.sh"
"$SCRIPT_DIR/scripts/linux/install.sh"

# ── Phase 4: NVIDIA Chromium QoL ─────────────────────────────────────────────
step "Phase 4/4: NVIDIA Chromium flags"
if command -v nvidia-smi &> /dev/null && nvidia-smi &> /dev/null; then
  FLAGS_FILE="$HOME/.config/chromium-flags.conf"
  if ! grep -qs "VaapiOnNvidiaGPUs" "$FLAGS_FILE"; then
    echo "--enable-features=VaapiOnNvidiaGPUs" >> "$FLAGS_FILE"
    echo "Added VA-API decode flag to $FLAGS_FILE"
  else
    echo "Chromium VA-API flag already present."
  fi
else
  echo "No NVIDIA GPU active — skipping."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Setup complete. Remaining manual steps:"
echo ""
echo " 1) Log into Claude CLI (one time):  claude"
echo " 2) Enroll your voice: open Jarvis (Ctrl+Alt+J or systemctl --user"
echo "    start jarvis-ui) and record >=1 sample in the SpeakerIdPanel."
echo "    Until enrolled, all voice turns are ignored."
echo " 3) Set JARVIS_OWNER_SPEAKER in"
echo "    ~/.config/systemd/user/jarvis-backend.service, then:"
echo "      systemctl --user daemon-reload && systemctl --user restart jarvis-backend"
echo " 4) Reload Hyprland for the wake hotkey:  hyprctl reload"
echo ""
echo " Services start automatically on every login."
echo " Logs: journalctl --user -u jarvis-backend -f"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
