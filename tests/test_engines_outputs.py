import json
import tempfile
import threading
import unittest
import zipfile
import io
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

from app import config, llm, outputs, secret_store, store


class FakeVLLM(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "Qwen/Qwen3.6-35B-A3B", "max_model_len": 65536},
                                    {"id": "openai/gpt-oss-120b"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeVLLM.seen.append((self.headers.get("Authorization"), req))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for d in ({"reasoning_content": "hmm"}, {"content": "Hel"}, {"content": "lo"}):
            self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": d}]}).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.srv = HTTPServer(("127.0.0.1", 0), FakeVLLM)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.shutdown)
        self.s = {"llm_provider": "openai", "openai_url": f"http://127.0.0.1:{self.srv.server_port}/v1",
                  "openai_key_enc": secret_store.protect("sk-test")}

    def test_vllm_lists_models_and_streams_reasoning_and_text(self):
        names = [m["name"] for m in llm.list_models(self.s)]
        self.assertIn("openai/gpt-oss-120b", names)
        picks = llm.auto_assign({}, llm.list_models(self.s))
        self.assertEqual(picks["writer_model"], "openai/gpt-oss-120b")
        out = list(llm.chat(self.s, "m", [{"role": "user", "content": "hi", "images": ["QUJD"]}]))
        self.assertEqual(out, [("thinking", "hmm"), ("content", "Hel"), ("content", "lo")])
        auth, req = FakeVLLM.seen[-1]
        self.assertEqual(auth, "Bearer sk-test")
        self.assertEqual(req["messages"][0]["content"][0]["image_url"]["url"], "data:image/jpeg;base64,QUJD")

    def test_claude_message_shape(self):
        system, msgs = llm._claude_messages([{"role": "system", "content": "be brief"},
                                             {"role": "user", "content": "look", "images": ["QUJD"]}])
        self.assertEqual(system, "be brief")
        self.assertEqual(msgs[0]["content"][0]["type"], "image")
        strict = llm._strict({"type": "object", "properties": {"a": {"type": "object", "properties": {}}}})
        self.assertFalse(strict["additionalProperties"])
        self.assertFalse(strict["properties"]["a"]["additionalProperties"])

    def test_claude_without_key_explains_what_to_do(self):
        with self.assertRaises(llm.LLMError) as e:
            list(llm.chat({"llm_provider": "anthropic"}, "claude-sonnet-5-5", [{"role": "user", "content": "x"}]))
        self.assertIn("API key", str(e.exception))


class OutputTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        data = Path(tmp.name) / "data"
        self.drive = Path(tmp.name) / "Pocket Scribe"
        self.drive.mkdir()
        for name, value in {"DATA_DIR": data, "SESSIONS_DIR": data / "sessions",
                            "SETTINGS_FILE": data / "settings.json"}.items():
            p = patch.object(config, name, value)
            p.start()
            self.addCleanup(p.stop)
        config.save({"phone_recordings_folder": str(self.drive)})
        m = store.create("Cert renewal KT", "", {}, copied=True)
        self.sid = m["id"]
        store.write_json(self.sid, "transcript.json", {"segments": [
            {"id": 0, "start": 0, "end": 4, "text": "We renew the certs with certbot on web01."}]})
        store.write_json(self.sid, "summary.json", {"summary": "Renewal walk-through", "key_points": [],
                                                    "chapters": [], "action_items": ["Automate it"]})
        from PIL import Image
        for fid in ("F0001", "F0002"):
            Image.new("RGB", (64, 36), "navy").save(store.frames_dir(self.sid) / f"{fid}.jpg")
        store.write_json(self.sid, "frames.json", [
            {"id": "F0001", "t": 2, "caption": "certbot output", "kind": "screen"},
            {"id": "F0002", "t": 3, "caption": "Webcam / people view", "kind": "webcam"}])
        store.write_text(self.sid, "runbook.md", "# KT\n\nRun certbot. [00:01]\n\n![certbot](frame:F0001)\n")
        store.write_json(self.sid, "invite.json", {"subject": "Automate cert renewal", "body": "Hi team,\nAgenda...",
                                                   "attendees": ["Server team"], "duration_minutes": 45})
        store.update(self.sid, bundle_goal="A script that renews and deploys the cert")

    def test_settings_never_expose_keys(self):
        saved = config.save({"anthropic_key": "sk-ant-secret"})
        self.assertTrue(saved["anthropic_key_enc"])
        pub = config.public(saved)
        self.assertTrue(pub["anthropic_key_set"])
        self.assertNotIn("sk-ant-secret", json.dumps(pub))
        self.assertEqual(llm.api_key({**saved, "llm_provider": "anthropic"}), "sk-ant-secret")

    def test_bundle_has_brief_doc_and_only_screen_shots(self):
        files = outputs.bundle_files(self.sid, config.load())
        self.assertIn("A script that renews", files["BRIEF.md"].decode())
        self.assertIn("screenshots/F0001.jpg", files["kt-document.md"].decode())
        self.assertIn("screenshots/F0001.jpg", files)
        self.assertNotIn("screenshots/F0002.jpg", files)
        z = zipfile.ZipFile(io.BytesIO(outputs.bundle_zip(self.sid, config.load())))
        self.assertTrue(any(n.endswith("BRIEF.md") for n in z.namelist()))

    def test_invite_calendar_file(self):
        ics = outputs.invite_ics(store.read_json(self.sid, "invite.json", {}), self.sid)
        self.assertIn("SUMMARY:Automate cert renewal", ics)
        self.assertIn("\\nAgenda", ics)
        self.assertTrue(ics.endswith("END:VCALENDAR\r\n"))

    def test_copy_to_drive_writes_outputs_folder(self):
        path = Path(outputs.copy_to_drive(self.sid, config.load()))
        self.assertEqual(path.parent, self.drive / "Outputs")
        names = sorted(p.name for p in path.iterdir())
        self.assertEqual(names, ["Claude bundle.zip", "KT document.docx", "Meeting invite.ics", "Meeting invite.txt"])


if __name__ == "__main__":
    unittest.main()
