"""
Machine-key AES-256-GCM helpers (Linux "DPAPI" equivalent).

Windows has DPAPI; Linux does not, so this protects bytes at rest with
AES-256-GCM keyed by a per-machine key file. It is byte-compatible with the
Node side (backend/src/lib/platformCrypto.js) — same key file, same container
format — so Node can write the owner voiceprint .enc that this STT service
reads, and vice-versa.

Container format (raw blob bytes):
    0x01            1-byte version
    iv              12 bytes  (random per encryption)
    ciphertext      N bytes
    authTag         16 bytes  (GCM tag, appended last)

`cryptography`'s AESGCM.encrypt() already returns `ciphertext || tag`
concatenated, so ct||tag maps directly onto the format. (Node exposes them
separately and concatenates the same way.)

MACHINE KEY FILE: <home>/.config/jarvis/machine.key
    If missing: the dir is created (0700), 32 random bytes are generated with
    os.urandom and written with mode 0600.
"""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_VERSION = 0x01
_IV_LEN = 12
_TAG_LEN = 16
_KEY_LEN = 32


def _machine_key_path() -> Path:
    return Path.home() / ".config" / "jarvis" / "machine.key"


def _load_machine_key() -> bytes:
    """Read the per-machine AES key, generating it on first use (0600)."""
    key_path = _machine_key_path()
    if key_path.exists():
        key = key_path.read_bytes()
        if len(key) != _KEY_LEN:
            raise ValueError(
                f"machine key at {key_path} is {len(key)} bytes, expected {_KEY_LEN}"
            )
        return key
    key_path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(key_path.parent, 0o700)
    key = os.urandom(_KEY_LEN)
    key_path.write_bytes(key)
    os.chmod(key_path, 0o600)
    return key


def encrypt(data: bytes) -> bytes:
    """Encrypt raw bytes. Returns the version||iv||ct||tag container blob."""
    key = _load_machine_key()
    iv = os.urandom(_IV_LEN)
    ct_and_tag = AESGCM(key).encrypt(iv, data, None)  # returns ct || tag
    return bytes([_VERSION]) + iv + ct_and_tag


def decrypt(blob: bytes) -> bytes:
    """Decrypt a blob produced by encrypt(). Returns the original bytes."""
    if len(blob) < 1 + _IV_LEN + _TAG_LEN:
        raise ValueError("blob_too_short")
    if blob[0] != _VERSION:
        raise ValueError(f"unsupported blob version {blob[0]}")
    key = _load_machine_key()
    iv = blob[1 : 1 + _IV_LEN]
    ct_and_tag = blob[1 + _IV_LEN :]  # AESGCM.decrypt expects ct || tag
    return AESGCM(key).decrypt(iv, ct_and_tag, None)
