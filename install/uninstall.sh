#!/usr/bin/env bash
# =============================================================================
# ESXP Network Services - uninstaller
#
# Removes the dashboard app and its systemd service. Kea itself and its configs
# are left in place. Pass --purge to also delete the config and database
# (/etc/esxp-network-services and /var/lib/esxp-network-services).
#
# Usage: sudo ./install/uninstall.sh [--purge]
# =============================================================================
set -euo pipefail

APP_NAME="esxp-network-services"
INSTALL_DIR="/opt/${APP_NAME}"
ETC_DIR="/etc/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
PURGE="${1:-}"

c_g="\033[1;32m"; c_y="\033[1;33m"; c_0="\033[0m"
ok()   { echo -e "${c_g}[+]${c_0} $*"; }
warn() { echo -e "${c_y}[!]${c_0} $*"; }

[[ "${EUID}" -eq 0 ]] || { echo "Please run as root."; exit 1; }

systemctl stop esxp-dashboard 2>/dev/null || true
systemctl disable esxp-dashboard 2>/dev/null || true
rm -f /etc/systemd/system/esxp-dashboard.service
systemctl daemon-reload 2>/dev/null || true
rm -rf "${INSTALL_DIR}"
ok "Removed dashboard app and service."

if [[ "${PURGE}" == "--purge" ]]; then
  rm -rf "${ETC_DIR}" "${DATA_DIR}"
  rm -f /etc/tmpfiles.d/${APP_NAME}-kea.conf
  ok "Purged configuration and database."
else
  warn "Kept ${ETC_DIR} and ${DATA_DIR}. Use --purge to remove them."
fi

warn "Kea packages and /etc/kea were left installed. Remove them manually if desired."
