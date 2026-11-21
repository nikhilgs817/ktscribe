"""App settings: stored as JSON in the data folder, editable from the UI."""
import json
import os
import threading
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

DEFAULTS = {
    "ollama_url": "http://127.0.0.1:11434",
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
    "runbook_template": DEFAULT_RUNBOOK_TEMPLATE,
}

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


def save(updates: dict) -> dict:
    with _lock:
        data = load()
        for k, v in updates.items():
            if k in DEFAULTS:
                data[k] = v
        SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data
