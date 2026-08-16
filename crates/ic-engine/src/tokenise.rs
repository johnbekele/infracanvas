//! Shared `bge-small-en-v1.5` tokeniser.
//!
//! The JSON is committed under `assets/` with no model weights. Chunking and the
//! embedder (issue 030) both count through this module so `chunks.token_count`
//! matches what the model will see.

use std::sync::OnceLock;

use tokenizers::Tokenizer;

use crate::chunk::ChunkError;

static TOKENIZER: OnceLock<Result<Tokenizer, String>> = OnceLock::new();

/// Absolute path to the committed tokeniser JSON.
#[must_use]
pub fn tokenizer_path() -> &'static str {
    concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/assets/bge-small-en-v1.5/tokenizer.json"
    )
}

fn load_tokenizer() -> Result<Tokenizer, String> {
    Tokenizer::from_file(tokenizer_path()).map_err(|err| err.to_string())
}

/// Process-wide tokeniser. Loads once; subsequent failures reuse the first error.
///
/// # Errors
///
/// Returns [`ChunkError::Tokeniser`] when the committed JSON cannot be loaded.
pub fn tokenizer() -> Result<&'static Tokenizer, ChunkError> {
    let slot = TOKENIZER.get_or_init(load_tokenizer);
    match slot {
        Ok(tok) => Ok(tok),
        Err(message) => Err(ChunkError::Tokeniser(message.clone())),
    }
}

/// Token count for `text` as the embedder will see it (no special tokens).
///
/// # Errors
///
/// Returns [`ChunkError::Tokeniser`] when encoding fails or the tokeniser is missing.
pub fn count_tokens(text: &str) -> Result<u32, ChunkError> {
    let tok = tokenizer()?;
    let encoding = tok
        .encode(text, false)
        .map_err(|err| ChunkError::Tokeniser(err.to_string()))?;
    u32::try_from(encoding.get_ids().len())
        .map_err(|_| ChunkError::Tokeniser("token count exceeds u32::MAX".to_owned()))
}
