"""Append-only audit logging."""
from __future__ import annotations

from .database import get_conn


def record(username: str | None, category: str, action: str,
           status: str = "success", detail: str | None = None) -> None:
    """Write one audit entry. Never raises (auditing must not break the request)."""
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO audit_log (username, category, action, status, detail) "
                "VALUES (?, ?, ?, ?, ?)",
                (username, category, action, status, detail),
            )
    except Exception:
        # Auditing is best-effort; swallow storage errors.
        pass


def recent(limit: int = 100) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT ts, username, category, action, status, detail "
            "FROM audit_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
