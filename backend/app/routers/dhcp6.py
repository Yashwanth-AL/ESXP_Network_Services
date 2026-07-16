"""DHCPv6 subnet and reservation management (mirrors dhcp4.py for IPv6)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import audit, kea_client, kea_config, ops
from ..auth import current_user
from ..models import Reservation6Request, Subnet6Request
from ..validation import (
    ValidationError, address_in_network, normalize_cidr, validate_dns_servers,
    validate_duid, validate_hostname, validate_pool, validate_timers,
)

router = APIRouter(prefix="/api/dhcp6", tags=["dhcp6"])
SERVICE = kea_client.DHCP6


def _require_subnet(config, subnet_id: int):
    subnet = kea_config.find_subnet(config, SERVICE, subnet_id)
    if subnet is None:
        raise HTTPException(status_code=404, detail=f"Subnet id {subnet_id} not found")
    return subnet


def _validate_subnet_payload(body: Subnet6Request) -> dict:
    cidr = normalize_cidr(body.subnet, 6)
    validate_pool(body.pool_start, body.pool_end, cidr, 6)
    dns = validate_dns_servers(body.dns_servers, 6)
    validate_timers(body.valid_lifetime, body.renew_timer, body.rebind_timer)
    # Raise ValidationError (-> 422 via main.py) rather than HTTPException so
    # v6 reports field problems exactly the way v4 does.
    if body.preferred_lifetime < 0:
        raise ValidationError("Preferred lifetime must be non-negative")
    if body.valid_lifetime and body.preferred_lifetime > body.valid_lifetime:
        raise ValidationError("Preferred lifetime must not exceed valid lifetime")
    return {"cidr": cidr, "dns": dns}


async def _build_candidate(body: Subnet6Request, subnet_id: int | None):
    """Fetch the running config and apply ``body`` to it in-memory, without
    calling Kea yet. Shared by the real create/update endpoints and the
    verify (dry-run) endpoints so a "valid" verdict always reflects exactly
    what would be applied.
    """
    v = _validate_subnet_payload(body)
    config = await kea_client.config_get(SERVICE)
    subnets = kea_config.subnet_list(config, SERVICE)
    for existing in subnets:
        if existing.get("id") != subnet_id and existing.get("subnet") == v["cidr"]:
            raise HTTPException(status_code=409, detail=f"Subnet {v['cidr']} already exists")
    if subnet_id is None:
        subnet = {"id": kea_config.next_subnet_id(config, SERVICE)}
        subnets.append(subnet)
    else:
        subnet = _require_subnet(config, subnet_id)
    kea_config.write_subnet6(
        subnet, cidr=v["cidr"], pool_start=body.pool_start, pool_end=body.pool_end,
        dns_servers=v["dns"], preferred_lifetime=body.preferred_lifetime,
        valid_lifetime=body.valid_lifetime, renew_timer=body.renew_timer,
        rebind_timer=body.rebind_timer,
    )
    return config, subnet, v


# --- subnets -----------------------------------------------------------------

@router.get("/subnets")
async def list_subnets(user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    return [kea_config.subnet6_to_api(s) for s in kea_config.subnet_list(config, SERVICE)]


@router.post("/subnets", status_code=201)
async def create_subnet(body: Subnet6Request, user: str = Depends(current_user)):
    async with kea_client.config_lock(SERVICE):
        config, subnet, v = await _build_candidate(body, None)
        saved_to = await ops.apply_and_audit(SERVICE, config, user=user,
                                             action="dhcp6.subnet.create", detail=v["cidr"])
        return {**kea_config.subnet6_to_api(subnet), "saved_to": saved_to}


@router.put("/subnets/{subnet_id}")
async def update_subnet(subnet_id: int, body: Subnet6Request, user: str = Depends(current_user)):
    async with kea_client.config_lock(SERVICE):
        config, subnet, v = await _build_candidate(body, subnet_id)
        saved_to = await ops.apply_and_audit(SERVICE, config, user=user,
                                             action="dhcp6.subnet.update", detail=v["cidr"])
        return {**kea_config.subnet6_to_api(subnet), "saved_to": saved_to}


@router.post("/subnets/verify")
async def verify_new_subnet(body: Subnet6Request, user: str = Depends(current_user)):
    """Dry-run: validate a candidate NEW subnet against Kea without applying it."""
    config, _subnet, v = await _build_candidate(body, None)
    try:
        await kea_client.config_test(SERVICE, config)
    except kea_client.KeaError as exc:
        await audit.arecord(user, "config", "dhcp6.subnet.verify", "failure", exc.message)
        return {"ok": False, "message": exc.message}
    await audit.arecord(user, "config", "dhcp6.subnet.verify", "success", v["cidr"])
    return {"ok": True, "message": "Configuration is valid."}


@router.post("/subnets/{subnet_id}/verify")
async def verify_existing_subnet(subnet_id: int, body: Subnet6Request,
                                 user: str = Depends(current_user)):
    """Dry-run: validate a candidate EDIT to an existing subnet, without applying it."""
    config, _subnet, v = await _build_candidate(body, subnet_id)
    try:
        await kea_client.config_test(SERVICE, config)
    except kea_client.KeaError as exc:
        await audit.arecord(user, "config", "dhcp6.subnet.verify", "failure", exc.message)
        return {"ok": False, "message": exc.message}
    await audit.arecord(user, "config", "dhcp6.subnet.verify", "success", v["cidr"])
    return {"ok": True, "message": "Configuration is valid."}


@router.delete("/subnets/{subnet_id}")
async def delete_subnet(subnet_id: int, user: str = Depends(current_user)):
    async with kea_client.config_lock(SERVICE):
        config = await kea_client.config_get(SERVICE)
        subnet = _require_subnet(config, subnet_id)
        cidr = subnet.get("subnet", "")
        # Drop this subnet's leases before its id can be recycled by the next
        # subnet created (best-effort; never blocks the delete).
        await ops.wipe_subnet_leases(SERVICE, subnet_id, user=user)
        subnets = kea_config.subnet_list(config, SERVICE)
        subnets[:] = [s for s in subnets if s.get("id") != subnet_id]
        await ops.apply_and_audit(SERVICE, config, user=user,
                                  action="dhcp6.subnet.delete", detail=cidr)
        return {"ok": True}


# --- reservations ------------------------------------------------------------

@router.get("/subnets/{subnet_id}/reservations")
async def list_reservations(subnet_id: int, user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    return [kea_config.reservation6_to_api(r) for r in subnet.get("reservations", [])]


@router.post("/subnets/{subnet_id}/reservations", status_code=201)
async def add_reservation(subnet_id: int, body: Reservation6Request,
                          user: str = Depends(current_user)):
    async with kea_client.config_lock(SERVICE):
        config = await kea_client.config_get(SERVICE)
        subnet = _require_subnet(config, subnet_id)
        duid = validate_duid(body.duid)
        address_in_network(body.ip, subnet["subnet"], 6)
        hostname = validate_hostname(body.hostname)
        reservations = subnet.setdefault("reservations", [])
        for r in reservations:
            if r.get("duid", "").lower() == duid:
                raise HTTPException(status_code=409, detail=f"DUID {duid} already reserved")
            if body.ip in r.get("ip-addresses", []):
                raise HTTPException(status_code=409, detail=f"IP {body.ip} already reserved")
        new_res = kea_config.build_reservation6(duid, body.ip, hostname)
        reservations.append(new_res)
        await ops.apply_and_audit(SERVICE, config, user=user,
                                  action="dhcp6.reservation.create",
                                  detail=f"{duid} -> {body.ip}")
        return kea_config.reservation6_to_api(new_res)


@router.put("/subnets/{subnet_id}/reservations/{duid}")
async def update_reservation(subnet_id: int, duid: str, body: Reservation6Request,
                             user: str = Depends(current_user)):
    key = validate_duid(duid)
    new_duid = validate_duid(body.duid)
    async with kea_client.config_lock(SERVICE):
        config = await kea_client.config_get(SERVICE)
        subnet = _require_subnet(config, subnet_id)
        address_in_network(body.ip, subnet["subnet"], 6)
        hostname = validate_hostname(body.hostname)
        reservations = subnet.get("reservations", [])
        target = next((r for r in reservations if r.get("duid", "").lower() == key), None)
        if target is None:
            raise HTTPException(status_code=404, detail=f"Reservation {duid} not found")
        for r in reservations:
            if r is target:
                continue
            if r.get("duid", "").lower() == new_duid:
                raise HTTPException(status_code=409, detail=f"DUID {new_duid} already reserved")
            if body.ip in r.get("ip-addresses", []):
                raise HTTPException(status_code=409, detail=f"IP {body.ip} already reserved")
        target.clear()
        target.update(kea_config.build_reservation6(new_duid, body.ip, hostname))
        await ops.apply_and_audit(SERVICE, config, user=user,
                                  action="dhcp6.reservation.update",
                                  detail=f"{new_duid} -> {body.ip}")
        return kea_config.reservation6_to_api(target)


@router.delete("/subnets/{subnet_id}/reservations/{duid}")
async def delete_reservation(subnet_id: int, duid: str, user: str = Depends(current_user)):
    key = validate_duid(duid)
    async with kea_client.config_lock(SERVICE):
        config = await kea_client.config_get(SERVICE)
        subnet = _require_subnet(config, subnet_id)
        reservations = subnet.get("reservations", [])
        new_list = [r for r in reservations if r.get("duid", "").lower() != key]
        if len(new_list) == len(reservations):
            raise HTTPException(status_code=404, detail=f"Reservation {duid} not found")
        subnet["reservations"] = new_list
        await ops.apply_and_audit(SERVICE, config, user=user,
                                  action="dhcp6.reservation.delete", detail=key)
        return {"ok": True}
