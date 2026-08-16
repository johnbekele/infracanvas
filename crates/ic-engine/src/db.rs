//! Postgres connection setup, binary `COPY` writers, and copy-forward.

use pgvector::HalfVector;
use postgres::binary_copy::BinaryCopyInWriter;
use postgres::types::{Kind, ToSql, Type};
use postgres::{Client, GenericClient, NoTls};
use uuid::Uuid;

use crate::index::IndexError;

/// Expected embedding width; matches `chunk_embeddings.embedding halfvec(384)`.
pub const EMBEDDING_DIMENSIONS: usize = 384;

/// One `files` row ready for binary `COPY`.
#[derive(Debug, Clone)]
pub struct FileRow {
    pub id: Uuid,
    pub repository_id: Uuid,
    pub run_id: Uuid,
    pub path: String,
    pub language: String,
    pub size_bytes: i32,
    pub sha256: String,
}

/// One `chunks` row ready for binary `COPY`.
#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub id: Uuid,
    pub file_id: Uuid,
    pub repository_id: Uuid,
    pub start_line: i32,
    pub end_line: i32,
    pub symbol: Option<String>,
    pub kind: String,
    pub content: String,
    pub token_count: i32,
}

/// One `chunk_embeddings` row ready for binary `COPY`.
#[derive(Debug, Clone)]
pub struct EmbeddingRow {
    pub chunk_id: Uuid,
    pub repository_id: Uuid,
    pub model: String,
    pub embedding: Vec<f32>,
}

/// Open a synchronous connection. Maps refusal to [`IndexError::DatabaseUnavailable`].
pub fn connect(database_url: &str) -> Result<Client, IndexError> {
    Client::connect(database_url, NoTls)
        .map_err(|err| IndexError::DatabaseUnavailable(err.to_string()))
}

/// True when `ingestion_runs` contains `run_id`.
pub fn run_exists(client: &mut impl GenericClient, run_id: Uuid) -> Result<bool, IndexError> {
    let row = client
        .query_opt("SELECT 1 FROM ingestion_runs WHERE id = $1", &[&run_id])
        .map_err(|err| map_db(&err))?;
    Ok(row.is_some())
}

/// Previous-run file id and language for a path, if present.
pub fn previous_file(
    client: &mut impl GenericClient,
    run_id: Uuid,
    path: &str,
) -> Result<Option<(Uuid, String)>, IndexError> {
    let row = client
        .query_opt(
            "SELECT id, language FROM files WHERE run_id = $1 AND path = $2",
            &[&run_id, &path],
        )
        .map_err(|err| map_db(&err))?;
    Ok(row.map(|r| (r.get(0), r.get(1))))
}

/// File rows for a run, ordered by path (for [`crate::RepoManifest::diff`]).
pub fn files_for_run(
    client: &mut impl GenericClient,
    run_id: Uuid,
) -> Result<Vec<(String, i32, String)>, IndexError> {
    let rows = client
        .query(
            "SELECT path, size_bytes, sha256 FROM files WHERE run_id = $1 ORDER BY path",
            &[&run_id],
        )
        .map_err(|err| map_db(&err))?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect())
}

/// Copy chunks and embeddings from a previous file row onto a new file id.
///
/// Returns `(chunks_copied, embeddings_copied)`.
pub fn copy_forward(
    client: &mut impl GenericClient,
    previous_file_id: Uuid,
    new_file_id: Uuid,
) -> Result<(usize, usize), IndexError> {
    let rows = client
        .query(
            "
            WITH mapped AS (
              SELECT c.*, gen_random_uuid() AS new_id
                FROM chunks c
               WHERE c.file_id = $1
            ), inserted AS (
              INSERT INTO chunks (id, file_id, repository_id, start_line, end_line, symbol, kind,
                                  content, token_count)
              SELECT new_id, $2, repository_id, start_line, end_line, symbol, kind, content, token_count
                FROM mapped
              RETURNING id
            ), emb AS (
              INSERT INTO chunk_embeddings (chunk_id, repository_id, model, embedding)
              SELECT m.new_id, e.repository_id, e.model, e.embedding
                FROM mapped m
                JOIN chunk_embeddings e ON e.chunk_id = m.id
              RETURNING chunk_id
            )
            SELECT
              (SELECT count(*)::bigint FROM inserted) AS chunks,
              (SELECT count(*)::bigint FROM emb) AS embeddings
            ",
            &[&previous_file_id, &new_file_id],
        )
        .map_err(|err| map_db(&err))?;
    let row = rows
        .first()
        .ok_or_else(|| IndexError::DatabaseUnavailable("copy-forward returned no row".into()))?;
    let chunks: i64 = row.get(0);
    let embeddings: i64 = row.get(1);
    Ok((
        usize::try_from(chunks).unwrap_or(0),
        usize::try_from(embeddings).unwrap_or(0),
    ))
}

/// Binary `COPY` for a batch of file rows.
pub fn copy_files(client: &mut impl GenericClient, rows: &[FileRow]) -> Result<(), IndexError> {
    if rows.is_empty() {
        return Ok(());
    }
    let sink = client
        .copy_in(
            "COPY files (id, repository_id, run_id, path, language, size_bytes, sha256) \
             FROM STDIN WITH (FORMAT BINARY)",
        )
        .map_err(|err| map_db(&err))?;
    let types = [
        Type::UUID,
        Type::UUID,
        Type::UUID,
        Type::TEXT,
        Type::TEXT,
        Type::INT4,
        Type::TEXT,
    ];
    let mut writer = BinaryCopyInWriter::new(sink, &types);
    for row in rows {
        writer
            .write(&[
                &row.id as &(dyn ToSql + Sync),
                &row.repository_id,
                &row.run_id,
                &row.path,
                &row.language,
                &row.size_bytes,
                &row.sha256,
            ])
            .map_err(|err| map_db(&err))?;
    }
    writer.finish().map_err(|err| map_db(&err))?;
    Ok(())
}

/// Binary `COPY` for a batch of chunk rows. Does not list `content_tsv`.
pub fn copy_chunks(client: &mut impl GenericClient, rows: &[ChunkRow]) -> Result<(), IndexError> {
    if rows.is_empty() {
        return Ok(());
    }
    let sink = client
        .copy_in(
            "COPY chunks (id, file_id, repository_id, start_line, end_line, symbol, kind, \
             content, token_count) FROM STDIN WITH (FORMAT BINARY)",
        )
        .map_err(|err| map_db(&err))?;
    let types = [
        Type::UUID,
        Type::UUID,
        Type::UUID,
        Type::INT4,
        Type::INT4,
        Type::TEXT,
        Type::TEXT,
        Type::TEXT,
        Type::INT4,
    ];
    let mut writer = BinaryCopyInWriter::new(sink, &types);
    for row in rows {
        writer
            .write(&[
                &row.id as &(dyn ToSql + Sync),
                &row.file_id,
                &row.repository_id,
                &row.start_line,
                &row.end_line,
                &row.symbol,
                &row.kind,
                &row.content,
                &row.token_count,
            ])
            .map_err(|err| map_db(&err))?;
    }
    writer.finish().map_err(|err| map_db(&err))?;
    Ok(())
}

/// Binary `COPY` for embedding rows as `halfvec`.
pub fn copy_embeddings(
    client: &mut impl GenericClient,
    rows: &[EmbeddingRow],
) -> Result<(), IndexError> {
    if rows.is_empty() {
        return Ok(());
    }
    let halfvec_ty = halfvec_type(client)?;
    let sink = client
        .copy_in(
            "COPY chunk_embeddings (chunk_id, repository_id, model, embedding) \
             FROM STDIN WITH (FORMAT BINARY)",
        )
        .map_err(|err| map_db(&err))?;
    let types = [Type::UUID, Type::UUID, Type::TEXT, halfvec_ty];
    let mut writer = BinaryCopyInWriter::new(sink, &types);
    for row in rows {
        if row.embedding.len() != EMBEDDING_DIMENSIONS {
            return Err(IndexError::DimensionMismatch {
                actual: row.embedding.len(),
                expected: EMBEDDING_DIMENSIONS,
            });
        }
        let vector = HalfVector::from_f32_slice(&row.embedding);
        writer
            .write(&[
                &row.chunk_id as &(dyn ToSql + Sync),
                &row.repository_id,
                &row.model,
                &vector,
            ])
            .map_err(|err| map_db(&err))?;
    }
    writer.finish().map_err(|err| map_db(&err))?;
    Ok(())
}

fn halfvec_type(client: &mut impl GenericClient) -> Result<Type, IndexError> {
    let row = client
        .query_one(
            "SELECT oid FROM pg_type WHERE typname = 'halfvec' AND typnamespace = \
             (SELECT oid FROM pg_namespace WHERE nspname = 'public')",
            &[],
        )
        .map_err(|err| map_db(&err))?;
    let oid: u32 = row.get(0);
    Ok(Type::new(
        "halfvec".to_owned(),
        oid,
        Kind::Simple,
        "public".to_owned(),
    ))
}

fn map_db(err: &postgres::Error) -> IndexError {
    IndexError::DatabaseUnavailable(err.to_string())
}
