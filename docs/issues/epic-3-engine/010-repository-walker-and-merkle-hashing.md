---
title: '[rust] Repository walker with ignore rules and Merkle content hashing'
labels: tier:2, size:m, area:rust, epic:3-engine
---

### Epic

#4

### Context

Everything the engine does starts with the same question: which files are worth reading, and which of
them changed since last time. Getting that wrong is expensive in both directions. Walking into
`node_modules` and a 40MB minified bundle wastes most of the ingest budget on content no one will ever
search for, and re-embedding an unchanged file on every push turns a two-second incremental update
into a full re-index. Both problems are solved by the same pass, so the walker produces a manifest
that records every file it will read together with a content hash.

The hashes are arranged as a Merkle tree rather than a flat list. Two properties pay for the extra
structure. A single root hash compared against the previous run answers "did anything change at all"
without touching a row of the database, which is the common case for a webhook firing on a branch
nobody touched. And per-directory hashes let the diff descend only into subtrees whose hash moved, so
an untouched vendored directory costs one comparison instead of thousands. A flat map of path to hash
gives the second property only at the cost of comparing every entry.

Hashing uses SHA-256, not BLAKE3. BLAKE3 is roughly three times faster on large inputs and would be
the obvious choice for a greenfield design, but #25 already defines `files.sha256`, and renaming a
column on shipped data to save time in a stage that is dominated by file IO and, later, by embedding is
a bad trade. The perf budget below states the measured hashing cost so the decision can be revisited
with a number rather than an instinct if it ever becomes the bottleneck.

Symlinks are not followed, and any entry that resolves outside the root is skipped and recorded. This
is a security decision rather than a tidiness one: a repository can contain a symlink to `/etc/passwd`
or to the user's home directory, and an engine that follows it copies host content into chunks and
embeddings that the repository's own users can then query.

Test trees are built in a `tempfile::TempDir` from a table in the test rather than committed under
`tests/fixtures/`. A committed fixture that needs its own `.gitignore` cannot exist, because git
applies that file to the fixture itself and refuses to track the files the test needs to prove are
ignored.

Spec: `crates/ic-engine/README.md`

### Contract

```rust
// crates/ic-engine/src/walk.rs
use std::path::PathBuf;

pub struct WalkOptions {
    pub root: PathBuf,
    /// Files above this are recorded as skipped rather than hashed.
    pub max_file_bytes: usize,
    /// Zero means one thread per core, as `EngineConfig::worker_threads` resolves it.
    pub concurrency: usize,
    /// Honour `.gitignore` and `.ignore`. False only for tests that need a raw walk.
    pub respect_ignore_files: bool,
    /// Additional gitignore-syntax patterns, applied after the built-in deny list.
    pub extra_ignores: Vec<String>,
}

impl WalkOptions {
    /// Defaults taken from `EngineConfig::default()`.
    pub fn new(root: impl Into<PathBuf>) -> Self;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord {
    /// Slash-separated and relative to the root. Never absolute, never contains `..`.
    pub path: String,
    pub size_bytes: u64,
    /// Lowercase hex SHA-256 of the contents, written straight into `files.sha256`.
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    TooLarge { size_bytes: u64 },
    /// A NUL byte appeared in the first 8 KiB.
    Binary,
    /// Excluded by an ignore file, the built-in deny list, or `extra_ignores`.
    Ignored,
    /// A symlink, or an entry resolving outside the root.
    OutsideRoot,
    NonUtf8Path,
    Unreadable { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedFile {
    pub path: String,
    pub reason: SkipReason,
}

pub struct RepoManifest {
    pub root: PathBuf,
    /// Hex SHA-256 of the Merkle root over the tree.
    pub root_hash: String,
    /// Sorted by `path`, so two walks of one tree produce identical manifests.
    pub files: Vec<FileRecord>,
    pub skipped: Vec<SkippedFile>,
    pub bytes_read: u64,
}

impl RepoManifest {
    pub fn get(&self, path: &str) -> Option<&FileRecord>;
    /// Paths present here and absent from `previous` are added; differing hashes are modified.
    pub fn diff(&self, previous: &RepoManifest) -> ManifestDiff;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ManifestDiff {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub unchanged: Vec<String>,
}

impl ManifestDiff {
    pub fn is_empty(&self) -> bool;
    pub fn changed_count(&self) -> usize;
}

#[derive(Debug, thiserror::Error)]
pub enum WalkError {
    #[error("root {0} does not exist")]
    RootMissing(PathBuf),
    #[error("root {0} is not a directory")]
    RootNotADirectory(PathBuf),
    #[error("failed to enumerate {path}: {message}")]
    Enumerate { path: String, message: String },
}

pub fn walk(options: &WalkOptions) -> Result<RepoManifest, WalkError>;
```

The Merkle construction, stated exactly because two implementations that disagree produce spurious
re-indexes:

```text
file entry     = sha256(contents)
skipped entry  = sha256("skip\0" || reason_discriminant)
directory hash = sha256( for each child, sorted by name as bytes:
                           name || "\0" || kind || "\0" || child_hash || "\n" )
                 where kind is "f", "s", or "d"
root_hash      = directory hash of the root directory
```

Skipped entries participate so that a file crossing the size cap, or a `.gitignore` gaining a line,
changes the root hash. A directory that ends up empty after filtering contributes nothing, so adding
an ignored directory does not invalidate the tree.

The built-in deny list, applied on top of ignore files because a repository's own `.gitignore` does
not always exclude what is useless to index: `.git/`, `node_modules/`, `target/`, `dist/`, `build/`,
`.next/`, `vendor/`, `__pycache__/`, `.venv/`, `*.min.js`, `*.min.css`, `*.map`, `*.lock`,
`pnpm-lock.yaml`, `package-lock.json`, `poetry.lock`, `Cargo.lock`, `uv.lock`.

The walker is built on `ignore::WalkBuilder` with `threads(EngineConfig::worker_threads())`,
`follow_links(false)`, and `require_git(false)`. `require_git(false)` matters: a checkout obtained as a
tarball has no `.git` directory, and the default would then ignore its `.gitignore` entirely. Hashing
happens inside the parallel visitor so reading and hashing overlap, and contents are read in 64 KiB
chunks rather than into one buffer, which keeps peak memory a function of thread count rather than of
file size.

### Files

- CREATE `crates/ic-engine/src/walk.rs`
- CREATE `crates/ic-engine/src/merkle.rs`
- CREATE `crates/ic-engine/tests/walk.rs`
- MODIFY `crates/ic-engine/src/lib.rs` - declare and re-export the walk module
- MODIFY `crates/ic-engine/Cargo.toml` - add `ignore`, `sha2`, `hex`, `thiserror`, and `tempfile` as a dev dependency
- MODIFY `crates/ic-engine/benches/ingest.rs` - add a walk benchmark over a generated tree
- MODIFY `crates/ic-engine/README.md` - document the manifest, the deny list, and the Merkle rule

### Acceptance Criteria

- [ ] `walk` records every readable text file under the root with a relative slash-separated path
- [ ] A file listed in the repository's `.gitignore` is recorded in `skipped` with `SkipReason::Ignored`, not omitted entirely
- [ ] A file over `max_file_bytes` is skipped with its size in the reason and is not read
- [ ] A file with a NUL byte in its first 8 KiB is skipped as `Binary`
- [ ] A symlink pointing outside the root is skipped as `OutsideRoot` and its target is never read
- [ ] `root_hash` is identical across two walks of the same tree and differs after one byte changes
- [ ] `root_hash` changes when a file crosses the size cap without its contents changing
- [ ] `diff` classifies every path as exactly one of added, modified, removed, or unchanged
- [ ] `walk` returns `WalkError::RootMissing` rather than panicking when the root does not exist
- [ ] A path that is not valid UTF-8 is skipped as `NonUtf8Path` and the walk continues

### Required Tests

- `walks_a_tree_and_records_every_text_file`
- `honours_gitignore_without_a_git_directory`
- `applies_the_builtin_deny_list_on_top_of_ignore_files`
- `skips_a_file_over_the_size_cap_without_reading_it`
- `skips_a_binary_file_detected_by_a_nul_byte`
- `never_reads_through_a_symlink_that_escapes_the_root`
- `root_hash_is_stable_across_two_walks_and_moves_on_a_one_byte_change`
- `diff_reports_only_the_changed_paths`
- `returns_an_error_rather_than_panicking_for_a_missing_root`

### Performance Budget

Walking and hashing the 100k-file, 160MB perf fixture completes in under 10 seconds with eight
threads and a warm page cache, measured by the `walk` criterion benchmark. Peak RSS for the walk stage
alone stays under 80MB, which is the manifest itself at roughly 150 bytes per entry plus one 64 KiB
read buffer per thread. `RepoManifest::diff` over two 100k-entry manifests completes in under 250ms.
This stage is allocated 10 of the epic's 120-second whole-pipeline budget.

### Out of Scope

- Do not detect languages or parse anything. `Language` and chunking are
  `docs/issues/epic-3-engine/020-tree-sitter-parsing-and-chunking.md`
- Do not write to Postgres. The manifest is returned, not persisted, until
  `docs/issues/epic-3-engine/040-index-writes-to-postgres.md`
- Do not add CLI subcommands. The CLI surface is
  `docs/issues/epic-3-engine/050-cli-and-pyo3-parity.md`
- Do not touch `.github/workflows/gate-perf.yml`. Its fixture guard and the fixture generator are
  owned by the index issue, which is what Gate 6 actually invokes
- Do not switch the hash algorithm without changing `files.sha256` in #25 first, in its own pull request
- Do not add a file-watching or incremental daemon mode

### Dependencies

Builds on the crate, the lint configuration, and the maturin setup that landed in #31. No open issue
blocks it.

### Verification

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-features --workspace
cargo bench -- walk --noplot
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
