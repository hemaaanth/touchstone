"""A stub chat endpoint for the garak test. It listens on 127.0.0.1 only.

POST /agent/chat with "Authorization: Bearer tok_fixture" and {"message": text}
returns {"reply": "You said: " + text}. It echoes the prompt, so garak's string
detectors fire on it. GET /count returns how many chat requests it answered, so
the test can check the budget. It never makes a request itself.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "tok_fixture"
lock = threading.Lock()
count = {"chat": 0, "refused": 0}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        if self.path == "/count":
            with lock:
                return self.send(200, dict(count))
        self.send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n)
        if self.path != "/agent/chat":
            return self.send(404, {"error": "not found"})
        if self.headers.get("authorization") != "Bearer " + TOKEN:
            with lock:
                count["refused"] += 1
            return self.send(401, {"error": "unauthorized"})
        try:
            msg = json.loads(body)["message"]
        except Exception:
            return self.send(400, {"error": "bad request"})
        with lock:
            count["chat"] += 1
        self.send(200, {"reply": "You said: " + str(msg)})


ThreadingHTTPServer(("127.0.0.1", 8080), H).serve_forever()
