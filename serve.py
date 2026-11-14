#!/usr/bin/env python3
"""Serve the GO:KEYS tone browser on http://localhost:8771 (Web MIDI needs http://localhost or https)."""
import functools
import http.server
import os
import sys
import webbrowser

PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8771)
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        url = f"http://localhost:{PORT}/"
        print(f"GO:KEYS tone browser running at {url}  (Ctrl+C to stop)")
        if "--no-open" not in sys.argv:
            webbrowser.get("open -a 'Google Chrome' %s" if sys.platform == "darwin" else None).open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
