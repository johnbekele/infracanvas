---
title: '[rust] Embedder trait and a local 384-dimension implementation'
labels: tier:2, size:m, area:rust, epic:3-engine
---

### Epic

#4

### Context

Embeddings are the one part of the pipeline where the easy choice, a hosted embedding API, would break
two things the product depends on. Indexing a repository means sending every line of it to a third
party, which is not acceptable for the private repositories this is aimed at, and it puts a per-repository
bill in front of the first user who tries the thing. A local model removes both: no key to configure,
no data leaving the machine, and a cost of CPU time the user already owns. #61's bring-your-own-key
work covers language models, where the quality difference justifies the trade-off; embeddings are
where a small local model is genuinely competitive.

The model is `bge-small-en-v1.5` in its int8-quantised ONNX form, run through `fastembed` on
`ort`'s CPU execution provider. The dimension is not a free choice: #25 defines
`chunk_embeddings.embedding halfvec(384)`, so a 768-dimension model such as `bge-base-en-v1.5` would
double index size and require a migration on shipped data. Quantisation is reported to buy 1.5 to 3
times the throughput for a recall change small enough to be invisible on code search, and the
retrieval epic (#5) is where that claim gets measured against the golden set rather than asserted here.
The rejected alternative was Candle with fp32 safetensors, which avoids the ONNX Runtime dependency and
is meaningfully slower on CPU with no int8 path, and this stage is the largest single term in the
ingest budget.

Vectors are L2-normalised before they leave the embedder. pgvector's cosine operator normalises
internally, but a unit-length vector converted to `halfvec` loses less precision than an arbitrary-magnitude
one, and it means the dot product and cosine distance agree if a later query uses the cheaper operator.

The offline guarantee is a behaviour with a test, not a note in a README. `LocalEmbedder::load` with
`offline: true` and a cold cache returns `EmbedError::ModelNotCached` rather than reaching for the
network, so an air-gapped or rate-limited environment fails immediately with a message that says what
to do instead of hanging on a socket. The first fetch writes into an explicit cache directory so the
same wheel used from the brain, the CLI, and CI all share one copy.

Spec: `crates/ic-engine/README.md`

### Contract

```rust
// crates/ic-engine/src/embed/mod.rs
/// Implemented once locally here. A hosted implementation would be a second impl, not a rewrite.
pub trait Embedder: Send + Sync {
    /// One vector per input, in the same order. An empty slice returns an empty vec.
    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError>;
    /// Always 384 for the local model, and asserted against the `halfvec(384)` column.
    fn dim(&self) -> usize;
    /// Written to `chunk_embeddings.model`, for example `bge-small-en-v1.5-q`.
    fn model_id(&self) -> &str;
    /// Token window. Inputs longer than this are truncated rather than rejected.
    fn max_tokens(&self) -> usize;
}

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("model {model_id} is not in {cache_dir} and offline mode is set")]
    ModelNotCached { model_id: String, cache_dir: PathBuf },
    #[error("failed to fetch {model_id}: {message}")]
    Fetch { model_id: String, message: String },
    #[error("inference failed: {0}")]
    Inference(String),
    #[error("tokeniser unavailable: {0}")]
    Tokeniser(String),
}
```

```rust
// crates/ic-engine/src/embed/local.rs
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

impl Default for LocalEmbedderOptions { fn default() -> Self; }

pub struct LocalEmbedder { /* private */ }

impl LocalEmbedder {
    /// Loads from the cache, fetching once when absent and `offline` is false.
    pub fn load(options: &LocalEmbedderOptions) -> Result<Self, EmbedError>;
    /// True when the model is already on disk, so a caller can decide whether to warn about a download.
    pub fn is_cached(options: &LocalEmbedderOptions) -> bool;
}

impl Embedder for LocalEmbedder { /* ... */ }
```

Behaviour the signatures do not carry:

- `embed_batch` splits its input into `batch_size` groups internally, so a caller may pass ten
  thousand texts without knowing the batch size.
- Inputs above `max_tokens` are truncated at a token boundary using the tokeniser committed in
  `crates/ic-engine/assets/`, the same one that produced `chunks.token_count`. Truncating rather than
  erroring is deliberate: a chunk that slightly overflows should still be searchable.
- Every returned vector is L2-normalised to within `1e-6` of unit length.
- The same input produces a bit-identical vector on repeated calls in one process, so an unchanged
  chunk re-embedded during a re-index does not produce a spurious write.
- `LocalEmbedder` is `Send + Sync` and one instance serves every worker. The ONNX session is shared
  and intra-op threading is left to `ort`, because one session per worker would multiply the resident
  model.

### Files

- CREATE `crates/ic-engine/src/embed/mod.rs`
- CREATE `crates/ic-engine/src/embed/local.rs`
- CREATE `crates/ic-engine/tests/embed.rs`
- MODIFY `crates/ic-engine/src/lib.rs` - declare and re-export the embed module
- MODIFY `crates/ic-engine/Cargo.toml` - add `fastembed`, `ort`, and `dirs`
- MODIFY `crates/ic-engine/benches/ingest.rs` - add an embedding throughput benchmark
- MODIFY `crates/ic-engine/README.md` - document the model, the cache directory, and the offline behaviour
- MODIFY `.github/workflows/gate-test.yml` - cache the model directory for the `test-rust` job so the
  fetch happens once per runner rather than once per run

### Acceptance Criteria

- [ ] `dim()` returns 384, matching the `halfvec(384)` column in #25
- [ ] `embed_batch` returns one vector per input, in input order
- [ ] Every returned vector has an L2 norm within `1e-6` of 1.0
- [ ] Embedding the same text twice in one process returns bit-identical vectors
- [ ] An input longer than `max_tokens()` is truncated and embedded rather than returning an error
- [ ] An empty input slice returns an empty vector without loading anything
- [ ] `load` with `offline: true` and an empty cache returns `EmbedError::ModelNotCached` naming the cache directory, with no network call
- [ ] `load` succeeds with no network access once the model is cached, verified by loading twice with the second call offline
- [ ] `embed_batch` is callable concurrently from several threads through a shared reference

### Required Tests

- `embeds_a_batch_into_384_dimension_vectors`
- `returns_unit_length_vectors`
- `is_deterministic_for_the_same_input`
- `truncates_an_input_longer_than_the_model_window`
- `returns_an_empty_result_for_an_empty_batch`
- `fails_with_model_not_cached_when_offline_and_the_cache_is_empty`
- `loads_from_the_cache_with_no_network_after_the_first_fetch`
- `embeds_from_several_threads_through_one_shared_embedder`

### Performance Budget

At least 700 chunks per second for 128-token inputs at `batch_size: 64` on the eight-vCPU CI runner,
measured by the `embed` criterion benchmark. Resident memory attributable to the loaded model stays
under 120MB. The first model fetch completes in under 90 seconds and every later load is offline. This
stage is allocated 65 of the epic's 120-second whole-pipeline budget, which is the largest single share
and the reason the throughput figure is a gate rather than a note: the fixture's roughly 45k chunks at
700 per second is 64 seconds.

### Out of Scope

- Do not add a hosted embedding provider. The trait exists so one can be added later, and adding it now
  means a credentials story that #61 owns
- Do not write embeddings to Postgres; that is
  `docs/issues/epic-3-engine/040-index-writes-to-postgres.md`
- Do not measure or tune retrieval recall. The int8-versus-fp32 recall comparison belongs to the
  retrieval epic (#5), where the golden set exists
- Do not commit model weights to the repository. Only the tokeniser is committed, and it landed with
  the chunker
- Do not add a GPU execution provider. It changes the dependency surface for a machine class this
  product does not assume

### Dependencies

Blocked by the tokeniser committed in
`docs/issues/epic-3-engine/020-tree-sitter-parsing-and-chunking.md`. The 384-dimension output is fixed
by the `halfvec(384)` column in #25.

### Verification

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-features --workspace
cargo bench -- embed --noplot
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
