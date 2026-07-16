"""Service control, server status, health, and audit-log surfacing."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from .. import audit, kea_client, kea_config, ops, services
from ..auth import current_user
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
    return {"interfaces": interfaces, "saved_to": saved_to}
