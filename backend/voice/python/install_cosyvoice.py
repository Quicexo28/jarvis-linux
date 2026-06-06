"""
One-shot installer for CosyVoice 2 sidecar.

Steps:
  1. Clone the CosyVoice repo with submodules into ./CosyVoice/
  2. Install its requirements into the active venv (skipping ttsfrd which
     has no Windows wheels — falls back to WeTextProcessing automatically).
  3. Download the CosyVoice2-0.5B model from Hugging Face into
     ./CosyVoice/pretrained_models/CosyVoice2-0.5B/

Idempotent: re-running skips work that's already done. Safe to invoke
from Electron at first boot OR from a CLI shell.

Usage:
    .venv\\Scripts\\python.exe install_cosyvoice.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COSYVOICE_DIR = HERE / 'CosyVoice'
COSY_VENV = HERE / '.venv-cosy'
COSY_PY = COSY_VENV / 'Scripts' / 'python.exe' if os.name == 'nt' else COSY_VENV / 'bin' / 'python'
MODEL_DIR = COSYVOICE_DIR / 'pretrained_models' / 'CosyVoice2-0.5B'
REPO_URL = 'https://github.com/FunAudioLLM/CosyVoice.git'


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print(f'  $ {" ".join(cmd)}', flush=True)
    subprocess.check_call(cmd, cwd=str(cwd) if cwd else None)


def step_clone() -> None:
    if COSYVOICE_DIR.exists():
        print(f'[install] repo already present at {COSYVOICE_DIR}, pulling latest', flush=True)
        try:
            run(['git', 'pull'], cwd=COSYVOICE_DIR)
            run(['git', 'submodule', 'update', '--init', '--recursive'], cwd=COSYVOICE_DIR)
        except Exception as e:
            print(f'[install] git pull failed (continuing): {e}', flush=True)
        return
    print(f'[install] cloning {REPO_URL} -> {COSYVOICE_DIR}', flush=True)
    run(['git', 'clone', '--recursive', REPO_URL, str(COSYVOICE_DIR)])


def step_make_venv() -> None:
    """Create a dedicated venv so CosyVoice's pinned deps don't clash with
    the existing XTTS venv (different torch / numpy / fastapi versions)."""
    if COSY_PY.exists():
        print(f'[install] cosy venv already at {COSY_VENV}', flush=True)
        return
    print(f'[install] creating venv at {COSY_VENV}', flush=True)
    run([sys.executable, '-m', 'venv', str(COSY_VENV)])
    # Newer pip + setuptools so PEP-517 source builds (pkg_resources lookup,
    # etc.) work for packages like pyworld / grpcio-tools.
    run([str(COSY_PY), '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'])


def step_install_deps() -> None:
    req_file = COSYVOICE_DIR / 'requirements.txt'
    if not req_file.exists():
        print(f'[install] no requirements.txt at {req_file}; skipping', flush=True)
        return
    print('[install] installing pip requirements (this can take several minutes)', flush=True)

    # PEP-517 isolated builds break for several CosyVoice deps on Windows
    # (openai-whisper, pyworld, etc.) because their setup.py imports
    # pkg_resources at top-level and pip's isolated build env lacks it.
    # Pre-install build prerequisites into the venv so --no-build-isolation
    # can satisfy them locally.
    print('[install] seeding build prerequisites...', flush=True)
    run([
        str(COSY_PY), '-m', 'pip', 'install',
        'setuptools<70', 'wheel', 'cython', 'numpy==1.26.4', 'packaging',
    ])

    # Filter out ttsfrd (no Windows wheels — CosyVoice falls back to
    # WeTextProcessing automatically). deepspeed line already has a
    # sys_platform == 'linux' guard so it's a no-op on Windows.
    raw = req_file.read_text(encoding='utf-8').splitlines()
    filtered_lines = [
        line for line in raw
        if not (line.strip().lower().startswith('ttsfrd') or 'ttsfrd' in line.lower())
    ]
    tmp_req = COSYVOICE_DIR / 'requirements.no-ttsfrd.txt'
    tmp_req.write_text('\n'.join(filtered_lines) + '\n', encoding='utf-8')

    # Install with --no-build-isolation so source-build packages (openai-
    # whisper, pyworld) see the setuptools+cython we just placed in the venv.
    run([
        str(COSY_PY), '-m', 'pip', 'install',
        '--no-build-isolation', '-r', str(tmp_req),
    ])

    # render_fillers.py needs websockets; the model download step needs
    # huggingface_hub. Both are small adders.
    run([str(COSY_PY), '-m', 'pip', 'install', 'websockets', 'huggingface_hub'])


def step_download_model() -> None:
    if MODEL_DIR.exists() and any(MODEL_DIR.iterdir()):
        print(f'[install] model already present at {MODEL_DIR}', flush=True)
        return
    print('[install] downloading CosyVoice2-0.5B (~2 GB, one-time)', flush=True)
    MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    # Run inside the cosy venv so huggingface_hub is available.
    run([
        str(COSY_PY), '-c',
        (
            "from huggingface_hub import snapshot_download;"
            f"snapshot_download(repo_id='FunAudioLLM/CosyVoice2-0.5B',"
            f"local_dir=r'{MODEL_DIR}', local_dir_use_symlinks=False)"
        ),
    ])


def main() -> None:
    print('=== CosyVoice 2 installer ===', flush=True)
    step_clone()
    step_make_venv()
    step_install_deps()
    step_download_model()
    print('[install] DONE. Restart Jarvis to use the new engine.', flush=True)


if __name__ == '__main__':
    main()
