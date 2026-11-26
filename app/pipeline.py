"""Background job runner: processes one job at a time so models don't fight for memory."""
import base64
import io
import json
import queue
import threading
import time
import traceback

from . import asr, config, llm, media, outputs as out_mod, prompts, store

_q: "queue.Queue[tuple]" = queue.Queue()
_cancel: set[str] = set()
_current = {"sid": None, "kind": None}

WEIGHTS = {"audio": 0.04, "transcript": 0.66, "frames": 0.12, "captions": 0.10, "summary": 0.08}


def start_worker():
    threading.Thread(target=_worker, daemon=True, name="ktscribe-worker").start()


def enqueue(kind: str, sid: str, **kw):
    _cancel.discard(sid)
    _q.put((kind, sid, kw))


def cancel(sid: str):
    _cancel.add(sid)


def current():
    return dict(_current)


def _worker():
    while True:
        kind, sid, kw = _q.get()
        if sid in _cancel:
            _cancel.discard(sid)
            continue
        _current.update(sid=sid, kind=kind)
        try:
            if kind == "process":
                process(sid)
            elif kind == "runbook":
                runbook(sid, kw.get("instructions", ""))
            elif kind == "recaption":
                captions_stage(sid, config.load(), force=True)
            elif kind == "invite":
                invite(sid)
            elif kind == "drive":
                drive(sid)
            elif kind == "outputs":
                outputs(sid)
        except Exception:
            traceback.print_exc()
        finally:
            _current.update(sid=None, kind=None)


# --------------------------------------------------------------------------- process

def _settings_for(meta):
    s = config.load()
    s.update({k: v for k, v in (meta.get("options") or {}).items() if v not in (None, "")})
    return s


def process(sid: str):
    meta = store.get(sid)
    if not meta:
        return
    s = _settings_for(meta)
    store.update(sid, status="running", error=None, message="Starting", warnings=[])
    done_weight = 0.0

    def is_cancelled():
        return sid in _cancel

    def runner(stage, fn):
        nonlocal done_weight
        st = store.get(sid)["stages"][stage]
        if st in ("done", "skipped"):
            done_weight += WEIGHTS[stage]
            return
        w = WEIGHTS[stage]
        base = done_weight
        store.update(sid, stage=stage, message=store.STAGE_LABELS[stage], stages={stage: "running"},
                     progress=round(base, 4))
        last = [0.0]

        def prog(p):
            now = time.time()
            if now - last[0] > 0.7:
                last[0] = now
                store.update(sid, progress=round(base + w * p, 4))

        result = fn(prog)
        store.update(sid, stages={stage: result or "done"}, progress=round(base + w, 4))
        done_weight += w

    try:
        # ---- audio
        def audio(prog):
            info = media.probe(meta["video_path"])
            store.update(sid, duration=info["duration"], has_video=info["has_video"],
                         width=info["width"], height=info["height"])
            if not info["has_audio"]:
                raise RuntimeError("This file has no audio track.")
            media.extract_audio(meta["video_path"], store.sdir(sid) / "audio.wav", info["duration"],
                                prog, is_cancelled)
        runner("audio", audio)
        meta = store.get(sid)

        # ---- transcript
        def transcript(prog):
            def on_segments(segs):
                store.write_json(sid, "transcript.json", {"partial": True, "segments": segs})

            def on_status(msg):
                store.update(sid, message=msg)

            lang, segs = asr.transcribe(store.sdir(sid) / "audio.wav", s, meta["duration"],
                                        on_segments, prog, on_status, is_cancelled)
            store.write_json(sid, "transcript.json", {"partial": False, "language": lang, "segments": segs})
            if not segs:
                raise RuntimeError("No speech was detected in this recording.")
        runner("transcript", transcript)

        # ---- screenshots
        def frames(prog):
            if not meta.get("has_video"):
                return "skipped"
            found = media.detect_screen_changes(meta["video_path"], meta["duration"],
                                                s.get("frame_sensitivity", "medium"),
                                                int(s.get("max_frames", 150)),
                                                lambda p: prog(p * 0.6), is_cancelled)
            out = []
            fdir = store.frames_dir(sid)
            for i, f in enumerate(found):
                fid = f"F{i + 1:04d}"
                media.grab_frame(meta["video_path"], f["t"] + 0.5, fdir / f"{fid}.jpg")
                out.append({"id": fid, "t": round(f["t"] + 0.5, 2), "caption": "", "kind": "screen",
                            "hidden": False, "manual": False})
                prog(0.6 + 0.4 * (i + 1) / max(1, len(found)))
                if is_cancelled():
                    raise InterruptedError()
            store.write_json(sid, "frames.json", out)
        runner("frames", frames)

        # ---- screenshot descriptions (non-fatal)
        runner("captions", lambda prog: _safe(sid, "Screenshot descriptions",
                                              lambda: captions_stage(sid, s, prog=prog)))

        # ---- summary (non-fatal)
        runner("summary", lambda prog: _safe(sid, "Summary", lambda: summary_stage(sid, s, prog)))

        store.update(sid, status="ready", stage=None, progress=1.0, message="Ready")
        if any(s.get(k) for k in ("auto_kt_doc", "auto_invite", "drive_outputs")):
            enqueue("outputs", sid)
    except InterruptedError:
        _cancel.discard(sid)
        st = store.get(sid)["stages"]
        store.update(sid, status="cancelled", message="Cancelled", error=None,
                     stages={k: "pending" for k, v in st.items() if v == "running"})
    except Exception as e:
        traceback.print_exc()
        st = store.get(sid)["stages"]
        store.update(sid, status="error", error=str(e), message="Failed",
                     stages={k: "error" for k, v in st.items() if v == "running"})


def _safe(sid, label, fn):
    """LLM stages shouldn't sink the transcript: record a warning and continue."""
    try:
        return fn()
    except InterruptedError:
        raise
    except Exception as e:
        traceback.print_exc()
        w = store.get(sid).get("warnings") or []
        w.append(f"{label} skipped: {e}")
        store.update(sid, warnings=w)
        return "error"


def _context_around(segments, t, span=25):
    words = [s["text"] for s in segments if s["end"] >= t - span and s["start"] <= t + span]
    txt = " ".join(words)
    return (txt[:600] + "…") if len(txt) > 600 else txt


def _jpeg_b64(path, max_w=1280):
    try:
        from PIL import Image
        im = Image.open(path).convert("RGB")
        if im.width > max_w:
            im = im.resize((max_w, int(im.height * max_w / im.width)))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode()
    except ImportError:
        return base64.b64encode(path.read_bytes()).decode()


def captions_stage(sid, s, prog=lambda p: None, force=False):
    if not s.get("describe_frames") and not force:
        return "skipped"
    model = s.get("vision_model")
    if not model:
        return "skipped"
    frames = store.read_json(sid, "frames.json", [])
    segs = store.read_json(sid, "transcript.json", {}).get("segments", [])
    todo = [f for f in frames if force or not f.get("caption")]
    for i, f in enumerate(todo):
        if sid in _cancel:
            raise InterruptedError()
        img = _jpeg_b64(store.frames_dir(sid) / f"{f['id']}.jpg")
        msg = [{"role": "user", "images": [img], "content": prompts.CAPTION_PROMPT.format(
            time=prompts.ts(f["t"]), context=_context_around(segs, f["t"]).replace('"', "'"))}]
        cap = llm.chat_text(s, model, msg, role="vision", num_ctx=8192,
                            max_tokens=160, temperature=0.1).strip()
        if cap.upper().startswith("WEBCAM"):
            f["kind"], f["caption"] = "webcam", "Webcam / people view"
        else:
            f["caption"] = cap.split("\n")[0][:400]
        # re-read & merge so edits made in the UI meanwhile aren't lost
        cur = store.read_json(sid, "frames.json", [])
        for c in cur:
            if c["id"] == f["id"]:
                c.update(caption=f["caption"], kind=f["kind"])
        store.write_json(sid, "frames.json", cur)
        prog((i + 1) / len(todo))
    return "done"


def _condense(s, text, model, role, prog=lambda p: None):
    """Map step for very long sessions: turn transcript chunks into dense notes."""
    max_ctx = int(s.get("max_context", 65536))
    chunk_chars = int(min(max_ctx * 0.5, 24000) * 3.6)
    chunks = prompts.split_chunks(text, chunk_chars)
    notes = []
    for i, c in enumerate(chunks):
        msgs = [{"role": "system", "content": prompts.NOTES_SYSTEM},
                {"role": "user", "content": f"Part {i + 1} of {len(chunks)}:\n\n{c}"}]
        notes.append(llm.chat_text(s, model, msgs, role=role,
                                   num_ctx=llm.ctx_for(llm.est_tokens(c), 3000, max_ctx),
                                   max_tokens=3000))
        prog((i + 1) / len(chunks))
    return "\n\n".join(notes)


def _source_text(s, sid, model, role, reserve, prog=lambda p: None):
    segs = store.read_json(sid, "transcript.json", {}).get("segments", [])
    text = prompts.transcript_text(segs)
    max_ctx = int(s.get("max_context", 65536))
    if llm.est_tokens(text) + reserve > max_ctx:
        return "DETAILED NOTES FROM THE TRANSCRIPT", _condense(s, text, model, role, prog)
    return "TRANSCRIPT", text


def summary_stage(sid, s, prog):
    model = s.get("assistant_model")
    if not model:
        raise RuntimeError("no assistant model selected in Settings")
    label, text = _source_text(s, sid, model, "assistant", 6000, lambda p: prog(p * 0.6))
    msgs = [{"role": "system", "content": prompts.SUMMARY_SYSTEM},
            {"role": "user", "content": prompts.SUMMARY_USER.format(transcript=text)}]
    raw = llm.chat_text(s, model, msgs, role="assistant",
                        num_ctx=llm.ctx_for(llm.est_tokens(text), 4000, int(s.get("max_context", 65536))),
                        max_tokens=4000, temperature=0.2, fmt=prompts.SUMMARY_SCHEMA)
    prog(1.0)
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`").split("\n", 1)[-1]
    data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    store.write_json(sid, "summary.json", data)
    meta = store.get(sid)
    if meta.get("title_auto", True) and data.get("title"):
        store.update(sid, title=data["title"])
    return "done"


# --------------------------------------------------------------------------- runbook

def runbook(sid: str, instructions: str = ""):
    meta = store.get(sid)
    s = _settings_for(meta)
    model = s.get("writer_model")
    store.update(sid, runbook={"state": "running", "error": None, "chars": 0, "phase": "Preparing"})
    try:
        if not model:
            raise RuntimeError("No writer model selected. Open Settings.")
        label, text = _source_text(
            s, sid, s.get("assistant_model") or model, "assistant", 14000,
            lambda p: store.update(sid, runbook={"phase": f"Condensing long transcript {int(p * 100)}%"}))
        frames = store.read_json(sid, "frames.json", [])
        title = meta.get("title") or "Application"
        extra = f"\nAdditional instructions from the user: {instructions.strip()}\n" if instructions.strip() else ""
        user = prompts.RUNBOOK_USER.format(
            template=s.get("runbook_template", config.DEFAULT_RUNBOOK_TEMPLATE).replace("{title}", title),
            extra=extra, title=title, frames=prompts.frames_text(frames) or "(none)",
            source_label=label, transcript=text)
        msgs = [{"role": "system", "content": prompts.RUNBOOK_SYSTEM}, {"role": "user", "content": user}]
        old = store.read_text(sid, "runbook.md")
        if old.strip():
            store.write_text(sid, "runbook.prev.md", old)
        buf, last, thinking = [], 0.0, 0
        store.update(sid, runbook={"phase": "Thinking"})
        for kind, chunk in llm.chat(s, model, msgs, role="writer",
                                    effort=s.get("writer_reasoning", "medium"),
                                    num_ctx=llm.ctx_for(llm.est_tokens(user), 12000, int(s.get("max_context", 65536))),
                                    max_tokens=12000, temperature=0.3):
            if sid in _cancel:
                raise InterruptedError()
            if kind == "thinking":
                thinking += len(chunk)
            else:
                buf.append(chunk)
            now = time.time()
            if now - last > 1.5:
                last = now
                body = "".join(buf)
                if body:
                    store.write_text(sid, "runbook.md", body)
                store.update(sid, runbook={"chars": len(body), "phase": "Writing" if body else f"Thinking ({thinking} chars)"})
        body = "".join(buf).strip()
        if body.startswith("```"):
            body = body.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        if not body:
            raise RuntimeError("The model returned an empty document.")
        store.write_text(sid, "runbook.md", body + "\n")
        store.update(sid, runbook={"state": "done", "chars": len(body), "phase": "Done", "updated": time.time()})
    except InterruptedError:
        _cancel.discard(sid)
        store.update(sid, runbook={"state": "cancelled", "phase": "Cancelled"})
    except Exception as e:
        traceback.print_exc()
        store.update(sid, runbook={"state": "error", "error": str(e), "phase": "Failed"})


# --------------------------------------------------------------------------- follow-on outputs

def invite(sid: str):
    s = _settings_for(store.get(sid))
    store.update(sid, invite={"state": "running", "error": None})
    try:
        out_mod.make_invite(sid, s, _source_text)
        store.update(sid, invite={"state": "done", "updated": time.time()})
    except Exception as e:
        traceback.print_exc()
        store.update(sid, invite={"state": "error", "error": str(e)})


def drive(sid: str):
    s = _settings_for(store.get(sid))
    store.update(sid, drive={"state": "running", "error": None})
    try:
        path = out_mod.copy_to_drive(sid, s)
        store.update(sid, drive={"state": "done" if path else "none", "path": path,
                                 "error": None if path else "Google Drive folder not found"})
    except Exception as e:
        traceback.print_exc()
        store.update(sid, drive={"state": "error", "error": str(e)})


def outputs(sid: str):
    """Run after processing: KT document, meeting invite, then copy everything to Drive."""
    meta = store.get(sid)
    if not meta or meta.get("status") != "ready":
        return
    s = _settings_for(meta)
    if s.get("auto_kt_doc") and (meta.get("runbook") or {}).get("state", "none") == "none":
        runbook(sid)
    if sid in _cancel:
        _cancel.discard(sid)
        return
    if s.get("auto_invite") and (store.get(sid).get("invite") or {}).get("state", "none") == "none":
        invite(sid)
    if s.get("drive_outputs") and out_mod.drive_outputs_dir() is not None:
        drive(sid)
