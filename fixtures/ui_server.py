import http.server
import os
import socketserver


ROOT = os.path.join(os.path.dirname(__file__), "ui-site")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)


if __name__ == "__main__":
    port = int(os.environ.get("TEST_AGENT_UI_PORT", "8090"))
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as server:
        server.serve_forever()
