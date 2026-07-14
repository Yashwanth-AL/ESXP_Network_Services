"""Async client for the Kea Control Agent REST API.

Every interaction with Kea goes through this module -- the dashboard never
shells out to ``keactrl`` and never edits Kea's JSON files directly. The
Control Agent listens on localhost and forwards commands to the running
``kea-dhcp4`` / ``kea-dhcp6`` servers over their unix control sockets.

Response shape from the Control Agent is a JSON *list*, one element per
targeted service::

    [ { "result": 0, "text": "...", "arguments": { ... } } ]

result codes: 0 success, 1 error, 2 unsupported, 3 empty/not-found.
"""
from __future__ import annotations

import copy
from typing import Any

import httpx

from .config import settings

# Kea "service" identifiers as used in the control channel.
DHCP4 = "dhcp4"
DHCP6 = "dhcp6"

_CONFIG_ROOT = {DHCP4: "Dhcp4", DHCP6: "Dhcp6"}


class KeaError(Exception):
    """Raised for any Control Agent transport or command-level failure.

    ``result`` carries Kea's numeric result code when the failure came from a
    command response (as opposed to a transport error).
    """

    def __init__(self, message: str, result: int | None = None):
        super().__init__(message)
        self.message = message
        self.result = result


async def _post(payload: dict[str, Any]) -> list[dict[str, Any]]:
    url = settings.kea_ca_url + "/"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=payload)
    except httpx.ConnectError:
        raise KeaError(
            "Cannot reach the Kea Control Agent. Is the kea-ctrl-agent service "
            "running?"
        )
    except httpx.HTTPError as exc:
        raise KeaError(f"Kea Control Agent request failed: {exc}")

    if resp.status_code != 200:
        raise KeaError(
            f"Kea Control Agent returned HTTP {resp.status_code}: {resp.text[:300]}"
        )
    try:
        data = resp.json()
    except ValueError:
        raise KeaError("Kea Control Agent returned a non-JSON response")
    if not isinstance(data, list):
        # The agent itself (no service) can return a single object.
        data = [data]
    return data


def _check(entry: dict[str, Any]) -> dict[str, Any]:
    result = entry.get("result", 1)
    if result == 0:
        return entry.get("arguments", {}) or {}
    if result == 3:
        # "empty" - treat as no data rather than an error.
        return entry.get("arguments", {}) or {}
    text = entry.get("text", "unknown error")
    raise KeaError(text, result=result)


async def command(cmd: str, service: str | None = None,
                  arguments: dict | None = None) -> dict[str, Any]:
    """Send a command to a single service and return its ``arguments`` dict.

    Raises :class:`KeaError` on any non-success result code.
    """
    payload: dict[str, Any] = {"command": cmd}
    if service is not None:
        payload["service"] = [service]
    if arguments is not None:
        payload["arguments"] = arguments
    data = await _post(payload)
    if not data:
        raise KeaError(f"Empty response from Kea for command '{cmd}'")
    return _check(data[0])


# --- Configuration -----------------------------------------------------------

async def config_get(service: str) -> dict[str, Any]:
    """Return the full running configuration ``{"Dhcp4": {...}}`` for a service."""
    args = await command("config-get", service)
    args = copy.deepcopy(args)
    args.pop("hash", None)
    root = _CONFIG_ROOT[service]
    if root not in args:
        raise KeaError(f"Unexpected config-get response: missing '{root}' key")
    return args


async def config_test(service: str, config: dict[str, Any]) -> None:
    """Validate a candidate config; raise KeaError with details if invalid."""
    await command("config-test", service, config)


async def config_set(service: str, config: dict[str, Any]) -> None:
    """Apply a config to the running server (already validated by config_test)."""
    await command("config-set", service, config)


async def config_write(service: str) -> str:
    """Persist the running config to disk. Returns the filename written."""
    args = await command("config-write", service)
    return args.get("filename", "")


async def config_reload(service: str) -> None:
    await command("config-reload", service)


async def apply_config(service: str, config: dict[str, Any]) -> None:
    """Full safe-apply pipeline: test -> set -> write.

    config-test is the gate that rejects a bad configuration *before* it can be
    pushed to the live server, satisfying the "validate before apply"
    requirement. config-write then persists it so it survives a restart.
    """
    await config_test(service, config)
    await config_set(service, config)
    await config_write(service)


# --- Status ------------------------------------------------------------------

async def status_get(service: str) -> dict[str, Any] | None:
    """Return status-get arguments, or None if the service is unreachable."""
    try:
        return await command("status-get", service)
    except KeaError:
        return None


# --- Leases ------------------------------------------------------------------

async def lease4_get_all() -> list[dict[str, Any]]:
    args = await command("lease4-get-all", DHCP4)
    return args.get("leases", [])


async def lease6_get_all() -> list[dict[str, Any]]:
    args = await command("lease6-get-all", DHCP6)
    return args.get("leases", [])


async def lease4_get(ip: str) -> dict[str, Any] | None:
    try:
        return await command("lease4-get", DHCP4, {"ip-address": ip})
    except KeaError:
        return None


async def lease6_get(ip: str) -> dict[str, Any] | None:
    try:
        return await command("lease6-get", DHCP6, {"ip-address": ip})
    except KeaError:
        return None


async def lease4_del(ip: str) -> None:
    await command("lease4-del", DHCP4, {"ip-address": ip})


async def lease6_del(ip: str) -> None:
    await command("lease6-del", DHCP6, {"ip-address": ip})


async def lease4_update(lease: dict[str, Any]) -> None:
    await command("lease4-update", DHCP4, lease)


async def lease6_update(lease: dict[str, Any]) -> None:
    await command("lease6-update", DHCP6, lease)
