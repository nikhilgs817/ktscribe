"""Model client for the three engines Pocket Scribe can use.

- ollama:    local Ollama (/api/chat).
- openai:    any OpenAI-compatible server, such as vLLM, LM Studio or llama.cpp (/v1/chat/completions).
- anthropic: Claude in the cloud through the official anthropic SDK (optional, needs an API key).

Every public function takes the settings dict `s`, so the provider, URL and key come from one place.
Messages use one shape everywhere: {"role", "content", "images": [base64 jpeg, ...]}.
"""
import json
import math
import urllib.error
import urllib.request

from . import secret_store

PROVIDERS = {
    "ollama": "Ollama",
    "openai": "vLLM / OpenAI-compatible",
    "anthropic": "Claude (cloud)",
}

CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]


class LLMError(RuntimeError):
    pass


# --------------------------------------------------------------------------- settings helpers

def provider(s: dict) -> str:
    p = (s.get("llm_provider") or "ollama").lower()
    return p if p in PROVIDERS else "ollama"


def base_url(s: dict) -> str:
    p = provider(s)
    if p == "openai":
        return (s.get("openai_url") or "http://127.0.0.1:8000/v1").rstrip("/")
    return (s.get("ollama_url") or "http://127.0.0.1:11434").rstrip("/")


def api_key(s: dict) -> str:
    p = provider(s)
    if p == "anthropic":
        return secret_store.unprotect(s.get("anthropic_key_enc", "")) or secret_store.env_key("anthropic")
    if p == "openai":
        return secret_store.unprotect(s.get("openai_key_enc", "")) or secret_store.env_key("openai")
    return ""


def describe(s: dict) -> str:
    p = provider(s)
    return PROVIDERS[p] if p == "anthropic" else f"{PROVIDERS[p]} at {base_url(s)}"


# --------------------------------------------------------------------------- http

def _req(url: str, path: str, body: dict | None = None, timeout=30, key: str = "", who="Ollama"):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url.rstrip("/") + path, data=data, headers=headers,
                                 method="POST" if body is not None else "GET")
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(detail)
            detail = j.get("error", detail)
            if isinstance(detail, dict):
                detail = detail.get("message", str(detail))
        except Exception:
            pass
        raise LLMError(f"{who} error ({e.code}): {detail}") from None
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        raise LLMError(f"Can't reach {who} at {url}. Is it running? ({e})") from None


# --------------------------------------------------------------------------- model lists

def list_models(s: dict) -> list[dict]:
    p = provider(s)
    if p == "openai":
        with _req(base_url(s), "/models", timeout=5, key=api_key(s), who="the model server") as r:
            data = json.loads(r.read()).get("data", [])
        out = []
        for m in data:
            name = m.get("id", "")
            caps = ["completion"]
            if any(k in name.lower() for k in ("vl", "vision", "qwen3.5", "qwen3.6", "gemma-3", "gemma3", "llava", "pixtral", "mistral-small-3")):
                caps.append("vision")
            out.append({"name": name, "size_gb": 0, "capabilities": caps, "max_len": m.get("max_model_len")})
        return out
    if p == "anthropic":
        client = _anthropic_client(s)
        try:
            names = [m.id for m in client.models.list()]
        except Exception as e:
            raise LLMError(f"Claude: {_claude_err(e)}") from None
        names = names or CLAUDE_MODELS
        return [{"name": n, "size_gb": 0, "capabilities": ["completion", "vision"]} for n in names]
    with _req(base_url(s), "/api/tags", timeout=5) as r:
        models = json.loads(r.read()).get("models", [])
    out = []
    for m in models:
        caps = []
        try:
            with _req(base_url(s), "/api/show", {"model": m["name"]}, timeout=10) as r:
                caps = json.loads(r.read()).get("capabilities", []) or []
        except Exception:
            pass
        out.append({"name": m["name"], "size_gb": round(m.get("size", 0) / 1e9, 1), "capabilities": caps})
    return out


def auto_assign(settings: dict, models: list[dict]) -> dict:
    """Fill empty model roles with sensible picks from what the server offers."""
    names = [m["name"] for m in models]
    if not names:
        return {}
    if provider(settings) == "anthropic":
        pick = lambda *ks: next((n for k in ks for n in names if k in n), names[0])
        upd = {}
        if not settings.get("writer_model"):
            upd["writer_model"] = pick("claude-sonnet-5-5", "sonnet", "opus")
        if not settings.get("assistant_model"):
            upd["assistant_model"] = pick("claude-haiku-5-5", "haiku", "sonnet")
        if not settings.get("vision_model"):
            upd["vision_model"] = pick("claude-haiku-5-5", "haiku", "sonnet")
        return upd
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
        upd["writer_model"] = find("gpt-oss:120b", "gpt-oss-120b", "gpt-oss") or by_size[0]["name"]
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


# --------------------------------------------------------------------------- chat

def chat(s: dict, model: str, messages: list[dict], *, role="assistant", effort="medium",
         num_ctx=16384, max_tokens=4096, temperature=0.3, fmt=None, stream=True):
    """Yields ('thinking'|'content', text) tuples. Non-streaming callers can use chat_text()."""
    if not model:
        raise LLMError(f"No {role} model selected. Open Settings and pick one.")
    p = provider(s)
    if p == "openai":
        yield from _chat_openai(s, model, messages, role, effort, max_tokens, temperature, fmt)
    elif p == "anthropic":
        yield from _chat_claude(s, model, messages, role, effort, max_tokens, fmt)
    else:
        yield from _chat_ollama(s, model, messages, role, effort, num_ctx, max_tokens, temperature, fmt)


def chat_text(s, model, messages, **kw) -> str:
    return "".join(t for kind, t in chat(s, model, messages, **kw) if kind == "content")


# ---- Ollama

def _think_value(model: str, role: str, effort: str):
    m = model.lower()
    if "gpt-oss" in m:
        return effort if role == "writer" else "low"
    if role == "writer":
        return None  # model default
    return False  # assistant/vision: no hidden reasoning, faster answers


def _chat_ollama(s, model, messages, role, effort, num_ctx, max_tokens, temperature, fmt):
    url = base_url(s)
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


# ---- OpenAI-compatible (vLLM)

def _openai_messages(messages):
    out = []
    for m in messages:
        imgs = m.get("images") or []
        if not imgs:
            out.append({"role": m["role"], "content": m.get("content", "")})
            continue
        parts = [{"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b}"}} for b in imgs]
        parts.append({"type": "text", "text": m.get("content", "")})
        out.append({"role": m["role"], "content": parts})
    return out


def _chat_openai(s, model, messages, role, effort, max_tokens, temperature, fmt):
    body = {"model": model, "messages": _openai_messages(messages), "stream": True,
            "max_tokens": int(max_tokens), "temperature": temperature}
    if "gpt-oss" in model.lower():
        body["reasoning_effort"] = effort if role == "writer" else "low"
    if fmt is not None:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "output", "schema": fmt}}
    try:
        resp = _req(base_url(s), "/chat/completions", body, timeout=900, key=api_key(s), who="the model server")
    except LLMError as e:
        retry = False
        if "response_format" in body and "response_format" in str(e).lower():
            body.pop("response_format"); retry = True
        if "reasoning_effort" in body and "reasoning" in str(e).lower():
            body.pop("reasoning_effort"); retry = True
        if not retry:
            raise
        resp = _req(base_url(s), "/chat/completions", body, timeout=900, key=api_key(s), who="the model server")
    with resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            msg = json.loads(data)
            if msg.get("error"):
                raise LLMError(str(msg["error"]))
            for ch in msg.get("choices") or []:
                d = ch.get("delta") or {}
                th = d.get("reasoning_content") or d.get("reasoning")
                if th:
                    yield ("thinking", th)
                if d.get("content"):
                    yield ("content", d["content"])


# ---- Claude (cloud, optional)

def _anthropic_client(s):
    try:
        import anthropic  # imported only when Claude is chosen
    except ImportError:
        raise LLMError("The Claude option needs the 'anthropic' package. Run Setup again to install it.") from None
    key = api_key(s)
    if not key:
        raise LLMError("Add your Claude API key in Settings > AI models.")
    return anthropic.Anthropic(api_key=key, max_retries=3)


def _claude_err(e) -> str:
    msg = getattr(e, "message", None) or str(e)
    return msg[:300]


def _strict(schema):
    """Claude structured output wants additionalProperties: false on every object."""
    if isinstance(schema, dict):
        schema = {k: _strict(v) for k, v in schema.items()}
        if schema.get("type") == "object":
            schema.setdefault("additionalProperties", False)
    elif isinstance(schema, list):
        schema = [_strict(v) for v in schema]
    return schema


def _claude_messages(messages):
    system, out = [], []
    for m in messages:
        if m["role"] == "system":
            system.append(m.get("content", ""))
            continue
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b}}
                   for b in (m.get("images") or [])]
        content.append({"type": "text", "text": m.get("content", "") or "."})
        out.append({"role": m["role"], "content": content})
    return "\n\n".join(system), out


def _chat_claude(s, model, messages, role, effort, max_tokens, fmt):
    client = _anthropic_client(s)
    system, msgs = _claude_messages(messages)
    kw = {"model": model, "max_tokens": int(max(max_tokens, 1024)), "messages": msgs}
    if system:
        kw["system"] = system
    out_cfg = {}
    if fmt is not None:
        out_cfg["format"] = {"type": "json_schema", "schema": _strict(fmt)}
    if "opus" in model and role == "writer":
        out_cfg["effort"] = effort if effort in ("low", "medium", "high") else "medium"
    if out_cfg:
        kw["output_config"] = out_cfg
    try:
        with client.messages.stream(**kw) as stream:
            for event in stream:
                if event.type == "content_block_delta":
                    if event.delta.type == "text_delta":
                        yield ("content", event.delta.text)
                    elif event.delta.type == "thinking_delta":
                        yield ("thinking", event.delta.thinking)
            final = stream.get_final_message()
    except LLMError:
        raise
    except Exception as e:
        raise LLMError(f"Claude: {_claude_err(e)}") from None
    if final.stop_reason == "refusal":
        raise LLMError("Claude declined this request.")
