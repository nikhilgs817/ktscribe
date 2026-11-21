"""Prompt text and transcript formatting helpers."""


def ts(sec: float) -> str:
    sec = int(max(0, sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def blocks(segments: list[dict], max_sec: float = 30.0, gap: float = 2.5, breaks=()) -> list[dict]:
    """Merge whisper segments into readable paragraphs (~30 s, at pauses, and at chapter starts)."""
    out = []
    cur = None
    for s in segments:
        crosses = cur and any(cur["start"] + 1 < b <= s["start"] + 1 for b in breaks)
        if cur and (crosses or s["start"] - cur["end"] > gap or s["end"] - cur["start"] > max_sec):
            out.append(cur)
            cur = None
        if cur is None:
            cur = {"start": s["start"], "end": s["end"], "text": s["text"], "ids": [s["id"]]}
        else:
            cur["end"] = s["end"]
            cur["text"] += " " + s["text"]
            cur["ids"].append(s["id"])
    if cur:
        out.append(cur)
    return out


def transcript_text(segments: list[dict]) -> str:
    return "\n".join(f"[{ts(b['start'])}] {b['text']}" for b in blocks(segments))


def frames_text(frames: list[dict]) -> str:
    rows = []
    for f in frames:
        if f.get("hidden") or f.get("kind") == "webcam":
            continue
        cap = f.get("caption") or "(no description)"
        rows.append(f"{f['id']} @ {ts(f['t'])} — {cap}")
    return "\n".join(rows)


def split_chunks(text: str, max_chars: int) -> list[str]:
    lines, chunks, cur, size = text.splitlines(), [], [], 0
    for ln in lines:
        if size + len(ln) > max_chars and cur:
            chunks.append("\n".join(cur))
            cur, size = [], 0
        cur.append(ln)
        size += len(ln) + 1
    if cur:
        chunks.append("\n".join(cur))
    return chunks


CONTEXT_NOTE = ("The transcript was produced by speech recognition, so expect some misheard words — "
                "infer the intended technical term when it is obvious (e.g. 'cloud watch' = CloudWatch).")

NOTES_SYSTEM = ("You condense part of a technical knowledge-transfer (KT) meeting transcript into dense, "
                "factual notes for a later writer. Keep every concrete detail: system names, environments, "
                "AWS services, hosts, URLs, paths, commands, config keys, schedules, thresholds, people/teams, "
                "steps in order, gotchas and open questions. Keep the [mm:ss] timestamp of each fact. "
                "No preamble. " + CONTEXT_NOTE)

SUMMARY_SYSTEM = ("You analyse a recorded technical knowledge-transfer (KT) meeting and return JSON only. "
                  + CONTEXT_NOTE)

SUMMARY_USER = """Analyse this KT session and return JSON with:
- "title": short descriptive title (max 8 words)
- "summary": 2 short paragraphs on what was covered
- "key_points": 5-12 most important facts a new owner must know
- "chapters": topic changes in order, each {{"start": "mm:ss" (copy a timestamp from the transcript), "title": "...", "summary": "one sentence"}} — about one chapter per 3-8 minutes
- "systems": every system, tool, AWS service, server, URL, repo or environment mentioned
- "action_items": follow-ups / things the new owner should do
- "open_questions": things that were unclear, contradicted, or not covered

TRANSCRIPT:
{transcript}"""

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "key_points": {"type": "array", "items": {"type": "string"}},
        "chapters": {"type": "array", "items": {"type": "object", "properties": {
            "start": {"type": "string"}, "title": {"type": "string"}, "summary": {"type": "string"}},
            "required": ["start", "title"]}},
        "systems": {"type": "array", "items": {"type": "string"}},
        "action_items": {"type": "array", "items": {"type": "string"}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "summary", "key_points", "chapters"],
}

RUNBOOK_SYSTEM = ("You are a senior DevOps/SRE technical writer. You turn knowledge-transfer (KT) meeting "
                  "recordings into clear, accurate operational runbooks in Markdown. " + CONTEXT_NOTE)

RUNBOOK_USER = """Write an operational runbook from the KT session below, following this structure (adapt headings when the session clearly calls for it; drop nothing that was covered):

<template>
{template}
</template>

Rules:
1. Use ONLY information from the session. Never invent hostnames, values, commands or contacts. If a template section was not covered, write "_Not covered in the KT session._" under it.
2. Procedures are numbered steps an on-call engineer can follow. Use tables for inventories (servers, services, alarms, contacts) and for Troubleshooting.
3. Put commands, paths and config in `inline code` or fenced code blocks.
4. Cite where each fact came from with the transcript timestamp in square brackets, e.g. [12:34], at the end of the sentence or step.
5. Screenshots: insert relevant ones on their own line as ![short caption](frame:F0012), right after the text they illustrate. Use only IDs from the SCREENSHOTS list. Prefer screenshots of consoles, dashboards, configs and diagrams; at most one or two per subsection.
6. Never write passwords, keys or tokens even if spoken — write where they are stored instead.
7. Output the Markdown document only — no preamble, no closing remarks.
{extra}
SESSION TITLE: {title}

SCREENSHOTS (id @ time — what it shows):
{frames}

{source_label}:
{transcript}"""

CHAT_SYSTEM = """You are an assistant answering questions about a recorded technical knowledge-transfer (KT) session titled "{title}".
Answer from the session content below. If the answer isn't in the session, say so plainly and suggest what to ask the colleague.
Cite timestamps in square brackets like [12:34] for every fact. Be concise and practical; use lists, tables or code blocks when helpful.
""" + CONTEXT_NOTE + """

SUMMARY:
{summary}

SCREENSHOTS:
{frames}

TRANSCRIPT:
{transcript}"""

CAPTION_PROMPT = """This is a frame from a recorded technical knowledge-transfer call (at {time}). Around this moment the speaker said: "{context}"

Describe what the screen shows in 1-2 sentences for an engineer: the application or console page (e.g. "AWS CloudWatch alarms list", "Jenkins job config"), and key visible names, settings, values or errors.
If the frame only shows people / a webcam view with no useful screen content, reply exactly: WEBCAM"""
