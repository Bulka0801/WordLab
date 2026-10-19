import http.client
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "voicebox_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
PROFILE = "1a6aa532-e30a-4763-a705-5f83af26d8c7"
GENERATION = "22222222-2222-4222-8222-222222222222"
ONYX = {"id": PROFILE, "name": "WordLab — Onyx", "language": "en", "voice_type": "preset", "preset_engine": "kokoro", "preset_voice_id": "am_onyx", "avatar_path": "/private/local/path"}


class Voicebox(BaseHTTPRequestHandler):
    received = []
    preset = ONYX

    def log_message(self, *args):
        pass

    def respond(self, data, content_type="application/json"):
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/profiles":
            self.respond([self.preset])
        elif self.path.startswith("/profiles/"):
            self.respond(self.preset)
        elif self.path.startswith("/history/"):
            self.respond({"id": GENERATION, "status": "completed"})
        else:
            self.respond(b"RIFF-test-audio", "audio/wav")

    def do_POST(self):
        self.received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.respond({"id": GENERATION, "status": "generating"})


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Voicebox)
        bridge.VOICEBOX = f"http://127.0.0.1:{cls.upstream.server_port}"
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        for server in (cls.upstream, cls.server):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.server, cls.upstream):
            server.shutdown()
            server.server_close()

    def request(self, method, path, body=None, **headers):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_local_file_and_pages_preflights_are_scoped(self):
        for origin in ("null", "https://bulka0801.github.io"):
            status, headers, _ = self.request("OPTIONS", "/voicebox/generate", Origin=origin, **{"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
            self.assertEqual(status, 204)
            self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
            self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")

    def test_untrusted_origin_and_host_are_denied(self):
        for headers in ({"Origin": "https://evil.example"}, {"Host": "evil.example"}):
            status, response, _ = self.request("GET", "/voicebox/profiles", **headers)
            self.assertEqual(status, 403)
            self.assertNotIn("Access-Control-Allow-Origin", response)

    def test_profiles_are_filtered_and_private_fields_removed(self):
        status, _, body = self.request("GET", "/voicebox/profiles", Origin="null")
        self.assertEqual(status, 200)
        self.assertNotIn("avatar_path", json.loads(body)[0])

    def test_generation_is_exact_onyx_and_disables_rewriting_and_effects(self):
        body = json.dumps({"profile_id": PROFILE, "text": "connectivity", "language": "en", "engine": "kokoro", "personality": True, "effects_chain": [{"type": "pitch_shift"}]})
        status, _, data = self.request("POST", "/voicebox/generate", body, **{"Content-Type": "application/json", "Origin": "null"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["status"], "generating")
        self.assertIs(Voicebox.received[-1]["personality"], False)
        self.assertEqual(Voicebox.received[-1]["effects_chain"], [])
        self.assertEqual(Voicebox.received[-1]["text"], "connectivity")

    def test_reject_other_profile_and_bad_payloads(self):
        body = {"profile_id": PROFILE, "text": "test", "language": "en", "engine": "kokoro"}
        Voicebox.preset = {**ONYX, "preset_voice_id": "bm_daniel"}
        try:
            status, _, _ = self.request("POST", "/voicebox/generate", json.dumps(body), **{"Content-Type": "application/json"})
            self.assertEqual(status, 422)
        finally:
            Voicebox.preset = ONYX
        for patch in ({"text": "x" * 201}, {"text": "\n"}, {"text": []}, {"profile_id": "../../settings"}, {"engine": "qwen"}):
            status, _, _ = self.request("POST", "/voicebox/generate", json.dumps({**body, **patch}), **{"Content-Type": "application/json"})
            self.assertEqual(status, 400)

    def test_no_proxy_escape_or_profile_mutations(self):
        for path in ("/voicebox/settings", "/voicebox/audio/../../settings", "/../README.md", "/.git/config"):
            self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("POST", "/voicebox/profiles", "{}")[0], 404)
        self.assertEqual(self.request("POST", "/voicebox/generate", "{}")[0], 415)

    def test_audio_history_and_static_page(self):
        self.assertEqual(self.request("GET", "/voicebox/audio/" + GENERATION)[2], b"RIFF-test-audio")
        self.assertEqual(json.loads(self.request("GET", "/voicebox/history/" + GENERATION)[2])["status"], "completed")
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"WordLab", body)

    def test_missing_voicebox_returns_actionable_gateway_error(self):
        previous = bridge.VOICEBOX
        bridge.VOICEBOX = "http://127.0.0.1:1"
        try:
            status, _, data = self.request("GET", "/voicebox/profiles")
            self.assertEqual(status, 502)
            self.assertIn("Launch", json.loads(data)["detail"])
        finally:
            bridge.VOICEBOX = previous


if __name__ == "__main__":
    unittest.main()
