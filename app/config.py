"""App settings: stored as JSON in the data folder, editable from the UI."""
import json
import os
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("KTSCRIBE_DATA", ROOT / "data"))
SESSIONS_DIR = DATA_DIR / "sessions"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_RUNBOOK_TEMPLATE = """# {title} — Runbook

## 1. Overview
Purpose of the application, who uses it, business criticality, scope of this runbook.

## 2. Architecture & Hosting
Components, AWS services/accounts/regions, environments (dev/test/prod), network, data stores, integrations. Use a table where helpful.

## 3. Access & Prerequisites
Accounts, roles, VPN, tools, repositories, credentials location (never the secrets themselves).

## 4. Configuration
Where configuration lives, key parameters, how to change them safely.

## 5. Build, Deploy & Release
Numbered step-by-step procedure, including validation and rollback.

## 6. Monitoring & Alerting
Dashboards, metrics, logs, alarms, thresholds, who gets paged.

## 7. Troubleshooting
Table: Symptom | Likely cause | Fix.

## 8. Routine Operations
Scheduled jobs, maintenance, certificate/password rotation, backups, housekeeping.

## 9. Contacts, Links & Open Questions
People/teams mentioned, URLs, and anything that was unclear or not covered in the KT.
"""

DEFAULT_INVITE_INSTRUCTIONS = (
    "Draft a follow-up meeting invite for the people in this session: a clear subject, "
    "one-line purpose, a short agenda built from the open questions and action items, "
    "and what attendees should prepare.")

DEFAULT_CLAUDE_BRIEF = """# Brief for Claude

I recorded a working session and turned it into the files in this folder:

- `transcript.md`: everything that was said, with [mm:ss] timestamps.
- `kt-document.md`: the knowledge-transfer document written from it.
- `summary.md`: summary, chapters, action items and open questions.
- `screenshots/`: the screens that were shown. `screenshots/index.md` lists each one with its time and what it shows.

## What I want you to build

{goal}

## How to work

1. Read `kt-document.md` and `summary.md` first, then check details in `transcript.md` and the screenshots.
2. Use only what the session shows. When something needed is missing (a hostname, a path, a credential location), list it as a question instead of guessing.
3. Start with a short plan, then build it step by step.
"""

DEFAULTS = {
    # AI engine: ollama | openai (vLLM or any OpenAI-compatible server) | anthropic (Claude, cloud)
    "llm_provider": "ollama",
    "ollama_url": "http://127.0.0.1:11434",
    "openai_url": "http://127.0.0.1:8000/v1",
    "openai_key_enc": "",
    "anthropic_key_enc": "",
    # Model roles (auto-filled from installed Ollama models on first run)
    "writer_model": "",      # runbooks & documents  -> gpt-oss:120b
    "assistant_model": "",   # summary, chapters, Q&A -> Qwen3.6-35B-A3B
    "vision_model": "",      # screenshot descriptions -> Qwen3.6-35B-A3B (multimodal)
    "writer_reasoning": "medium",   # gpt-oss reasoning effort: low|medium|high
    "max_context": 65536,           # tokens; long sessions are chunked above this
    # Speech-to-text
    "asr_engine": "faster-whisper",  # faster-whisper | whisper.cpp
    "whisper_model": "large-v3-turbo",
    "whisper_compute": "int8",
    "whisper_threads": 0,            # 0 = auto
    "whisper_beam": 5,
    "whispercpp_exe": "",            # path to whisper-cli.exe (Vulkan build for AMD GPU)
    "whispercpp_model": "",          # path to ggml-large-v3-turbo.bin
    "language": "auto",
    "vocabulary": "AWS, EC2, S3, CloudWatch, CloudFormation, Terraform, IAM, VPC, RDS, Lambda, ECS, EKS, Jenkins, Ansible, GitLab, SonarQube, Nexus, WebSphere, Kubernetes, Splunk",
    # Screenshots
    "frame_sensitivity": "medium",   # low | medium | high
    "describe_frames": True,
    "max_frames": 150,
    "phone_recordings_folder": "",
    # Phone & Google Drive
    "auto_process_phone": True,      # process new phone recordings as soon as Drive syncs them
    "auto_process_since": "",        # only recordings started after this (set when switched on)
    "phone_poll_seconds": 60,
    "drive_outputs": True,           # copy finished outputs to <Drive folder>/Outputs/
    # Automatic outputs after processing
    "auto_kt_doc": True,
    "auto_invite": True,
    "invite_instructions": DEFAULT_INVITE_INSTRUCTIONS,
    "invite_duration": 30,
    "claude_brief": DEFAULT_CLAUDE_BRIEF,
    "bundle_skip_webcam": True,
    # Appearance
    "theme": "system",               # system | light | dark
    "animations": True,
    "runbook_template": DEFAULT_RUNBOOK_TEMPLATE,
}

SECRET_FIELDS = {"anthropic_key": "anthropic_key_enc", "openai_key": "openai_key_enc"}

_lock = threading.Lock()


def ensure_dirs():
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def load() -> dict:
    ensure_dirs()
    data = dict(DEFAULTS)
    if SETTINGS_FILE.exists():
        try:
            data.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
        except Exception:
            pass
    return data


def public(data: dict) -> dict:
    """Settings as the page sees them: keys never leave the PC, only whether one is set."""
    out = {k: v for k, v in data.items() if not k.endswith("_key_enc")}
    for plain, enc in SECRET_FIELDS.items():
        out[plain + "_set"] = bool(data.get(enc))
    return out


def save(updates: dict) -> dict:
    from . import secret_store
    with _lock:
        data = load()
        for plain, enc in SECRET_FIELDS.items():
            if plain in updates and isinstance(updates[plain], str):
                data[enc] = secret_store.protect(updates[plain].strip())
        if updates.get("auto_process_phone") and not data.get("auto_process_phone"):
            data["auto_process_since"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for k, v in updates.items():
            if k in DEFAULTS and not k.endswith("_key_enc"):
                data[k] = v
        SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data
