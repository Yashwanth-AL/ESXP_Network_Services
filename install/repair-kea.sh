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

# --- 3. Control Agent reachability ------------------------------------------
# The dashboard talks to Kea ONLY through the Control Agent. Two packaging traps
# on modern Debian/Ubuntu keep it from working: the CA unit won't start without
# /etc/kea/kea-api-password, and AppArmor blocks the CA from the DHCP sockets.
ensure_ca_can_start kea-ctrl-agent
fix_kea_apparmor

# --- 4. restart Kea so everything takes effect ------------------------------
# DHCP servers first so their control sockets exist before the CA connects.
for unit in "${dhcp4_unit}" "${dhcp6_unit}" kea-ctrl-agent; do
  systemctl enable "${unit}" >/dev/null 2>&1 || true
  systemctl restart "${unit}" || warn "Could not restart ${unit} -- check 'systemctl status ${unit}'."
done

# --- 5. verify the CA actually answers --------------------------------------
if command -v curl >/dev/null 2>&1; then
  sleep 1
  if curl -fsS -m 5 -X POST http://127.0.0.1:8000/ \
       -H 'Content-Type: application/json' \
       -d '{"command":"list-commands","service":["dhcp4"]}' >/dev/null 2>&1; then
    ok "Control Agent is answering on http://127.0.0.1:8000 for dhcp4."
  else
    warn "Control Agent did not answer yet. Check 'systemctl status kea-ctrl-agent' and 'journalctl -u kea-ctrl-agent -n 50'."
  fi
fi

echo
ok "Repair complete."
echo -e "  ${c_y}Note:${c_0} any subnet that had failed to save before is not on disk --"
echo -e "        re-add it in the dashboard; it will now persist."
