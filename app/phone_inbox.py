"""Read the finished recordings Pocket Scribe sends through Google Drive."""
import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import config


@dataclass(frozen=True)
class Recording:
    id: str
    title: str
    mode: str
    started_at: str
    duration_ms: int
    media: Path
    size: int
    checksum: str

    def available(self) -> bool:
        try:
            return self.media.is_file() and self.media.stat().st_size == self.size
        except OSError:
            return False


def folder() -> Path | None:
    configured = config.load()["phone_recordings_folder"]
    if configured:
        return Path(configured)
    drives = getattr(os, "listdrives", lambda: [])()
    for name in ("Pocket Scribe", "VoiceCam"):
        for drive in drives:
            candidate = Path(drive) / "My Drive" / name
            if candidate.is_dir():
                return candidate
    return None


def _read(sidecar: Path, root: Path) -> Recording | None:
    if sidecar.resolve().parent != root:
        return None
    limit = 64 * 1024
    with sidecar.open("rb") as source:
        content = source.read(limit + 1)
    if len(content) > limit:
        return None
    item = json.loads(content)
    if not isinstance(item, dict) or item.get("schemaVersion") != 1:
        return None
    if item.get("finalCopy") is not True or item.get("backupPart") is True:
        return None

    ident = item["sessionId"]
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", ident):
        return None
    mode = item["mode"]
    extension = {"audio_only": ".m4a", "audio_video": ".mp4"}[mode]
    name = item["mediaFile"]
    if name != sidecar.stem + extension or any(char in name for char in r'\/:'):
        return None
    media = (root / name).resolve()
    if media.parent != root or media.name != name:
        return None
    size = item["sizeBytes"]
    checksum = item["md5"]
    if type(size) is not int or size <= 0 or not re.fullmatch(r"[0-9a-f]{32}", checksum):
        return None
    duration = item.get("durationMs")
    title = item.get("recordingName") or sidecar.stem
    return Recording(ident, title.strip()[:200] or sidecar.stem, mode,
                     item["startedAt"][:40], max(0, duration) if type(duration) is int else 0,
                     media, size, checksum)


def scan(directory: Path) -> dict[str, Recording]:
    root = directory.resolve(strict=True)
    recordings = {}
    for sidecar in sorted(root.glob("*.json")):
        try:
            recording = _read(sidecar, root)
        except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError):
            continue
        if recording and (recording.id not in recordings or recording.available()):
            recordings[recording.id] = recording
    return recordings


class RecordingNotReady(Exception):
    pass


def stage(recording: Recording) -> Path:
    """Copy one file locally and check the bytes that will actually be processed."""
    if not recording.available():
        raise RecordingNotReady("The recording is still syncing. Try again in a moment.")
    checksum = hashlib.md5(usedforsecurity=False)
    size = 0
    staged = None
    try:
        with tempfile.NamedTemporaryFile(dir=config.DATA_DIR, prefix="phone-", suffix=".partial",
                                         delete=False) as target:
            staged = Path(target.name)
            if recording.media.resolve(strict=True) != recording.media:
                raise RecordingNotReady("The recording changed during sync. Try again shortly.")
            with recording.media.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > recording.size:
                        break
                    target.write(chunk)
                    checksum.update(chunk)
        if size != recording.size or checksum.hexdigest() != recording.checksum:
            raise RecordingNotReady("The recording has not synced completely. Try again shortly.")
        return staged
    except Exception:
        if staged is not None:
            staged.unlink(missing_ok=True)
        raise
