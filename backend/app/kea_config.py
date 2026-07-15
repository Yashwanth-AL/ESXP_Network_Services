"""Translation between the dashboard's subnet/reservation models and Kea's
native ``subnet4`` / ``subnet6`` JSON.

Kea's running JSON configuration remains the single source of truth: these
helpers mutate a config dict obtained from ``config-get`` in place, which is
then validated and applied via :func:`kea_client.apply_config`.
"""
from __future__ import annotations

import ipaddress
from typing import Any

from . import kea_client
from .validation import netmask_for

ROOT = {kea_client.DHCP4: "Dhcp4", kea_client.DHCP6: "Dhcp6"}
SUBNET_KEY = {kea_client.DHCP4: "subnet4", kea_client.DHCP6: "subnet6"}

# Option names Kea uses for the fields the dashboard exposes.
OPT_ROUTERS = "routers"                # IPv4 default gateway
OPT_DNS4 = "domain-name-servers"       # IPv4 DNS
OPT_DNS6 = "dns-servers"               # IPv6 DNS


# --- generic helpers ---------------------------------------------------------

def subnet_list(config: dict[str, Any], service: str) -> list[dict[str, Any]]:
    root = config[ROOT[service]]
    return root.setdefault(SUBNET_KEY[service], [])


def next_subnet_id(config: dict[str, Any], service: str) -> int:
    ids = [s.get("id", 0) for s in subnet_list(config, service)]
    return (max(ids) + 1) if ids else 1


def find_subnet(config: dict[str, Any], service: str, subnet_id: int) -> dict[str, Any] | None:
    for s in subnet_list(config, service):
        if s.get("id") == subnet_id:
            return s
    return None


def _get_option(subnet: dict[str, Any], name: str) -> str | None:
    for opt in subnet.get("option-data", []):
        if opt.get("name") == name:
            return opt.get("data")
    return None


def _set_option(subnet: dict[str, Any], name: str, value: str | None) -> None:
    opts = subnet.setdefault("option-data", [])
    opts[:] = [o for o in opts if o.get("name") != name]
    if value:
        opts.append({"name": name, "data": value})
    if not opts:
        subnet.pop("option-data", None)


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [p.strip() for p in value.split(",") if p.strip()]


def _pool_bounds(pool_str: str) -> tuple[str, str]:
    if "-" in pool_str:
        start, _, end = pool_str.partition("-")
        return start.strip(), end.strip()
    return pool_str.strip(), pool_str.strip()


def _first_pool(subnet: dict[str, Any]) -> tuple[str, str]:
    pools = subnet.get("pools", [])
    if not pools:
        return "", ""
    return _pool_bounds(pools[0].get("pool", ""))


def _write_first_pool(subnet: dict[str, Any], pool_start: str, pool_end: str) -> None:
    """Update only the FIRST pool, leaving any additional pools untouched.

    The dashboard surfaces a single pool per subnet (see :func:`_first_pool`),
    so replacing ``pools`` wholesale would silently delete extra pools that Kea
    already had -- e.g. a multi-pool subnet configured before this dashboard
    existed would lose address space on an unrelated edit such as changing DNS.
    Any non-``pool`` keys on the first entry (``client-class``, ``option-data``
    and friends) are preserved too.
    """
    pools = list(subnet.get("pools") or [])
    if pool_start and pool_end:
        entry = {"pool": f"{pool_start} - {pool_end}"}
        pools = ([{**pools[0], **entry}] + pools[1:]) if pools else [entry]
    else:
        # Pool cleared in the UI: drop just the first one, keep the rest.
        pools = pools[1:]
    subnet["pools"] = pools


def _timers(subnet: dict[str, Any]) -> dict[str, int]:
    return {
        "valid_lifetime": subnet.get("valid-lifetime", 0),
        "renew_timer": subnet.get("renew-timer", 0),
        "rebind_timer": subnet.get("rebind-timer", 0),
    }


def _apply_timers(subnet: dict[str, Any], valid_lifetime: int,
                  renew_timer: int, rebind_timer: int) -> None:
    subnet["valid-lifetime"] = valid_lifetime
    subnet["renew-timer"] = renew_timer
    subnet["rebind-timer"] = rebind_timer


# --- IPv4 --------------------------------------------------------------------

def subnet4_to_api(subnet: dict[str, Any]) -> dict[str, Any]:
    start, end = _first_pool(subnet)
    cidr = subnet.get("subnet", "")
    return {
        "id": subnet.get("id"),
        "subnet": cidr,
        "netmask": netmask_for(cidr) if cidr else "",
        "pool_start": start,
        "pool_end": end,
        "gateway": _get_option(subnet, OPT_ROUTERS) or "",
        "dns_servers": _split_csv(_get_option(subnet, OPT_DNS4)),
        **_timers(subnet),
        "reservation_count": len(subnet.get("reservations", [])),
        "pool_count": len(subnet.get("pools", [])),
    }


def write_subnet4(subnet: dict[str, Any], *, cidr: str, pool_start: str, pool_end: str,
                  gateway: str | None, dns_servers: list[str], valid_lifetime: int,
                  renew_timer: int, rebind_timer: int) -> None:
    subnet["subnet"] = cidr
    _write_first_pool(subnet, pool_start, pool_end)
    _set_option(subnet, OPT_ROUTERS, gateway or None)
    _set_option(subnet, OPT_DNS4, ", ".join(dns_servers) if dns_servers else None)
    _apply_timers(subnet, valid_lifetime, renew_timer, rebind_timer)
    subnet.setdefault("reservations", [])


def reservation4_to_api(res: dict[str, Any]) -> dict[str, Any]:
    return {
        "mac": res.get("hw-address", ""),
        "ip": res.get("ip-address", ""),
        "hostname": res.get("hostname", "") or "",
    }


def build_reservation4(mac: str, ip: str, hostname: str | None) -> dict[str, Any]:
    res: dict[str, Any] = {"hw-address": mac, "ip-address": ip}
    if hostname:
        res["hostname"] = hostname
    return res


# --- IPv6 --------------------------------------------------------------------

def subnet6_to_api(subnet: dict[str, Any]) -> dict[str, Any]:
    start, end = _first_pool(subnet)
    return {
        "id": subnet.get("id"),
        "subnet": subnet.get("subnet", ""),
        "pool_start": start,
        "pool_end": end,
        "dns_servers": _split_csv(_get_option(subnet, OPT_DNS6)),
        "preferred_lifetime": subnet.get("preferred-lifetime", 0),
        "valid_lifetime": subnet.get("valid-lifetime", 0),
        "renew_timer": subnet.get("renew-timer", 0),
        "rebind_timer": subnet.get("rebind-timer", 0),
        "reservation_count": len(subnet.get("reservations", [])),
        "pool_count": len(subnet.get("pools", [])),
    }


def write_subnet6(subnet: dict[str, Any], *, cidr: str, pool_start: str, pool_end: str,
                  dns_servers: list[str], preferred_lifetime: int, valid_lifetime: int,
                  renew_timer: int, rebind_timer: int) -> None:
    subnet["subnet"] = cidr
    _write_first_pool(subnet, pool_start, pool_end)
    _set_option(subnet, OPT_DNS6, ", ".join(dns_servers) if dns_servers else None)
    subnet["preferred-lifetime"] = preferred_lifetime
    _apply_timers(subnet, valid_lifetime, renew_timer, rebind_timer)
    subnet.setdefault("reservations", [])


def reservation6_to_api(res: dict[str, Any]) -> dict[str, Any]:
    ips = res.get("ip-addresses", [])
    return {
        "duid": res.get("duid", ""),
        "ip": ips[0] if ips else "",
        "hostname": res.get("hostname", "") or "",
    }


def build_reservation6(duid: str, ip: str, hostname: str | None) -> dict[str, Any]:
    res: dict[str, Any] = {"duid": duid, "ip-addresses": [ip]}
    if hostname:
        res["hostname"] = hostname
    return res
