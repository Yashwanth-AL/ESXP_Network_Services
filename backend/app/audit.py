"""Append-only audit logging.

``record`` / ``recent`` are the blocking SQLite primitives. Async request
handlers must use the ``a``-prefixed wrappers instead: the dashboard runs a
single event loop, so a synchronous DB call inside a coroutine stalls *every*
in-flight request, not just its own.
"""
from __future__ import annotations

from starlette.concurrency import run_in_threadpool

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


# --- async-safe wrappers for use inside request handlers ---------------------

async def arecord(username: str | None, category: str, action: str,
                  status: str = "success", detail: str | None = None) -> None:
    await run_in_threadpool(record, username, category, action, status, detail)


async def arecent(limit: int = 100) -> list[dict]:
    return await run_in_threadpool(recent, limit)
