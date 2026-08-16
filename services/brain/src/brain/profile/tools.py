"""Repository read tools for the AppProfile agent.

Reads come from the `files` and `chunks` tables for one ingestion run. Every
span a tool actually returns is appended to `ProfileDeps.reads`; the agent
cannot write that list, which is what makes citation checks mechanical.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath
from uuid import UUID

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from pydantic_ai import RunContext

from brain.profile.models import Citation

MAX_SPAN_LINES = 200
MAX_READS = 60


class ProfileToolError(Exception):
    """A tool failure the model can see and react to."""


@dataclass
class ProfileDeps:
    repository_id: UUID
    run_id: UUID
    pool: AsyncConnectionPool
    # Every span a tool actually returned, appended by the tool layer. The
    # agent cannot write to this, which is the whole point.
    reads: list[Citation] = field(default_factory=list)


class FileEntry(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    path: str
    language: str
    size_bytes: int


class SpanText(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    path: str
    start_line: int
    end_line: int
    text: str
    file_sha256: str


def _budget_remaining(deps: ProfileDeps) -> int:
    return MAX_READS - len(deps.reads)


def _require_budget(deps: ProfileDeps) -> None:
    if _budget_remaining(deps) <= 0:
        raise ProfileToolError(
            f"Read budget exhausted ({MAX_READS} spans). Finish with what you have."
        )


def _path_matches(path: str, pattern: str) -> bool:
    pure = PurePosixPath(path)
    if pure.match(pattern):
        return True
    # Allow bare patterns like `*.py` to match any depth.
    return pure.name == pattern or PurePosixPath(pure.name).match(pattern)


async def list_files(ctx: RunContext[ProfileDeps], path_glob: str) -> list[FileEntry]:
    """List files in the run whose paths match a glob."""
    deps = ctx.deps
    async with deps.pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT path, language, size_bytes
                FROM files
                WHERE repository_id = %(repository_id)s
                  AND run_id = %(run_id)s
                ORDER BY path
                """,
                {"repository_id": deps.repository_id, "run_id": deps.run_id},
            )
            rows = await cur.fetchall()

    return [
        FileEntry(path=row["path"], language=row["language"], size_bytes=row["size_bytes"])
        for row in rows
        if _path_matches(str(row["path"]), path_glob)
    ]


async def read_span(
    ctx: RunContext[ProfileDeps], path: str, start_line: int, end_line: int
) -> SpanText:
    """Return one inclusive line range from a file in the run."""
    deps = ctx.deps
    _require_budget(deps)

    if start_line < 1 or end_line < start_line:
        raise ProfileToolError(
            f"Invalid line range {start_line}-{end_line}: start must be >= 1 and "
            f"end must be >= start."
        )

    span_lines = end_line - start_line + 1
    if span_lines > MAX_SPAN_LINES:
        raise ProfileToolError(
            f"Span {start_line}-{end_line} is {span_lines} lines; the maximum is "
            f"{MAX_SPAN_LINES}. Narrow the range rather than truncating."
        )

    async with deps.pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT id, sha256
                FROM files
                WHERE repository_id = %(repository_id)s
                  AND run_id = %(run_id)s
                  AND path = %(path)s
                """,
                {
                    "repository_id": deps.repository_id,
                    "run_id": deps.run_id,
                    "path": path,
                },
            )
            file_row = await cur.fetchone()
            if file_row is None:
                raise ProfileToolError(
                    f"Path {path!r} is not in this ingestion run; refuse to read it."
                )

            file_id = file_row["id"]
            file_sha256 = str(file_row["sha256"])

            await cur.execute(
                """
                SELECT start_line, end_line, content
                FROM chunks
                WHERE file_id = %(file_id)s
                  AND start_line <= %(end_line)s
                  AND end_line >= %(start_line)s
                ORDER BY start_line
                """,
                {
                    "file_id": file_id,
                    "start_line": start_line,
                    "end_line": end_line,
                },
            )
            chunk_rows = await cur.fetchall()

    lines: dict[int, str] = {}
    for chunk in chunk_rows:
        chunk_start = int(chunk["start_line"])
        content_lines = str(chunk["content"]).splitlines()
        for offset, line in enumerate(content_lines):
            line_no = chunk_start + offset
            if start_line <= line_no <= end_line:
                lines[line_no] = line

    ordered = [lines.get(n, "") for n in range(start_line, end_line + 1)]
    text = "\n".join(ordered)

    citation = Citation(
        path=path,
        start_line=start_line,
        end_line=end_line,
        file_sha256=file_sha256,
    )
    deps.reads.append(citation)

    return SpanText(
        path=path,
        start_line=start_line,
        end_line=end_line,
        text=text,
        file_sha256=file_sha256,
    )


async def search_text(
    ctx: RunContext[ProfileDeps], pattern: str, limit: int = 20
) -> list[Citation]:
    """Full-text search over chunk content for this run."""
    deps = ctx.deps
    _require_budget(deps)

    if limit < 1:
        return []

    remaining = _budget_remaining(deps)
    fetch_limit = min(limit, remaining)

    async with deps.pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT f.path, c.start_line, c.end_line, f.sha256 AS file_sha256
                FROM chunks c
                JOIN files f ON f.id = c.file_id
                WHERE f.repository_id = %(repository_id)s
                  AND f.run_id = %(run_id)s
                  AND c.content_tsv @@ plainto_tsquery('english', %(pattern)s)
                ORDER BY f.path, c.start_line
                LIMIT %(limit)s
                """,
                {
                    "repository_id": deps.repository_id,
                    "run_id": deps.run_id,
                    "pattern": pattern,
                    "limit": fetch_limit,
                },
            )
            rows = await cur.fetchall()

    citations: list[Citation] = []
    for row in rows:
        if _budget_remaining(deps) <= 0:
            break
        citation = Citation(
            path=str(row["path"]),
            start_line=int(row["start_line"]),
            end_line=int(row["end_line"]),
            file_sha256=str(row["file_sha256"]),
        )
        deps.reads.append(citation)
        citations.append(citation)

    return citations
