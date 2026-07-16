# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick start

```bash
# Backend tests (in repo root)
python backend/app/kea_client.py         # (doctest example, if present)
python -m pytest backend/                # (future: unit tests)

# Frontend check
node --check frontend/js/*.js frontend/js/views/*.js

# Compile/syntax check (all)
python -m compileall -q backend/app
bash -n install/*.sh run.sh

# Smoke test (end-to-end verification)
python scratchpad/smoke_test.py          # (ad-hoc test harness in scratchpad/)
```

Test harnesses are written to `scratchpad/` (temp/verify-only):
- `smoke_test.py` — full app lifecycle (login, dhcp ops, logout)
- `fix_test.py` — round-2 code-review fixes (multi-pool, concurrent edits, audit, etc.)
- `concurrency_test.py` — proves the asyncio.Lock fix (two edits, both land)
- `iface_test.py` — listen-interface picker and save-to-disk confirmation

None are in the repo proper; they're for development/verification only. Run them via Python, not pytest.

## Architecture

### Backend: FastAPI + Kea Control Agent

**Pattern: read-modify-write with async locks**

Every config mutation follows the same safe pipeline:
1. `config_get(service)` → snapshot the running config
2. Edit the snapshot in-memory (validation first)
3. `config_test(service, config)` → dry-run against Kea
4. `config_set(service, config)` → apply in-memory
5. `config_write(service)` → persist to disk

**Concurrency:** Two concurrent edits (e.g. operator in tab A reserves IP, tab B adds a subnet) race on step 1 — both read the same snapshot. The second `config_set` overwrites the first's changes. **Fix:** `async with kea_client.config_lock(SERVICE):` wraps the whole pipeline in a per-service lock. Snapshot is taken *inside* the lock.

**Key files:**
- `backend/app/kea_client.py` — Kea Control Agent transport (async HTTP, config pipeline, per-service asyncio.Lock)
- `backend/app/kea_config.py` — config shape builders (pools, subnets, interfaces, reservations). `_write_first_pool()` preserves extra pools when editing the first.
- `backend/app/ops.py` — shared mutation helpers (`apply_and_audit`, `wipe_subnet_leases`)
- `backend/app/routers/dhcp4.py`, `dhcp6.py` — subnet & reservation CRUD (mirror each other, use config locks)
- `backend/app/routers/system.py` — services (start/stop/restart), interfaces (list host NICs, get/set Kea interfaces-config), audit log
- `backend/app/routers/leases.py` — active leases, bulk release (validates per-item, partial-success)
- `backend/app/validation.py` — parse/validate all input (IPs, MACs, DUIDs, CIDRs, pools, timers, interfaces)
- `backend/app/services.py` — subprocess wrappers (systemctl, Kea socket detection, NIC enumeration)
- `backend/app/audit.py` — async SQLite wrappers (arecord, arecent for event-loop safety)
- `backend/app/database.py` — init schema, chmod DB + WAL sidecars to 0600

**Three-tier validation:**
- Request models (Pydantic) → 422 on parse failure
- Router validators (validation.py) → ValidationError → 422
- Kea dry-run (config_test) → KeaError → 502 with actionable message

### Frontend: Vanilla JS SPA

**Pattern: hash routing, request-sequence guards against stale responses**

- `frontend/js/app.js` — bootstrap (auth, shell, 5s status poll, logout, password banner)
- `frontend/js/views/dhcp.js` — DHCP → Configuration (subnets, reservations, **listen interfaces**)
- `frontend/js/views/leases.js` — DHCP → Active Leases (live table, renew, bulk release)
- `frontend/js/views/settings.js` — DHCP → Settings (service control, config test/write, audit log)
- `frontend/js/util.js` — DOM helpers (h() for markup, icons, form inputs, confirmations)
- `frontend/js/api.js` — HTTP client (login, auth header, error → unauthorized event)

**Stale-response race:** On slow links, saving subnet A then quickly switching to IPv6 tab could render A's rows under B's headers if the old GET lands after the new one. **Fix:** per-view `reqSeq` counter captured before async calls, guarded on callback with `if (seq !== reqSeq || version !== state.version) return;`.

**Listen interfaces:** A card at the top of Config reads host NICs via `/api/system/interfaces` and lets you pick (or "All"). Saves via `PUT /system/listen/{family}`, returns the file it wrote to for UI confirmation.

**Save-to-disk confirmation:** Subnet/interface saves now return `saved_to` (the file Kea config-write touched), surfaced in the success toast so the operator sees *"...saved to /etc/kea/kea-dhcp4.conf"*.

### Database

**SQLite at `/var/lib/esxp-network-services/dashboard.db`**

- Schema: `schema_migrations`, `users`, `audit_log` (created by migrations)
- Permissions: 0600 on DB file AND `-wal`/`-shm` sidecars (WAL holds plaintext hashes/audit rows)
- Async safety: `audit.arecord()` / `arecent()` use `run_in_threadpool()` so they never block the event loop

### Installers

**One-command flow:** `sudo ./run.sh`

- Detects fresh machine vs. existing install (checks `/etc/esxp-network-services/.env`)
- Fresh → `install.sh` (Kea packages, Kea config templates, app env, venv, systemd service)
- Existing → `update.sh` (git pull, backup+rollback on failure, pip install, restart)
- Repair → `install/repair-kea.sh` (ProtectSystem=strict sandbox fix, lease_cmds hook injection)

**Key guards:**
- `install.sh` refuses to run from the deployed copy (would `rm -rf` its own source)
- `lib-kea.sh` `inject_lease_hook()` tolerates Kea's comments via a JSONC stripper, never aborts caller
- `update.sh` backs up and restores `backend/`, `frontend/`, AND `install/` dirs
- `uninstall.sh` removes systemd drop-ins left behind

## Common changes

**Add a new DHCP config field (e.g., client-class-data)?**

1. Edit `backend/app/models.py` — add to `Subnet4Request`/`Subnet6Request`
2. Edit `backend/app/validation.py` — add validator for the field
3. Edit `backend/app/kea_config.py` — add to `write_subnet4/6()`, `subnet4/6_to_api()`
4. Edit `backend/app/routers/dhcp4.py` and `dhcp6.py` — pass field through `_build_candidate()`
5. Edit `frontend/js/views/dhcp.js` — add form input in `form4()/form6()`, pass in `read()` payload
6. Test with smoke_test.py (or extend it)

**Change how interfaces are selected?**

The current UI is a checkbox grid. To make it simpler:
- Hide interfaces without "ethernet" in the name (grep-style filter in `services.list_interfaces()`)
- OR add a text input for custom interface names (edit `validate_interfaces()` to be more lenient when enum is empty)
- OR keep all NICs but group by type (edit `frontend/js/views/dhcp.js` `renderListen()` to fold into categories)

The endpoint is independent of the UI — change the UI without touching the backend.

**Fix a race or audit issue?**

All mutations hold `async with kea_client.config_lock(SERVICE)`. If you add a new endpoint, wrap the whole pipeline (get → mutate → apply_and_audit). Don't forget to import the lock. Audit actions follow the pattern `"{service}.{entity}.{op}"` (e.g. `"dhcp4.subnet.create"`). Failures are recorded with the error message in the detail.

## Security constraints

**Do NOT push to GitHub:**
- Any `.claude/` artifacts (*.jsonl transcripts, session files, scratchpad)
- Test databases, `.env` files, or credentials
- Generated files from IDEs or build systems

The security review found DB file permissions and config-write errors to be the two vectors. Both are fixed. No other credentials/tokens to worry about.

---

## Debugging tips

**Kea isn't accepting config changes (config-write fails)?**

→ Run `sudo install/repair-kea.sh`. It adds `ReadWritePaths=/etc/kea` to the Kea systemd service (sandboxing issue) and injects the `lease_cmds` hook.

**Stale interface list or concurrency bug?**

→ Check that ALL config mutations hold `config_lock`. Verify `config_get` is called *inside* the lock, not before. For stale responses in the frontend, verify `reqSeq` capture and guarding.

**SQLite "database is locked"?**

→ `run_in_threadpool()` wraps all DB calls. If you add a new sync DB operation in an async handler, wrap it. Never call `audit.record()` from an async handler — use `await audit.arecord()`.

**Multi-pool subnet silently truncated on save?**

→ The fix is `kea_config._write_first_pool()` which replaces only the first pool. Verify subnet edit flow calls `write_subnet4/6()`, which calls `_write_first_pool()`, not a naive `pools = [...]` assignment.
