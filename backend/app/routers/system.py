"""Service control, server status, health, and audit-log surfacing."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from .. import audit, kea_client, kea_config, ops, services
from ..auth import current_user
from ..config import settings
from ..models import InterfacesRequest
from ..validation import validate_interfaces

router = APIRouter(prefix="/api/system", tags=["system"])


def _service(family: str) -> str:
    if family not in (kea_client.DHCP4, kea_client.DHCP6):
        raise HTTPException(status_code=400, detail=f"Unknown service '{family}'")
    return family


@router.get("/health")
async def health():
    """Unauthenticated liveness probe for the installer / load balancers."""
    return {"status": "ok"}


@router.get("/status")
async def status(user: str = Depends(current_user)):
    # service_status() shells out to systemctl up to three times (20s timeout
    # each). This endpoint is polled every 5s by every open dashboard, so it has
    # to stay off the event loop or a slow systemctl blocks the whole app.
    svc = await run_in_threadpool(services.service_status)
    ca_reachable = False
    kea_info: dict = {}
    # Query both daemons concurrently: each status_get is a Control Agent
    # round-trip with a 15s timeout, and this endpoint is polled every 5s, so
    # running them back-to-back would double the worst-case stall.
    names = ("dhcp4", "dhcp6")
    results = await asyncio.gather(*(kea_client.status_get(n) for n in names))
    for name, info in zip(names, results):
        if info is not None:
            ca_reachable = True
            kea_info[name] = {
                "pid": info.get("pid"),
                "uptime": info.get("uptime"),
                "reload": info.get("reload"),
            }
    return {
        "services": svc,
        "kea_ca_reachable": ca_reachable,
        "kea": kea_info,
    }


@router.post("/service/{which}/{action}")
async def service_control(which: str, action: str, user: str = Depends(current_user)):
    if which not in ("dhcp4", "dhcp6", "ctrl_agent"):
        raise HTTPException(status_code=400, detail=f"Unknown service '{which}'")
    try:
        message = await run_in_threadpool(services.control, which, action)
    except services.ServiceError as exc:
        await audit.arecord(user, "service", f"{which}.{action}", "failure", str(exc))
        raise HTTPException(status_code=502, detail=str(exc))
    await audit.arecord(user, "service", f"{which}.{action}", "success", message)
    return {"ok": True, "message": message}


@router.get("/audit")
async def audit_log(limit: int = 100, user: str = Depends(current_user)):
    limit = max(1, min(limit, 500))
    return await audit.arecent(limit)


# --- listen interfaces -------------------------------------------------------
# Which host NICs each DHCP daemon binds to (Kea's interfaces-config). Kept here
# rather than duplicated across the dhcp4/dhcp6 routers.

@router.get("/interfaces")
async def available_interfaces(user: str = Depends(current_user)):
    """Network interfaces present on this host, for the listen-interface picker.

    ``interfaces`` is the complete list (what a selection is validated
    against); ``physical`` is the hardware-backed subset the picker shows by
    default to stay uncluttered (empty when undetectable, e.g. non-Linux).
    """
    def gather():
        names = services.list_interfaces()
        return {"interfaces": names, "physical": services.physical_interfaces(names)}
    return await run_in_threadpool(gather)


@router.get("/listen/{family}")
async def get_listen(family: str, user: str = Depends(current_user)):
    service = _service(family)
    config = await kea_client.config_get(service)
    return {"interfaces": kea_config.get_interfaces(config, service)}


def _interfaces_in_file(path: str, interfaces: list[str]) -> bool | None:
    """Best-effort: confirm the saved config file actually contains the
    interface selection (answers "did it really reach the .conf?"). Returns
    None if the file can't be read (path unknown / no permission)."""
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    if interfaces == ["*"]:
        return '"*"' in text
    return all(f'"{i}"' in text for i in interfaces)


@router.put("/listen/{family}")
async def set_listen(family: str, body: InterfacesRequest,
                     user: str = Depends(current_user)):
    service = _service(family)
    available = await run_in_threadpool(services.list_interfaces)
    async with kea_client.config_lock(service):
        config = await kea_client.config_get(service)
        # Validated against the FULL host list plus whatever Kea already has
        # configured, so an active-but-currently-down interface still saves.
        current = kea_config.get_interfaces(config, service)
        interfaces = validate_interfaces(body.interfaces, available, current)
        kea_config.set_interfaces(config, service, interfaces)
        saved_to = await ops.apply_and_audit(
            service, config, user=user, action=f"{service}.interfaces.update",
            detail=", ".join(interfaces))
        # Read the running config straight back so the operator gets proof the
        # change is really in effect, not just that the request was accepted.
        after = await kea_client.config_get(service)
        persisted = kea_config.get_interfaces(after, service)
    confirmed = sorted(persisted) == sorted(interfaces)
    in_file = await run_in_threadpool(_interfaces_in_file, saved_to, interfaces)
    return {"interfaces": interfaces, "saved_to": saved_to,
            "persisted": persisted, "confirmed": confirmed, "in_file": in_file}


# --- troubleshooting probes --------------------------------------------------
# Each check is its own endpoint returning {ok, title, detail} so the Settings
# page can run them individually and show the raw backend answer next to each.

_DHCP_PORT = {kea_client.DHCP4: 67, kea_client.DHCP6: 547}


@router.get("/check/ca")
async def check_ca(user: str = Depends(current_user)):
    """Is the Kea Control Agent answering on its REST endpoint?"""
    try:
        version = await kea_client.ca_version()
    except kea_client.KeaError as exc:
        return {"ok": False, "title": "Control Agent",
                "detail": f"Not reachable: {exc.message}"}
    return {"ok": True, "title": "Control Agent",
            "detail": f"Reachable at {settings.kea_ca_url}\n{version}"}


@router.get("/check/socket/{family}")
async def check_socket(family: str, user: str = Depends(current_user)):
    """Is the DHCP server actually bound to its UDP port (67 v4 / 547 v6)?"""
    service = _service(family)
    port = _DHCP_PORT[service]
    ok, detail = await run_in_threadpool(services.socket_listening, port)
    return {"ok": ok, "title": f"{family} listening on UDP :{port}", "detail": detail}


@router.get("/check/interfaces")
async def check_interfaces(user: str = Depends(current_user)):
    """The interfaces each server is really bound to, read from its live config.

    This is the ground truth for "did my listen-interface change take effect?"
    -- it reads Kea's running configuration, not what the UI last sent.
    """
    result: dict = {}
    for service in (kea_client.DHCP4, kea_client.DHCP6):
        try:
            config = await kea_client.config_get(service)
            result[service] = {"ok": True, "interfaces": kea_config.get_interfaces(config, service)}
        except kea_client.KeaError as exc:
            result[service] = {"ok": False, "error": exc.message}
    return result


@router.get("/check/leasehook/{family}")
async def check_leasehook(family: str, user: str = Depends(current_user)):
    """Is the lease_cmds hook loaded? (Active Leases needs lease{4,6}-get-all.)"""
    service = _service(family)
    needed = "lease4-get-all" if service == kea_client.DHCP4 else "lease6-get-all"
    try:
        commands = await kea_client.list_commands(service)
    except kea_client.KeaError as exc:
        return {"ok": False, "title": f"{family} lease hook", "detail": exc.message}
    loaded = needed in commands
    return {"ok": loaded, "title": f"{family} lease hook",
            "detail": (f"lease_cmds hook is loaded ({needed} available)." if loaded
                       else f"{needed} is not available -- the lease_cmds hook is "
                            "not loaded, so Active Leases will be empty. Run "
                            "install/repair-kea.sh to inject it.")}


@router.get("/logs/{which}")
async def service_logs(which: str, lines: int = 120, user: str = Depends(current_user)):
    """Recent journal lines for a Kea unit (DHCPv4/DHCPv6/Control Agent)."""
    if which not in ("dhcp4", "dhcp6", "ctrl_agent"):
        raise HTTPException(status_code=400, detail=f"Unknown service '{which}'")
    unit = settings.service_unit(which)
    if not unit:
        raise HTTPException(status_code=400, detail=f"No unit configured for '{which}'")
    lines = max(20, min(lines, 500))
    text = await run_in_threadpool(services.journal_tail, unit, lines)
    return {"unit": unit, "lines": text}
