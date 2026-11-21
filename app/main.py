"""KT Scribe — local web app. Run with:  python run.py"""
import json
import re
import shutil
import threading
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, exporters, llm, media, phone_inbox, pipeline, prompts, store

STATIC = config.ROOT / "static"
VIDEO_EXT = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".wmv", ".flv", ".mpg", ".mpeg", ".ts",
             ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}

app = FastAPI(title="KT Scribe")


@app.on_event("startup")
def _startup():
    config.ensure_dirs()
    store.recover_interrupted()
    pipeline.start_worker()


def _meta(sid):
    try:
        m = store.get(sid)
    except ValueError:
        m = None
    if not m:
        raise HTTPException(404, "Session not found")
    return m


@app.exception_handler(llm.LLMError)
def _llm_err(_, exc):
    return JSONResponse({"detail": str(exc)}, status_code=502)


# ----------------------------------------------------------------------------- system

@app.get("/api/health")
def health():
    s = config.load()
    out = {"ffmpeg": False, "ollama": False, "models": [], "worker": pipeline.current()}
    try:
        media.ffmpeg_exe()
        out["ffmpeg"] = True
    except Exception as e:
        out["ffmpeg_error"] = str(e)
    try:
        out["models"] = llm.list_models(s["ollama_url"])
        out["ollama"] = True
        upd = llm.auto_assign(s, out["models"])
        if upd:
            config.save(upd)
    except Exception as e:
        out["ollama_error"] = str(e)
    out["settings"] = config.load()
    return out


@app.post("/api/quit")
def quit_app():
    """Stop the server (used by the Quit button when KT Scribe runs without a console window)."""
    import os
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return {"ok": True}


@app.get("/api/settings")
def get_settings():
    return config.load()


@app.put("/api/settings")
def put_settings(body: dict = Body(...)):
    return config.save(body)


@app.get("/api/settings/default-template")
def default_template():
    return {"template": config.DEFAULT_RUNBOOK_TEMPLATE}


@app.post("/api/settings/test-model")
def test_model(body: dict = Body(...)):
    s = config.load()
    t0 = time.time()
    txt = llm.chat_text(s["ollama_url"], body["model"], [{"role": "user", "content": "Reply with exactly: OK"}],
                        role=body.get("role", "assistant"), num_ctx=2048, max_tokens=200)
    return {"reply": txt.strip()[:200], "seconds": round(time.time() - t0, 1)}


# ----------------------------------------------------------------------------- sessions

def _options(raw) -> dict:
    o = raw if isinstance(raw, dict) else json.loads(raw or "{}")
    keep = ("language", "vocabulary", "frame_sensitivity", "describe_frames")
    return {k: o[k] for k in keep if k in o}



_phone_import_lock = threading.Lock()


@app.get("/api/phone-recordings")
def list_phone_recordings():
    directory = phone_inbox.folder()
    result = {"folder": str(directory) if directory else "", "folderAvailable": False, "recordings": []}
    if directory is None:
        return result
    try:
        recordings = phone_inbox.scan(directory)
    except OSError:
        return result
    sessions_by_recording = {s.get("phone_recording_id"): s for s in store.list_all()}
    result["folderAvailable"] = True
    for rec in sorted(recordings.values(), key=lambda row: row.started_at, reverse=True):
        session = sessions_by_recording.get(rec.id)
        result["recordings"].append({
            "id": rec.id, "title": rec.title, "mode": rec.mode, "startedAt": rec.started_at,
            "durationMs": rec.duration_ms,
            "state": session["status"] if session else "available" if rec.available() else "syncing",
            "sessionId": session["id"] if session else None,
        })
    return result


@app.put("/api/phone-recordings/folder")
def set_phone_folder(body: dict = Body(...)):
    value = body.get("folder")
    if not isinstance(value, str):
        raise HTTPException(400, "Enter the recording folder path.")
    value = value.strip().strip('"')
    if value:
        try:
            path = Path(value).expanduser()
            if not path.is_absolute() or not path.is_dir():
                raise ValueError()
            value = str(path.resolve(strict=True))
        except (OSError, ValueError, RuntimeError):
            raise HTTPException(400, "Folder not found. Use the full path from File Explorer.") from None
    config.save({"phone_recordings_folder": value})
    return {"folder": value}


@app.post("/api/phone-recordings/{recording_id}/process")
def process_phone_recording(recording_id: str, body: dict = Body(...)):
    with _phone_import_lock:
        for session in store.list_all():
            if session.get("phone_recording_id") == recording_id:
                return session
        directory = phone_inbox.folder()
        try:
            rec = phone_inbox.scan(directory).get(recording_id) if directory else None
        except OSError:
            rec = None
        if rec is None:
            raise HTTPException(404, "Recording unavailable. Check that Google Drive is connected.")
        try:
            staged = phone_inbox.stage(rec)
        except phone_inbox.RecordingNotReady as exc:
            raise HTTPException(409, str(exc)) from None
        except OSError:
            raise HTTPException(409, "Could not copy the recording. Check Drive sync and free disk space.") from None
        try:
            meta = store.create(rec.title, "", {}, copied=True, staged_source=(staged, rec.media.suffix),
                                phone_recording_id=rec.id)
        except OSError:
            raise HTTPException(500, "Could not save the recording in KT Scribe. Check free disk space.") from None
        finally:
            staged.unlink(missing_ok=True)
        pipeline.enqueue("process", meta["id"])
        return meta



@app.get("/api/sessions")
def sessions():
    return store.list_all()


@app.post("/api/sessions/import")
def import_path(body: dict = Body(...)):
    path = (body.get("path") or "").strip().strip('"')
    p = Path(path)
    if not p.is_file():
        raise HTTPException(400, f"File not found: {path}")
    if p.suffix.lower() not in VIDEO_EXT:
        raise HTTPException(400, f"Unsupported file type: {p.suffix}")
    title = (body.get("title") or "").strip()
    meta = store.create(title or p.stem, str(p.resolve()), _options(body.get("options")), copied=False)
    store.update(meta["id"], title_auto=not title)
    pipeline.enqueue("process", meta["id"])
    return store.get(meta["id"])


@app.post("/api/sessions/upload")
async def upload(request: Request, filename: str, title: str = "", options: str = "{}"):
    ext = Path(filename).suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, f"Unsupported file type: {ext}")
    meta = store.create(title.strip() or Path(filename).stem, "", _options(options), copied=True)
    sid = meta["id"]
    dest = store.sdir(sid) / f"source{ext}"
    try:
        with open(dest, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
    except Exception:
        store.delete(sid)
        raise HTTPException(400, "Upload interrupted")
    store.update(sid, video_path=str(dest), title_auto=not title.strip())
    pipeline.enqueue("process", sid)
    return store.get(sid)


@app.get("/api/sessions/{sid}")
def session(sid: str):
    m = _meta(sid)
    m["worker"] = pipeline.current()
    return m


@app.patch("/api/sessions/{sid}")
def patch_session(sid: str, body: dict = Body(...)):
    _meta(sid)
    if "title" in body:
        return store.update(sid, title=body["title"].strip()[:200] or "Untitled", title_auto=False)
    return _meta(sid)


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str):
    _meta(sid)
    pipeline.cancel(sid)
    time.sleep(0.2)
    store.delete(sid)
    return {"ok": True}


@app.post("/api/sessions/{sid}/cancel")
def cancel(sid: str):
    _meta(sid)
    pipeline.cancel(sid)
    return {"ok": True}


@app.post("/api/sessions/{sid}/resume")
def resume(sid: str, body: dict = Body(default={})):
    m = _meta(sid)
    redo = body.get("redo")  # e.g. "summary", "captions", "frames", "transcript"
    if redo in store.STAGES:
        idx = store.STAGES.index(redo)
        store.update(sid, stages={s: "pending" for s in store.STAGES[idx:]})
        if redo == "frames":
            shutil.rmtree(store.frames_dir(sid), ignore_errors=True)
            store.frames_dir(sid).mkdir(exist_ok=True)
            store.write_json(sid, "frames.json", [])
        if redo == "captions":
            fr = store.read_json(sid, "frames.json", [])
            for f in fr:
                if not f.get("manual"):
                    f["caption"], f["kind"] = "", "screen"
            store.write_json(sid, "frames.json", fr)
    if body.get("options"):
        opts = dict(m.get("options") or {})
        opts.update(_options(body["options"]))
        store.update(sid, options=opts)
    store.update(sid, status="queued", message="Queued", error=None)
    pipeline.enqueue("process", sid)
    return store.get(sid)


@app.get("/api/sessions/{sid}/video")
def video(sid: str):
    m = _meta(sid)
    p = Path(m.get("video_path") or "")
    if not p.is_file():
        raise HTTPException(404, "Video file not found (was it moved or deleted?)")
    return FileResponse(p)


# ----------------------------------------------------------------------------- transcript

@app.get("/api/sessions/{sid}/transcript")
def transcript(sid: str):
    _meta(sid)
    return store.read_json(sid, "transcript.json", {"partial": True, "segments": []})


@app.put("/api/sessions/{sid}/transcript/segment")
def edit_segment(sid: str, body: dict = Body(...)):
    _meta(sid)
    t = store.read_json(sid, "transcript.json", {"segments": []})
    for s in t["segments"]:
        if s["id"] == body["id"]:
            s["text"] = body["text"].strip()
    store.write_json(sid, "transcript.json", t)
    return {"ok": True}


@app.post("/api/sessions/{sid}/transcript/replace")
def replace_all(sid: str, body: dict = Body(...)):
    _meta(sid)
    find, repl = body.get("find", ""), body.get("replace", "")
    if not find:
        raise HTTPException(400, "Nothing to find")
    flags = 0 if body.get("case") else re.IGNORECASE
    pat = re.compile((r"\b%s\b" if body.get("whole") else "%s") % re.escape(find), flags)
    t = store.read_json(sid, "transcript.json", {"segments": []})
    n = 0
    for s in t["segments"]:
        s["text"], k = pat.subn(repl, s["text"])
        n += k
    store.write_json(sid, "transcript.json", t)
    return {"count": n}


@app.get("/api/sessions/{sid}/summary")
def summary(sid: str):
    _meta(sid)
    return store.read_json(sid, "summary.json", {})


# ----------------------------------------------------------------------------- screenshots

@app.get("/api/sessions/{sid}/frames")
def frames(sid: str):
    _meta(sid)
    return store.read_json(sid, "frames.json", [])


@app.get("/api/sessions/{sid}/frames/{fid}.jpg")
def frame_img(sid: str, fid: str):
    if not re.fullmatch(r"F\d{4,5}", fid):
        raise HTTPException(404)
    p = store.frames_dir(sid) / f"{fid}.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "max-age=86400"})


@app.patch("/api/sessions/{sid}/frames/{fid}")
def patch_frame(sid: str, fid: str, body: dict = Body(...)):
    _meta(sid)
    fr = store.read_json(sid, "frames.json", [])
    for f in fr:
        if f["id"] == fid:
            for k in ("caption", "hidden", "kind"):
                if k in body:
                    f[k] = body[k]
    store.write_json(sid, "frames.json", fr)
    return {"ok": True}


@app.delete("/api/sessions/{sid}/frames/{fid}")
def delete_frame(sid: str, fid: str):
    _meta(sid)
    fr = [f for f in store.read_json(sid, "frames.json", []) if f["id"] != fid]
    store.write_json(sid, "frames.json", fr)
    (store.frames_dir(sid) / f"{fid}.jpg").unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/sessions/{sid}/frames/capture")
def capture(sid: str, body: dict = Body(...)):
    m = _meta(sid)
    t = float(body.get("t", 0))
    fr = store.read_json(sid, "frames.json", [])
    nums = [int(f["id"][1:]) for f in fr] + [0]
    fid = f"F{max(nums) + 1:04d}"
    media.grab_frame(m["video_path"], t, store.frames_dir(sid) / f"{fid}.jpg")
    item = {"id": fid, "t": round(t, 2), "caption": body.get("caption", ""), "kind": "screen",
            "hidden": False, "manual": True}
    fr.append(item)
    fr.sort(key=lambda f: f["t"])
    store.write_json(sid, "frames.json", fr)
    return item


@app.post("/api/sessions/{sid}/frames/{fid}/describe")
def describe_frame(sid: str, fid: str):
    _meta(sid)
    s = config.load()
    if not s.get("vision_model"):
        raise HTTPException(400, "No vision model selected in Settings")
    fr = store.read_json(sid, "frames.json", [])
    f = next((x for x in fr if x["id"] == fid), None)
    if not f:
        raise HTTPException(404)
    segs = store.read_json(sid, "transcript.json", {}).get("segments", [])
    img = pipeline._jpeg_b64(store.frames_dir(sid) / f"{fid}.jpg")
    cap = llm.chat_text(s["ollama_url"], s["vision_model"], [{"role": "user", "images": [img],
                        "content": prompts.CAPTION_PROMPT.format(time=prompts.ts(f["t"]),
                        context=pipeline._context_around(segs, f["t"]))}],
                        role="vision", num_ctx=8192, max_tokens=160, temperature=0.1).strip()
    f["caption"], f["kind"] = ("Webcam / people view", "webcam") if cap.upper().startswith("WEBCAM") \
        else (cap.split("\n")[0][:400], "screen")
    store.write_json(sid, "frames.json", fr)
    return f


# ----------------------------------------------------------------------------- runbook

@app.get("/api/sessions/{sid}/runbook")
def get_runbook(sid: str):
    m = _meta(sid)
    return {"text": store.read_text(sid, "runbook.md"), "status": m.get("runbook"),
            "has_previous": (store.sdir(sid) / "runbook.prev.md").exists()}


@app.put("/api/sessions/{sid}/runbook")
def put_runbook(sid: str, body: dict = Body(...)):
    m = _meta(sid)
    if m.get("runbook", {}).get("state") == "running":
        raise HTTPException(409, "Runbook is being generated")
    store.write_text(sid, "runbook.md", body.get("text", ""))
    store.update(sid, runbook={"updated": time.time(), "state": "done" if body.get("text") else "none"})
    return {"ok": True}


@app.post("/api/sessions/{sid}/runbook/generate")
def gen_runbook(sid: str, body: dict = Body(default={})):
    m = _meta(sid)
    if not store.read_json(sid, "transcript.json", {}).get("segments"):
        raise HTTPException(400, "Transcript isn't ready yet")
    if m.get("runbook", {}).get("state") in ("running", "queued"):
        raise HTTPException(409, "Already generating")
    store.update(sid, runbook={"state": "queued", "error": None, "phase": "Queued"})
    pipeline.enqueue("runbook", sid, instructions=body.get("instructions", ""))
    return {"ok": True}


@app.post("/api/sessions/{sid}/runbook/cancel")
def cancel_runbook(sid: str):
    _meta(sid)
    pipeline.cancel(sid)
    return {"ok": True}


@app.post("/api/sessions/{sid}/runbook/restore")
def restore_runbook(sid: str):
    _meta(sid)
    prev = store.read_text(sid, "runbook.prev.md")
    if not prev:
        raise HTTPException(404, "No previous version")
    cur = store.read_text(sid, "runbook.md")
    store.write_text(sid, "runbook.md", prev)
    store.write_text(sid, "runbook.prev.md", cur)
    return {"text": prev}


# ----------------------------------------------------------------------------- exports

def _safe_name(s):
    return re.sub(r"[^\w\- ]+", "", s).strip().replace(" ", "_")[:80] or "session"


@app.get("/api/sessions/{sid}/export/{what}.{fmt}")
def export(sid: str, what: str, fmt: str):
    m = _meta(sid)
    title = m.get("title") or "KT session"
    segs = store.read_json(sid, "transcript.json", {}).get("segments", [])
    summ = store.read_json(sid, "summary.json", {})
    name = f"{_safe_name(title)}_{what}.{fmt}"
    tmp = store.sdir(sid) / "exports"
    tmp.mkdir(exist_ok=True)

    if what == "transcript":
        if fmt == "txt":
            body = f"{title}\n\n" + exporters.transcript_txt(segs)
        elif fmt == "srt":
            body = exporters.transcript_srt(segs)
        elif fmt in ("md", "docx", "pdf"):
            body = exporters.transcript_md(title, segs, summ)
        else:
            raise HTTPException(400)
    elif what == "runbook":
        body = store.read_text(sid, "runbook.md")
        if not body.strip():
            raise HTTPException(400, "Runbook is empty")
    elif what == "summary":
        body = f"# {title}\n\n" + exporters.summary_md(summ)
    else:
        raise HTTPException(404)

    if fmt in ("txt", "srt", "md"):
        if fmt == "md" and what == "runbook":
            body = re.sub(r"\(frame:(F\d+)\)", r"(frames/\1.jpg)", body)
        return Response(body, media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    out = tmp / name
    if fmt == "docx":
        exporters.to_docx(body, store.frames_dir(sid), out, title)
        mt = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif fmt == "pdf":
        exporters.to_pdf(body, store.frames_dir(sid), out, title)
        mt = "application/pdf"
    else:
        raise HTTPException(400)
    return FileResponse(out, media_type=mt, filename=name)


# ----------------------------------------------------------------------------- chat

def _chat_context(sid, s):
    segs = store.read_json(sid, "transcript.json", {}).get("segments", [])
    text = prompts.transcript_text(segs)
    max_ctx = int(s.get("max_context", 65536))
    if llm.est_tokens(text) > max_ctx - 10000:
        notes = store.read_text(sid, "notes.md")
        if not notes:
            notes = pipeline._condense(s, text, s["assistant_model"], "assistant")
            store.write_text(sid, "notes.md", notes)
        text = "(Condensed notes of a long session)\n" + notes
    return text


@app.get("/api/sessions/{sid}/chat")
def get_chat(sid: str):
    _meta(sid)
    return store.read_json(sid, "chat.json", [])


@app.delete("/api/sessions/{sid}/chat")
def clear_chat(sid: str):
    _meta(sid)
    store.write_json(sid, "chat.json", [])
    return {"ok": True}


@app.post("/api/sessions/{sid}/chat")
def chat(sid: str, body: dict = Body(...)):
    m = _meta(sid)
    s = config.load()
    q = (body.get("question") or "").strip()
    if not q:
        raise HTTPException(400, "Empty question")
    history = store.read_json(sid, "chat.json", [])
    summ = store.read_json(sid, "summary.json", {})
    frames_ = store.read_json(sid, "frames.json", [])
    model = s.get("assistant_model")

    def gen():
        try:
            transcript_text = _chat_context(sid, s)
            system = prompts.CHAT_SYSTEM.format(
                title=m.get("title", ""), summary=summ.get("summary", "(none)"),
                frames=prompts.frames_text(frames_) or "(none)", transcript=transcript_text)
            msgs = [{"role": "system", "content": system}]
            msgs += [{"role": h["role"], "content": h["content"]} for h in history[-12:]]
            msgs.append({"role": "user", "content": q})
            prompt_tokens = sum(llm.est_tokens(x["content"]) for x in msgs)
            answer = []
            for kind, chunk in llm.chat(s["ollama_url"], model, msgs, role="assistant",
                                        num_ctx=llm.ctx_for(prompt_tokens, 3000, int(s.get("max_context", 65536))),
                                        max_tokens=3000, temperature=0.2):
                if kind == "content":
                    answer.append(chunk)
                yield json.dumps({"t": kind, "d": chunk}) + "\n"
            full = "".join(answer).strip()
            hist = store.read_json(sid, "chat.json", [])
            hist += [{"role": "user", "content": q, "ts": time.time()},
                     {"role": "assistant", "content": full, "ts": time.time(), "model": model}]
            store.write_json(sid, "chat.json", hist)
            yield json.dumps({"t": "done"}) + "\n"
        except Exception as e:
            yield json.dumps({"t": "error", "d": str(e)}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ----------------------------------------------------------------------------- UI

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
