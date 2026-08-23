from __future__ import annotations

import json
import os
import subprocess
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
HOST = os.environ.get("MAKERWORLD_SCRAPER_HOST", "0.0.0.0")
PORT = int(os.environ.get("MAKERWORLD_SCRAPER_PORT", "8010"))
SCRAPE_TIMEOUT_SECONDS = int(os.environ.get("MAKERWORLD_SCRAPER_TIMEOUT", "120"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self._write_json(HTTPStatus.NOT_FOUND, {"error": {"code": "NOT_FOUND", "message": "Rota não encontrada."}})
            return
        self._write_json(HTTPStatus.OK, {"status": "ok"})

    def do_POST(self):
        if self.path != "/scrape":
            self._write_json(HTTPStatus.NOT_FOUND, {"error": {"code": "NOT_FOUND", "message": "Rota não encontrada."}})
            return

        payload = self._read_json()
        if payload is None:
            self._write_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"code": "INVALID_JSON", "message": "JSON inválido."}},
            )
            return

        url = str(payload.get("url") or "").strip()
        if not url:
            self._write_json(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {"error": {"code": "INVALID_URL", "message": "URL do MakerWorld é obrigatória."}},
            )
            return

        try:
            result = subprocess.run(
                [sys.executable, "-m", "makerworld_scraper.scrape_cli", url],
                cwd=BASE_DIR,
                capture_output=True,
                text=True,
                timeout=SCRAPE_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            self._write_json(
                HTTPStatus.GATEWAY_TIMEOUT,
                {"error": {"code": "SCRAPE_TIMEOUT", "message": "O scraper do MakerWorld excedeu o tempo limite."}},
            )
            return

        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        parsed = None
        if stdout:
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError:
                parsed = None

        if result.returncode != 0:
            self._write_json(
                HTTPStatus.BAD_GATEWAY,
                {
                    "error": {
                        "code": "SCRAPE_FAILED",
                        "message": parsed.get("error") if isinstance(parsed, dict) else stderr or "Falha ao executar o scraper do MakerWorld.",
                    }
                },
            )
            return

        self._write_json(HTTPStatus.OK, {"model": parsed})

    def log_message(self, format, *args):  # noqa: A003
        return

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return None

    def _write_json(self, status: HTTPStatus, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"makerworld scraper listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
