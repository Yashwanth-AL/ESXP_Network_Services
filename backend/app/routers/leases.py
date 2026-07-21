"""Active lease viewing and management (renew / release)."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from .. import audit, kea_client, services
from ..auth import current_user
from ..validation import ValidationError, parse_address

router = APIRouter(prefix="/api/leases", tags=["leases"])

_STATE_NAMES = {0: "active", 1: "declined", 2: "expired"}


def _iso(epoch: int | float | None) -> str | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()
    except (ValueError, OSError, OverflowError):
        return None


def _format_v4(lease: dict) -> dict:
    cltt = lease.get("cltt", 0)
    valid = lease.get("valid-lft", 0)
    return {
        "ip": lease.get("ip-address", ""),
        "identifier": lease.get("hw-address", ""),
        "identifier_type": "MAC",
        "hostname": lease.get("hostname", "") or "",
        "state": _STATE_NAMES.get(lease.get("state", 0), str(lease.get("state"))),
        "start": _iso(cltt),
        "expire": _iso(cltt + valid if cltt else None),
        "valid_lft": valid,
        "subnet_id": lease.get("subnet-id"),
    }


def _format_v6(lease: dict) -> dict:
    cltt = lease.get("cltt", 0)
    valid = lease.get("valid-lft", 0)
    return {
        "ip": lease.get("ip-address", ""),
        "identifier": lease.get("duid", ""),
        "identifier_type": "DUID",
        "hostname": lease.get("hostname", "") or "",
        "state": _STATE_NAMES.get(lease.get("state", 0), str(lease.get("state"))),
        "start": _iso(cltt),
        "expire": _iso(cltt + valid if cltt else None),
        "valid_lft": valid,
        "preferred_lft": lease.get("preferred-lft", 0),
        "subnet_id": lease.get("subnet-id"),
        "lease_type": lease.get("type", "IA_NA"),
        "iaid": lease.get("iaid"),
    }


async def _with_reachability(rows: list[dict], version: int) -> list[dict]:
    """Tag each lease with ``connected`` (reachable on the wire right now).

    Probing shells out (ping + ip neigh), so it runs in a worker thread to keep
    the event loop free. When probing is unavailable (non-Linux dev host) every
    lease comes back ``connected: False`` and the UI simply shows them all under
    "other leases".
    """
    ips = [r["ip"] for r in rows if r.get("ip")]
    connected = await run_in_threadpool(services.connected_ips, ips, version)
    for r in rows:
        r["connected"] = r.get("ip") in connected
    return rows


@router.get("/v4")
async def leases_v4(user: str = Depends(current_user)):
    leases = await kea_client.lease4_get_all()
    return await _with_reachability([_format_v4(l) for l in leases], 4)


@router.get("/v6")
async def leases_v6(user: str = Depends(current_user)):
    leases = await kea_client.lease6_get_all()
    return await _with_reachability([_format_v6(l) for l in leases], 6)


# --- release -----------------------------------------------------------------

async def _release(ips: list[str], version: int, delete, action: str, user: str) -> dict:
    # Release is a bulk, partial-success operation: a bad address is reported per
    # item (like a Kea failure) instead of 422-ing the whole batch, so one stale
    # row can't block releasing the other valid selections.
    released, errors = [], []
    for ip in ips:
        try:
            parse_address(ip, version)
            await delete(ip)
            released.append(ip)
        except ValidationError as exc:
            errors.append({"ip": ip, "error": str(exc)})
        except kea_client.KeaError as exc:
            errors.append({"ip": ip, "error": exc.message})
    await audit.arecord(user, "lease", action,
                        "success" if not errors else "failure",
                        f"released {len(released)}, {len(errors)} errors")
    return {"released": released, "errors": errors}


@router.post("/v4/release")
async def release_v4(ips: list[str] = Body(..., embed=True), user: str = Depends(current_user)):
    return await _release(ips, 4, kea_client.lease4_del, "dhcp4.release", user)


@router.post("/v6/release")
async def release_v6(ips: list[str] = Body(..., embed=True), user: str = Depends(current_user)):
    return await _release(ips, 6, kea_client.lease6_del, "dhcp6.release", user)


# --- renew (extend expiry from now) ------------------------------------------

@router.post("/v4/renew")
async def renew_v4(ip: str = Body(..., embed=True), user: str = Depends(current_user)):
    parse_address(ip, 4)
    lease = await kea_client.lease4_get(ip)
    if not lease:
        raise HTTPException(status_code=404, detail=f"Lease {ip} not found")
    valid = int(lease.get("valid-lft", 0)) or 3600
    payload = {
        "ip-address": lease["ip-address"],
        "hw-address": lease.get("hw-address"),
        "subnet-id": lease.get("subnet-id"),
        "valid-lft": valid,
        "expire": int(time.time()) + valid,
    }
    if lease.get("hostname"):
        payload["hostname"] = lease["hostname"]
    payload = {k: v for k, v in payload.items() if v is not None}
    await kea_client.lease4_update(payload)
    await audit.arecord(user, "lease", "dhcp4.renew", "success", ip)
    return {"ok": True, "ip": ip, "expire": _iso(payload["expire"])}


@router.post("/v6/renew")
async def renew_v6(ip: str = Body(..., embed=True), user: str = Depends(current_user)):
    parse_address(ip, 6)
    lease = await kea_client.lease6_get(ip)
    if not lease:
        raise HTTPException(status_code=404, detail=f"Lease {ip} not found")
    valid = int(lease.get("valid-lft", 0)) or 3600
    payload = {
        "ip-address": lease["ip-address"],
        "type": lease.get("type", "IA_NA"),
        "duid": lease.get("duid"),
        "iaid": lease.get("iaid"),
        "subnet-id": lease.get("subnet-id"),
        "valid-lft": valid,
        "preferred-lft": lease.get("preferred-lft", valid),
        "expire": int(time.time()) + valid,
    }
    if lease.get("hostname"):
        payload["hostname"] = lease["hostname"]
    payload = {k: v for k, v in payload.items() if v is not None}
    await kea_client.lease6_update(payload)
    await audit.arecord(user, "lease", "dhcp6.renew", "success", ip)
    return {"ok": True, "ip": ip, "expire": _iso(payload["expire"])}
