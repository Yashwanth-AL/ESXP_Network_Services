#!/usr/bin/env bash
# =============================================================================
# Shared Kea helpers for the ESXP installer and repair script.
# This file is SOURCED, not executed directly.
# =============================================================================

# --- pretty logging ----------------------------------------------------------
c_g="\033[1;32m"; c_y="\033[1;33m"; c_r="\033[1;31m"; c_b="\033[1;34m"; c_0="\033[0m"
log()  { echo -e "${c_b}[*]${c_0} $*"; }
ok()   { echo -e "${c_g}[+]${c_0} $*"; }
warn() { echo -e "${c_y}[!]${c_0} $*"; }
die()  { echo -e "${c_r}[x]${c_0} $*" >&2; exit 1; }

KEA_CONF_DIR="${KEA_CONF_DIR:-/etc/kea}"

# Resolve a Kea systemd unit name (handles kea-dhcp4-server vs kea-dhcp4).
detect_unit() {                       # $1 = base name (kea-dhcp4 / kea-dhcp6)
  local base="$1" u
  for u in "${base}-server" "${base}"; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^${u}\.service"; then echo "${u}"; return; fi
  done
  echo "${base}-server"
}

# The system user the Kea daemons run as.
detect_kea_user() {
  local u
  for u in _kea kea dhcpd; do id "${u}" >/dev/null 2>&1 && { echo "${u}"; return; }; done
  echo root
}

# Directory holding Kea's hook libraries (distro-specific), or "" if not found.
detect_hooks_dir() {
  local d found
  for d in /usr/lib/x86_64-linux-gnu/kea/hooks \
           /usr/lib/aarch64-linux-gnu/kea/hooks \
           /usr/lib64/kea/hooks \
           /usr/lib/kea/hooks \
           /usr/local/lib/kea/hooks; do
    [[ -f "${d}/libdhcp_lease_cmds.so" ]] && { echo "${d}"; return; }
  done
  found="$(find /usr /opt -name libdhcp_lease_cmds.so 2>/dev/null | head -1 || true)"
  [[ -n "${found}" ]] && { dirname "${found}"; return; }
  echo ""
}

# Ensure a DHCP config loads the lease_cmds hook (needed for Active Leases).
# Rewrites the JSON in place, preserving all existing content (subnets, pools,
# reservations). Pass an empty hooks dir to remove the hook instead.
inject_lease_hook() {                 # $1 = conf path, $2 = hooks dir ("" = remove)
  command -v python3 >/dev/null 2>&1 || { warn "python3 not available; cannot edit ${1} for the lease hook."; return 0; }
  # Always exits 0: editing the hook is best-effort. Kea configs may carry
  # comments (# // /* */), which strict json.load rejects -- if we let that
  # abort the caller under `set -e`, the far more important config-write
  # drop-in step would be skipped. On any parse trouble we warn and leave the
  # file untouched instead.
  python3 - "$1" "$2" <<'PY'
import json, os, re, sys

path, hooks_dir = sys.argv[1], sys.argv[2]


def strip_jsonc(text):
    """Remove // # line and /* */ block comments that Kea tolerates, without
    touching comment-like sequences inside strings."""
    out, i, n = [], 0, len(text)
    in_str = esc = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True; out.append(c); i += 1; continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            i = text.find("\n", i);  i = n if i == -1 else i;  continue
        if c == "#":
            i = text.find("\n", i);  i = n if i == -1 else i;  continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2);  i = n if end == -1 else end + 2;  continue
        out.append(c); i += 1
    return "".join(out)


try:
    with open(path) as fh:
        raw = fh.read()
    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError:
        cfg = json.loads(strip_jsonc(raw))
    root = next(iter(cfg))            # "Dhcp4" / "Dhcp6"
    lib = os.path.join(hooks_dir, "libdhcp_lease_cmds.so") if hooks_dir else ""
    # Preserve any other hooks already configured; only manage lease_cmds.
    libs = [l for l in cfg[root].get("hooks-libraries", [])
            if "libdhcp_lease_cmds.so" not in l.get("library", "")]
    if lib and os.path.exists(lib):
        libs.append({"library": lib})
    if libs:
        cfg[root]["hooks-libraries"] = libs
    else:
        cfg[root].pop("hooks-libraries", None)
    with open(path, "w") as fh:
        json.dump(cfg, fh, indent=4)
        fh.write("\n")
except Exception as exc:  # noqa: BLE001 - best effort, must not abort the caller
    sys.stderr.write(
        f"[!] Could not update {path} for the lease hook ({exc}); left as-is.\n")
PY
}

# Let the Kea daemons persist config-write to /etc/kea even when the packaged
# units set ProtectSystem=strict (Debian/Ubuntu), via a systemd drop-in.
write_kea_conf_dropins() {            # $1 = dhcp4 unit, $2 = dhcp6 unit
  local unit dir
  for unit in "$1" "$2"; do
    [[ -n "${unit}" ]] || continue
    dir="/etc/systemd/system/${unit}.service.d"
    mkdir -p "${dir}"
    cat > "${dir}/10-esxp-writable-conf.conf" <<EOF
[Service]
# Added by ESXP Network Services: the dashboard persists configuration through
# Kea's config-write, which writes ${KEA_CONF_DIR}/*.conf. The packaged units
# set ProtectSystem=strict (making /etc read-only to the daemon), so whitelist
# the Kea config dir here or config-write fails with "Unable to open file".
ReadWritePaths=${KEA_CONF_DIR}
EOF
  done
  systemctl daemon-reload >/dev/null 2>&1 || true
}
