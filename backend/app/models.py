"""Pydantic request models for the API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=6)


class Subnet4Request(BaseModel):
    subnet: str
    pool_start: str
    pool_end: str
    gateway: str | None = ""
    dns_servers: list[str] = Field(default_factory=list)
    valid_lifetime: int = 4000
    renew_timer: int = 1000
    rebind_timer: int = 2000


class Reservation4Request(BaseModel):
    mac: str
    ip: str
    hostname: str | None = ""


class Subnet6Request(BaseModel):
    subnet: str
    pool_start: str
    pool_end: str
    dns_servers: list[str] = Field(default_factory=list)
    preferred_lifetime: int = 3000
    valid_lifetime: int = 4000
    renew_timer: int = 1000
    rebind_timer: int = 2000


class Reservation6Request(BaseModel):
    duid: str
    ip: str
    hostname: str | None = ""


class InterfacesRequest(BaseModel):
    interfaces: list[str] = Field(default_factory=list)
