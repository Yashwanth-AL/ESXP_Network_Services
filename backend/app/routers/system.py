"""Service control, server status, health, and audit-log surfacing."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from .. import audit, kea_client, services
from ..auth import current_user

router = APIRouter(prefix="/api/system", tags=["system"])


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
    for name in ("dhcp4", "dhcp6"):
        info = await kea_client.status_get(name)
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
