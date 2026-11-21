"""Speech-to-text engines.

* faster-whisper (default): pip-installable, CPU (or NVIDIA GPU). Works everywhere.
* whisper.cpp: optional external whisper-cli.exe. A Vulkan build uses AMD Radeon GPUs on Windows.

Both report segments live so the UI can show the transcript while it is being produced.
"""
import os
import re
import subprocess
import threading
from pathlib import Path

from . import config

_cache = {}
_cache_lock = threading.Lock()
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _threads(setting: int) -> int:
    if setting and setting > 0:
        return setting
    n = os.cpu_count() or 4
    return max(1, min(16, n // 2 if n > 8 else n))  # physical cores usually fastest


def _prompt(vocab: str) -> str | None:
    vocab = (vocab or "").strip()
    if not vocab:
        return None
    return "Technical knowledge-transfer meeting about an application. Terms used: " + vocab + "."


def transcribe(wav: Path, s: dict, duration: float, on_segments, on_progress, on_status, cancel):
    """Returns (language, segments). Calls on_segments(list) periodically with all segments so far."""
    if s.get("asr_engine") == "whisper.cpp" and s.get("whispercpp_exe"):
        return _whispercpp(wav, s, duration, on_segments, on_progress, cancel)
    return _faster_whisper(wav, s, duration, on_segments, on_progress, on_status, cancel)


def _faster_whisper(wav, s, duration, on_segments, on_progress, on_status, cancel):
    from faster_whisper import WhisperModel

    name = s.get("whisper_model") or "large-v3-turbo"
    compute = s.get("whisper_compute") or "int8"
    threads = _threads(int(s.get("whisper_threads") or 0))
    key = (name, compute, threads)
    with _cache_lock:
        model = _cache.get(key)
        if model is None:
            _cache.clear()
            on_status(f"Loading Whisper '{name}' (first run downloads it, ~1.6 GB)…")
            root = config.DATA_DIR / "models" / "whisper"
            root.mkdir(parents=True, exist_ok=True)
            model = WhisperModel(name, device="auto", compute_type=compute,
                                 cpu_threads=threads, download_root=str(root))
            _cache[key] = model
    on_status("Transcribing")
    lang = s.get("language") or "auto"
    segs_iter, info = model.transcribe(
        str(wav),
        language=None if lang == "auto" else lang,
        beam_size=int(s.get("whisper_beam") or 5),
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 600},
        initial_prompt=_prompt(s.get("vocabulary", "")),
        condition_on_previous_text=True,
    )
    out = []
    total = duration or info.duration or 1
    for seg in segs_iter:
        text = seg.text.strip()
        if text:
            out.append({"id": len(out), "start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
        on_progress(min(1.0, seg.end / total))
        if len(out) % 8 == 0:
            on_segments(out)
        if cancel():
            raise InterruptedError()
    on_segments(out)
    return info.language, out


_LINE = re.compile(r"^\[(\d+):(\d+):(\d+\.\d+)\s*-->\s*(\d+):(\d+):(\d+\.\d+)\]\s*(.*)$")


def _whispercpp(wav, s, duration, on_segments, on_progress, cancel):
    exe, model = s["whispercpp_exe"], s.get("whispercpp_model", "")
    if not Path(exe).exists():
        raise RuntimeError(f"whisper.cpp executable not found: {exe}")
    if not Path(model).exists():
        raise RuntimeError(f"whisper.cpp model file not found: {model}")
    lang = s.get("language") or "auto"
    args = [exe, "-m", model, "-f", str(wav), "-t", str(_threads(int(s.get("whisper_threads") or 0))),
            "-l", lang, "-bs", str(int(s.get("whisper_beam") or 5))]
    p = _prompt(s.get("vocabulary", ""))
    if p:
        args += ["--prompt", p]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            creationflags=_NO_WINDOW)
    out = []
    total = duration or 1
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        m = _LINE.match(line)
        if m:
            h1, m1, s1, h2, m2, s2, text = m.groups()
            st = int(h1) * 3600 + int(m1) * 60 + float(s1)
            en = int(h2) * 3600 + int(m2) * 60 + float(s2)
            text = text.strip()
            if text and not re.fullmatch(r"\[.*\]|\(.*\)", text):
                out.append({"id": len(out), "start": round(st, 2), "end": round(en, 2), "text": text})
                on_progress(min(1.0, en / total))
                if len(out) % 8 == 0:
                    on_segments(out)
        if cancel():
            proc.kill()
            raise InterruptedError()
    proc.wait()
    if proc.returncode != 0 and not out:
        raise RuntimeError(f"whisper.cpp exited with code {proc.returncode}")
    on_segments(out)
    return (None if lang == "auto" else lang), out
