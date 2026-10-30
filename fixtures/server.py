from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import time


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            self._send(200, {"status": "ok"})
        elif self.path.startswith("/api/echo"):
            self._send(200, {"method": "GET", "path": self.path})
        elif self.path == "/api/fail":
            self._send(500, {"error": "expected failure"})
        elif self.path == "/api/orders/ORD-1001":
            self._send(200, {"id": "ORD-1001", "status": "paid"})
        elif self.path == "/api/redirect-external":
            self.send_response(302)
            self.send_header("Location", "https://external.example.test/forbidden")
            self.end_headers()
        elif self.path == "/api/health?verbose=true":
            self._send(200, {"status": "ok", "verbose": True})
        elif self.path == "/api/slow":
            time.sleep(10)
            self._send(200, {"status": "slow"})
        elif self.path == "/api/echo":
            self._send(200, {"method": "GET", "path": self.path})
        elif self.path == "/api/cancel":
            time.sleep(10)
            self._send(200, {"status": "slow"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        if self.path == "/api/echo":
            self._send(200, {"method": "POST", "path": self.path, "body": raw})
        elif self.path == "/api/orders":
            self._send(201, {"created": True, "body": raw})
        else:
            self._send(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(os.environ.get("TEST_AGENT_FIXTURE_PORT", "8089"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
