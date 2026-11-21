import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from import_recordings import NotReady, import_one, open_database


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "drive"
        self.source.mkdir()
        self.inbox = self.root / "inbox"
        self.db = open_database(self.inbox)
        self.media = self.source / "recording.m4a"
        self.media.write_bytes(b"test media payload")
        self.item = dict(schemaVersion=1, sessionId=str(uuid.uuid4()), sequence=1,
                         mode="audio_only", mediaFile=self.media.name, driveId="drive_file_1",
                         sizeBytes=self.media.stat().st_size,
                         md5=hashlib.md5(self.media.read_bytes()).hexdigest())
        self.sidecar = self.source / "recording.json"
        self.save()

    def save(self):
        self.sidecar.write_text(json.dumps(self.item), encoding="utf-8")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_verified_recording_creates_atomic_ready_manifest(self):
        self.assertTrue(import_one(self.sidecar, self.inbox, self.db))
        ready = list(self.inbox.rglob("*.ready.json"))
        self.assertEqual(len(ready), 1)
        delivered = json.loads(ready[0].read_text())
        self.assertEqual(Path(delivered["mediaPath"]).read_bytes(), self.media.read_bytes())
        self.assertFalse(list(self.inbox.rglob("*.partial")))

    def test_live_backup_parts_are_not_duplicate_ai_jobs(self):
        self.item["backupPart"] = True
        self.save()
        self.assertFalse(import_one(self.sidecar, self.inbox, self.db))
        self.assertFalse(list(self.inbox.rglob("*.ready.json")))

    def test_named_final_copy_keeps_title(self):
        self.item.update(finalCopy=True, backupPart=False, recordingName="Planning meeting")
        self.save()
        self.assertTrue(import_one(self.sidecar, self.inbox, self.db))
        ready = json.loads(next(self.inbox.rglob("*.ready.json")).read_text())
        self.assertEqual(ready["recordingName"], "Planning meeting")

    def test_restart_does_not_import_same_recording_again(self):
        import_one(self.sidecar, self.inbox, self.db)
        self.db.close()
        self.db = open_database(self.inbox)
        self.assertFalse(import_one(self.sidecar, self.inbox, self.db))
        self.assertEqual(len(list(self.inbox.rglob("*.ready.json"))), 1)

    def test_partial_sync_is_not_delivered(self):
        self.media.write_bytes(b"partial")
        with self.assertRaises(NotReady):
            import_one(self.sidecar, self.inbox, self.db)
        self.assertFalse(list(self.inbox.rglob("*.ready.json")))

    def test_same_size_corruption_is_not_delivered(self):
        self.media.write_bytes(b"x" * self.item["sizeBytes"])
        with self.assertRaises(NotReady):
            import_one(self.sidecar, self.inbox, self.db)

    def test_manifest_cannot_read_outside_sync_folder(self):
        self.item["mediaFile"] = "../private.m4a"
        self.save()
        with self.assertRaises(ValueError):
            import_one(self.sidecar, self.inbox, self.db)

    def test_replayed_identifier_with_changed_content_is_rejected(self):
        import_one(self.sidecar, self.inbox, self.db)
        self.item["md5"] = "0" * 32
        self.save()
        with self.assertRaises(ValueError):
            import_one(self.sidecar, self.inbox, self.db)

    def test_recovery_after_commit_before_database_receipt(self):
        import_one(self.sidecar, self.inbox, self.db)
        self.db.execute("DELETE FROM imports")
        self.db.commit()
        self.assertTrue(import_one(self.sidecar, self.inbox, self.db))
        self.assertEqual(len(list(self.inbox.rglob("*.ready.json"))), 1)


if __name__ == "__main__":
    unittest.main()
