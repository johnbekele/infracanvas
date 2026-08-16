//! Local text embeddings for the ingest pipeline.
//!
//! A hosted provider would be a second [`Embedder`] implementation, not a
//! rewrite of callers. The only implementation shipped here runs int8
//! `bge-small-en-v1.5` on CPU via ONNX Runtime.

mod local;

use std::path::PathBuf;

pub use local::{LocalEmbedder, LocalEmbedderOptions};

/// Implemented once locally here. A hosted implementation would be a second impl, not a rewrite.
pub trait Embedder: Send + Sync {
    /// One vector per input, in the same order. An empty slice returns an empty vec.
    ///
    /// # Errors
    ///
    /// Returns [`EmbedError`] when tokenisation or inference fails.
    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError>;
    /// Always 384 for the local model, and asserted against the `halfvec(384)` column.
    fn dim(&self) -> usize;
    /// Written to `chunk_embeddings.model`, for example `bge-small-en-v1.5-q`.
    fn model_id(&self) -> &str;
    /// Token window. Inputs longer than this are truncated rather than rejected.
    fn max_tokens(&self) -> usize;
}

/// Failures loading or running the embedder.
#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    /// Offline mode was set and the ONNX weights are not on disk yet.
    #[error("model {model_id} is not in {cache_dir} and offline mode is set")]
    ModelNotCached {
        model_id: String,
        cache_dir: PathBuf,
    },
    /// The first-time model download failed.
    #[error("failed to fetch {model_id}: {message}")]
    Fetch { model_id: String, message: String },
    /// ONNX Runtime rejected the batch or returned an unexpected shape.
    #[error("inference failed: {0}")]
    Inference(String),
    /// The committed `WordPiece` JSON could not be loaded or applied.
    #[error("tokeniser unavailable: {0}")]
    Tokeniser(String),
}
