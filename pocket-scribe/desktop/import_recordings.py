"""Verify synced VoiceCam files and hand them to a Windows AI app. Python 3.10+, stdlib only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time
import uuid


class NotReady(Exception):
    """Drive Desktop has not fully synchronized this recording yet."""


def digest(path: Path) -> str:
    result = hashlib.md5()
    with path.open("rb") as source:
        for data in iter(lambda: source.read(1024 * 1024), b""):
            result.update(data)
    return result.hexdigest()


def validate(item: dict) -> None:
    if item.get("schemaVersion") != 1:
        raise ValueError("Unsupported manifest version")
    uuid.UUID(item["sessionId"])
    if str(uuid.UUID(item["sessionId"])) != item["sessionId"]:
        raise ValueError("Invalid session identifier")
    if type(item.get("sequence")) is not int or item["sequence"] < 1:
        raise ValueError("Invalid sequence")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", item["driveId"]):
        raise ValueError("Invalid Drive identifier")
    name = item["mediaFile"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.(mp4|m4a)", name) or name in {".", ".."}:
        raise ValueError("Unsafe media filename")
    if item["mode"] not in {"audio_only", "audio_video"}:
        raise ValueError("Invalid recording mode")
    if (item["mode"] == "audio_only") != name.endswith(".m4a"):
        raise ValueError("Mode and file type do not match")
    if type(item.get("sizeBytes")) is not int or item["sizeBytes"] <= 0:
        raise ValueError("Invalid size")
    if not re.fullmatch(r"[0-9a-f]{32}", item["md5"]):
        raise ValueError("Invalid checksum")


def import_one(sidecar: Path, inbox: Path, database: sqlite3.Connection) -> bool:
    if sidecar.stat().st_size > 64 * 1024:
        raise ValueError("Manifest is unexpectedly large")
    item = json.loads(sidecar.read_text(encoding="utf-8"))
    validate(item)
    if item.get("backupPart", False):
        return False  # The named final copy is imported once; live backups are not duplicate AI jobs.
    row = database.execute("SELECT checksum FROM imports WHERE drive_id = ?", (item["driveId"],)).fetchone()
    if row:
        if row[0] != item["md5"]:
            raise ValueError("Previously imported Drive ID now has a different checksum")
        return False
    source = sidecar.parent / item["mediaFile"]
    if not source.is_file() or source.stat().st_size != item["sizeBytes"]:
        raise NotReady("Waiting for the media file to finish syncing")
    if digest(source) != item["md5"]:
        raise NotReady("Waiting for a media copy with the expected checksum")
    directory = inbox / item["sessionId"]
    directory.mkdir(parents=True, exist_ok=True)
    basename = f'{item["sequence"]:06d}_{item["driveId"]}'
    target = directory / (basename + source.suffix)
    ready = directory / (basename + ".ready.json")
    descriptor, temporary = tempfile.mkstemp(prefix=".copy-", suffix=".partial", dir=directory)
    os.close(descriptor)
    temporary = Path(temporary)
    try:
        shutil.copyfile(source, temporary)
        if temporary.stat().st_size != item["sizeBytes"] or digest(temporary) != item["md5"]:
            raise NotReady("Source changed during sync; will retry")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    delivered = dict(item, mediaPath=str(target.resolve()), sourceManifest=str(sidecar.resolve()))
    # Atomic .ready.json is the only signal the AI app should watch. Replays reuse the same path/ID.
    descriptor, temporary_name = tempfile.mkstemp(prefix=".manifest-", suffix=".partial", dir=directory)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(delivered, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary_name, ready)
    database.execute("INSERT OR IGNORE INTO imports (drive_id, checksum) VALUES (?, ?)", (item["driveId"], item["md5"]))
    database.commit()
    return True


def open_database(inbox: Path) -> sqlite3.Connection:
    inbox.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(inbox / ".voicecam-imports.sqlite3", timeout=30)
    connection.execute("CREATE TABLE IF NOT EXISTS imports (drive_id TEXT PRIMARY KEY, checksum TEXT NOT NULL)")
    connection.commit()
    return connection


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Synced Google Drive VoiceCam folder")
    parser.add_argument("--inbox", type=Path, required=True, help="Local folder watched by the AI app")
    parser.add_argument("--once", action="store_true", help="Scan once and exit")
    parser.add_argument("--poll", type=float, default=10, help="Seconds between scans, minimum 2")
    args = parser.parse_args()
    source, inbox = args.source.resolve(), args.inbox.resolve()
    if source == inbox or source in inbox.parents or inbox in source.parents:
        parser.error("Use separate source and inbox folders, with neither nested in the other")
    if not source.is_dir():
        parser.error("Source folder does not exist; set up Google Drive for desktop first")
    database = open_database(inbox)
    messages = {}
    print(f"Watching {source}\nVerified recording inbox: {inbox}", flush=True)
    try:
        while True:
            for sidecar in source.rglob("*.json"):
                try:
                    if import_one(sidecar, inbox, database):
                        print(f"Imported {sidecar.name}", flush=True)
                    messages.pop(str(sidecar), None)
                except (OSError, ValueError, KeyError, TypeError, NotReady) as error:
                    message = f"{sidecar.name}: {error}"
                    if messages.get(str(sidecar)) != message:
                        print(message, flush=True)
                        messages[str(sidecar)] = message
            if args.once:
                break
            time.sleep(max(2, args.poll))
    except KeyboardInterrupt:
        print("Importer stopped. Existing imports are retained.")
    finally:
        database.close()


if __name__ == "__main__":
    main()
