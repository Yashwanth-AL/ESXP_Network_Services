"""Input validation shared by the DHCPv4/DHCPv6 routers.

Everything here raises ``ValidationError`` (mapped to HTTP 422 in main.py) with a
human-readable message, so the frontend can surface it directly in a toast.
Validation is intentionally strict: nothing reaches Kea until it passes here,
which is the first of the two safety gates (the second being Kea's config-test).
"""
from __future__ import annotations

import ipaddress
import re

_MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
_HOSTNAME_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?"
                          r"(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*$")


class ValidationError(ValueError):
    """Raised when user-supplied network data is malformed."""


def _fail(msg: str) -> None:
    raise ValidationError(msg)


# --- CIDR / addresses --------------------------------------------------------

def parse_network(cidr: str, version: int) -> ipaddress._BaseNetwork:
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        _fail(f"'{cidr}' is not a valid CIDR subnet")
    if net.version != version:
        _fail(f"'{cidr}' is not an IPv{version} subnet")
    return net


def parse_address(ip: str, version: int) -> ipaddress._BaseAddress:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        _fail(f"'{ip}' is not a valid IP address")
    if addr.version != version:
        _fail(f"'{ip}' is not an IPv{version} address")
    return addr


def normalize_cidr(cidr: str, version: int) -> str:
    net = parse_network(cidr, version)
    return str(net)


def netmask_for(cidr: str) -> str:
    return str(ipaddress.ip_network(cidr, strict=False).netmask)


def address_in_network(ip: str, cidr: str, version: int) -> None:
    net = parse_network(cidr, version)
    addr = parse_address(ip, version)
    if addr not in net:
        _fail(f"{ip} is not inside subnet {cidr}")


def validate_pool(start: str, end: str, cidr: str, version: int) -> None:
    net = parse_network(cidr, version)
    s = parse_address(start, version)
    e = parse_address(end, version)
    if s not in net:
        _fail(f"Pool start {start} is not inside subnet {cidr}")
    if e not in net:
        _fail(f"Pool end {end} is not inside subnet {cidr}")
    if int(s) > int(e):
        _fail("Pool start must be less than or equal to pool end")


# --- Identifiers -------------------------------------------------------------

def validate_mac(mac: str) -> str:
    if not _MAC_RE.match(mac or ""):
        _fail(f"'{mac}' is not a valid MAC address (expected aa:bb:cc:dd:ee:ff)")
    return mac.lower().replace("-", ":")


def validate_duid(duid: str) -> str:
    raw = (duid or "").strip().lower()
    # Accept colon/hyphen separated hex pairs or a continuous hex string.
    if ":" in raw or "-" in raw:
        parts = re.split(r"[:-]", raw)
        if not parts or any(not re.fullmatch(r"[0-9a-f]{1,2}", p) for p in parts):
            _fail(f"'{duid}' is not a valid DUID")
        normalized = ":".join(p.zfill(2) for p in parts)
    else:
        if not re.fullmatch(r"[0-9a-f]+", raw) or len(raw) % 2 != 0:
            _fail(f"'{duid}' is not a valid DUID (hex string)")
        normalized = ":".join(raw[i:i + 2] for i in range(0, len(raw), 2))
    pair_count = len(normalized.split(":"))
    if not (3 <= pair_count <= 130):
        _fail("DUID length is out of range")
    return normalized


def validate_hostname(hostname: str | None) -> str | None:
    if hostname is None or hostname == "":
        return None
    if len(hostname) > 253 or not _HOSTNAME_RE.match(hostname):
        _fail(f"'{hostname}' is not a valid hostname")
    return hostname


# --- Numbers -----------------------------------------------------------------

def validate_timers(valid_lifetime: int, renew_timer: int, rebind_timer: int) -> None:
    for name, val in (("valid lifetime", valid_lifetime),
                      ("renew timer", renew_timer),
                      ("rebind timer", rebind_timer)):
        if not isinstance(val, int) or val < 0:
            _fail(f"{name} must be a non-negative integer")
    if renew_timer and rebind_timer and renew_timer >= rebind_timer:
        _fail("Renew timer must be less than rebind timer")
    if rebind_timer and valid_lifetime and rebind_timer >= valid_lifetime:
        _fail("Rebind timer must be less than valid lifetime")


def validate_dns_servers(servers: list[str], version: int) -> list[str]:
    out: list[str] = []
    for s in servers:
        s = s.strip()
        if not s:
            continue
        parse_address(s, version)
        out.append(s)
    return out


# --- Listen interfaces -------------------------------------------------------

def validate_interfaces(requested: list[str], available: list[str]) -> list[str]:
    """Normalise a listen-interface selection.

    ``"*"`` means "all interfaces" and cannot be combined with specific names.
    When we could enumerate the host's interfaces, every requested name must be
    one of them (catching typos before Kea silently fails to bind); if we could
    not enumerate them (``available`` empty), names pass through and Kea's
    config-test remains the backstop. At least one interface is required.
    """
    clean, seen = [], set()
    for i in requested or []:
        i = (i or "").strip()
        if i and i not in seen:
            seen.add(i)
            clean.append(i)
    if not clean:
        _fail("Select at least one interface (or '*' for all).")
    if "*" in clean:
        return ["*"]
    if available:
        for i in clean:
            if i not in available:
                _fail(f"'{i}' is not a network interface on this host")
    return clean
