#!/usr/bin/env python3
"""Local server for the static prototype; only forwards fixed NDL search parameters."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import urlopen, Request
import os

ROOT = Path(__file__).resolve().parent / "dist"

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if urlparse(self.path).path != "/api/meeting":
            return super().do_GET()
        query = parse_qs(urlparse(self.path).query)
        keyword = query.get("any", [""])[0][:80]
        if not keyword:
            self.send_error(400, "Missing search word")
            return
        params = urlencode({"any": keyword, "from": "2020-01-01",
                            "maximumRecords": "6", "recordPacking": "json"})
        try:
            request = Request("https://kokkai.ndl.go.jp/api/meeting?" + params,
                              headers={"User-Agent": "DietMinistryRouter/0.1"})
            with urlopen(request, timeout=25) as response:
                body = response.read(12_000_000)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            self.send_error(502, str(exc))

if __name__ == "__main__":
    os.chdir(ROOT)
    print("Open http://127.0.0.1:8765", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
