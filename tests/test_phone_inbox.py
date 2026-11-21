import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app import config, main, store


class PhoneInboxTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.drive = self.root / "Pocket Scribe"
        self.drive.mkdir()
        data = self.root / "data"
        for name, value in {"DATA_DIR": data, "SESSIONS_DIR": data / "sessions",
                            "SETTINGS_FILE": data / "settings.json"}.items():
            patcher = patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        main.set_phone_folder({"folder": str(self.drive)})

    def recording(self, ident, *, audio=False, backup=False):
        stem = ident[:8]
        target = self.drive / (stem + (".m4a" if audio else ".mp4"))
        data = b"sample recording"
        target.write_bytes(data)
        sidecar = target.with_suffix(".json")
        sidecar.write_text(json.dumps({
            "schemaVersion": 1, "finalCopy": not backup, "backupPart": backup,
            "sessionId": ident, "driveId": "id_" + stem,
            "recordingName": "Team handover", "mode": "audio_only" if audio else "audio_video",
            "startedAt": "2026-11-21T15:30:00Z", "durationMs": 125000,
            "sizeBytes": len(data), "mediaFile": target.name, "md5": hashlib.md5(data).hexdigest(),
        }), encoding="utf-8")
        return target

    def test_scan_and_process_final_once(self):
        video_id = "11111111-1111-1111-1111-111111111111"
        audio_id = "22222222-2222-2222-2222-222222222222"
        original = self.recording(video_id)
        self.recording(audio_id, audio=True)
        self.recording("33333333-3333-3333-3333-333333333333", backup=True)
        with patch.object(main.pipeline, "enqueue") as enqueue:
            rows = {r["id"]: r for r in main.list_phone_recordings()["recordings"]}
            self.assertEqual(set(rows), {video_id, audio_id})
            self.assertEqual(rows[audio_id]["mode"], "audio_only")
            self.assertEqual(rows[video_id]["state"], "available")
            enqueue.assert_not_called()

            session = main.process_phone_recording(video_id, {})
            self.assertEqual(session["title"], "Team handover")
            self.assertEqual(Path(session["video_path"]).read_bytes(), original.read_bytes())
            self.assertNotEqual(Path(session["video_path"]), original)
            self.assertEqual(main.process_phone_recording(video_id, {})["id"], session["id"])
            enqueue.assert_called_once_with("process", session["id"])

        rows = {r["id"]: r for r in main.list_phone_recordings()["recordings"]}
        self.assertEqual(rows[video_id]["sessionId"], session["id"])

    def test_partial_and_corrupt_sync_never_starts_processing(self):
        ident = "44444444-4444-4444-4444-444444444444"
        media = self.recording(ident)
        media.write_bytes(b"incomplete")
        self.assertEqual(main.list_phone_recordings()["recordings"][0]["state"], "syncing")
        media.write_bytes(b"x" * len(b"sample recording"))
        with patch.object(main.pipeline, "enqueue") as enqueue, self.assertRaises(HTTPException) as error:
            main.process_phone_recording(ident, {})
        self.assertEqual(error.exception.status_code, 409)
        enqueue.assert_not_called()
        self.assertEqual(store.list_all(), [])

    def test_manifest_cannot_read_media_outside_folder(self):
        ident = "55555555-5555-5555-5555-555555555555"
        media = self.recording(ident)
        sidecar = media.with_suffix(".json")
        manifest = json.loads(sidecar.read_text(encoding="utf-8"))
        manifest["mediaFile"] = "../outside.mp4"
        sidecar.write_text(json.dumps(manifest), encoding="utf-8")
        self.assertEqual(main.list_phone_recordings()["recordings"], [])
