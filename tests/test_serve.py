import http.client
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("serve", Path(__file__).resolve().parents[1] / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class StaticServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.site = root / "dist"
        self.site.mkdir()
        (self.site / "assets").mkdir()
        (self.site / "index.html").write_text('<script src="./assets/viewer-123.js"></script>')
        (self.site / "assets/viewer-123.js").write_text('export const built = true;')
        (self.site / "assets/viewer-123.css").write_text('body { margin: 0; }')
        (root / "data.json").write_text('{"revision": 1}')
        (root / "secret.txt").write_text('outside')
        (self.site / "outside").symlink_to(root / "secret.txt")
        self.root = root
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), serve.handler_for(root, self.site))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, path, method='GET'):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request(method, path)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_build_assets_root_and_head(self):
        status, headers, body = self.request('/?cache=1')
        self.assertEqual(status, 200)
        self.assertIn(b'./assets/viewer-123.js', body)
        for path, mime in [('/assets/viewer-123.js', 'javascript'), ('/assets/viewer-123.css', 'text/css')]:
            status, headers, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertIn(mime, headers['Content-Type'])
            self.assertTrue(body)
            status, headers, body = self.request(path, 'HEAD')
            self.assertEqual(status, 200)
            self.assertEqual(body, b'')
            self.assertGreater(int(headers['Content-Length']), 0)

    def test_module_mime_type_does_not_depend_on_host_database(self):
        with patch.object(serve.mimetypes, 'guess_type', return_value=('text/plain', None)):
            for path, expected in [
                ('/', 'text/html; charset=utf-8'),
                ('/assets/viewer-123.js', 'text/javascript; charset=utf-8'),
                ('/assets/viewer-123.css', 'text/css; charset=utf-8'),
                ('/data.json', 'application/json; charset=utf-8'),
            ]:
                with self.subTest(path=path):
                    status, headers, body = self.request(path)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers['Content-Type'], expected)

    def test_external_data_is_read_fresh(self):
        self.assertEqual(self.request('/data.json')[2], b'{"revision": 1}')
        (self.root / 'data.json').write_text('{"revision": 2}')
        status, headers, body = self.request('/data.json?fresh=1')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(body, b'{"revision": 2}')

    def test_paths_cannot_escape_build_directory(self):
        for path in ['/../secret.txt', '/%2e%2e/secret.txt', '/outside', '/%00', '/.git/config', '/serve.py', '/assets/']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)
