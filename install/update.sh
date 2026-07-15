#!/usr/bin/env bash
# =============================================================================
# ESXP Network Services - updater
#
# Pulls the latest dashboard code from the repository URL configured in the
# environment file (REPO_URL) -- never from a hard-coded URL -- redeploys it,
# and restarts the service. Kea itself is left untouched.
#
# Usage: sudo ./install/update.sh
# =============================================================================
set -euo pipefail

APP_NAME="esxp-network-services"
INSTALL_DIR="/opt/${APP_NAME}"
ETC_DIR="/etc/${APP_NAME}"
ENV_FILE="${ETC_DIR}/.env"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared logging helpers (log/ok/warn/die).
# shellcheck source=install/lib-kea.sh
source "${SCRIPT_DIR}/lib-kea.sh"

[[ "${EUID}" -eq 0 ]] || die "Please run as root (sudo ./install/update.sh)."
[[ -f "${ENV_FILE}" ]] || die "Missing ${ENV_FILE}. Run install.sh first."

# Read values without executing the file.
get_env() { grep -E "^$1=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true; }
REPO_URL="$(get_env REPO_URL)"
REPO_BRANCH="$(get_env REPO_BRANCH)"; REPO_BRANCH="${REPO_BRANCH:-main}"

[[ -n "${REPO_URL}" ]] || die "REPO_URL is not set in ${ENV_FILE}."
if [[ "${REPO_URL}" == *"YOUR-ORG/YOUR-REPO"* ]]; then
  die "REPO_URL in ${ENV_FILE} is still the placeholder. Set it to your Git remote first."
fi

command -v git >/dev/null 2>&1 || die "git is not installed."

TMP="$(mktemp -d)"
BACKUP="$(mktemp -d)"
RESTORE_ON_ERR=0

cleanup() { rm -rf "${TMP}" "${BACKUP}"; }

# The redeploy below replaces the live code in place. If any step after that
# fails (a bad requirement, a network blip during pip), `set -e` would abort
# with the old code already deleted and the service never restarted -- leaving
# a server that only has a browser UI with no working backend. Put the previous
# version back instead.
rollback() {
  [[ "${RESTORE_ON_ERR}" -eq 1 ]] || return 0
  warn "Update failed -- restoring the previous version…"
  rm -rf "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend"
  [[ -d "${BACKUP}/backend" ]]  && cp -a "${BACKUP}/backend"  "${INSTALL_DIR}/backend"
  [[ -d "${BACKUP}/frontend" ]] && cp -a "${BACKUP}/frontend" "${INSTALL_DIR}/frontend"
  systemctl restart esxp-dashboard || true
  warn "Rolled back. The previous version is running again; nothing was updated."
}
trap 'rollback; cleanup' EXIT

log "Cloning ${REPO_URL} (branch ${REPO_BRANCH})…"
git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${TMP}" \
  || die "Clone failed. Check REPO_URL / network / credentials."
[[ -d "${TMP}/backend" && -d "${TMP}/frontend" ]] || die "Cloned repo has no backend/ or frontend/."

log "Backing up the current version…"
[[ -d "${INSTALL_DIR}/backend" ]]  && cp -a "${INSTALL_DIR}/backend"  "${BACKUP}/backend"
[[ -d "${INSTALL_DIR}/frontend" ]] && cp -a "${INSTALL_DIR}/frontend" "${BACKUP}/frontend"

log "Redeploying application source…"
RESTORE_ON_ERR=1
rm -rf "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend"
cp -a "${TMP}/backend"  "${INSTALL_DIR}/backend"
cp -a "${TMP}/frontend" "${INSTALL_DIR}/frontend"

# Keep the deployed scripts current too, so update.sh/repair-kea.sh on the box
# match the code that is running.
if [[ -d "${TMP}/install" ]]; then
  rm -rf "${INSTALL_DIR}/install"
  cp -a "${TMP}/install" "${INSTALL_DIR}/install"
  chmod 0755 "${INSTALL_DIR}/install"/*.sh
fi

log "Updating Python dependencies…"
"${INSTALL_DIR}/.venv/bin/pip" install --quiet -r "${INSTALL_DIR}/backend/requirements.txt"

# Refresh the systemd unit if it changed.
if [[ -f "${TMP}/systemd/esxp-dashboard.service" ]]; then
  install -m 0644 "${TMP}/systemd/esxp-dashboard.service" /etc/systemd/system/esxp-dashboard.service
  systemctl daemon-reload
fi

log "Restarting dashboard…"
systemctl restart esxp-dashboard

# Past the point of no return: everything succeeded, so keep the new version.
RESTORE_ON_ERR=0
ok "Update complete."
