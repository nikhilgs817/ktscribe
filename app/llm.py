"""Minimal Ollama client (stdlib only)."""
import json
import math
import urllib.error
import urllib.request


class LLMError(RuntimeError):
    pass


def _req(url: str, path: str, body: dict | None = None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url.rstrip("/") + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST" if body is not None else "GET")
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except Exception:
            pass
        raise LLMError(f"Ollama error ({e.code}): {detail}") from None
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        raise LLMError(f"Can't reach Ollama at {url} — is Ollama running? ({e})") from None


def list_models(url: str) -> list[dict]:
    with _req(url, "/api/tags", timeout=5) as r:
        models = json.loads(r.read()).get("models", [])
    out = []
    for m in models:
        caps = []
        try:
            with _req(url, "/api/show", {"model": m["name"]}, timeout=10) as r:
                caps = json.loads(r.read()).get("capabilities", []) or []
        except Exception:
            pass
        out.append({"name": m["name"], "size_gb": round(m.get("size", 0) / 1e9, 1), "capabilities": caps})
    return out


def auto_assign(settings: dict, models: list[dict]) -> dict:
    """Fill empty model roles with sensible picks from what's installed."""
    names = [m["name"] for m in models]
    if not names:
        return {}
    by_size = sorted(models, key=lambda m: m["size_gb"], reverse=True)

    def find(*keys):
        for k in keys:
            for n in names:
                if k in n.lower():
                    return n
        return None

    vision = [m["name"] for m in by_size if "vision" in m["capabilities"]]
    upd = {}
    if not settings.get("writer_model"):
        upd["writer_model"] = find("gpt-oss:120b", "gpt-oss") or by_size[0]["name"]
    if not settings.get("assistant_model"):
        upd["assistant_model"] = find("qwen3.6", "qwen3.5", "35b-a3b", "30b-a3b") or find("qwen3") or by_size[0]["name"]
    if not settings.get("vision_model"):
        q = find("qwen3.6", "qwen3.5", "vl")
        upd["vision_model"] = (q if q in vision or not vision else vision[0]) if (q or vision) else ""
    return upd


def est_tokens(text: str) -> int:
    return math.ceil(len(text) / 3.6)


def ctx_for(prompt_tokens: int, out_tokens: int, cap: int) -> int:
    need = prompt_tokens + out_tokens + 1024
    n = 8192
    while n < need and n < cap:
        n *= 2
    return min(n, cap)


def _think_value(model: str, role: str, effort: str):
    m = model.lower()
    if "gpt-oss" in m:
        return effort if role == "writer" else "low"
    if role == "writer":
        return None  # model default
    return False  # assistant/vision: no hidden reasoning, faster answers


def chat(url: str, model: str, messages: list[dict], *, role="assistant", effort="medium",
         num_ctx=16384, max_tokens=4096, temperature=0.3, fmt=None, stream=True):
    """Yields ('thinking'|'content', text) tuples. Non-streaming callers can use chat_text()."""
    if not model:
        raise LLMError(f"No {role} model selected. Open Settings and pick one.")
    body = {
        "model": model,
        "messages": messages,
        "stream": True,
        "keep_alive": "20m",
        "options": {"num_ctx": int(num_ctx), "num_predict": int(max_tokens), "temperature": temperature},
    }
    tv = _think_value(model, role, effort)
    if tv is not None:
        body["think"] = tv
    if fmt is not None:
        body["format"] = fmt
    try:
        resp = _req(url, "/api/chat", body, timeout=900)
    except LLMError as e:
        if "think" in str(e).lower() and "think" in body:
            body.pop("think")
            resp = _req(url, "/api/chat", body, timeout=900)
        else:
            raise
    with resp:
        for raw in resp:
            if not raw.strip():
                continue
            msg = json.loads(raw)
            if msg.get("error"):
                raise LLMError(msg["error"])
            m = msg.get("message") or {}
            if m.get("thinking"):
                yield ("thinking", m["thinking"])
            if m.get("content"):
                yield ("content", m["content"])
            if msg.get("done"):
                break


def chat_text(url, model, messages, **kw) -> str:
    return "".join(t for kind, t in chat(url, model, messages, **kw) if kind == "content")
