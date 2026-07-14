"""DHCPv4 subnet and reservation management.

Every mutation follows the same safe pipeline: read the running config
(config-get), edit the in-memory copy, then validate + apply + persist
(config-test -> config-set -> config-write) via kea_client.apply_config.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import audit, kea_client, kea_config
from ..auth import current_user
from ..models import Reservation4Request, Subnet4Request
from ..validation import (
    ValidationError, address_in_network, normalize_cidr, validate_dns_servers,
    validate_hostname, validate_mac, validate_pool, validate_timers,
)

router = APIRouter(prefix="/api/dhcp4", tags=["dhcp4"])
SERVICE = kea_client.DHCP4


def _require_subnet(config, subnet_id: int):
    subnet = kea_config.find_subnet(config, SERVICE, subnet_id)
    if subnet is None:
        raise HTTPException(status_code=404, detail=f"Subnet id {subnet_id} not found")
    return subnet


def _validate_subnet_payload(body: Subnet4Request) -> dict:
    cidr = normalize_cidr(body.subnet, 4)
    validate_pool(body.pool_start, body.pool_end, cidr, 4)
    gateway = (body.gateway or "").strip()
    if gateway:
        address_in_network(gateway, cidr, 4)
    dns = validate_dns_servers(body.dns_servers, 4)
    validate_timers(body.valid_lifetime, body.renew_timer, body.rebind_timer)
    return {"cidr": cidr, "gateway": gateway, "dns": dns}


# --- subnets -----------------------------------------------------------------

@router.get("/subnets")
async def list_subnets(user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    return [kea_config.subnet4_to_api(s) for s in kea_config.subnet_list(config, SERVICE)]


@router.post("/subnets", status_code=201)
async def create_subnet(body: Subnet4Request, user: str = Depends(current_user)):
    v = _validate_subnet_payload(body)
    config = await kea_client.config_get(SERVICE)
    for existing in kea_config.subnet_list(config, SERVICE):
        if existing.get("subnet") == v["cidr"]:
            raise HTTPException(status_code=409, detail=f"Subnet {v['cidr']} already exists")
    subnet = {"id": kea_config.next_subnet_id(config, SERVICE)}
    kea_config.write_subnet4(
        subnet, cidr=v["cidr"], pool_start=body.pool_start, pool_end=body.pool_end,
        gateway=v["gateway"], dns_servers=v["dns"], valid_lifetime=body.valid_lifetime,
        renew_timer=body.renew_timer, rebind_timer=body.rebind_timer,
    )
    kea_config.subnet_list(config, SERVICE).append(subnet)
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp4.subnet.create", "success", v["cidr"])
    return kea_config.subnet4_to_api(subnet)


@router.put("/subnets/{subnet_id}")
async def update_subnet(subnet_id: int, body: Subnet4Request, user: str = Depends(current_user)):
    v = _validate_subnet_payload(body)
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    for existing in kea_config.subnet_list(config, SERVICE):
        if existing.get("id") != subnet_id and existing.get("subnet") == v["cidr"]:
            raise HTTPException(status_code=409, detail=f"Subnet {v['cidr']} already exists")
    kea_config.write_subnet4(
        subnet, cidr=v["cidr"], pool_start=body.pool_start, pool_end=body.pool_end,
        gateway=v["gateway"], dns_servers=v["dns"], valid_lifetime=body.valid_lifetime,
        renew_timer=body.renew_timer, rebind_timer=body.rebind_timer,
    )
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp4.subnet.update", "success", v["cidr"])
    return kea_config.subnet4_to_api(subnet)


@router.delete("/subnets/{subnet_id}")
async def delete_subnet(subnet_id: int, user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    cidr = subnet.get("subnet", "")
    subnets = kea_config.subnet_list(config, SERVICE)
    subnets[:] = [s for s in subnets if s.get("id") != subnet_id]
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp4.subnet.delete", "success", cidr)
    return {"ok": True}


# --- reservations ------------------------------------------------------------

@router.get("/subnets/{subnet_id}/reservations")
async def list_reservations(subnet_id: int, user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    return [kea_config.reservation4_to_api(r) for r in subnet.get("reservations", [])]


@router.post("/subnets/{subnet_id}/reservations", status_code=201)
async def add_reservation(subnet_id: int, body: Reservation4Request,
                          user: str = Depends(current_user)):
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    mac = validate_mac(body.mac)
    address_in_network(body.ip, subnet["subnet"], 4)
    hostname = validate_hostname(body.hostname)
    reservations = subnet.setdefault("reservations", [])
    for r in reservations:
        if r.get("hw-address", "").lower() == mac:
            raise HTTPException(status_code=409, detail=f"MAC {mac} already reserved")
        if r.get("ip-address") == body.ip:
            raise HTTPException(status_code=409, detail=f"IP {body.ip} already reserved")
    new_res = kea_config.build_reservation4(mac, body.ip, hostname)
    reservations.append(new_res)
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp4.reservation.create", "success", f"{mac} -> {body.ip}")
    return kea_config.reservation4_to_api(new_res)


@router.put("/subnets/{subnet_id}/reservations/{mac}")
async def update_reservation(subnet_id: int, mac: str, body: Reservation4Request,
                             user: str = Depends(current_user)):
    key = validate_mac(mac)
    new_mac = validate_mac(body.mac)
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    address_in_network(body.ip, subnet["subnet"], 4)
    hostname = validate_hostname(body.hostname)
    reservations = subnet.get("reservations", [])
    target = next((r for r in reservations if r.get("hw-address", "").lower() == key), None)
    if target is None:
        raise HTTPException(status_code=404, detail=f"Reservation {mac} not found")
    for r in reservations:
        if r is target:
            continue
        if r.get("hw-address", "").lower() == new_mac:
            raise HTTPException(status_code=409, detail=f"MAC {new_mac} already reserved")
        if r.get("ip-address") == body.ip:
            raise HTTPException(status_code=409, detail=f"IP {body.ip} already reserved")
    target.clear()
    target.update(kea_config.build_reservation4(new_mac, body.ip, hostname))
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp4.reservation.update", "success", f"{new_mac} -> {body.ip}")
    return kea_config.reservation4_to_api(target)


@router.delete("/subnets/{subnet_id}/reservations/{mac}")
async def delete_reservation(subnet_id: int, mac: str, user: str = Depends(current_user)):
    key = validate_mac(mac)
    config = await kea_client.config_get(SERVICE)
    subnet = _require_subnet(config, subnet_id)
    reservations = subnet.get("reservations", [])
    new_list = [r for r in reservations if r.get("hw-address", "").lower() != key]
    if len(new_list) == len(reservations):
        raise HTTPException(status_code=404, detail=f"Reservation {mac} not found")
    subnet["reservations"] = new_list
    await kea_client.apply_config(SERVICE, config)
    audit.record(user, "config", "dhcp4.reservation.delete", "success", key)
    return {"ok": True}
