//! Repository ingestion engine.
//!
//! This is the part of the system where memory and speed decide whether the
//! product works at all. Parsing and embedding a large repository from Node or
//! Python means either one slow thread or a heap that rules out the ordinary
//! laptop this is meant to run on.
//!
//! The engine is reachable two ways. The `ic-engine` binary is what benchmarks
//! and CI invoke, and it makes the engine testable without the rest of the
//! stack. The `ic_engine` Python module, built by maturin, is what the brain
//! service calls in-process, so ingesting a repository does not serialise
//! several hundred megabytes of chunks across a subprocess boundary.
//!
//! Parsing and chunking land in this crate; embedding follows in a later issue.

// The engine parses untrusted repository content, where a panic is a denial of
// service rather than a crash report.
#![warn(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod chunk;
mod merkle;
mod parse;
mod tokenise;
mod walk;

pub use chunk::{
    Chunk, ChunkError, ChunkKind, ChunkOptions, ChunkStats, chunk_file, chunk_manifest,
};
pub use parse::Language;
pub use tokenise::{count_tokens, tokenizer, tokenizer_path};
pub use walk::{
    BUILTIN_DENY_PATTERNS, FileRecord, ManifestDiff, RepoManifest, SkipReason, SkippedFile,
    WalkError, WalkOptions, walk,
};

/// Limits on a single ingestion run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineConfig {
    /// Files above this size are skipped. Minified bundles, lockfiles, and
    /// vendored blobs are large, uninformative, and would dominate both the
    /// embedding budget and the retrieved context.
    pub max_file_bytes: usize,
    /// Worker threads. Zero means one per available core.
    pub concurrency: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024,
            concurrency: 0,
        }
    }
}

impl EngineConfig {
    /// Resolve `concurrency` to a concrete thread count.
    ///
    /// Falls back to one thread when the core count cannot be determined,
    /// because a slow ingest is recoverable and a panic during startup is not.
    #[must_use]
    pub fn worker_threads(self) -> usize {
        if self.concurrency > 0 {
            return self.concurrency;
        }
        std::thread::available_parallelism().map_or(1, std::num::NonZero::get)
    }
}

/// The engine version, taken from the crate manifest.
///
/// The CLI and the Python module both report this, so a user who reports a bug
/// against one is describing the same build as the other.
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(feature = "python")]
mod python {
    use pyo3::prelude::*;

    #[pyfunction]
    #[pyo3(name = "version")]
    fn py_version() -> &'static str {
        super::version()
    }

    #[pymodule]
    fn ic_engine(module: &Bound<'_, PyModule>) -> PyResult<()> {
        module.add_function(wrap_pyfunction!(py_version, module)?)?;
        module.add("__version__", super::version())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{EngineConfig, version};

    #[test]
    fn version_is_not_empty() {
        assert!(!version().is_empty());
    }

    #[test]
    fn version_matches_the_crate_manifest() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn zero_concurrency_resolves_to_at_least_one_thread() {
        assert!(EngineConfig::default().worker_threads() >= 1);
    }

    #[test]
    fn explicit_concurrency_is_honoured() {
        let config = EngineConfig {
            concurrency: 3,
            ..EngineConfig::default()
        };
        assert_eq!(config.worker_threads(), 3);
    }

    #[test]
    fn default_skips_files_over_one_megabyte() {
        assert_eq!(EngineConfig::default().max_file_bytes, 1024 * 1024);
    }
}
