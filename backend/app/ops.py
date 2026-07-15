"""Shared config-mutation helpers for the DHCPv4/DHCPv6 routers.

Keeping the apply+audit and lease-cleanup logic here (rather than copy-pasted
into both routers) is what stops the two address families from drifting apart.
"""
from __future__ import annotations

from . import audit, kea_client


async def apply_and_audit(service: str, config: dict, *, user: str, action: str,
                          detail: str) -> None:
    """Apply a candidate config, recording the outcome either way.

    Mirrors the pattern already used in routers/system.py: a *failure* has to
    leave an audit trail too. Without this, a config-write error -- which leaves
    the change live in Kea but unpersisted -- would surface as a 502 and vanish
    from the audit log entirely, so nobody could tell the change had happened.
    """
    try:
        await kea_client.apply_config(service, config)
    except kea_client.KeaError as exc:
        await audit.arecord(user, "config", action, "failure", exc.message)
        raise
    await audit.arecord(user, "config", action, "success", detail)


async def wipe_subnet_leases(service: str, subnet_id: int, *, user: str,
                             action: str) -> None:
    """Best-effort removal of the leases belonging to a subnet being deleted.

    Subnet ids are allocated as ``max(existing) + 1``, so a deleted id is handed
    straight back out to the next subnet created. Without this cleanup that new
    subnet inherits the old one's leases in Kea's lease database and allocation
    engine, even though it may be a completely different CIDR.

    Failures are audited but never block the delete the operator asked for --
    lease-wipe needs the lease_cmds hook, which may not be loaded.
    """
    wipe = kea_client.lease4_wipe if service == kea_client.DHCP4 else kea_client.lease6_wipe
    try:
        await wipe(subnet_id)
    except kea_client.KeaError as exc:
        await audit.arecord(user, "config", action, "failure",
                            f"subnet {subnet_id} leases could not be wiped: {exc.message}")
