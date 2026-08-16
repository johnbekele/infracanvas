//! Int8 `bge-small-en-v1.5` embedder via fastembed / ONNX Runtime (CPU).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use ort::execution_providers::CPU;

use super::{EmbedError, Embedder};
use crate::EngineConfig;
use crate::tokenise;

/// Identifier written to `chunk_embeddings.model`.
const MODEL_ID: &str = "bge-small-en-v1.5-q";
/// Must match `chunk_embeddings.embedding halfvec(384)`.
const MODEL_DIM: usize = 384;
/// Model context window; longer inputs are truncated, not rejected.
const MODEL_MAX_TOKENS: usize = 512;
/// Hugging Face repo fastembed pulls for [`EmbeddingModel::BGESmallENV15Q`].
const HF_MODEL_CODE: &str = "Qdrant/bge-small-en-v1.5-onnx-Q";
/// ONNX filename inside that repo.
const MODEL_FILE: &str = "model_optimized.onnx";

/// Serialises `HF_HOME` / `HF_HUB_OFFLINE` mutation across concurrent `load` calls.
static LOAD_ENV_LOCK: Mutex<()> = Mutex::new(());

/// Options for [`LocalEmbedder::load`].
#[derive(Debug, Clone)]
pub struct LocalEmbedderOptions {
    /// Defaults to `$XDG_CACHE_HOME/infracanvas/models`, or `~/.cache/infracanvas/models`.
    pub cache_dir: PathBuf,
    /// Sequences per forward pass. Default 64.
    pub batch_size: usize,
    /// Zero means `EngineConfig::worker_threads()`.
    pub threads: usize,
    /// True fails rather than fetching. Default false.
    pub offline: bool,
}

impl Default for LocalEmbedderOptions {
    fn default() -> Self {
        Self {
            cache_dir: default_cache_dir(),
            batch_size: 64,
            threads: 0,
            offline: false,
        }
    }
}

/// Shared CPU embedder. One instance serves every worker; the ONNX session is
/// behind a mutex because `ort` needs exclusive access per run.
pub struct LocalEmbedder {
    inner: Mutex<TextEmbedding>,
    batch_size: usize,
}

impl LocalEmbedder {
    /// Loads from the cache, fetching once when absent and `offline` is false.
    ///
    /// # Errors
    ///
    /// Returns [`EmbedError::ModelNotCached`] when `offline` is set and the
    /// weights are missing, [`EmbedError::Fetch`] when the download fails, or
    /// [`EmbedError::Inference`] when the ONNX session cannot be built.
    pub fn load(options: &LocalEmbedderOptions) -> Result<Self, EmbedError> {
        let cache_dir = options.cache_dir.clone();
        if options.offline && !Self::is_cached(options) {
            return Err(EmbedError::ModelNotCached {
                model_id: MODEL_ID.to_owned(),
                cache_dir,
            });
        }

        let threads = if options.threads == 0 {
            EngineConfig::default().worker_threads()
        } else {
            options.threads
        };
        let batch_size = options.batch_size.max(1);

        // fastembed prefers `HF_HOME` over `with_cache_dir`. Pin both under a
        // process lock so concurrent loads cannot clobber each other's env.
        let _env_lock = LOAD_ENV_LOCK
            .lock()
            .map_err(|_| EmbedError::Inference("embedder load lock poisoned".to_owned()))?;
        let _hf_home = EnvVarGuard::set("HF_HOME", Some(cache_dir.as_os_str()));
        let offline_flag = OsString::from("1");
        let _hub_offline = if options.offline {
            EnvVarGuard::set("HF_HUB_OFFLINE", Some(offline_flag.as_os_str()))
        } else {
            EnvVarGuard::set("HF_HUB_OFFLINE", None)
        };

        let init = TextInitOptions::new(EmbeddingModel::BGESmallENV15Q)
            .with_cache_dir(cache_dir.clone())
            .with_show_download_progress(false)
            .with_max_length(MODEL_MAX_TOKENS)
            .with_intra_threads(threads)
            .with_execution_providers(vec![CPU::default().build()]);

        let model = TextEmbedding::try_new(init).map_err(|err| {
            let message = err.to_string();
            if options.offline {
                EmbedError::ModelNotCached {
                    model_id: MODEL_ID.to_owned(),
                    cache_dir,
                }
            } else if Self::is_cached(options) {
                EmbedError::Inference(message)
            } else {
                EmbedError::Fetch {
                    model_id: MODEL_ID.to_owned(),
                    message,
                }
            }
        })?;

        Ok(Self {
            inner: Mutex::new(model),
            batch_size,
        })
    }

    /// True when the model is already on disk, so a caller can decide whether to warn about a download.
    #[must_use]
    pub fn is_cached(options: &LocalEmbedderOptions) -> bool {
        model_onnx_path(&options.cache_dir).is_some_and(|path| path.is_file())
    }
}

impl Embedder for LocalEmbedder {
    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let prepared: Vec<String> = texts
            .iter()
            .map(|text| truncate_to_max_tokens(text, MODEL_MAX_TOKENS))
            .collect::<Result<Vec<_>, _>>()?;

        let mut session = self
            .inner
            .lock()
            .map_err(|_| EmbedError::Inference("embedder mutex poisoned".to_owned()))?;

        let embeddings = session
            .embed(prepared, Some(self.batch_size))
            .map_err(|err| EmbedError::Inference(err.to_string()))?;

        if embeddings.len() != texts.len() {
            return Err(EmbedError::Inference(format!(
                "expected {} embeddings, got {}",
                texts.len(),
                embeddings.len()
            )));
        }

        let mut out = Vec::with_capacity(embeddings.len());
        for vector in embeddings {
            if vector.len() != MODEL_DIM {
                return Err(EmbedError::Inference(format!(
                    "expected dimension {MODEL_DIM}, got {}",
                    vector.len()
                )));
            }
            out.push(l2_normalize(vector));
        }
        Ok(out)
    }

    fn dim(&self) -> usize {
        MODEL_DIM
    }

    fn model_id(&self) -> &str {
        MODEL_ID
    }

    fn max_tokens(&self) -> usize {
        MODEL_MAX_TOKENS
    }
}

fn default_cache_dir() -> PathBuf {
    // Contract: `$XDG_CACHE_HOME/infracanvas/models`, else `~/.cache/...`.
    // Do not use `dirs::cache_dir()` — on macOS that is `~/Library/Caches`.
    let cache_root = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".cache")))
        .unwrap_or_else(|| PathBuf::from(".cache"));
    cache_root.join("infracanvas").join("models")
}

fn hf_repo_dir(cache_dir: &Path) -> PathBuf {
    // hf-hub layout: models--{org}--{name} with `/` replaced by `--`.
    cache_dir.join(format!("models--{}", HF_MODEL_CODE.replace('/', "--")))
}

fn model_onnx_path(cache_dir: &Path) -> Option<PathBuf> {
    let repo = hf_repo_dir(cache_dir);
    if !repo.is_dir() {
        return None;
    }
    // Prefer the snapshots tree; fall back to a recursive search so a
    // partially-migrated cache layout still counts as present.
    let snapshots = repo.join("snapshots");
    if snapshots.is_dir()
        && let Ok(revs) = std::fs::read_dir(&snapshots)
    {
        for rev in revs.flatten() {
            let candidate = rev.path().join(MODEL_FILE);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    find_file_named(&repo, MODEL_FILE)
}

fn find_file_named(dir: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && entry.file_name() == name {
            return Some(path);
        }
        if path.is_dir()
            && let Some(found) = find_file_named(&path, name)
        {
            return Some(found);
        }
    }
    None
}

fn truncate_to_max_tokens(text: &str, max_tokens: usize) -> Result<String, EmbedError> {
    let tok = tokenise::tokenizer().map_err(|err| EmbedError::Tokeniser(err.to_string()))?;
    let encoding = tok
        .encode(text, false)
        .map_err(|err| EmbedError::Tokeniser(err.to_string()))?;
    let ids = encoding.get_ids();
    if ids.len() <= max_tokens {
        return Ok(text.to_owned());
    }
    let truncated = ids
        .get(..max_tokens)
        .ok_or_else(|| EmbedError::Tokeniser("token slice out of range".to_owned()))?;
    tok.decode(truncated, true)
        .map_err(|err| EmbedError::Tokeniser(err.to_string()))
}

fn l2_normalize(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

/// Restores a process environment variable when dropped.
///
/// `set_var` / `remove_var` are unsafe on Rust 2024 because another thread may
/// read the environment concurrently. Load runs once at startup; tests that
/// call it are sequential on the shared cache path.
struct EnvVarGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: Option<&std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(key);
        // SAFETY: embedder load is not concurrent with other env mutation in
        // this process; see struct docs.
        unsafe {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        // SAFETY: mirrors `set`; restores the prior value for the same reason.
        unsafe {
            match &self.previous {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }
}
