"""FastAPI application entrypoint.

Serves the JSON API under ``/api`` and the static single-page frontend at ``/``.
The SPA uses hash-based routing, so the server only ever needs to serve
``index.html`` at the root plus static assets.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import __version__
from .config import settings
from .database import init_db
from .kea_client import KeaError
from .services import ServiceError
from .validation import ValidationError
from .routers import auth, config as config_router, dhcp4, dhcp6, leases, system

logger = logging.getLogger("esxp")

app = FastAPI(title="ESXP Network Services", version=__version__)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    max_age=settings.session_max_age,
    session_cookie=settings.session_cookie,
    same_site="lax",
    https_only=False,
)


@app.on_event("startup")
def _startup() -> None:
    init_db()
    logger.info("ESXP Network Services %s started", __version__)


# --- error handling ----------------------------------------------------------
# Turn internal exceptions into clean JSON so the frontend can toast the message
# instead of the operator ever seeing a stack trace or reading a log file.

@app.exception_handler(ValidationError)
async def _validation_handler(request: Request, exc: ValidationError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(KeaError)
async def _kea_handler(request: Request, exc: KeaError):
    return JSONResponse(status_code=502, content={"detail": exc.message})


@app.exception_handler(ServiceError)
async def _service_handler(request: Request, exc: ServiceError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


# --- routers -----------------------------------------------------------------

app.include_router(auth.router)
app.include_router(dhcp4.router)
app.include_router(dhcp6.router)
app.include_router(leases.router)
app.include_router(config_router.router)
app.include_router(system.router)


# --- static frontend ---------------------------------------------------------

if settings.frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(settings.frontend_dir), html=True), name="frontend")
else:  # pragma: no cover - only in a misconfigured deployment
    @app.get("/")
    async def _missing_frontend():
        return JSONResponse(
            status_code=500,
            content={"detail": f"Frontend directory not found: {settings.frontend_dir}"},
        )
