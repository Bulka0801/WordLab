#!/usr/bin/env python3
"""WordLab's loopback-only adapter for the Voicebox desktop app (stdlib only)."""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import socket
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener
import webbrowser

ROOT = Path(__file__).resolve().parent
VOICEBOX = "http://127.0.0.1:17493"
UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
MAX_RESPONSE = 16 * 1024 * 1024
OPENER = build_opener(ProxyHandler({}))


def onyx(profile):
    return (isinstance(profile, dict) and profile.get("voice_type") == "preset"
            and profile.get("preset_engine") == "kokoro"
            and profile.get("preset_voice_id") == "am_onyx"
            and profile.get("language", "en") == "en")


def upstream(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(VOICEBOX + path, data=data, headers={"Content-Type": "application/json"})
    with OPENER.open(request, timeout=180 if data else 15) as response:
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise ValueError("Audio response exceeds 16 MiB")
        return response.status, response.headers.get_content_type(), body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Do not put vocabulary, request bodies, or Voicebox profile data in logs.
        pass

    def allowed(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origins = {"null", "https://bulka0801.github.io",
                   f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
        return (self.headers.get("Host", "") in hosts
                and (self.headers.get("Origin") is None or self.headers.get("Origin") in origins))

    def reply(self, status, body=b"", content_type="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin and self.allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            # For browser versions using the older Private Network Access preflight.
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reject_untrusted(self):
        if self.allowed():
            return False
        self.close_connection = True
        self.reply(403, {"detail": "This origin or host is not allowed."})
        return True

    def do_OPTIONS(self):
        if self.reject_untrusted():
            return
        if (not self.path.startswith("/voicebox/")
                or self.headers.get("Access-Control-Request-Method") not in {"GET", "POST"}):
            self.reply(405)
            return
        requested = {h.strip().lower() for h in self.headers.get("Access-Control-Request-Headers", "").split(",") if h.strip()}
        self.reply(204 if requested <= {"content-type"} else 403)

    def do_GET(self):
        if self.reject_untrusted():
            return
        path = urlsplit(self.path).path
        if path in {"/", "/index.html"}:
            try:
                self.reply(200, (ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self.reply(404, {"detail": "Keep index.html next to voicebox_bridge.py."})
            return
        if path == "/voicebox/bridge-health":
            self.reply(200, {"service": "wordlab-voicebox-bridge", "version": 1})
            return
        if path == "/voicebox/profiles":
            def profiles():
                status, content_type, body = upstream("/profiles")
                data = json.loads(body)
                if not isinstance(data, list):
                    raise ValueError("Expected a profile list")
                fields = {"id", "name", "language", "voice_type", "preset_engine", "preset_voice_id", "default_engine"}
                return status, "application/json", json.dumps([
                    {k: v for k, v in p.items() if k in fields} for p in data if onyx(p)
                ]).encode()
            self.proxy(profiles)
            return
        if re.fullmatch(r"/voicebox/(?:audio|history)/" + UUID, path):
            self.proxy(lambda: upstream(path.removeprefix("/voicebox")))
            return
        self.reply(404, {"detail": "Unknown WordLab endpoint."})

    def do_POST(self):
        if self.reject_untrusted():
            return
        if self.path != "/voicebox/generate":
            self.reply(404)
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self.close_connection = True
            self.reply(415, {"detail": "Expected application/json."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError("Invalid request length")
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError("Expected an object")
            text, profile_id = data.get("text"), data.get("profile_id")
            if (not isinstance(text, str) or not text.strip() or len(text) > 200
                    or any(ord(ch) < 32 for ch in text)
                    or not isinstance(profile_id, str) or not re.fullmatch(UUID, profile_id)
                    or data.get("engine") != "kokoro" or data.get("language") != "en"):
                raise ValueError("Expected an English word and a Kokoro profile ID")
        except (ValueError, UnicodeError, socket.timeout):
            self.close_connection = True
            self.reply(400, {"detail": "Invalid word or voice profile. Maximum: 200 characters."})
            return

        def generate():
            _, _, body = upstream("/profiles/" + profile_id)
            if not onyx(json.loads(body)):
                return 422, "application/json", b'{"detail":"Choose a Kokoro Onyx preset profile."}'
            # Never let a remote caller rewrite vocabulary or invoke other engines.
            return upstream("/generate", {"text": text, "profile_id": profile_id,
                "language": "en", "engine": "kokoro", "personality": False,
                "effects_chain": [], "seed": 0})
        self.proxy(generate)

    def proxy(self, operation):
        try:
            status, content_type, body = operation()
            self.reply(status, body, content_type)
        except HTTPError as error:
            status = error.code if 400 <= error.code < 600 else 502
            # Upstream errors may include local paths; keep the browser response small.
            self.reply(status, {"detail": "Voicebox rejected the request.", "upstream_status": status})
        except (URLError, OSError, ValueError):
            self.reply(502, {"detail": "Voicebox is unavailable. Launch the desktop app and try again."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser tab")
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", 17494), Handler)
    except OSError as error:
        print(f"Не вдалося запустити WordLab: {error}")
        print("Якщо запускник уже працює, відкрий http://127.0.0.1:17494")
        return 1
    server.daemon_threads = True
    url = "http://127.0.0.1:17494"
    print(f"WordLab: {url}\nЗалиш Voicebox і це вікно запущеними. Зупинити: Ctrl+C.", flush=True)
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
