"""Authentication endpoints: login, logout, whoami, change password."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from .. import audit, auth
from ..models import ChangePasswordRequest, LoginRequest

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginRequest, request: Request):
    user = auth.authenticate(body.username, body.password)
    if not user:
        audit.record(body.username, "auth", "login", "failure", "invalid credentials")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password"
        )
    request.session["user"] = user["username"]
    audit.record(user["username"], "auth", "login", "success")
    return {
        "username": user["username"],
        "must_change_password": bool(user["must_change_pw"]),
    }


@router.post("/logout")
def logout(request: Request):
    username = request.session.get("user")
    request.session.clear()
    if username:
        audit.record(username, "auth", "logout", "success")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    username = request.session.get("user")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user = auth.get_user(username)
    if not user:
        request.session.clear()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return {
        "username": user["username"],
        "must_change_password": bool(user["must_change_pw"]),
    }


@router.post("/change-password")
def change_password(body: ChangePasswordRequest, request: Request):
    username = request.session.get("user")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user = auth.authenticate(username, body.current_password)
    if not user:
        audit.record(username, "auth", "change-password", "failure", "wrong current password")
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    auth.set_password(username, body.new_password)
    audit.record(username, "auth", "change-password", "success")
    return {"ok": True}
