#!/usr/bin/env bash
# =============================================================================
# ESXP Network Services - one-shot installer
#
# Installs ISC Kea (dhcp4, dhcp6, ctrl-agent), lays down working Kea configs
# with control sockets, deploys the dashboard web app into a Python venv, and
# registers + starts everything as systemd services. After this runs, the whole
# system is managed from the browser -- no further CLI needed.
#
# Usage:   sudo ./install/install.sh
# Env:     ADMIN_PASSWORD=... (default "admin"), DASHBOARD_PORT=... (default 8080)
# =============================================================================
set -euo pipefail

APP_NAME="esxp-network-services"
INSTALL_DIR="/opt/${APP_NAME}"
ETC_DIR="/etc/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
ENV_FILE="${ETC_DIR}/.env"
KEA_CONF_DIR="/etc/kea"
DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
ADMIN_PASSWORD_IS_DEFAULT=0
[[ "${ADMIN_PASSWORD}" == "admin" ]] && ADMIN_PASSWORD_IS_DEFAULT=1
# Set FORCE_KEA_CONF=1 to reset /etc/kea/*.conf back to the shipped templates.
# Off by default so re-running the installer never destroys live DHCP config.
FORCE_KEA_CONF="${FORCE_KEA_CONF:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Shared logging + Kea detection/repair helpers.
# shellcheck source=install/lib-kea.sh
source "${SCRIPT_DIR}/lib-kea.sh"

[[ "${EUID}" -eq 0 ]] || die "Please run as root (sudo ./install/install.sh)."
[[ -d "${SRC_ROOT}/backend" && -d "${SRC_ROOT}/frontend" ]] \
  || die "Cannot find backend/ and frontend/ next to the installer (run it from the cloned repo)."
# deploy_app rm -rf's ${INSTALL_DIR}/backend etc. before copying the source in.
# If the source IS the install dir (the installer is now shipped there), that
# would delete its own input mid-copy. Send the operator to update.sh instead.
[[ "${SRC_ROOT}" != "${INSTALL_DIR}" ]] \
  || die "Run install.sh from a fresh clone, not the deployed copy. To upgrade an existing install use: sudo ${INSTALL_DIR}/install/update.sh"

# --- 1. detect package manager ----------------------------------------------
detect_pkg() {
  if   command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf     >/dev/null 2>&1; then echo dnf
  elif command -v yum     >/dev/null 2>&1; then echo yum
  elif command -v zypper  >/dev/null 2>&1; then echo zypper
  else echo none; fi
}
PKG="$(detect_pkg)"
log "Package manager: ${PKG}"

install_packages() {
  log "Installing Kea and Python runtime (this can take a minute)…"
  case "${PKG}" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      apt-get install -y kea-dhcp4-server kea-dhcp6-server kea-ctrl-agent \
        python3 python3-venv python3-pip git curl openssl tcpdump || \
      apt-get install -y kea python3 python3-venv python3-pip git curl openssl tcpdump
      ;;
    dnf) dnf install -y kea python3 python3-pip git curl openssl tcpdump ;;
    yum) yum install -y kea python3 python3-pip git curl openssl tcpdump ;;
    zypper) zypper --non-interactive install kea python3 python3-pip git curl openssl tcpdump ;;
    none) die "No supported package manager found. Install Kea + python3 manually, then re-run." ;;
  esac
  ok "Packages installed."
}

# --- 2. detect kea service unit names + kea user ----------------------------
# detect_unit / detect_kea_user / detect_hooks_dir / inject_lease_hook /
# write_kea_conf_dropins are provided by install/lib-kea.sh (sourced above).

# --- 3. lay down Kea configuration ------------------------------------------
configure_kea() {
  local kea_user kea_group hooks_dir dhcp4_unit dhcp6_unit
  kea_user="$(detect_kea_user)"
  kea_group="$(id -gn "${kea_user}" 2>/dev/null || echo "${kea_user}")"
  log "Kea runs as user '${kea_user}:${kea_group}'."

  mkdir -p "${KEA_CONF_DIR}" /var/log/kea /var/lib/kea

  # Shared runtime dir for the control sockets (survives reboot via tmpfiles).
  install -d -o "${kea_user}" -g "${kea_group}" -m 0750 /run/kea
  cat > /etc/tmpfiles.d/${APP_NAME}-kea.conf <<EOF
d /run/kea 0750 ${kea_user} ${kea_group} -
EOF
  systemd-tmpfiles --create /etc/tmpfiles.d/${APP_NAME}-kea.conf >/dev/null 2>&1 || true

  # Active Leases needs the lease_cmds hook (lease4-get-all, lease6-del, ...).
  hooks_dir="$(detect_hooks_dir)"
  if [[ -n "${hooks_dir}" ]]; then
    log "lease_cmds hook found in ${hooks_dir} (enables Active Leases)."
  else
    warn "libdhcp_lease_cmds.so not found -- the Active Leases page will be unavailable until Kea's hook libraries are installed."
  fi

  local ts target; ts="$(date +%Y%m%d-%H%M%S)"
  for f in kea-dhcp4.conf kea-dhcp6.conf kea-ctrl-agent.conf; do
    target="${KEA_CONF_DIR}/${f}"
    if [[ -f "${target}" ]] && grep -q "/run/kea/kea[46]-ctrl-socket" "${target}" \
       && [[ "${FORCE_KEA_CONF}" != "1" ]]; then
      # Already wired by a previous run: this file now holds the operator's live
      # subnets and reservations. Overwriting it with the blank template would
      # destroy production DHCP config on a well-meaning re-run of the installer.
      log "Keeping existing ${f} (already configured; FORCE_KEA_CONF=1 resets it to the template)."
    else
      [[ -f "${target}" ]] && cp -a "${target}" "${target}.bak-${ts}"
      install -m 0640 "${SRC_ROOT}/install/kea/${f}" "${target}"
    fi
    case "${f}" in
      kea-dhcp4.conf|kea-dhcp6.conf) inject_lease_hook "${target}" "${hooks_dir}" ;;
    esac
    # Kea daemons (running as kea_user) must be able to config-write these.
    chown "${kea_user}:${kea_group}" "${target}"
    chmod 0640 "${target}"
  done

  # Let config-write reach /etc/kea even under ProtectSystem=strict, otherwise
  # saved subnets live only in memory and vanish on the next Kea reload.
  dhcp4_unit="$(detect_unit kea-dhcp4)"
  dhcp6_unit="$(detect_unit kea-dhcp6)"
  write_kea_conf_dropins "${dhcp4_unit}" "${dhcp6_unit}"

  # Two packaging traps that otherwise leave the dashboard unable to reach Kea:
  #   1. the CA unit's kea-api-password start condition (service silently skipped)
  #   2. AppArmor denying the CA access to the /run/kea control sockets
  ensure_ca_can_start kea-ctrl-agent
  fix_kea_apparmor

  ok "Kea configuration written to ${KEA_CONF_DIR} (backups: *.bak-${ts})."
}

# --- 4. deploy dashboard app -------------------------------------------------
deploy_app() {
  log "Deploying dashboard to ${INSTALL_DIR}…"
  install -d -m 0755 "${INSTALL_DIR}"
  install -d -m 0750 "${ETC_DIR}"
  # Holds dashboard.db: PBKDF2 password hashes + the full audit log. Keep it
  # unreadable to other local accounts (the default 0755 would expose it).
  install -d -m 0750 "${DATA_DIR}"
  rm -rf "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend" \
         "${INSTALL_DIR}/install" "${INSTALL_DIR}/systemd"
  cp -a "${SRC_ROOT}/backend"  "${INSTALL_DIR}/backend"
  cp -a "${SRC_ROOT}/frontend" "${INSTALL_DIR}/frontend"
  # Ship the scripts too, so the update/repair commands we print actually exist
  # on the box once the operator's temporary clone is gone.
  cp -a "${SRC_ROOT}/install"  "${INSTALL_DIR}/install"
  cp -a "${SRC_ROOT}/systemd"  "${INSTALL_DIR}/systemd"
  chmod 0755 "${INSTALL_DIR}/install"/*.sh
  # Tighten anything already created with a looser mode.
  [[ -f "${DATA_DIR}/dashboard.db" ]] && chmod 0600 "${DATA_DIR}/dashboard.db"
  find "${DATA_DIR}" -maxdepth 1 -name 'dashboard.db-*' -exec chmod 0600 {} + 2>/dev/null || true

  log "Creating Python virtual environment…"
  python3 -m venv "${INSTALL_DIR}/.venv"
  "${INSTALL_DIR}/.venv/bin/pip" install --quiet --upgrade pip
  "${INSTALL_DIR}/.venv/bin/pip" install --quiet -r "${INSTALL_DIR}/backend/requirements.txt"
  ok "Dashboard deployed and dependencies installed."
}

# --- 5. environment file -----------------------------------------------------
write_env() {
  local secret repo_url dhcp4_unit dhcp6_unit ca_unit
  if command -v openssl >/dev/null 2>&1; then secret="$(openssl rand -hex 32)"
  else secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi

  # Repo URL lives in ONE place (this .env). Prefer the checkout's git remote so
  # updates work out of the box; fall back to the placeholder in .env.example.
  repo_url="$(git -C "${SRC_ROOT}" config --get remote.origin.url 2>/dev/null || true)"
  if [[ -z "${repo_url}" ]]; then
    repo_url="$(grep -E '^REPO_URL=' "${SRC_ROOT}/.env.example" | head -1 | cut -d= -f2- || true)"
  fi

  dhcp4_unit="$(detect_unit kea-dhcp4)"
  dhcp6_unit="$(detect_unit kea-dhcp6)"
  ca_unit="kea-ctrl-agent"

  if [[ -f "${ENV_FILE}" ]]; then
    warn "Existing ${ENV_FILE} kept (not overwritten). Delete it to regenerate."
    return
  fi
  cat > "${ENV_FILE}" <<EOF
# ESXP Network Services - generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# The repository URL is defined ONCE here; update.sh pulls from it.
REPO_URL=${repo_url}
REPO_BRANCH=main

DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=${DASHBOARD_PORT}
SECRET_KEY=${secret}
SESSION_MAX_AGE=28800
DB_PATH=${DATA_DIR}/dashboard.db

ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}

KEA_CA_URL=http://127.0.0.1:8000
KEA_DHCP4_SERVICE=${dhcp4_unit}
KEA_DHCP6_SERVICE=${dhcp6_unit}
KEA_CTRL_AGENT_SERVICE=${ca_unit}
EOF
  chmod 0640 "${ENV_FILE}"
  ok "Environment written to ${ENV_FILE} (services: ${dhcp4_unit}, ${dhcp6_unit}, ${ca_unit})."
}

# --- 6. systemd services -----------------------------------------------------
setup_services() {
  log "Registering systemd services…"
  install -m 0644 "${SRC_ROOT}/systemd/esxp-dashboard.service" /etc/systemd/system/esxp-dashboard.service
  systemctl daemon-reload

  local dhcp4_unit dhcp6_unit
  dhcp4_unit="$(detect_unit kea-dhcp4)"
  dhcp6_unit="$(detect_unit kea-dhcp6)"

  # Start DHCP daemons first (they create the control sockets), then the agent.
  for unit in "${dhcp4_unit}" "${dhcp6_unit}" kea-ctrl-agent; do
    systemctl enable "${unit}" >/dev/null 2>&1 || warn "Could not enable ${unit}"
    systemctl restart "${unit}" || warn "Could not (re)start ${unit} -- check 'systemctl status ${unit}'"
  done

  systemctl enable esxp-dashboard >/dev/null 2>&1 || true
  systemctl restart esxp-dashboard
  ok "Services enabled and started."
}

verify() {
  log "Verifying dashboard is responding…"
  sleep 2
  if curl -fsS "http://127.0.0.1:${DASHBOARD_PORT}/api/system/health" >/dev/null 2>&1; then
    ok "Dashboard health check passed."
  else
    warn "Health check did not pass yet. Check: systemctl status esxp-dashboard"
  fi
}

# --- run ---------------------------------------------------------------------
install_packages
configure_kea
deploy_app
write_env
setup_services
verify

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; IP="${IP:-<server-ip>}"
echo
ok "Installation complete."
echo -e "  Dashboard : ${c_g}http://${IP}:${DASHBOARD_PORT}/${c_0}"
# Never print the password itself -- it would persist in scrollback, install
# logs and CI output. The operator either chose it or it is the documented default.
if [[ "${ADMIN_PASSWORD_IS_DEFAULT}" -eq 1 ]]; then
  echo -e "  Login     : ${ADMIN_USERNAME} / ${c_y}the default password 'admin' -- change it on first login${c_0}"
else
  echo -e "  Login     : ${ADMIN_USERNAME} / ${c_y}the ADMIN_PASSWORD you supplied${c_0}"
fi
echo -e "  Config    : ${ENV_FILE}"
echo -e "  Update    : sudo ${INSTALL_DIR}/install/update.sh  (pulls from REPO_URL in ${ENV_FILE})"
echo -e "  Repair Kea: sudo ${INSTALL_DIR}/install/repair-kea.sh"
echo
