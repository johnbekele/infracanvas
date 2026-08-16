//! Walk, chunk, embed, and write one ingestion run into Postgres.

use std::path::{Path, PathBuf};
use std::time::Instant;

use postgres::Client;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::EngineConfig;
use crate::chunk::{Chunk, ChunkError, ChunkOptions, chunk_file};
use crate::db::{
    ChunkRow, EMBEDDING_DIMENSIONS, EmbeddingRow, FileRow, connect, copy_chunks, copy_embeddings,
    copy_files, copy_forward, files_for_run, previous_file, run_exists,
};
use crate::embed::{EmbedError, Embedder, LocalEmbedder, LocalEmbedderOptions};
use crate::parse::Language;
use crate::rss;
use crate::walk::{FileRecord, ManifestDiff, RepoManifest, WalkError, WalkOptions, walk};

/// Which embedder `index` should use for this run.
pub enum EmbedderChoice {
    Local {
        cache_dir: Option<PathBuf>,
        offline: bool,
    },
    /// Writes chunks and no embeddings. For tests and for measuring the other stages.
    Disabled,
}

/// Inputs for a single [`index`] call.
pub struct IndexOptions {
    pub root: PathBuf,
    pub repository_id: Uuid,
    /// The run this snapshot belongs to. Created by the caller, never by the engine.
    pub run_id: Uuid,
    /// Previous succeeded run. Its `files` rows are the baseline for the incremental path.
    pub previous_run_id: Option<Uuid>,
    pub database_url: String,
    pub engine: EngineConfig,
    pub chunking: ChunkOptions,
    pub embedder: EmbedderChoice,
    /// Files per transaction. Default 256. A crash leaves whole files, never half of one.
    pub files_per_transaction: usize,
}

/// Counters returned after a successful index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexStats {
    pub files_scanned: usize,
    pub files_skipped: usize,
    /// Parsed, chunked, and embedded in this run.
    pub files_indexed: usize,
    /// Copied forward from `previous_run_id` without parsing.
    pub files_unchanged: usize,
    pub files_removed: usize,
    pub chunks_written: usize,
    pub embeddings_written: usize,
    pub bytes_read: u64,
    /// Merkle root from the walk, so a caller can short-circuit an identical commit.
    pub root_hash: String,
    pub elapsed_ms: u64,
    /// From `VmHWM` on Linux and `ru_maxrss` elsewhere. Zero when unavailable.
    pub peak_rss_bytes: u64,
}

/// Failures from [`index`].
#[derive(Debug, Error)]
pub enum IndexError {
    #[error(transparent)]
    Walk(#[from] WalkError),
    #[error(transparent)]
    Chunk(#[from] ChunkError),
    #[error(transparent)]
    Embed(#[from] EmbedError),
    #[error("database unavailable: {0}")]
    DatabaseUnavailable(String),
    #[error("run {0} does not exist")]
    UnknownRun(Uuid),
    #[error("embedder produced {actual} dimensions, the column expects {expected}")]
    DimensionMismatch { actual: usize, expected: usize },
}

/// Blocking. Safe to call from `py.allow_threads`, which is how the brain reaches it.
///
/// # Errors
///
/// Returns [`IndexError`] when walking, chunking, embedding, or writing fails, when
/// `run_id` (or `previous_run_id`) is unknown, or when the embedder is not 384-dimensional.
#[allow(clippy::needless_pass_by_value)] // Contract: owned `IndexOptions`.
pub fn index(options: IndexOptions) -> Result<IndexStats, IndexError> {
    let embedder = load_embedder(&options.embedder)?;
    index_with_resolved(&options, embedder.as_ref().map(|e| e as &dyn Embedder))
}

/// Run indexing with an arbitrary [`Embedder`]. Used by tests to assert
/// [`IndexError::DimensionMismatch`] without shipping a wrong model.
///
/// # Errors
///
/// Same failure modes as [`index`].
#[doc(hidden)]
#[allow(clippy::needless_pass_by_value)] // Mirrors [`index`].
pub fn index_with_embedder(
    options: IndexOptions,
    embedder: &dyn Embedder,
) -> Result<IndexStats, IndexError> {
    index_with_resolved(&options, Some(embedder))
}

fn index_with_resolved(
    options: &IndexOptions,
    embedder: Option<&dyn Embedder>,
) -> Result<IndexStats, IndexError> {
    let started = Instant::now();
    if let Some(embedder) = embedder {
        ensure_dimensions(embedder.dim())?;
    }

    let mut client = connect(&options.database_url)?;
    if !run_exists(&mut client, options.run_id)? {
        return Err(IndexError::UnknownRun(options.run_id));
    }
    if let Some(prev) = options.previous_run_id
        && !run_exists(&mut client, prev)?
    {
        return Err(IndexError::UnknownRun(prev));
    }

    let walk_opts = WalkOptions {
        root: options.root.clone(),
        max_file_bytes: options.engine.max_file_bytes,
        concurrency: options.engine.concurrency,
        respect_ignore_files: true,
        extra_ignores: Vec::new(),
    };
    let manifest = walk(&walk_opts)?;

    let previous = match options.previous_run_id {
        Some(prev) => Some(manifest_from_run(&mut client, prev)?),
        None => None,
    };
    let diff = if let Some(prev) = &previous {
        manifest.diff(prev)
    } else {
        ManifestDiff {
            added: manifest.files.iter().map(|f| f.path.clone()).collect(),
            ..ManifestDiff::default()
        }
    };

    let files_per_tx = if options.files_per_transaction == 0 {
        256
    } else {
        options.files_per_transaction
    };

    let mut to_index: Vec<&FileRecord> = Vec::new();
    for path in diff.added.iter().chain(diff.modified.iter()) {
        if let Some(file) = manifest.get(path) {
            to_index.push(file);
        }
    }
    let unchanged_paths = diff.unchanged.clone();

    let mut stats = IndexStats {
        files_scanned: manifest.files.len() + manifest.skipped.len(),
        files_skipped: manifest.skipped.len(),
        files_indexed: 0,
        files_unchanged: 0,
        files_removed: diff.removed.len(),
        chunks_written: 0,
        embeddings_written: 0,
        bytes_read: manifest.bytes_read,
        root_hash: manifest.root_hash.clone(),
        elapsed_ms: 0,
        peak_rss_bytes: 0,
    };

    let mut work: Vec<WorkItem<'_>> = Vec::with_capacity(to_index.len() + unchanged_paths.len());
    for file in to_index {
        work.push(WorkItem::Index(file));
    }
    for path in &unchanged_paths {
        work.push(WorkItem::Unchanged(path.as_str()));
    }

    for batch in work.chunks(files_per_tx) {
        write_batch(&mut client, options, &manifest, embedder, batch, &mut stats)?;
    }

    stats.elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    stats.peak_rss_bytes = rss::peak_rss_bytes();
    Ok(stats)
}

/// Builds a `RepoManifest` from `files` so `RepoManifest::diff` can classify the new walk.
///
/// `root_hash` is left empty: the schema does not store it on the run, and an empty
/// hash does not affect path-level classification. When the run has no file rows the
/// baseline is empty and every current file is treated as added.
fn manifest_from_run(client: &mut Client, run_id: Uuid) -> Result<RepoManifest, IndexError> {
    if !run_exists(client, run_id)? {
        return Err(IndexError::UnknownRun(run_id));
    }
    let rows = files_for_run(client, run_id)?;
    let files = rows
        .into_iter()
        .map(|(path, size_bytes, sha256)| FileRecord {
            path,
            size_bytes: u64::try_from(size_bytes).unwrap_or(0),
            sha256,
        })
        .collect();
    Ok(RepoManifest {
        root: PathBuf::new(),
        root_hash: String::new(),
        files,
        skipped: Vec::new(),
        bytes_read: 0,
    })
}

enum WorkItem<'a> {
    Index(&'a FileRecord),
    Unchanged(&'a str),
}

fn write_batch(
    client: &mut Client,
    options: &IndexOptions,
    manifest: &RepoManifest,
    embedder: Option<&dyn Embedder>,
    batch: &[WorkItem<'_>],
    stats: &mut IndexStats,
) -> Result<(), IndexError> {
    // CPU work outside the transaction so a chunk/embed failure does not hold locks.
    let mut prepared: Vec<PreparedFile> = Vec::new();
    for item in batch {
        if let WorkItem::Index(file) = item {
            prepared.push(prepare_indexed_file(
                &manifest.root,
                options.repository_id,
                options.run_id,
                file,
                &options.chunking,
                embedder,
            )?);
        }
    }

    let mut tx = client
        .transaction()
        .map_err(|err| IndexError::DatabaseUnavailable(err.to_string()))?;

    let mut indexed_count = 0usize;
    let mut unchanged_count = 0usize;
    let mut chunks_written = 0usize;
    let mut embeddings_written = 0usize;

    let mut file_rows: Vec<FileRow> = Vec::with_capacity(prepared.len());
    let mut chunk_rows: Vec<ChunkRow> = Vec::new();
    let mut embedding_rows: Vec<EmbeddingRow> = Vec::new();
    for prepared in &prepared {
        file_rows.push(prepared.file.clone());
        chunk_rows.extend(prepared.chunks.iter().cloned());
        embedding_rows.extend(prepared.embeddings.iter().cloned());
        indexed_count += 1;
        chunks_written += prepared.chunks.len();
        embeddings_written += prepared.embeddings.len();
    }

    copy_files(&mut tx, &file_rows)?;
    copy_chunks(&mut tx, &chunk_rows)?;
    if embedder.is_some() {
        copy_embeddings(&mut tx, &embedding_rows)?;
    }

    for item in batch {
        let WorkItem::Unchanged(path) = item else {
            continue;
        };
        let Some(prev_run) = options.previous_run_id else {
            continue;
        };
        let Some(current) = manifest.get(path) else {
            continue;
        };
        let Some((prev_id, language)) = previous_file(&mut tx, prev_run, path)? else {
            continue;
        };
        let new_id = Uuid::now_v7();
        let row = FileRow {
            id: new_id,
            repository_id: options.repository_id,
            run_id: options.run_id,
            path: current.path.clone(),
            language,
            size_bytes: i32::try_from(current.size_bytes).unwrap_or(i32::MAX),
            sha256: current.sha256.clone(),
        };
        copy_files(&mut tx, std::slice::from_ref(&row))?;
        let (c, e) = copy_forward(&mut tx, prev_id, new_id)?;
        unchanged_count += 1;
        chunks_written += c;
        embeddings_written += e;
    }

    tx.commit()
        .map_err(|err| IndexError::DatabaseUnavailable(err.to_string()))?;

    stats.files_indexed += indexed_count;
    stats.files_unchanged += unchanged_count;
    stats.chunks_written += chunks_written;
    stats.embeddings_written += embeddings_written;
    Ok(())
}

struct PreparedFile {
    file: FileRow,
    chunks: Vec<ChunkRow>,
    embeddings: Vec<EmbeddingRow>,
}

fn prepare_indexed_file(
    root: &Path,
    repository_id: Uuid,
    run_id: Uuid,
    file: &FileRecord,
    chunking: &ChunkOptions,
    embedder: Option<&dyn Embedder>,
) -> Result<PreparedFile, IndexError> {
    let path = join_manifest_path(root, &file.path);
    let source = std::fs::read_to_string(&path).unwrap_or_default();
    let language = Language::from_path(&file.path)
        .or_else(|| source.lines().next().and_then(Language::from_shebang));
    let language_name = language.map_or("text", Language::name).to_owned();
    let chunks = chunk_file(&source, language, chunking)?;

    let file_id = Uuid::now_v7();
    let file_row = FileRow {
        id: file_id,
        repository_id,
        run_id,
        path: file.path.clone(),
        language: language_name,
        size_bytes: i32::try_from(file.size_bytes).unwrap_or(i32::MAX),
        sha256: file.sha256.clone(),
    };

    let mut chunk_rows = Vec::with_capacity(chunks.len());
    let mut embedding_rows = Vec::new();

    if let Some(embedder) = embedder {
        let texts: Vec<&str> = chunks.iter().map(|c| c.content.as_str()).collect();
        let vectors = embedder.embed_batch(&texts)?;
        if vectors.len() != chunks.len() {
            return Err(EmbedError::Inference(format!(
                "expected {} embeddings, got {}",
                chunks.len(),
                vectors.len()
            ))
            .into());
        }
        for (chunk, vector) in chunks.iter().zip(vectors) {
            ensure_dimensions(vector.len())?;
            let chunk_id = Uuid::now_v7();
            chunk_rows.push(chunk_to_row(chunk_id, file_id, repository_id, chunk));
            embedding_rows.push(EmbeddingRow {
                chunk_id,
                repository_id,
                model: embedder.model_id().to_owned(),
                embedding: vector,
            });
        }
    } else {
        for chunk in &chunks {
            let chunk_id = Uuid::now_v7();
            chunk_rows.push(chunk_to_row(chunk_id, file_id, repository_id, chunk));
        }
    }

    Ok(PreparedFile {
        file: file_row,
        chunks: chunk_rows,
        embeddings: embedding_rows,
    })
}

fn chunk_to_row(id: Uuid, file_id: Uuid, repository_id: Uuid, chunk: &Chunk) -> ChunkRow {
    ChunkRow {
        id,
        file_id,
        repository_id,
        start_line: i32::try_from(chunk.start_line).unwrap_or(i32::MAX),
        end_line: i32::try_from(chunk.end_line).unwrap_or(i32::MAX),
        symbol: chunk.symbol.clone(),
        kind: chunk.kind.as_str().to_owned(),
        content: chunk.content.clone(),
        token_count: i32::try_from(chunk.token_count).unwrap_or(i32::MAX),
    }
}

fn join_manifest_path(root: &Path, relative: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for part in relative.split('/') {
        if !part.is_empty() {
            out.push(part);
        }
    }
    out
}

fn load_embedder(choice: &EmbedderChoice) -> Result<Option<LocalEmbedder>, IndexError> {
    match choice {
        EmbedderChoice::Disabled => Ok(None),
        EmbedderChoice::Local { cache_dir, offline } => {
            let mut options = LocalEmbedderOptions::default();
            if let Some(dir) = cache_dir {
                options.cache_dir.clone_from(dir);
            }
            options.offline = *offline;
            Ok(Some(LocalEmbedder::load(&options)?))
        }
    }
}

fn ensure_dimensions(dim: usize) -> Result<(), IndexError> {
    if dim != EMBEDDING_DIMENSIONS {
        return Err(IndexError::DimensionMismatch {
            actual: dim,
            expected: EMBEDDING_DIMENSIONS,
        });
    }
    Ok(())
}
