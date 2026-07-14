"""Authentication: password hashing, user CRUD, and the session dependency.

Passwords use PBKDF2-HMAC-SHA256 from the standard library (no native build
dependency), which is a reasonable choice for an internal single-server tool.
Sessions are signed cookies managed by Starlette's ``SessionMiddleware``.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

from fastapi import Depends, HTTPException, Request, status

from .config import settings
from .database import get_conn

_PBKDF2_ITERATIONS = 200_000


def hash_password(password: str, salt: str | None = None,
                  iterations: int = _PBKDF2_ITERATIONS) -> tuple[str, str, int]:
    """Return ``(hex_hash, hex_salt, iterations)`` for the given password."""
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations
    )
    return dk.hex(), salt, iterations


def verify_password(password: str, password_hash: str, salt: str, iterations: int) -> bool:
    candidate, _, _ = hash_password(password, salt, iterations)
    # Constant-time comparison to avoid timing side channels.
    return hmac.compare_digest(candidate, password_hash)


def get_user(username: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
        return dict(row) if row else None


def create_user(username: str, password: str, must_change_pw: bool = False) -> None:
    pw_hash, salt, iters = hash_password(password)
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO users (username, password_hash, salt, iterations, must_change_pw) "
            "VALUES (?, ?, ?, ?, ?)",
            (username, pw_hash, salt, iters, 1 if must_change_pw else 0),
        )


def set_password(username: str, password: str) -> None:
    pw_hash, salt, iters = hash_password(password)
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ?, salt = ?, iterations = ?, must_change_pw = 0 "
            "WHERE username = ?",
            (pw_hash, salt, iters, username),
        )


def authenticate(username: str, password: str) -> dict | None:
    user = get_user(username)
    if not user:
        # Still run a hash to keep timing roughly constant for unknown users.
        hash_password(password)
        return None
    if verify_password(password, user["password_hash"], user["salt"], user["iterations"]):
        with get_conn() as conn:
            conn.execute(
                "UPDATE users SET last_login_at = datetime('now') WHERE id = ?",
                (user["id"],),
            )
        return user
    return None


def ensure_seed_admin() -> None:
    """Create the initial admin account if the users table is empty."""
    with get_conn() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    if count == 0:
        create_user(settings.admin_username, settings.admin_password, must_change_pw=True)


# --- FastAPI dependency ------------------------------------------------------

def current_user(request: Request) -> str:
    """Require a logged-in session; return the username or raise 401."""
    username = request.session.get("user")
    if not username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    return username


LoginRequired = Depends(current_user)
