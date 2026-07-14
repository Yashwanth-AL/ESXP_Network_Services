# ESXP Network Services — DHCP Management Dashboard for ISC Kea

A self-contained web application that fully wraps the **ISC Kea** DHCP server
(v4 and v6) so that installation, configuration and day-to-day management need
**zero command-line interaction** after install. Built for an internal,
single-server industrial deployment (Schneider Electric network) to assign and
manage IP addresses for panel servers and gateways.

DHCP is the first module of a broader **Network Services** tool; **DNS** and
**NTP/SNTP** are present as routed “Coming soon” placeholders so they can be
filled in later without restructuring the app.

---

## Highlights

- **No CLI after install.** Subnets, reservations, leases, service control and
  configuration save/verify are all driven from the browser.
- **Kea via its REST API only.** The backend talks to Kea exclusively through
  the **Kea Control Agent** (`config-get`, `config-test`, `config-set`,
  `config-write`, `lease4/6-get-all`, `status-get`, …). It never shells out to
  `keactrl` or edits Kea’s JSON files by hand. Kea’s native JSON stays the
  single source of truth.
- **Safe by construction.** Every change is validated twice — client- and
  server-side input validation (CIDR / MAC / DUID / IP-in-subnet), then Kea’s
  own `config-test` — *before* it is applied with `config-set` and persisted
  with `config-write`.
- **Live leases.** Auto-refreshing table with search, single/bulk **release**
  and **renew**.
- **One toast system.** All errors and confirmations surface as top-right
  toasts — the operator never needs to open a log file.
- **Schneider Electric look.** Light UI, “Life Green” `#3DCD58` accents, logo in
  the header.

## Tech stack

| Layer     | Choice                                    | Why |
|-----------|-------------------------------------------|-----|
| Backend   | Python 3 + **FastAPI** + Uvicorn          | Small, reliable, great for proxying a REST API; easy systemd service |
| Storage   | **SQLite** (stdlib) for auth + audit log  | Zero-admin, single-server appropriate |
| Frontend  | **Vanilla JS SPA** (no framework, no build, no CDN) | Fully self-contained — nothing to fetch on an isolated industrial network |
| Auth      | Signed session cookies, PBKDF2 passwords  | No native build deps |

---

## Architecture

```
  Browser ──HTTP(8080)──▶  Dashboard (FastAPI + static SPA)
                                │  REST (localhost:8000)
                                ▼
                        Kea Control Agent
                          │ unix sockets (/run/kea)
              ┌───────────┴───────────┐
              ▼                       ▼
        kea-dhcp4-server        kea-dhcp6-server
                                │
        systemctl start/stop/restart/reload  ◀── backend (as root)
```

- Dashboard serves the API under `/api/*` and the SPA at `/` (hash-routed).
- The Control Agent listens only on `127.0.0.1:8000`.
- Service control uses `systemctl`; see **Security notes**.

---

## Requirements

- A **Linux** server with **systemd** and one of: `apt` (Debian/Ubuntu),
  `dnf`/`yum` (RHEL/Fedora/Alma/Rocky), or `zypper` (openSUSE).
- Root access for installation.
- Outbound access to your package repositories and Git remote (install time only).

---

## Install

```bash
# 1. Clone the repository (temporary/hosting repo shown here)
git clone https://github.com/YOUR-ORG/YOUR-REPO.git
cd YOUR-REPO

# 2. Run the one-shot installer as root
sudo ./install/install.sh
```

Optional environment overrides for the installer:

```bash
sudo ADMIN_PASSWORD='StrongPass!' DASHBOARD_PORT=8080 ./install/install.sh
```

The installer will:

1. Install `kea-dhcp4-server`, `kea-dhcp6-server`, `kea-ctrl-agent` and the
   Python runtime.
2. Write working Kea configs (`/etc/kea/*.conf`) wired to control sockets in
   `/run/kea`, backing up any existing files.
3. Deploy the app to `/opt/esxp-network-services` in a Python venv.
4. Generate `/etc/esxp-network-services/.env` (random `SECRET_KEY`, detected Kea
   service unit names, admin credentials).
5. Register and start the `esxp-dashboard` systemd service and enable + start
   the three Kea services.

When it finishes it prints the dashboard URL and login.

### Default login

```
username: admin
password: admin        # (or the ADMIN_PASSWORD you passed)
```

You are prompted to change this on first sign-in — please do.

Open: `http://<server-ip>:8080/`

---

## Using the dashboard

- **DHCP → Configuration** — IPv4 / IPv6 tabs, two-pane subnet editor.
  - *Left:* list of subnets. *Right:* the selected subnet’s settings
    (CIDR, pool, mask/gateway (v4), DNS, lifetimes/timers) and, below it, a
    **reservations** table with add / edit / delete (MAC + IP + hostname for v4,
    DUID + IPv6 + hostname for v6).
  - Saving a subnet or reservation runs `config-test` → `config-set` →
    `config-write` automatically, so changes are validated and persisted.
- **DHCP → Active Leases** — live table (auto-refresh every 5 s), search, and
  **Renew** / **Release** per row plus bulk release.
- **DHCP → Settings** — start / stop / restart / reload each Kea service,
  **Verify configuration** (`config-test`), **Save configuration**
  (`config-set` + `config-write`), and a status / audit-history panel.
- **DNS**, **NTP / SNTP** — routed placeholders (“Coming soon”).

Top bar shows the SE logo, live **DHCPv4 / DHCPv6** running indicators, the
signed-in user, and Logout.

---

## Configuration (`.env`)

All tunables live in `/etc/esxp-network-services/.env` (template:
[`.env.example`](.env.example)). Key values:

| Variable | Purpose |
|----------|---------|
| `REPO_URL`, `REPO_BRANCH` | **Single source** for the code repo. `update.sh` pulls from here — no URL is hard-coded anywhere else. |
| `DASHBOARD_HOST`, `DASHBOARD_PORT` | Where the dashboard binds (default `0.0.0.0:8080`). |
| `SECRET_KEY` | Session cookie signing secret (installer randomises it). |
| `DB_PATH` | SQLite path for auth + audit log. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Seed admin (used only when the users table is empty). |
| `KEA_CA_URL` | Kea Control Agent endpoint (default `http://127.0.0.1:8000`). |
| `KEA_DHCP4_SERVICE`, `KEA_DHCP6_SERVICE`, `KEA_CTRL_AGENT_SERVICE` | systemd unit names (auto-detected per distro). |

> **Repository URL is defined in one place.** To point installs/updates at your
> own remote, set `REPO_URL` in `.env` (and in `.env.example` before cloning).
> The updater reads it from there.

---

## Updating

```bash
sudo ./install/update.sh
```

Clones `REPO_URL` (branch `REPO_BRANCH`) from `.env`, redeploys `backend/` and
`frontend/`, refreshes dependencies and the systemd unit, and restarts the
service. Kea is left untouched.

## Uninstall

```bash
sudo ./install/uninstall.sh            # remove app + service (keep data)
sudo ./install/uninstall.sh --purge    # also remove /etc + /var/lib data
```

Kea packages are intentionally left installed.

---

## Repository layout

```
.
├── install/
│   ├── install.sh            # one-shot installer
│   ├── update.sh             # pulls from REPO_URL in .env
│   ├── uninstall.sh
│   └── kea/                  # Kea config templates (control sockets wired)
│       ├── kea-dhcp4.conf
│       ├── kea-dhcp6.conf
│       └── kea-ctrl-agent.conf
├── systemd/
│   └── esxp-dashboard.service
├── backend/
│   ├── requirements.txt
│   ├── migrations/001_init.sql   # SQLite schema: users + audit_log
│   └── app/
│       ├── main.py            # FastAPI app, static SPA mount, error handlers
│       ├── config.py          # env-driven settings
│       ├── database.py        # SQLite + migration runner
│       ├── auth.py            # PBKDF2 + session dependency
│       ├── audit.py           # audit log
│       ├── validation.py      # CIDR / MAC / DUID / IP-in-subnet
│       ├── kea_client.py      # Kea Control Agent REST client
│       ├── kea_config.py      # subnet/reservation <-> Kea JSON translation
│       ├── services.py        # systemctl control
│       ├── models.py          # pydantic request models
│       └── routers/           # auth, dhcp4, dhcp6, leases, config, system
├── frontend/                  # vanilla JS SPA (index.html, css/, js/, assets/)
├── .env.example
└── README.md
```

---

## Security notes

This is designed for a **trusted, single-server internal network**, not the
public internet.

- **The dashboard runs as `root`** (via its systemd unit) so it can control the
  Kea services with `systemctl`. To harden, run it as a dedicated user and grant
  a narrow `sudoers` rule for the specific `systemctl` verbs on the Kea units.
- **Change the default password** immediately (you’re prompted on first login).
- The **Kea Control Agent is bound to `127.0.0.1`** — not reachable off-box.
- Consider firewalling the dashboard port to the management VLAN, and putting a
  TLS-terminating reverse proxy in front if you need HTTPS.
- Passwords are stored as PBKDF2-HMAC-SHA256 with per-user salt; sessions are
  signed cookies.

---

## Troubleshooting

- **“Cannot reach the Kea Control Agent.”** `systemctl status kea-ctrl-agent`
  and the DHCP daemons. The agent needs the daemons running so the
  `/run/kea/*.socket` control sockets exist.
- **Dashboard won’t start.** `journalctl -u esxp-dashboard -e`.
- **A save fails validation.** The toast shows Kea’s `config-test` message
  verbatim — fix the reported field and retry.
- **Service unit names differ.** They’re auto-detected and stored in `.env`
  (`KEA_*_SERVICE`); edit there if your distro differs.

---

## Local development

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
# point at a reachable Kea CA (or a stub) and run:
cd backend && python -m app        # serves http://0.0.0.0:8080
```

`config.py` reads `.env` from the repo root during development.

---

## Note on branding assets

`frontend/assets/logo.png` (header/login lockup) and `favicon.png` (tab icon)
are the Schneider Electric brand images supplied for this project. If you
later get higher-resolution or vector (SVG/EPS) originals from Schneider's
brand portal, drop them in under the same filenames — nothing else needs to
change, since the header, login page, and `<link rel="icon">` all reference
just these two files.
