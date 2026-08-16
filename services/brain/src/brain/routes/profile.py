"""POST /profile: enrich a deterministic AppProfile with cited agent findings."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from brain.db import open_pool
from brain.llm.credentials import load_default_credential
from brain.llm.providers import build_model
from brain.profile.agent import ReasoningSettings, build_profile
from brain.profile.judge import Judge
from brain.profile.models import AppProfileInput, VerifiedAppProfile
from brain.profile.tools import ProfileDeps
from brain.profile.verifier import PoolSpanReader, UnsupportedClaimError, verify_profile
from brain.settings import load_settings

router = APIRouter()


class ProfileRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    repository_id: UUID
    run_id: UUID


class ProfileResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    profile: VerifiedAppProfile


class UnusableProfileError(ValueError):
    """The agent produced nothing that can be turned into a profile."""


@router.post("/profile", response_model=ProfileResponse)
async def create_profile(
    body: ProfileRequest,
    x_user_id: Annotated[UUID, Header(alias="X-User-Id")],
    reasoning_scale: Annotated[str, Header(alias="X-Reasoning-Scale")] = "balanced",
) -> ProfileResponse:
    """Enrich the deterministic profile for one ingestion run.

    Ownership failures are 404 rather than 403 so the existence of another
    user's run is not confirmed.
    """
    del reasoning_scale  # Scale mapping lands with issue 030; defaults apply.
    settings = load_settings()
    pool = await open_pool(settings)

    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT ir.commit_sha, ir.ref, a.profile AS deterministic_profile
            FROM ingestion_runs ir
            JOIN repositories r ON r.id = ir.repository_id
            LEFT JOIN LATERAL (
                SELECT profile
                FROM analyses
                WHERE repository_id = ir.repository_id
                  AND status = 'succeeded'
                  AND profile IS NOT NULL
                ORDER BY finished_at DESC NULLS LAST, created_at DESC
                LIMIT 1
            ) a ON TRUE
            WHERE ir.id = %(run_id)s
              AND ir.repository_id = %(repository_id)s
              AND r.user_id = %(user_id)s
            """,
            {
                "run_id": body.run_id,
                "repository_id": body.repository_id,
                "user_id": x_user_id,
            },
        )
        row = await cursor.fetchone()

    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")

    commit_sha, ref, deterministic_raw = row
    if deterministic_raw is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No deterministic profile is available for this repository",
        )

    try:
        deterministic = AppProfileInput.model_validate(deterministic_raw)
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Deterministic profile is not usable",
        ) from error

    # Prefer the ingestion run's commit/ref so the cited profile describes the
    # snapshot the tools will read, even if the stored analysis is slightly older.
    deterministic = deterministic.model_copy(
        update={"commit_sha": str(commit_sha), "ref": str(ref)}
    )

    try:
        credential = await load_default_credential(x_user_id, settings)
        model = build_model(credential, settings)
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No usable model credential is configured",
        ) from error

    deps = ProfileDeps(
        repository_id=body.repository_id,
        run_id=body.run_id,
        pool=pool,
    )
    reasoning = ReasoningSettings(max_tokens=2048)

    try:
        profile = await build_profile(deterministic, deps, model, reasoning)
    except UnusableProfileError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error

    if not profile.components and not profile.dependencies:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The agent produced nothing usable",
        )

    reader = PoolSpanReader(
        repository_id=body.repository_id,
        run_id=body.run_id,
        pool=pool,
    )
    judge = Judge(model)

    try:
        verified = await verify_profile(profile, reader, judge)
    except UnsupportedClaimError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(error),
        ) from error

    return ProfileResponse(profile=verified)
