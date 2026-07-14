"""Run the dashboard: ``python -m app`` (used by the systemd service).

Reads host/port from settings so the systemd unit needs no argument wiring.
"""
from __future__ import annotations

import uvicorn

from .config import settings


def main() -> None:
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
        proxy_headers=True,
    )


if __name__ == "__main__":
    main()
