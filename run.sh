#!/usr/bin/env bash
# =============================================================================
# ESXP Network Services - one command to install or update on Linux.
#
#   sudo ./run.sh
#
# On a fresh machine this installs everything (Kea + the dashboard) and starts
# it. If it is already installed, it pulls the latest version from GitHub and
# redeploys. Either way, when it finishes it prints the dashboard URL.
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/etc/esxp-network-services/.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo:  sudo ./run.sh" >&2
  exit 1
fi

if [[ -f "${ENV_FILE}" ]]; then
  echo "==> Existing install found — updating to the latest version…"
  exec "${DIR}/install/update.sh"
else
  echo "==> Fresh machine — installing ESXP Network Services…"
  exec "${DIR}/install/install.sh"
fi
