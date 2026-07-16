"""SQLite access layer for dashboard auth + audit log.

Uses the stdlib ``sqlite3`` module (no ORM) to keep the dependency surface
small. Concurrency is low for a single-server internal tool, so a fresh
short-lived connection per operation is more than adequate and avoids
cross-thread connection sharing issues under the async server.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import settings


def _ensure_parent(path: str) -> None:
    parent = Path(path).expanduser().resolve().parent
    parent.mkdir(parents=True, exist_ok=True)


def _restrict(path: str) -> None:
    """Make the DB and its WAL sidecars owner-only.

    dashboard.db -- and the ``-wal`` / ``-shm`` files SQLite creates in WAL mode
    -- hold PBKDF2 password hashes and the audit log; the default umask would
    leave them readable by every local account. The installer also locks down
    the parent directory; this is defense-in-depth for dev runs and any
    non-installer deployment. SQLite recreates the sidecars after a checkpoint,
    so this runs on every connection (a chmod to the same mode is a cheap no-op)
    rather than only at first creation, which would miss them.
    """
    for p in (path, path + "-wal", path + "-shm"):
        try:
            os.chmod(p, 0o600)
        except OSError:  # sidecar not present yet, or unsupported filesystem
            pass


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    _ensure_parent(settings.db_path)
    conn = sqlite3.connect(settings.db_path, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    # After WAL is enabled the sidecars exist -- lock down all three.
    _restrict(settings.db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _applied_migrations(conn: sqlite3.Connection) -> set[str]:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    rows = conn.execute("SELECT filename FROM schema_migrations").fetchall()
    return {r["filename"] for r in rows}


def run_migrations() -> None:
    """Apply any *.sql files in the migrations directory, in filename order."""
    migrations_dir = settings.migrations_dir
    if not migrations_dir.is_dir():
        return
    files = sorted(p for p in migrations_dir.glob("*.sql"))
    with get_conn() as conn:
        applied = _applied_migrations(conn)
        for path in files:
            if path.name in applied:
                continue
            sql = path.read_text(encoding="utf-8")
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO schema_migrations (filename) VALUES (?)", (path.name,)
            )


def init_db() -> None:
    """Ensure schema exists and the seed admin account is present."""
    run_migrations()
    # Import here to avoid a circular import at module load time.
    from .auth import ensure_seed_admin

    ensure_seed_admin()
