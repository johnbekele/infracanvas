"""Health endpoint.

The response shape matches the TypeScript API's `/health` so that both services
can sit behind one probe configuration rather than two.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from brain.db import ping
from brain.settings import Settings, load_settings

router = APIRouter()


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    database: Literal["up", "down"]


async def check_health(settings: Settings) -> HealthResponse:
    database_up = await ping(settings)
    return HealthResponse(
        status="ok" if database_up else "degraded",
        database="up" if database_up else "down",
    )


@router.get("/health", response_model=HealthResponse)
async def health(response: Response) -> HealthResponse:
    """Report readiness.

    A degraded result is a 503 rather than a 200 with a sad payload, because a
    load balancer reads the status code and nothing else.
    """
    result = await check_health(load_settings())
    if result.status != "ok":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return result
