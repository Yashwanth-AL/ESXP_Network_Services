-- =============================================================================
-- 001_init.sql - initial schema for dashboard auth + audit log
-- Applied automatically on startup by app.database.run_migrations().
-- =============================================================================

-- Dashboard user accounts. Passwords are stored as PBKDF2-HMAC-SHA256 hashes
-- with a per-user random salt (see app/auth.py).
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    salt            TEXT NOT NULL,
    iterations      INTEGER NOT NULL,
    must_change_pw  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT
);

-- Append-only audit trail of every meaningful action performed through the
-- dashboard: logins, config changes, service control, lease operations.
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (datetime('now')),
    username    TEXT,
    category    TEXT NOT NULL,   -- auth | config | service | lease | system
    action      TEXT NOT NULL,   -- short verb, e.g. "subnet.create"
    status      TEXT NOT NULL,   -- success | failure
    detail      TEXT             -- human-readable context / error message
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log (category);
