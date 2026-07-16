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

from .config import settings

ALLOWED_ACTIONS = {"start", "stop", "restart", "reload"}


def list_interfaces() -> list[str]:
    """Names of this host's network interfaces (for the listen-interface picker).

    The dashboard runs on the same box as Kea, so these are exactly the
    interfaces Kea can bind to. Loopback is excluded -- serving DHCP on it is
    never what the operator wants.
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
