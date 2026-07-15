#!/usr/bin/env bash
# =============================================================================
# ESXP Network Services - Kea repair
#
# Fixes an EXISTING install so that:
#   * saving configuration persists   (Kea config-write can reach /etc/kea)
#   * the Active Leases page works     (loads the lease_cmds hook)
#
# Unlike install.sh this NEVER overwrites your Kea configs with blank templates.
# It edits them in place to add the lease hook, fixes ownership, installs the
# systemd drop-in that permits config-write, and restarts Kea. Safe to re-run.
#
# Usage: sudo ./install/repair-kea.sh
# =============================================================================
set -euo pipefail

KEA_CONF_DIR="/etc/kea"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install/lib-kea.sh
source "${SCRIPT_DIR}/lib-kea.sh"

[[ "${EUID}" -eq 0 ]] || die "Please run as root (sudo ./install/repair-kea.sh)."
command -v python3 >/dev/null 2>&1 || die "python3 is required to edit the Kea config."

kea_user="$(detect_kea_user)"
kea_group="$(id -gn "${kea_user}" 2>/dev/null || echo "${kea_user}")"
dhcp4_unit="$(detect_unit kea-dhcp4)"
dhcp6_unit="$(detect_unit kea-dhcp6)"
hooks_dir="$(detect_hooks_dir)"

log "Kea user: ${kea_user}:${kea_group} | units: ${dhcp4_unit}, ${dhcp6_unit}"

# --- 1. lease_cmds hook -> Active Leases ------------------------------------
if [[ -n "${hooks_dir}" ]]; then
  ok "lease_cmds hook: ${hooks_dir}/libdhcp_lease_cmds.so"
else
  warn "libdhcp_lease_cmds.so not found -- Active Leases will stay unavailable."
fi
ts="$(date +%Y%m%d-%H%M%S)"
for f in kea-dhcp4.conf kea-dhcp6.conf; do
  if [[ -f "${KEA_CONF_DIR}/${f}" ]]; then
    cp -a "${KEA_CONF_DIR}/${f}" "${KEA_CONF_DIR}/${f}.bak-${ts}"
    inject_lease_hook "${KEA_CONF_DIR}/${f}" "${hooks_dir}"
    chown "${kea_user}:${kea_group}" "${KEA_CONF_DIR}/${f}"
    ok "Updated ${KEA_CONF_DIR}/${f} (backup: ${f}.bak-${ts})."
  else
    warn "${KEA_CONF_DIR}/${f} not found -- skipped."
  fi
done

# --- 2. config-write persistence -> saves survive a restart -----------------
write_kea_conf_dropins "${dhcp4_unit}" "${dhcp6_unit}"
ok "Installed systemd drop-ins allowing config-write to ${KEA_CONF_DIR}."

# --- 3. restart Kea so both take effect -------------------------------------
for unit in "${dhcp4_unit}" "${dhcp6_unit}" kea-ctrl-agent; do
  systemctl restart "${unit}" || warn "Could not restart ${unit} -- check 'systemctl status ${unit}'."
done

echo
ok "Repair complete."
echo -e "  ${c_y}Note:${c_0} any subnet that had failed to save before is not on disk --"
echo -e "        re-add it in the dashboard; it will now persist."
