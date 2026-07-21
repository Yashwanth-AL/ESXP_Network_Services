"""Control of the Kea systemd units from the dashboard.

The backend invokes ``systemctl`` on the user's behalf so the operator never
touches a terminal. This requires the dashboard process to have privilege to
manage those units (the shipped systemd unit runs it as root on the single
internal server; see systemd/esxp-dashboard.service and the README).
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time

from .config import settings

ALLOWED_ACTIONS = {"start", "stop", "restart", "reload"}

# Neighbour-table states that mean "the kernel has a live L2 mapping for this
# host" -- i.e. the device answered ARP/NDP recently, so it is on the wire now.
# STALE/FAILED/INCOMPLETE are deliberately excluded: after our ping nudge a
# device that is actually present resolves to REACHABLE, so a still-STALE entry
# means it did not answer.
_LIVE_NEIGH = {"REACHABLE", "DELAY", "PROBE", "PERMANENT"}


def list_interfaces() -> list[str]:
    """Names of ALL of this host's network interfaces except loopback.

    The dashboard runs on the same box as Kea, so these are exactly the
    interfaces Kea can bind to. This list is the source of truth for
    validating a listen-interface selection, so it must be COMPLETE --
    filtering it here would make legitimate interfaces (bridges, bonds with
    custom names, usb0, ...) impossible to configure. Cosmetic filtering for
    the picker uses physical_interfaces() below instead. Loopback alone is
    excluded: binding a DHCP server to it is never valid.
    """
    names: list[str] = []
    try:
        names = [name for _, name in socket.if_nameindex()]
    except (OSError, AttributeError):
        names = []
    if not names:
        try:
            names = os.listdir("/sys/class/net")
        except OSError:
            names = []
    return sorted({n for n in names if n and n != "lo"})


def physical_interfaces(names: list[str]) -> list[str]:
    """The subset of ``names`` that are physical devices (NICs on a real bus).

    Uses /sys/class/net/<if>/device, which exists only for interfaces backed
    by hardware (PCI/USB/...) -- no fragile name-prefix lists. Virtual
    interfaces (bridges, veth, docker, dummies) have no device link. Returns
    [] when /sys is unavailable (non-Linux dev boxes); the UI then just shows
    everything. Display-only: validation always uses the full list.
    """
    out = []
    for n in names:
        try:
            if os.path.exists(f"/sys/class/net/{n}/device"):
                out.append(n)
        except OSError:
            continue
    return out


class ServiceError(Exception):
    pass


def _systemctl_path() -> str:
    path = shutil.which("systemctl")
    if not path:
        raise ServiceError(
            "systemctl is not available on this host. Service control requires a "
            "systemd-based Linux system."
        )
    return path


def _run(args: list[str], timeout: int = 20) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired:
        raise ServiceError(f"'{' '.join(args)}' timed out")
    except FileNotFoundError:
        raise ServiceError("systemctl executable not found")


def is_active(unit: str) -> bool:
    try:
        proc = _run([_systemctl_path(), "is-active", unit])
    except ServiceError:
        return False
    return proc.stdout.strip() == "active"


def service_status() -> dict[str, bool]:
    """Return running state for the three Kea units."""
    return {
        "dhcp4": is_active(settings.kea_dhcp4_service),
        "dhcp6": is_active(settings.kea_dhcp6_service),
        "ctrl_agent": is_active(settings.kea_ctrl_agent_service),
    }


# --- reachability (which leased devices are actually on the wire now) --------

def _ping_sweep(ips: list[str], version: int) -> set[str]:
    """Fire a short concurrent ping at each IP to force ARP/NDP resolution.

    Returns the set that answered ICMP. Best-effort: the real signal is the
    neighbour table afterwards (a device that answers ARP but filters ICMP
    still shows REACHABLE), so failures here are fine.
    """
    ping = shutil.which("ping")
    if not ping:
        return set()
    flag = "-6" if version == 6 else "-4"
    responded: set[str] = set()
    batch: list[tuple[str, subprocess.Popen]] = []

    def reap(items):
        deadline = time.time() + 3
        for ip, proc in items:
            try:
                if proc.wait(timeout=max(0.05, deadline - time.time())) == 0:
                    responded.add(ip)
            except subprocess.TimeoutExpired:
                proc.kill()

    for ip in ips[:256]:                       # cap the fan-out
        try:
            proc = subprocess.Popen(
                [ping, flag, "-c", "1", "-W", "1", "-n", ip],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            continue
        batch.append((ip, proc))
        if len(batch) >= 64:                   # bound concurrent processes
            reap(batch); batch = []
    reap(batch)
    return responded


def _neighbor_reachable(ips: set[str]) -> set[str]:
    """IPs from ``ips`` that appear in the kernel neighbour table as live."""
    ip_bin = shutil.which("ip")
    if not ip_bin:
        return set()
    try:
        proc = _run([ip_bin, "neigh", "show"], timeout=5)
    except ServiceError:
        return set()
    out: set[str] = set()
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in ips and parts[-1].upper() in _LIVE_NEIGH:
            out.add(parts[0])
    return out


def connected_ips(ips: list[str], version: int = 4) -> set[str]:
    """Best-effort set of leased IPs that are reachable on the network *now*.

    Nudges ARP/NDP with a short ping sweep, then reads the neighbour table.
    Returns an empty set when the tooling is unavailable (e.g. a non-Linux dev
    box), which the UI treats as "reachability unknown".
    """
    ips = [i for i in ips if i]
    if not ips:
        return set()
    responders = _ping_sweep(ips, version)
    return responders | _neighbor_reachable(set(ips))


# --- troubleshooting probes --------------------------------------------------

def socket_listening(port: int) -> tuple[bool, str]:
    """Whether any UDP socket is bound to ``port`` (DHCP: 67 v4 / 547 v6)."""
    ss = shutil.which("ss")
    if not ss:
        return False, "'ss' not available on this host (iproute2 not installed)."
    try:
        proc = _run([ss, "-lunp"], timeout=5)
    except ServiceError as exc:
        return False, str(exc)
    hits = [ln for ln in proc.stdout.splitlines() if f":{port} " in f"{ln} "]
    if hits:
        return True, "\n".join(hits[:6])
    return False, f"Nothing is listening on UDP :{port}."


def journal_tail(unit: str, lines: int = 120) -> str:
    """Recent journal lines for a systemd unit (for the log viewer)."""
    jc = shutil.which("journalctl")
    if not jc:
        return "journalctl not available on this host."
    try:
        proc = _run([jc, "-u", unit, "-n", str(lines), "--no-pager",
                     "-o", "short-iso"], timeout=15)
    except ServiceError as exc:
        return str(exc)
    return (proc.stdout or proc.stderr or "").strip() or "(no journal output)"


def control(which: str, action: str) -> str:
    """Run a start/stop/restart/reload action against one Kea unit.

    Returns a short status message on success; raises ServiceError otherwise.
    """
    if action not in ALLOWED_ACTIONS:
        raise ServiceError(f"Unsupported action '{action}'")
    unit = settings.service_unit(which)
    if not unit:
        raise ServiceError(f"Unknown service '{which}'")

    proc = _run([_systemctl_path(), action, unit])
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip() or f"exit code {proc.returncode}"
        raise ServiceError(f"systemctl {action} {unit} failed: {detail}")
    return f"{unit}: {action} ok"
