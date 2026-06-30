"""FastAPI application entry point."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.invites import router as invites_router
from app.api.sessions import router as sessions_router
from app.api.version import router as version_router
from app.core.config import settings

app = FastAPI(
    title="Split Bill Calculator API",
    version="0.1.0",
    description="Multi-user, multi-session split-bill calculator (v0.1-dev).",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# CORS — v0.1 dev: allow localhost dev server origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
# NOTE on prefixes: the dev proxy (vite.config.ts) strips /api from
# incoming requests, so backend routers live at the URL the SPEC names
# without the /api prefix. The frontend always talks to /api/....
app.include_router(auth_router)
app.include_router(sessions_router)
app.include_router(invites_router)
app.include_router(version_router)


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe. Returns {"status": "ok"} when the process is up."""
    return {"status": "ok"}


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "split-bill-calculator",
        "version": "0.1.0",
        "docs": "/api/docs",
    }
