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

c_g="\033[1;32m"; c_r="\033[1;31m"; c_b="\033[1;34m"; c_0="\033[0m"
log() { echo -e "${c_b}[*]${c_0} $*"; }
ok()  { echo -e "${c_g}[+]${c_0} $*"; }
die() { echo -e "${c_r}[x]${c_0} $*" >&2; exit 1; }

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
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

log "Cloning ${REPO_URL} (branch ${REPO_BRANCH})…"
git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${TMP}" \
  || die "Clone failed. Check REPO_URL / network / credentials."
[[ -d "${TMP}/backend" && -d "${TMP}/frontend" ]] || die "Cloned repo has no backend/ or frontend/."

log "Redeploying application source…"
rm -rf "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend"
cp -a "${TMP}/backend"  "${INSTALL_DIR}/backend"
cp -a "${TMP}/frontend" "${INSTALL_DIR}/frontend"

log "Updating Python dependencies…"
"${INSTALL_DIR}/.venv/bin/pip" install --quiet -r "${INSTALL_DIR}/backend/requirements.txt"

# Refresh the systemd unit if it changed.
if [[ -f "${TMP}/systemd/esxp-dashboard.service" ]]; then
  install -m 0644 "${TMP}/systemd/esxp-dashboard.service" /etc/systemd/system/esxp-dashboard.service
  systemctl daemon-reload
fi

log "Restarting dashboard…"
systemctl restart esxp-dashboard
ok "Update complete."
