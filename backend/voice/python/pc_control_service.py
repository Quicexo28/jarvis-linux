#!/usr/bin/env python3
"""
PC Control sidecar (Linux port) — FastAPI on port 8792.

This is the Linux equivalent of the Windows `pc_control_service.py`. It exposes
the SAME HTTP endpoints (paths, request bodies, response keys) so the Node proxy
(`backend/src/handlers/pcControl.js`) and the voice MCP tools work unchanged.

Linux has no single UI-Automation API and no single window manager, so each
feature is driven by whatever system tool is present, picked at call time:

  Feature                | Wayland (Hyprland)        | Wayland (Sway) | X11
  -----------------------|---------------------------|----------------|--------------------------
  windows / active / focus | hyprctl -j ...          | swaymsg -t ... | wmctrl / xdotool
  type / keys / click / move | ydotool (via ydotoold)  | ydotool        | ydotool or xdotool
  read_ui (accessibility tree) | NOT SUPPORTED — degrades to the window list
  launch                 | alias -> which -> gtk-launch -> xdg-open (all sessions)
  processes / kill       | psutil (all sessions)

Session detection uses XDG_SESSION_TYPE / WAYLAND_DISPLAY, plus
HYPRLAND_INSTANCE_SIGNATURE (Hyprland) and SWAYSOCK (Sway).

INPUT NOTE: `ydotool` is the Wayland-capable injector but needs the `ydotoold`
daemon running (it talks to /dev/uinput). On X11, `xdotool` works without a
daemon. If neither binary is installed, input endpoints return
{"ok": false, "error": "no_input_tool", ...}.

Design rule: this service must NEVER crash. Every handler wraps its work in
try/except and returns JSON {"ok": false, "error": "..."} on failure so callers
degrade gracefully instead of hitting a 500/connection drop.

Imports are limited to: fastapi, uvicorn, pydantic, psutil, subprocess, shutil,
json, os, signal.
"""

import json
import os
import shutil
import signal
import subprocess
from typing import Optional

import psutil
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

PORT = int(os.environ.get("PC_CONTROL_PORT", "8792"))

# Common spoken/typed names -> Linux binary. Lists are tried in order; the first
# binary found on PATH wins. Spanish aliases included to match the voice brain.
APP_ALIASES = {
    "spotify":     ["spotify", "spotify-launcher"],
    "chrome":      ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"],
    "navegador":   ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "firefox"],
    "browser":     ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "firefox"],
    "chromium":    ["chromium", "chromium-browser"],
    "firefox":     ["firefox"],
    "edge":        ["microsoft-edge-stable", "microsoft-edge"],
    "code":        ["code", "codium", "code-oss"],
    "vscode":      ["code", "codium", "code-oss"],
    "terminal":    ["kitty", "alacritty", "wezterm", "foot", "gnome-terminal", "konsole", "xterm"],
    "terminala":   ["kitty", "alacritty", "wezterm", "foot", "gnome-terminal", "konsole", "xterm"],
    "files":       ["nautilus", "dolphin", "thunar", "nemo", "pcmanfm"],
    "archivos":    ["nautilus", "dolphin", "thunar", "nemo", "pcmanfm"],
    "explorer":    ["nautilus", "dolphin", "thunar", "nemo", "pcmanfm"],
    "calc":        ["gnome-calculator", "kcalc", "qalculate-gtk"],
    "calculadora": ["gnome-calculator", "kcalc", "qalculate-gtk"],
    "bloc":        ["gnome-text-editor", "gedit", "kate", "mousepad"],
    "bloc de notas": ["gnome-text-editor", "gedit", "kate", "mousepad"],
    "notepad":     ["gnome-text-editor", "gedit", "kate", "mousepad"],
    "editor":      ["gnome-text-editor", "gedit", "kate", "mousepad"],
    "discord":     ["discord", "vesktop"],
    "slack":       ["slack"],
    "telegram":    ["telegram-desktop", "telegram"],
    "whatsapp":    ["whatsapp-for-linux", "whatsapp"],
    "vlc":         ["vlc"],
    "paint":       ["pinta", "krita", "gimp"],
    "taskmgr":     ["gnome-system-monitor", "ksysguard", "plasma-systemmonitor", "htop"],
    "administrador de tareas": ["gnome-system-monitor", "ksysguard", "plasma-systemmonitor", "htop"],
    "settings":    ["gnome-control-center", "systemsettings"],
    "ajustes":     ["gnome-control-center", "systemsettings"],
}


# --- Request models (identical shapes to the Windows service) ---

class ReadUiBody(BaseModel):
    title: Optional[str] = None

class LaunchBody(BaseModel):
    name: str
    path: Optional[str] = None

class FocusBody(BaseModel):
    title: str

class KillBody(BaseModel):
    pid: Optional[int] = None
    name: Optional[str] = None

class TypeBody(BaseModel):
    text: str

class KeysBody(BaseModel):
    combo: str

class ClickBody(BaseModel):
    x: Optional[int] = None
    y: Optional[int] = None
    button: str = "left"

class MouseMoveBody(BaseModel):
    x: int
    y: int


# --- Environment / tool detection ---

def _detect_session():
    """Return (session_type, compositor).

    session_type: 'wayland' | 'x11' | 'unknown'
    compositor:   'hyprland' | 'sway' | 'x11' | 'unknown'
    """
    sess = (os.environ.get("XDG_SESSION_TYPE") or "").strip().lower()
    if not sess:
        sess = "wayland" if os.environ.get("WAYLAND_DISPLAY") else ("x11" if os.environ.get("DISPLAY") else "unknown")

    if os.environ.get("HYPRLAND_INSTANCE_SIGNATURE"):
        comp = "hyprland"
    elif os.environ.get("SWAYSOCK"):
        comp = "sway"
    elif sess == "x11" or os.environ.get("DISPLAY"):
        comp = "x11"
    else:
        comp = "unknown"
    return sess, comp


def _tools():
    return {
        "ydotool": shutil.which("ydotool") is not None,
        "xdotool": shutil.which("xdotool") is not None,
        "wmctrl":  shutil.which("wmctrl") is not None,
        "hyprctl": shutil.which("hyprctl") is not None,
        "swaymsg": shutil.which("swaymsg") is not None,
    }


def _run(cmd, timeout=5, input_text=None):
    """subprocess.run wrapper -> (ok, stdout, err_string)."""
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_text,
        )
        if r.returncode != 0:
            return False, r.stdout or "", (r.stderr or "").strip() or f"exit_{r.returncode}"
        return True, r.stdout or "", None
    except FileNotFoundError:
        return False, "", f"tool_not_found:{cmd[0]}"
    except subprocess.TimeoutExpired:
        return False, "", "timeout"
    except Exception as e:
        return False, "", str(e)


def _input_tool():
    """Pick the input injector. Prefer ydotool (Wayland-capable), else xdotool."""
    if shutil.which("ydotool"):
        return "ydotool"
    if shutil.which("xdotool"):
        return "xdotool"
    return None


# --- Key combo translation ---

# ydotool key uses Linux input-event-codes key NAMES; xdotool uses X keysyms.
# We normalize spoken modifiers, then map per tool.
_MOD_ALIASES = {
    "control": "ctrl", "ctrl": "ctrl",
    "alt": "alt", "option": "alt",
    "shift": "shift",
    "super": "super", "win": "super", "windows": "super", "meta": "super", "cmd": "super",
}

_YDOTOOL_KEYMAP = {
    "ctrl": "KEY_LEFTCTRL",
    "alt": "KEY_LEFTALT",
    "shift": "KEY_LEFTSHIFT",
    "super": "KEY_LEFTMETA",
    "enter": "KEY_ENTER", "return": "KEY_ENTER",
    "esc": "KEY_ESC", "escape": "KEY_ESC",
    "tab": "KEY_TAB",
    "space": "KEY_SPACE",
    "backspace": "KEY_BACKSPACE",
    "delete": "KEY_DELETE", "del": "KEY_DELETE",
    "up": "KEY_UP", "down": "KEY_DOWN", "left": "KEY_LEFT", "right": "KEY_RIGHT",
    "home": "KEY_HOME", "end": "KEY_END",
    "pageup": "KEY_PAGEUP", "pagedown": "KEY_PAGEDOWN",
}
for _i in range(1, 13):
    _YDOTOOL_KEYMAP[f"f{_i}"] = f"KEY_F{_i}"


def _ydotool_key_token(part):
    p = part.strip().lower()
    p = _MOD_ALIASES.get(p, p)
    if p in _YDOTOOL_KEYMAP:
        return _YDOTOOL_KEYMAP[p]
    if len(p) == 1 and p.isalpha():
        return f"KEY_{p.upper()}"
    if len(p) == 1 and p.isdigit():
        return f"KEY_{p}"
    # Last resort: assume caller passed a raw KEY_* or a name we map directly.
    return p if p.startswith("KEY_") else f"KEY_{p.upper()}"


def _xdotool_combo(combo):
    # xdotool key wants "ctrl+c" with X keysyms; modifiers normalized, rest passthrough.
    parts = [_MOD_ALIASES.get(p.strip().lower(), p.strip()) for p in combo.split("+") if p.strip()]
    return "+".join(parts)


# --- Window helpers (per compositor) ---

def _windows_hyprland():
    ok, out, err = _run(["hyprctl", "-j", "clients"])
    if not ok:
        return None, err
    try:
        data = json.loads(out or "[]")
    except Exception as e:
        return None, f"parse_error:{e}"
    result = []
    for c in data:
        title = (c.get("title") or "").strip()
        if not title:
            continue
        result.append({
            "title": title,
            "pid": c.get("pid"),
            "process_name": c.get("class") or None,
            "address": c.get("address"),
        })
    return result, None


def _windows_sway():
    ok, out, err = _run(["swaymsg", "-t", "get_tree"])
    if not ok:
        return None, err
    try:
        tree = json.loads(out or "{}")
    except Exception as e:
        return None, f"parse_error:{e}"
    result = []

    def walk(node):
        if node.get("type") in ("con", "floating_con") and node.get("name") and not node.get("nodes") and not node.get("floating_nodes"):
            app_id = node.get("app_id")
            win_props = node.get("window_properties") or {}
            result.append({
                "title": node.get("name"),
                "pid": node.get("pid"),
                "process_name": app_id or win_props.get("class") or None,
                "id": node.get("id"),
            })
        for child in (node.get("nodes") or []) + (node.get("floating_nodes") or []):
            walk(child)

    walk(tree)
    return result, None


def _windows_x11():
    # wmctrl -lp: "<id> <desktop> <pid> <host> <title>"
    ok, out, err = _run(["wmctrl", "-lp"])
    if not ok:
        return None, err
    result = []
    for line in (out or "").splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        wid, _desk, pid_s, _host, title = parts
        try:
            pid = int(pid_s)
        except ValueError:
            pid = None
        proc_name = None
        if pid:
            try:
                proc_name = psutil.Process(pid).name()
            except Exception:
                proc_name = None
        result.append({"title": title.strip(), "pid": pid, "process_name": proc_name, "id": wid})
    return result, None


def _list_windows():
    sess, comp = _detect_session()
    if comp == "hyprland" and shutil.which("hyprctl"):
        wins, err = _windows_hyprland()
    elif comp == "sway" and shutil.which("swaymsg"):
        wins, err = _windows_sway()
    elif shutil.which("wmctrl"):
        wins, err = _windows_x11()
    else:
        return [], "no_window_tool"
    if wins is None:
        return [], err
    return wins, None


def _active_window():
    sess, comp = _detect_session()
    try:
        if comp == "hyprland" and shutil.which("hyprctl"):
            ok, out, err = _run(["hyprctl", "-j", "activewindow"])
            if ok:
                d = json.loads(out or "{}")
                if d and d.get("title") is not None:
                    return {
                        "title": (d.get("title") or "").strip() or None,
                        "pid": d.get("pid"),
                        "process_name": d.get("class") or None,
                    }
        elif comp == "sway" and shutil.which("swaymsg"):
            ok, out, err = _run(["swaymsg", "-t", "get_tree"])
            if ok:
                tree = json.loads(out or "{}")
                found = {}

                def walk(node):
                    if node.get("focused") and node.get("name"):
                        win_props = node.get("window_properties") or {}
                        found["w"] = {
                            "title": node.get("name"),
                            "pid": node.get("pid"),
                            "process_name": node.get("app_id") or win_props.get("class") or None,
                        }
                    for child in (node.get("nodes") or []) + (node.get("floating_nodes") or []):
                        walk(child)

                walk(tree)
                if found.get("w"):
                    return found["w"]
        elif shutil.which("xdotool"):
            ok, out, err = _run(["xdotool", "getactivewindow", "getwindowname"])
            if ok and out.strip():
                title = out.strip()
                pid = None
                ok2, out2, _ = _run(["xdotool", "getactivewindow", "getwindowpid"])
                if ok2 and out2.strip().isdigit():
                    pid = int(out2.strip())
                proc_name = None
                if pid:
                    try:
                        proc_name = psutil.Process(pid).name()
                    except Exception:
                        proc_name = None
                return {"title": title, "pid": pid, "process_name": proc_name}
    except Exception:
        pass
    return {"title": None, "pid": None, "process_name": None}


# --- Routes ---

@app.get("/health")
def health():
    sess, comp = _detect_session()
    return {
        "ok": True,
        "service": "pc_control",
        "platform": "linux",
        "session": sess,
        "compositor": comp,
        "tools": _tools(),
    }


@app.get("/windows")
def list_windows():
    try:
        wins, err = _list_windows()
        if err and not wins:
            return {"ok": False, "error": err, "windows": []}
        return {"ok": True, "windows": wins}
    except Exception as e:
        return {"ok": False, "error": str(e), "windows": []}


@app.get("/active_window")
def active_window():
    try:
        win = _active_window()
        return {"ok": True, **win}
    except Exception as e:
        return {"ok": False, "error": str(e), "title": None, "pid": None, "process_name": None}


@app.post("/read_ui")
def read_ui(body: ReadUiBody):
    """No universal accessibility-tree API on Linux. Degrade to the window list
    so callers get *something* useful instead of crashing."""
    try:
        wins, _err = _list_windows()
    except Exception:
        wins = []
    return {
        "ok": False,
        "error": "read_ui_not_supported_on_linux",
        "windows": wins,
    }


@app.post("/launch")
def launch(body: LaunchBody):
    try:
        # 1) Explicit path wins.
        if body.path:
            subprocess.Popen(
                [body.path],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return {"ok": True, "launched": body.path}

        key = (body.name or "").lower().strip()
        if not key:
            return {"ok": False, "error": "name_required"}

        # 2) Alias -> first binary that exists on PATH.
        candidates = APP_ALIASES.get(key, [])
        for cand in candidates:
            hit = shutil.which(cand)
            if hit:
                subprocess.Popen(
                    [hit],
                    start_new_session=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return {"ok": True, "launched": hit}

        # 3) Raw name on PATH.
        hit = shutil.which(body.name)
        if hit:
            subprocess.Popen(
                [hit],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return {"ok": True, "launched": hit}

        # 4) gtk-launch <name>.desktop (handles .desktop apps not on PATH).
        if shutil.which("gtk-launch"):
            desktop_name = body.name[:-8] if body.name.endswith(".desktop") else body.name
            try:
                subprocess.Popen(
                    ["gtk-launch", desktop_name],
                    start_new_session=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return {"ok": True, "launched": f"gtk-launch:{desktop_name}"}
            except Exception:
                pass

        # 5) xdg-open as a last resort (URLs, files, schemes).
        if shutil.which("xdg-open"):
            subprocess.Popen(
                ["xdg-open", body.name],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return {"ok": True, "launched": f"xdg-open:{body.name}"}

        return {"ok": False, "error": "app_not_found", "name": body.name}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/focus")
def focus_window(body: FocusBody):
    try:
        title = (body.title or "").strip()
        if not title:
            return {"ok": False, "error": "title_required"}
        sess, comp = _detect_session()
        tl = title.lower()

        if comp == "hyprland" and shutil.which("hyprctl"):
            wins, err = _windows_hyprland()
            if wins is None:
                return {"ok": False, "error": err or "hyprctl_failed"}
            for w in wins:
                if tl in (w.get("title") or "").lower() and w.get("address"):
                    ok, _out, ferr = _run(["hyprctl", "dispatch", "focuswindow", f"address:{w['address']}"])
                    if ok:
                        return {"ok": True, "window": w["title"]}
                    return {"ok": False, "error": ferr or "focus_failed"}
            return {"ok": False, "error": "window_not_found"}

        if comp == "sway" and shutil.which("swaymsg"):
            wins, err = _windows_sway()
            if wins is None:
                return {"ok": False, "error": err or "swaymsg_failed"}
            for w in wins:
                if tl in (w.get("title") or "").lower() and w.get("id") is not None:
                    ok, _out, ferr = _run(["swaymsg", f'[con_id={w["id"]}]', "focus"])
                    if ok:
                        return {"ok": True, "window": w["title"]}
                    return {"ok": False, "error": ferr or "focus_failed"}
            return {"ok": False, "error": "window_not_found"}

        # X11: prefer wmctrl substring activation (wmctrl -a matches the title
        # substring and activates), fall back to xdotool search + activate.
        if shutil.which("wmctrl"):
            ok, _out, ferr = _run(["wmctrl", "-a", title])
            if ok:
                return {"ok": True, "window": title}
        if shutil.which("xdotool"):
            ok, out, ferr = _run(["xdotool", "search", "--name", title])
            wid = (out or "").strip().splitlines()
            if ok and wid:
                ok2, _o2, ferr2 = _run(["xdotool", "windowactivate", wid[0]])
                if ok2:
                    return {"ok": True, "window": title}
                return {"ok": False, "error": ferr2 or "activate_failed"}
            return {"ok": False, "error": "window_not_found"}

        return {"ok": False, "error": "no_window_tool"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/processes")
def list_processes():
    try:
        procs = []
        for p in psutil.process_iter(["pid", "name", "status"]):
            try:
                info = p.info
                mem = None
                cpu = None
                try:
                    cpu = p.cpu_percent(interval=None)
                except Exception:
                    cpu = None
                try:
                    mem = p.memory_info().rss
                except Exception:
                    mem = None
                procs.append({
                    "pid": info.get("pid"),
                    "name": info.get("name"),
                    "status": info.get("status"),
                    "cpu_percent": cpu,
                    "memory": mem,
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return {"ok": True, "processes": procs}
    except Exception as e:
        return {"ok": False, "error": str(e), "processes": []}


@app.post("/kill")
def kill_process(body: KillBody):
    try:
        if body.pid:
            try:
                psutil.Process(body.pid).terminate()
                return {"ok": True, "killed_pid": body.pid}
            except Exception as e:
                return {"ok": False, "error": str(e)}

        if body.name:
            killed = []
            for p in psutil.process_iter(["pid", "name"]):
                try:
                    if body.name.lower() in (p.info["name"] or "").lower():
                        p.terminate()
                        killed.append(p.pid)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            if killed:
                return {"ok": True, "killed_pids": killed}
            return {"ok": False, "error": "process_not_found"}

        return {"ok": False, "error": "pid or name required"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/type")
def type_text(body: TypeBody):
    try:
        tool = _input_tool()
        if tool is None:
            return {"ok": False, "error": "no_input_tool", "hint": "install ydotool or xdotool"}
        if tool == "ydotool":
            ok, _out, err = _run(["ydotool", "type", "--", body.text], timeout=15)
        else:
            ok, _out, err = _run(["xdotool", "type", "--clearmodifiers", "--", body.text], timeout=15)
        if ok:
            return {"ok": True}
        return {"ok": False, "error": err or f"{tool}_failed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/keys")
def press_keys(body: KeysBody):
    try:
        tool = _input_tool()
        if tool is None:
            return {"ok": False, "error": "no_input_tool", "hint": "install ydotool or xdotool"}
        combo = (body.combo or "").strip()
        if not combo:
            return {"ok": False, "error": "combo_required"}

        if tool == "ydotool":
            # ydotool key wants press/release pairs: "<code>:1" down, "<code>:0" up.
            tokens = [_ydotool_key_token(p) for p in combo.split("+") if p.strip()]
            if not tokens:
                return {"ok": False, "error": "combo_required"}
            args = [f"{t}:1" for t in tokens] + [f"{t}:0" for t in reversed(tokens)]
            ok, _out, err = _run(["ydotool", "key"] + args, timeout=10)
        else:
            ok, _out, err = _run(["xdotool", "key", "--clearmodifiers", _xdotool_combo(combo)], timeout=10)
        if ok:
            return {"ok": True}
        return {"ok": False, "error": err or f"{tool}_failed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/click")
def mouse_click(body: ClickBody):
    try:
        tool = _input_tool()
        if tool is None:
            return {"ok": False, "error": "no_input_tool", "hint": "install ydotool or xdotool"}

        if tool == "ydotool":
            # Optional move first (ydotool mousemove --absolute -x X -y Y).
            if body.x is not None and body.y is not None:
                _run(["ydotool", "mousemove", "--absolute", "-x", str(body.x), "-y", str(body.y)])
            # ydotool click button codes: 0xC0=left, 0xC1=right, 0xC2=middle.
            btn = {"left": "0xC0", "right": "0xC1", "middle": "0xC2"}.get((body.button or "left").lower(), "0xC0")
            ok, _out, err = _run(["ydotool", "click", btn])
        else:
            btn = {"left": "1", "middle": "2", "right": "3"}.get((body.button or "left").lower(), "1")
            if body.x is not None and body.y is not None:
                _run(["xdotool", "mousemove", str(body.x), str(body.y)])
            ok, _out, err = _run(["xdotool", "click", btn])
        if ok:
            return {"ok": True}
        return {"ok": False, "error": err or f"{tool}_failed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/mouse_move")
def mouse_move(body: MouseMoveBody):
    try:
        tool = _input_tool()
        if tool is None:
            return {"ok": False, "error": "no_input_tool", "hint": "install ydotool or xdotool"}
        if tool == "ydotool":
            ok, _out, err = _run(["ydotool", "mousemove", "--absolute", "-x", str(body.x), "-y", str(body.y)])
        else:
            ok, _out, err = _run(["xdotool", "mousemove", str(body.x), str(body.y)])
        if ok:
            return {"ok": True}
        return {"ok": False, "error": err or f"{tool}_failed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT)
