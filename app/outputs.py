"""The three things a session turns into besides the transcript:
a meeting invite, a bundle to hand to Claude, and copies of everything in Google Drive."""
import datetime as dt
import io
import json
import re
import shutil
import time
import zipfile
from pathlib import Path

from . import config, exporters, llm, phone_inbox, prompts, store


def safe_name(text: str) -> str:
    return re.sub(r"[^\w\- ]+", "", text or "").strip().replace(" ", "_")[:80] or "session"


# --------------------------------------------------------------------------- meeting invite

def make_invite(sid: str, s: dict, source) -> dict:
    """source(s, sid, model, role, reserve) -> (label, text); passed in to reuse the pipeline's condensing."""
    meta = store.get(sid)
    model = s.get("assistant_model")
    if not model:
        raise RuntimeError("No assistant model selected. Open Settings.")
    summ = store.read_json(sid, "summary.json", {})
    label, text = source(s, sid, model, "assistant", 6000)
    duration = int(s.get("invite_duration") or 30)
    user = prompts.INVITE_USER.format(
        instructions=s.get("invite_instructions") or config.DEFAULT_INVITE_INSTRUCTIONS,
        duration=duration, title=meta.get("title", ""), summary=summ.get("summary", "(none)"),
        actions="\n".join(f"- {a}" for a in summ.get("action_items", [])) or "(none)",
        questions="\n".join(f"- {q}" for q in summ.get("open_questions", [])) or "(none)",
        source_label=label, transcript=text)
    msgs = [{"role": "system", "content": prompts.INVITE_SYSTEM}, {"role": "user", "content": user}]
    raw = llm.chat_text(s, model, msgs, role="assistant",
                        num_ctx=llm.ctx_for(llm.est_tokens(user), 2500, int(s.get("max_context", 65536))),
                        max_tokens=2500, temperature=0.3, fmt=prompts.INVITE_SCHEMA).strip()
    data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    data["duration_minutes"] = duration
    store.write_json(sid, "invite.json", data)
    return data


def invite_text(inv: dict) -> str:
    lines = [f"Subject: {inv.get('subject', '')}", ""]
    if inv.get("attendees"):
        lines += ["Attendees: " + ", ".join(inv["attendees"]), ""]
    lines.append(inv.get("body", "").strip())
    return "\n".join(lines).strip() + "\n"


def _ics_escape(t: str) -> str:
    return t.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def invite_ics(inv: dict, sid: str) -> str:
    """A calendar file Outlook and Google Calendar can open. The time is a placeholder
    (next working day, 10:00 local) that the user moves before sending."""
    day = dt.date.today() + dt.timedelta(days=1)
    while day.weekday() >= 5:
        day += dt.timedelta(days=1)
    start = dt.datetime.combine(day, dt.time(10, 0))
    end = start + dt.timedelta(minutes=int(inv.get("duration_minutes") or 30))
    f = "%Y%m%dT%H%M%S"
    body = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pocket Scribe//Desktop//EN", "METHOD:PUBLISH",
        "BEGIN:VEVENT", f"UID:{sid}@pocket-scribe", f"DTSTAMP:{time.strftime(f, time.gmtime())}Z",
        f"DTSTART:{start.strftime(f)}", f"DTEND:{end.strftime(f)}",
        f"SUMMARY:{_ics_escape(inv.get('subject', 'Follow-up'))}",
        f"DESCRIPTION:{_ics_escape(inv.get('body', ''))}",
        "END:VEVENT", "END:VCALENDAR",
    ]
    return "\r\n".join(body) + "\r\n"


# --------------------------------------------------------------------------- Claude bundle

def bundle_files(sid: str, s: dict) -> dict[str, bytes]:
    """Everything Claude needs, as {path in zip: bytes}."""
    meta = store.get(sid)
    title = meta.get("title") or "Session"
    segs = store.read_json(sid, "transcript.json", {}).get("segments", [])
    summ = store.read_json(sid, "summary.json", {})
    frames = [f for f in store.read_json(sid, "frames.json", []) if not f.get("hidden")]
    if s.get("bundle_skip_webcam", True):
        frames = [f for f in frames if f.get("kind") != "webcam"]
    goal = (meta.get("bundle_goal") or "").strip() or \
        "_Describe the automation or document you want, for example: automate the certificate renewal shown in this session._"
    brief = (s.get("claude_brief") or config.DEFAULT_CLAUDE_BRIEF).replace("{goal}", goal).replace("{title}", title)
    files = {
        "BRIEF.md": brief.encode(),
        "transcript.md": exporters.transcript_md(title, segs, summ).encode(),
        "summary.md": (f"# {title}\n\n" + exporters.summary_md(summ)).encode(),
    }
    kt = store.read_text(sid, "runbook.md")
    if kt.strip():
        files["kt-document.md"] = re.sub(r"\(frame:(F\d+)\)", r"(screenshots/\1.jpg)", kt).encode()
    rows = ["# Screenshots", "", "| File | Time | What it shows |", "|---|---|---|"]
    for f in frames:
        p = store.frames_dir(sid) / f"{f['id']}.jpg"
        if p.exists():
            files[f"screenshots/{f['id']}.jpg"] = p.read_bytes()
            cap = (f.get("caption") or "").replace("|", "/") or "(no description)"
            rows.append(f"| {f['id']}.jpg | {prompts.ts(f['t'])} | {cap} |")
    files["screenshots/index.md"] = ("\n".join(rows) + "\n").encode()
    inv = store.read_json(sid, "invite.json", None)
    if inv:
        files["meeting-invite.txt"] = invite_text(inv).encode()
    return files


def bundle_zip(sid: str, s: dict) -> bytes:
    buf = io.BytesIO()
    folder = safe_name(store.get(sid).get("title", "session"))
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in bundle_files(sid, s).items():
            z.writestr(f"{folder}/{name}", data)
    return buf.getvalue()


# --------------------------------------------------------------------------- Google Drive copy

def drive_outputs_dir() -> Path | None:
    root = phone_inbox.folder()
    if root is None or not root.is_dir():
        return None
    return root / "Outputs"


def copy_to_drive(sid: str, s: dict) -> str:
    """Write the finished outputs into <Drive folder>/Outputs/<date title>/ so they sync everywhere."""
    base = drive_outputs_dir()
    if base is None:
        return ""
    meta = store.get(sid)
    stamp = time.strftime("%Y-%m-%d", time.localtime(meta.get("created", time.time())))
    dest = base / f"{stamp} {safe_name(meta.get('title', 'session')).replace('_', ' ')}"
    tmp = dest.with_name(dest.name + ".partial")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    title = meta.get("title") or "Session"
    kt = store.read_text(sid, "runbook.md")
    if kt.strip():
        exporters.to_docx(kt, store.frames_dir(sid), tmp / "KT document.docx", title)
    inv = store.read_json(sid, "invite.json", None)
    if inv:
        (tmp / "Meeting invite.txt").write_text(invite_text(inv), encoding="utf-8")
        (tmp / "Meeting invite.ics").write_text(invite_ics(inv, sid), encoding="utf-8", newline="")
    (tmp / "Claude bundle.zip").write_bytes(bundle_zip(sid, s))
    shutil.rmtree(dest, ignore_errors=True)
    tmp.replace(dest)
    return str(dest)
