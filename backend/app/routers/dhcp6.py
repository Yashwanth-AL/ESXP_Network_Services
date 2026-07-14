"""DHCPv6 subnet and reservation management (mirrors dhcp4.py for IPv6)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import audit, kea_client, kea_config
from ..auth import current_user
from ..models import Reservation6Request, Subnet6Request
from ..validation import (
    address_in_network, normalize_cidr, validate_dns_servers, validate_duid,
    validate_hostname, validate_pool, validate_timers,
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
    if body.preferred_lifetime < 0:
        raise HTTPException(status_code=422, detail="Preferred lifetime must be non-negative")
    if body.valid_lifetime and body.preferred_lifetime > body.valid_lifetime:
        raise HTTPException(
            status_code=422, detail="Preferred lifetime must not exceed valid lifetime"
        )
    return {"cidr": cidr, "dns": dns}


# --- subnets -----------------------------------------------------------------

@router.get("/subnets")
async def list_subnets(user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    return [kea_config.subnet6_to_api(s) for s in kea_config.subnet_list(config, SERVICE)]


@router.post("/subnets", status_code=201)
async def create_subnet(body: Subnet6Request, user: str = Depends(current_user)):
    v = _validate_subnet_payload(body)
    config = await kea_client.config_get(SERVICE)
    for existing in kea_config.subnet_list(config, SERVICE):
        if existing.get("subnet") == v["cidr"]:
            raise HTTPException(status_code=409, detail=f"Subnet {v['cidr']} already exists")
    subnet = {"id": kea_config.next_subnet_id(config, SERVICE)}
    kea_config.write_subnet6(
        subnet, cidr=v["cidr"], pool_start=body.pool_start, pool_end=body.pool_end,
        dns_servers=v["dns"], preferred_lifetime=body.preferred_lifetime,
        valid_lifetime=body.valid_lifetime, renew_timer=body.renew_timer,
        rebind_timer=body.rebind_timer,
    )
    kea_config.subnet_list(config, SERVICE).append(subnet)
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp6.subnet.create", "success", v["cidr"])
    return kea_config.subnet6_to_api(subnet)


@router.put("/subnets/{subnet_id}")
async def update_subnet(subnet_id: int, body: Subnet6Request, user: str = Depends(current_user)):
    v = _validate_subnet_payload(body)
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    for existing in kea_config.subnet_list(config, SERVICE):
        if existing.get("id") != subnet_id and existing.get("subnet") == v["cidr"]:
            raise HTTPException(status_code=409, detail=f"Subnet {v['cidr']} already exists")
    kea_config.write_subnet6(
        subnet, cidr=v["cidr"], pool_start=body.pool_start, pool_end=body.pool_end,
        dns_servers=v["dns"], preferred_lifetime=body.preferred_lifetime,
        valid_lifetime=body.valid_lifetime, renew_timer=body.renew_timer,
        rebind_timer=body.rebind_timer,
    )
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp6.subnet.update", "success", v["cidr"])
    return kea_config.subnet6_to_api(subnet)


@router.delete("/subnets/{subnet_id}")
async def delete_subnet(subnet_id: int, user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    cidr = subnet.get("subnet", "")
    subnets = kea_config.subnet_list(config, SERVICE)
    subnets[:] = [s for s in subnets if s.get("id") != subnet_id]
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp6.subnet.delete", "success", cidr)
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
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp6.reservation.create", "success", f"{duid} -> {body.ip}")
    return kea_config.reservation6_to_api(new_res)


@router.put("/subnets/{subnet_id}/reservations/{duid}")
async def update_reservation(subnet_id: int, duid: str, body: Reservation6Request,
                             user: str = Depends(current_user)):
    key = validate_duid(duid)
    new_duid = validate_duid(body.duid)
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
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp6.reservation.update", "success", f"{new_duid} -> {body.ip}")
    return kea_config.reservation6_to_api(target)


@router.delete("/subnets/{subnet_id}/reservations/{duid}")
async def delete_reservation(subnet_id: int, duid: str, user: str = Depends(current_user)):
    key = validate_duid(duid)
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    reservations = subnet.get("reservations", [])
    new_list = [r for r in reservations if r.get("duid", "").lower() != key]
    if len(new_list) == len(reservations):
        raise HTTPException(status_code=404, detail=f"Reservation {duid} not found")
    subnet["reservations"] = new_list
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp6.reservation.delete", "success", key)
    return {"ok": True}
