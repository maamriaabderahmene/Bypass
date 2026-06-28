"""
server.py — local reCAPTCHA v3 bypass server

Drop this file next to bypass.py and run:
    python server.py        (or: uv run python server.py)

Endpoints:
    GET  /ping       → {"status":"ok","v":"<version>"}
    POST /solve      → {"token":"<token>"} | {"error":"..."}
    POST /refresh    → {"status":"ok","v":"<version>"}

/solve accepts JSON body:
    {
        "site_key": "6Le...",   # required
        "origin":   "https://example.com",  # required (scheme+host, JS location.origin)
        "action":   "submit",   # optional (default "submit")
        "hl":       "en"        # optional (default "en")
    }
"""

import base64
import json
import logging
import random
import re
import string
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode

import requests

from bypass import ReCaptchaV3Bypass

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("server")

# ── reCAPTCHA version cache ────────────────────────────────────────────────────
DEFAULT_V = "MerVUtRoajKEbP7pLiGXkL28"
_v_cache: dict[str, str] = {"v": DEFAULT_V}
_v_lock = threading.Lock()


def _fetch_latest_v() -> str:
    """Fetch the current reCAPTCHA JS version string from Google."""
    try:
        # api.js redirects to the versioned bundle; follow the redirect.
        r = requests.get(
            "https://www.google.com/recaptcha/api.js",
            timeout=8,
            allow_redirects=True,
        )
        # The version appears as ?v=XXXXX in the redirected URL or inside the JS.
        m = re.search(r'[?&;]v=([A-Za-z0-9_-]{15,})', r.url + " " + r.text[:4000])
        if m:
            return m.group(1)
    except Exception as exc:
        log.warning("Could not fetch latest v: %s", exc)
    return DEFAULT_V


def refresh_v() -> str:
    v = _fetch_latest_v()
    with _v_lock:
        _v_cache["v"] = v
    log.info("reCAPTCHA version: %s", v)
    return v


def _bg_refresh_v(interval: int = 300):
    """Background thread: refresh the version every `interval` seconds."""
    time.sleep(interval)
    while True:
        refresh_v()
        time.sleep(interval)


# ── Anchor URL construction ────────────────────────────────────────────────────
def _build_co(origin: str) -> str:
    return base64.b64encode(origin.encode()).decode().rstrip("=")


def _random_cb(n: int = 12) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def build_anchor_url(site_key: str, origin: str, hl: str = "en", extra: dict | None = None) -> str:
    with _v_lock:
        v = _v_cache["v"]
    params = {
        "k": site_key,
        "co": _build_co(origin),
        "hl": hl,
        "v": v,
        "cb": _random_cb(),
    }
    if extra:
        params.update(extra)
    return "https://www.google.com/recaptcha/api2/anchor?" + urlencode(params)


# ── HTTP handler ───────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        # Suppress default access log; our logger handles it.
        pass

    def _send(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict | None:
        try:
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n)
            return json.loads(raw)
        except Exception:
            return None

    # ── Routes ─────────────────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/ping":
            with _v_lock:
                v = _v_cache["v"]
            self._send(200, {"status": "ok", "v": v})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/refresh":
            v = refresh_v()
            self._send(200, {"status": "ok", "v": v})
            return

        if self.path != "/solve":
            self._send(404, {"error": "not found"})
            return

        body = self._read_json()
        if not body:
            self._send(400, {"error": "invalid JSON body"})
            return

        site_key = body.get("site_key", "").strip()
        origin   = body.get("origin",   "").strip()
        action   = body.get("action",   "submit")
        hl       = body.get("hl",       "en")

        if not site_key or not origin:
            self._send(400, {"error": "site_key and origin are required"})
            return

        log.info("SOLVE  site_key=%.12s…  origin=%s  action=%s", site_key, origin, action)

        # Try progressively more anchor params (different site keys need different params).
        token = None
        anchor_variants = [
            None,                          # minimal
            {"size": "invisible"},         # 2captcha/appspot style
            {"ar": "1", "size": "invisible", "anchor-ms": "20000", "execute-ms": "30000"},
        ]
        for extra in anchor_variants:
            anchor_url = build_anchor_url(site_key, origin, hl, extra=extra)
            log.debug("       anchor=%s", anchor_url)
            try:
                token = ReCaptchaV3Bypass(anchor_url, action=action).bypass()
            except Exception as exc:
                log.warning("       bypass raised: %s", exc)
                continue
            if token:
                break
            log.debug("       no token with extra=%s", extra)

        if token:
            log.info("       ✓ token=%.20s…", token)
            self._send(200, {"success": True, "token": token})
        else:
            log.warning("       ✗ no token returned after all anchor variants")
            self._send(500, {"success": False, "error": "failed to get token"})


# ── Entry point ────────────────────────────────────────────────────────────────
def main():
    # Fetch the latest v synchronously so the first solve has a fresh version.
    refresh_v()

    # Refresh version in background every 5 minutes.
    t = threading.Thread(target=_bg_refresh_v, kwargs={"interval": 300}, daemon=True)
    t.start()

    # Use ThreadingMixIn to handle concurrent solve requests without blocking.
    from socketserver import ThreadingMixIn

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    port = 5000
    server = ThreadedHTTPServer(("127.0.0.1", port), Handler)
    log.info("Bypass server running on http://127.0.0.1:%d", port)
    log.info("Press Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
