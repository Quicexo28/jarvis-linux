"""
Embedding service — semantic vectors for Jarvis's long-term memory.

Memory recall was BM25 only (SQLite FTS5). That finds "gimnasio" when the
owner says "gimnasio", but not when he says "¿a qué hora entreno?" — different
words, same meaning. This service turns text into vectors so the backend can
rank stored facts by MEANING and fuse that with BM25 (reciprocal rank fusion).

Separate process on purpose: a crash or a slow load here must never touch the
STT. The backend treats it as optional — any failure falls back to BM25 alone.

Model: intfloat/multilingual-e5-small (118M params, 384 dims, strong Spanish).
CPU only: the 4 GB GPU belongs to whisper. Threads capped so speaker-id (also
CPU) keeps its headroom. e5 needs the "query: " / "passage: " prefixes — they
are part of how it was trained, not decoration.

  GET  /health  -> {"ok": true, "ready": bool, "model": ..., "dim": 384}
  POST /embed   {"texts": [...], "kind": "query"|"passage"} -> {"vectors": [[...]], "dim": 384}
"""

from __future__ import annotations

import os
import threading
import time

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer

MODEL_NAME = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-small")
THREADS = int(os.environ.get("EMBED_THREADS", "2"))
MAX_TEXTS = 64
MAX_TOKENS = 256

torch.set_num_threads(THREADS)

_state = {"tok": None, "model": None, "ready": False, "error": None, "dim": None}
_lock = threading.Lock()


def _load() -> None:
    t0 = time.time()
    try:
        tok = AutoTokenizer.from_pretrained(MODEL_NAME)
        model = AutoModel.from_pretrained(MODEL_NAME)
        model.eval()
        _state.update(tok=tok, model=model)
        # Warm the first forward pass now, not on the first real query.
        vec = _embed(["query: hola"])
        _state.update(ready=True, dim=len(vec[0]))
        print(f"[embed] {MODEL_NAME} listo en {time.time() - t0:.1f}s (dim={_state['dim']})", flush=True)
    except Exception as e:  # noqa: BLE001 — surfaced through /health
        _state["error"] = f"{type(e).__name__}: {e}"
        print(f"[embed] carga fallida: {_state['error']}", flush=True)


def _embed(texts: list[str]) -> list[list[float]]:
    tok, model = _state["tok"], _state["model"]
    with _lock, torch.inference_mode():
        batch = tok(texts, padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt")
        out = model(**batch).last_hidden_state
        # Mean pooling over real tokens (padding masked out), then L2-normalise so
        # the backend's dot product IS the cosine.
        mask = batch["attention_mask"].unsqueeze(-1).to(out.dtype)
        pooled = (out * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
        return pooled.tolist()


app = FastAPI()


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: str = "passage"


@app.get("/health")
def health():
    return {
        "ok": _state["error"] is None,
        "ready": _state["ready"],
        "model": MODEL_NAME,
        "dim": _state["dim"],
        "error": _state["error"],
    }


@app.post("/embed")
def embed(req: EmbedRequest):
    if not _state["ready"]:
        raise HTTPException(503, detail=_state["error"] or "loading")
    texts = [t.strip() for t in req.texts if t and t.strip()][:MAX_TEXTS]
    if not texts:
        return {"vectors": [], "dim": _state["dim"]}
    prefix = "query: " if req.kind == "query" else "passage: "
    t0 = time.time()
    vectors = _embed([prefix + t for t in texts])
    return {"vectors": vectors, "dim": _state["dim"], "ms": round((time.time() - t0) * 1000, 1)}


if __name__ == "__main__":
    threading.Thread(target=_load, daemon=True).start()
    port = int(os.environ.get("EMBED_PORT", "8797"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
