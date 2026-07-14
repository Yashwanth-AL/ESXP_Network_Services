"""Application configuration.

Values are read from the environment, optionally seeded from a ``.env`` file.
Search order for the ``.env`` file:

1. ``$ESXP_ENV_FILE`` if set
2. ``/etc/esxp-network-services/.env`` (written by the installer)
3. ``<repo>/.env`` (handy for local development)

Keeping every tunable in one place means the same code runs unchanged on a
developer laptop and on the deployed Linux server.
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

# <repo>/backend/app/config.py -> <repo>
BASE_DIR = Path(__file__).resolve().parents[2]


def _load_env_file() -> None:
    candidates = []
    explicit = os.environ.get("ESXP_ENV_FILE")
    if explicit:
        candidates.append(Path(explicit))
    candidates.append(Path("/etc/esxp-network-services/.env"))
    candidates.append(BASE_DIR / ".env")
    for path in candidates:
        try:
            if path.is_file():
                load_dotenv(path, override=False)
                break
        except OSError:
            continue


_load_env_file()


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    """Resolved runtime settings (read once at import time)."""

    def __init__(self) -> None:
        self.host: str = os.environ.get("DASHBOARD_HOST", "0.0.0.0")
        self.port: int = int(os.environ.get("DASHBOARD_PORT", "8080"))

        # Session signing secret. A random per-process value is used as a last
        # resort so the app still boots, but that logs everyone out on restart.
        self.secret_key: str = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
        self.session_max_age: int = int(os.environ.get("SESSION_MAX_AGE", str(8 * 3600)))
        self.session_cookie: str = os.environ.get("SESSION_COOKIE", "esxp_session")

        default_db = str(BASE_DIR / "data" / "dashboard.db")
        self.db_path: str = os.environ.get("DB_PATH", default_db)

        self.admin_username: str = os.environ.get("ADMIN_USERNAME", "admin")
        self.admin_password: str = os.environ.get("ADMIN_PASSWORD", "admin")

        self.kea_ca_url: str = os.environ.get("KEA_CA_URL", "http://127.0.0.1:8000").rstrip("/")

        self.kea_dhcp4_service: str = os.environ.get("KEA_DHCP4_SERVICE", "kea-dhcp4-server")
        self.kea_dhcp6_service: str = os.environ.get("KEA_DHCP6_SERVICE", "kea-dhcp6-server")
        self.kea_ctrl_agent_service: str = os.environ.get(
            "KEA_CTRL_AGENT_SERVICE", "kea-ctrl-agent"
        )

        self.frontend_dir: Path = Path(
            os.environ.get("FRONTEND_DIR", str(BASE_DIR / "frontend"))
        )

        self.migrations_dir: Path = Path(
            os.environ.get("MIGRATIONS_DIR", str(BASE_DIR / "backend" / "migrations"))
        )

    def service_unit(self, which: str) -> str | None:
        return {
            "dhcp4": self.kea_dhcp4_service,
            "dhcp6": self.kea_dhcp6_service,
            "ctrl_agent": self.kea_ctrl_agent_service,
        }.get(which)


settings = Settings()
