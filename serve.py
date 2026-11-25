"""Host the built static report with data supplied by another checkout."""

import argparse
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

SITE = Path(__file__).resolve().parent / "dist"


def handler_for(data_dir, site_dir=SITE):
    site_dir = site_dir.resolve()
    data_dir = data_dir.resolve()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_asset(include_body=True)

        def do_HEAD(self):
            self.send_asset(include_body=False)

        def send_asset(self, include_body):
            name = unquote(urlsplit(self.path).path)
            if "\x00" in name:
                self.send_error(404)
                return
            if name == "/data.json":
                path, content_type = data_dir / "data.json", "application/json"
            else:
                relative = "index.html" if name == "/" else name.lstrip("/")
                path = (site_dir / relative).resolve()
                # Never expose checkout files, parent directories or symlink targets.
                if not path.is_relative_to(site_dir) or not path.is_file():
                    self.send_error(404)
                    return
                content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            try:
                data = path.read_bytes()
            except (OSError, ValueError):
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
    if not (SITE / "index.html").is_file():
        parser.error("Built website not found. Run npm ci && npm run build first.")
    with ThreadingHTTPServer((args.bind, args.port), handler_for(args.data_dir)) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
