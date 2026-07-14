"""Explicit "Verify configuration" and "Save configuration" actions.

Subnet/reservation edits already validate + apply + persist automatically, so
these endpoints give the operator an on-demand way to re-validate the running
configuration (config-test) and to force a write to disk (config-write).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import audit, kea_client
from ..auth import current_user

router = APIRouter(prefix="/api/config", tags=["config"])

_SERVICES = {"dhcp4": kea_client.DHCP4, "dhcp6": kea_client.DHCP6}


def _resolve(service: str) -> str:
    svc = _SERVICES.get(service)
    if not svc:
        raise HTTPException(status_code=400, detail=f"Unknown service '{service}'")
    return svc


@router.post("/{service}/verify")
async def verify(service: str, user: str = Depends(current_user)):
    svc = _resolve(service)
    try:
        config = await kea_client.config_get(svc)
        await kea_client.config_test(svc, config)
    except kea_client.KeaError as exc:
        audit.record(user, "config", f"{service}.verify", "failure", exc.message)
        return {"ok": False, "message": exc.message}
    audit.record(user, "config", f"{service}.verify", "success")
    return {"ok": True, "message": "Configuration is valid"}


@router.post("/{service}/save")
async def save(service: str, user: str = Depends(current_user)):
    svc = _resolve(service)
    try:
        config = await kea_client.config_get(svc)
        # Validate first, then re-apply and persist to disk.
        await kea_client.config_test(svc, config)
        await kea_client.config_set(svc, config)
        filename = await kea_client.config_write(svc)
    except kea_client.KeaError as exc:
        audit.record(user, "config", f"{service}.save", "failure", exc.message)
        return {"ok": False, "message": exc.message}
    audit.record(user, "config", f"{service}.save", "success", filename)
    return {"ok": True, "message": f"Configuration saved to {filename}" if filename
            else "Configuration saved"}
