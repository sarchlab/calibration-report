"""Host the shared report with data supplied by another checkout."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

SITE = Path(__file__).resolve().parent / "site"


def handler_for(data_dir):
    assets = {
        "/": (SITE / "index.html", "text/html; charset=utf-8"),
        "/index.html": (SITE / "index.html", "text/html; charset=utf-8"),
        "/report.css": (SITE / "report.css", "text/css; charset=utf-8"),
        "/report.js": (SITE / "report.js", "text/javascript; charset=utf-8"),
        "/data.json": (data_dir / "data.json", "application/json"),
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_asset(include_body=True)

        def do_HEAD(self):
            self.send_asset(include_body=False)

        def send_asset(self, include_body):
            name = urlsplit(self.path).path
            if name not in assets:
                self.send_error(404)
                return
            path, content_type = assets[name]
            try:
                data = path.read_bytes()
            except FileNotFoundError:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if include_body:
                self.wfile.write(data)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path, help="directory containing data.json")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()
    with ThreadingHTTPServer((args.bind, args.port), handler_for(args.data_dir)) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
