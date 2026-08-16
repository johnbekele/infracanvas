//! Repository walker: ignore rules, content hashing, and a Merkle manifest.
//!
//! Everything the engine does starts with which files are worth reading and
//! which of them changed. This pass answers both: it walks the tree, applies
//! ignore rules and a built-in deny list, hashes readable text files, and
//! returns a [`RepoManifest`] whose root hash is stable across identical trees.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{
    DirEntry, IncrementalIgnore, ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::EngineConfig;
use crate::merkle;

/// Built-in patterns applied on top of ignore files.
///
/// A repository's own `.gitignore` does not always exclude what is useless to
/// index (lockfiles, build output, vendored trees).
pub const BUILTIN_DENY_PATTERNS: &[&str] = &[
    ".git/",
    "node_modules/",
    "target/",
    "dist/",
    "build/",
    ".next/",
    "vendor/",
    "__pycache__/",
    ".venv/",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
    "poetry.lock",
    "Cargo.lock",
    "uv.lock",
];

const READ_CHUNK_BYTES: usize = 64 * 1024;
const BINARY_PROBE_BYTES: usize = 8 * 1024;

/// Options controlling a single repository walk.
#[derive(Debug, Clone)]
pub struct WalkOptions {
    /// Absolute or relative path to the repository root.
    pub root: PathBuf,
    /// Files above this are recorded as skipped rather than hashed.
    pub max_file_bytes: usize,
    /// Zero means one thread per core, as [`EngineConfig::worker_threads`] resolves it.
    pub concurrency: usize,
    /// Honour `.gitignore` and `.ignore`. False only for tests that need a raw walk.
    pub respect_ignore_files: bool,
    /// Additional gitignore-syntax patterns, applied after the built-in deny list.
    pub extra_ignores: Vec<String>,
}

impl WalkOptions {
    /// Defaults taken from [`EngineConfig::default`].
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let defaults = EngineConfig::default();
        Self {
            root: root.into(),
            max_file_bytes: defaults.max_file_bytes,
            concurrency: defaults.concurrency,
            respect_ignore_files: true,
            extra_ignores: Vec::new(),
        }
    }

    fn worker_threads(&self) -> usize {
        EngineConfig {
            max_file_bytes: self.max_file_bytes,
            concurrency: self.concurrency,
        }
        .worker_threads()
    }
}

/// A readable text file discovered by the walker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord {
    /// Slash-separated and relative to the root. Never absolute, never contains `..`.
    pub path: String,
    /// Size in bytes as reported by the filesystem before reading.
    pub size_bytes: u64,
    /// Lowercase hex SHA-256 of the contents, written straight into `files.sha256`.
    pub sha256: String,
}

/// Why a path was not hashed into the manifest's file list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    /// File exceeded [`WalkOptions::max_file_bytes`]; contents were not read.
    TooLarge {
        /// Size from metadata.
        size_bytes: u64,
    },
    /// A NUL byte appeared in the first 8 KiB.
    Binary,
    /// Excluded by an ignore file, the built-in deny list, or `extra_ignores`.
    Ignored,
    /// A symlink, or an entry resolving outside the root.
    OutsideRoot,
    /// Path is not valid UTF-8; the walk continues.
    NonUtf8Path,
    /// Open or read failed.
    Unreadable {
        /// Underlying IO error message.
        message: String,
    },
}

/// A path that was seen but not hashed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedFile {
    /// Slash-separated relative path when UTF-8; lossy otherwise.
    pub path: String,
    /// Classification for Merkle participation and diagnostics.
    pub reason: SkipReason,
}

/// Result of walking a repository once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoManifest {
    /// Root that was walked.
    pub root: PathBuf,
    /// Hex SHA-256 of the Merkle root over the tree.
    pub root_hash: String,
    /// Sorted by `path`, so two walks of one tree produce identical manifests.
    pub files: Vec<FileRecord>,
    /// Sorted by `path`.
    pub skipped: Vec<SkippedFile>,
    /// Total bytes read while hashing (excludes skipped files).
    pub bytes_read: u64,
}

impl RepoManifest {
    /// Lookup a file record by relative path.
    #[must_use]
    pub fn get(&self, path: &str) -> Option<&FileRecord> {
        self.files
            .binary_search_by(|f| f.path.as_str().cmp(path))
            .ok()
            .and_then(|idx| self.files.get(idx))
    }

    /// Paths present here and absent from `previous` are added; differing hashes are modified.
    #[must_use]
    pub fn diff(&self, previous: &RepoManifest) -> ManifestDiff {
        let mut diff = ManifestDiff::default();
        let mut i = 0;
        let mut j = 0;

        while i < self.files.len() || j < previous.files.len() {
            match (self.files.get(i), previous.files.get(j)) {
                (Some(cur), Some(prev)) => match cur.path.cmp(&prev.path) {
                    std::cmp::Ordering::Less => {
                        diff.added.push(cur.path.clone());
                        i += 1;
                    }
                    std::cmp::Ordering::Greater => {
                        diff.removed.push(prev.path.clone());
                        j += 1;
                    }
                    std::cmp::Ordering::Equal => {
                        if cur.sha256 == prev.sha256 {
                            diff.unchanged.push(cur.path.clone());
                        } else {
                            diff.modified.push(cur.path.clone());
                        }
                        i += 1;
                        j += 1;
                    }
                },
                (Some(cur), None) => {
                    diff.added.push(cur.path.clone());
                    i += 1;
                }
                (None, Some(prev)) => {
                    diff.removed.push(prev.path.clone());
                    j += 1;
                }
                (None, None) => break,
            }
        }

        diff
    }
}

/// Classification of path-level changes between two manifests.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ManifestDiff {
    /// Present in the new manifest only.
    pub added: Vec<String>,
    /// Present in both with different content hashes.
    pub modified: Vec<String>,
    /// Present in the previous manifest only.
    pub removed: Vec<String>,
    /// Present in both with identical content hashes.
    pub unchanged: Vec<String>,
}

impl ManifestDiff {
    /// True when no path was added, modified, or removed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.removed.is_empty()
    }

    /// Count of paths that are not unchanged.
    #[must_use]
    pub fn changed_count(&self) -> usize {
        self.added.len() + self.modified.len() + self.removed.len()
    }
}

/// Fatal errors that abort a walk before a manifest can be produced.
#[derive(Debug, Error)]
pub enum WalkError {
    /// The configured root path does not exist.
    #[error("root {0} does not exist")]
    RootMissing(PathBuf),
    /// The configured root exists but is not a directory.
    #[error("root {0} is not a directory")]
    RootNotADirectory(PathBuf),
    /// Directory enumeration failed in a way that cannot be recorded as a skip.
    #[error("failed to enumerate {path}: {message}")]
    Enumerate {
        /// Path that could not be enumerated.
        path: String,
        /// Underlying error message.
        message: String,
    },
}

#[derive(Debug)]
enum WalkOutcome {
    File(FileRecord),
    Skipped(SkippedFile),
}

struct WalkCollector {
    outcomes: Arc<Mutex<Vec<WalkOutcome>>>,
    fatal: Arc<Mutex<Option<WalkError>>>,
}

struct Visitor {
    root: PathBuf,
    max_file_bytes: usize,
    deny: Arc<Gitignore>,
    ignore_matcher: Arc<Mutex<Option<IncrementalIgnore>>>,
    outcomes: Arc<Mutex<Vec<WalkOutcome>>>,
    fatal: Arc<Mutex<Option<WalkError>>>,
}

impl ParallelVisitor for Visitor {
    fn visit(&mut self, entry: Result<DirEntry, ignore::Error>) -> WalkState {
        if self.fatal.lock().map_or(true, |g| g.is_some()) {
            return WalkState::Quit;
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                if let Ok(mut guard) = self.fatal.lock() {
                    *guard = Some(WalkError::Enumerate {
                        path: "<walk>".to_owned(),
                        message: err.to_string(),
                    });
                }
                return WalkState::Quit;
            }
        };

        if entry.depth() == 0 {
            return WalkState::Continue;
        }

        if let Some(outcome) = process_entry(
            &entry,
            &self.root,
            self.max_file_bytes,
            &self.deny,
            &self.ignore_matcher,
        ) && let Ok(mut guard) = self.outcomes.lock()
        {
            guard.push(outcome);
        }

        WalkState::Continue
    }
}

struct VisitorBuilder {
    root: PathBuf,
    max_file_bytes: usize,
    deny: Arc<Gitignore>,
    ignore_matcher: Arc<Mutex<Option<IncrementalIgnore>>>,
    outcomes: Arc<Mutex<Vec<WalkOutcome>>>,
    fatal: Arc<Mutex<Option<WalkError>>>,
}

impl<'s> ParallelVisitorBuilder<'s> for VisitorBuilder {
    fn build(&mut self) -> Box<dyn ParallelVisitor + 's> {
        Box::new(Visitor {
            root: self.root.clone(),
            max_file_bytes: self.max_file_bytes,
            deny: Arc::clone(&self.deny),
            ignore_matcher: Arc::clone(&self.ignore_matcher),
            outcomes: Arc::clone(&self.outcomes),
            fatal: Arc::clone(&self.fatal),
        })
    }
}

/// Walk `options.root` and build a content-addressed manifest.
///
/// Hashing happens inside the parallel visitor so reading and hashing overlap.
/// Contents are read in 64 KiB chunks rather than into one buffer.
///
/// # Errors
///
/// Returns [`WalkError::RootMissing`] or [`WalkError::RootNotADirectory`] when
/// the root is unusable, or [`WalkError::Enumerate`] when building ignore
/// matchers fails fatally.
pub fn walk(options: &WalkOptions) -> Result<RepoManifest, WalkError> {
    let root_abs = resolve_root(&options.root)?;
    let deny = Arc::new(build_deny_matcher(&root_abs, &options.extra_ignores)?);
    let ignore_matcher = Arc::new(Mutex::new(build_ignore_matcher(
        &root_abs,
        options.respect_ignore_files,
    )));
    let collector = WalkCollector {
        outcomes: Arc::new(Mutex::new(Vec::new())),
        fatal: Arc::new(Mutex::new(None)),
    };

    run_parallel_walk(
        &root_abs,
        options.worker_threads(),
        options.max_file_bytes,
        Arc::clone(&deny),
        Arc::clone(&ignore_matcher),
        &collector,
    );

    if let Some(err) = take_fatal(&collector.fatal, &root_abs)? {
        return Err(err);
    }

    assemble_manifest(root_abs, &collector.outcomes)
}

fn resolve_root(root: &Path) -> Result<PathBuf, WalkError> {
    let meta = fs::metadata(root).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            WalkError::RootMissing(root.to_path_buf())
        } else {
            WalkError::Enumerate {
                path: root.display().to_string(),
                message: err.to_string(),
            }
        }
    })?;
    if !meta.is_dir() {
        return Err(WalkError::RootNotADirectory(root.to_path_buf()));
    }
    root.canonicalize().map_err(|err| WalkError::Enumerate {
        path: root.display().to_string(),
        message: err.to_string(),
    })
}

fn run_parallel_walk(
    root_abs: &Path,
    threads: usize,
    max_file_bytes: usize,
    deny: Arc<Gitignore>,
    ignore_matcher: Arc<Mutex<Option<IncrementalIgnore>>>,
    collector: &WalkCollector,
) {
    let mut builder = WalkBuilder::new(root_abs);
    builder
        .standard_filters(false)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .parents(false)
        .threads(threads);

    let filter_deny = Arc::clone(&deny);
    let filter_ignore = Arc::clone(&ignore_matcher);
    let filter_root = root_abs.to_path_buf();
    builder.filter_entry(move |entry| {
        if entry.depth() == 0 {
            return true;
        }
        let is_dir = entry.file_type().is_some_and(|ft| ft.is_dir());
        if !is_dir {
            return true;
        }
        // Prune ignored directories so their contents never appear.
        !directory_is_ignored(entry.path(), &filter_root, &filter_deny, &filter_ignore)
    });

    let mut visitor_builder = VisitorBuilder {
        root: root_abs.to_path_buf(),
        max_file_bytes,
        deny,
        ignore_matcher,
        outcomes: Arc::clone(&collector.outcomes),
        fatal: Arc::clone(&collector.fatal),
    };
    builder.build_parallel().visit(&mut visitor_builder);
}

fn take_fatal(
    fatal: &Mutex<Option<WalkError>>,
    root_abs: &Path,
) -> Result<Option<WalkError>, WalkError> {
    fatal
        .lock()
        .map(|mut guard| guard.take())
        .map_err(|e| WalkError::Enumerate {
            path: root_abs.display().to_string(),
            message: e.to_string(),
        })
}

fn assemble_manifest(
    root_abs: PathBuf,
    outcomes: &Mutex<Vec<WalkOutcome>>,
) -> Result<RepoManifest, WalkError> {
    let collected = outcomes.lock().map_err(|e| WalkError::Enumerate {
        path: root_abs.display().to_string(),
        message: e.to_string(),
    })?;

    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut bytes_read = 0_u64;

    for outcome in collected.iter() {
        match outcome {
            WalkOutcome::File(record) => {
                bytes_read = bytes_read.saturating_add(record.size_bytes);
                files.push(record.clone());
            }
            WalkOutcome::Skipped(record) => skipped.push(record.clone()),
        }
    }
    drop(collected);

    files.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort_by(|a, b| a.path.cmp(&b.path));
    let root_hash = merkle::root_hash(&files, &skipped);

    Ok(RepoManifest {
        root: root_abs,
        root_hash,
        files,
        skipped,
        bytes_read,
    })
}

fn build_deny_matcher(root: &Path, extra: &[String]) -> Result<Gitignore, WalkError> {
    let mut builder = GitignoreBuilder::new(root);
    for pattern in BUILTIN_DENY_PATTERNS {
        builder
            .add_line(None, pattern)
            .map_err(|err| WalkError::Enumerate {
                path: root.display().to_string(),
                message: format!("invalid deny pattern {pattern}: {err}"),
            })?;
    }
    for pattern in extra {
        builder
            .add_line(None, pattern)
            .map_err(|err| WalkError::Enumerate {
                path: root.display().to_string(),
                message: format!("invalid extra ignore pattern {pattern}: {err}"),
            })?;
    }
    builder.build().map_err(|err| WalkError::Enumerate {
        path: root.display().to_string(),
        message: err.to_string(),
    })
}

fn build_ignore_matcher(root: &Path, respect_ignore_files: bool) -> Option<IncrementalIgnore> {
    if !respect_ignore_files {
        return None;
    }
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(true)
        .ignore(true)
        .git_global(false)
        .git_exclude(false)
        .parents(false);
    builder.build_matchers().pop()
}

fn directory_is_ignored(
    path: &Path,
    root: &Path,
    deny: &Gitignore,
    ignore_matcher: &Mutex<Option<IncrementalIgnore>>,
) -> bool {
    let Some(rel) = relative_path(root, path) else {
        return true;
    };
    if deny.matched(&rel, true).is_ignore() {
        return true;
    }
    let Ok(mut guard) = ignore_matcher.lock() else {
        return false;
    };
    match guard.as_mut() {
        Some(matcher) => matcher.matched(&rel, true).is_ignore(),
        None => false,
    }
}

fn process_entry(
    entry: &DirEntry,
    root: &Path,
    max_file_bytes: usize,
    deny: &Gitignore,
    ignore_matcher: &Mutex<Option<IncrementalIgnore>>,
) -> Option<WalkOutcome> {
    let path = entry.path();

    let ft = match entry.file_type() {
        Some(ft) => ft,
        None => match fs::symlink_metadata(path) {
            Ok(meta) => meta.file_type(),
            Err(err) => {
                return Some(WalkOutcome::Skipped(SkippedFile {
                    path: path_string_lossy(root, path),
                    reason: SkipReason::Unreadable {
                        message: err.to_string(),
                    },
                }));
            }
        },
    };

    if ft.is_dir() {
        return None;
    }

    let Some(rel) = relative_path(root, path) else {
        return Some(WalkOutcome::Skipped(SkippedFile {
            path: path.display().to_string(),
            reason: SkipReason::OutsideRoot,
        }));
    };

    let path_str = match rel.to_str() {
        Some(s) => s.replace('\\', "/"),
        None => {
            return Some(WalkOutcome::Skipped(SkippedFile {
                path: rel.to_string_lossy().replace('\\', "/"),
                reason: SkipReason::NonUtf8Path,
            }));
        }
    };

    if ft.is_symlink() {
        return Some(WalkOutcome::Skipped(SkippedFile {
            path: path_str,
            reason: SkipReason::OutsideRoot,
        }));
    }

    if is_ignored(&rel, false, deny, ignore_matcher) {
        return Some(WalkOutcome::Skipped(SkippedFile {
            path: path_str,
            reason: SkipReason::Ignored,
        }));
    }

    // Confirm the resolved path stays under the root (defence in depth).
    if let Ok(canonical) = path.canonicalize()
        && !canonical.starts_with(root)
    {
        return Some(WalkOutcome::Skipped(SkippedFile {
            path: path_str,
            reason: SkipReason::OutsideRoot,
        }));
    }

    match hash_text_file(path, max_file_bytes) {
        HashResult::File { size_bytes, sha256 } => Some(WalkOutcome::File(FileRecord {
            path: path_str,
            size_bytes,
            sha256,
        })),
        HashResult::Skipped(reason) => Some(WalkOutcome::Skipped(SkippedFile {
            path: path_str,
            reason,
        })),
    }
}

fn is_ignored(
    rel: &Path,
    is_dir: bool,
    deny: &Gitignore,
    ignore_matcher: &Mutex<Option<IncrementalIgnore>>,
) -> bool {
    if deny.matched(rel, is_dir).is_ignore() {
        return true;
    }
    let Ok(mut guard) = ignore_matcher.lock() else {
        return false;
    };
    match guard.as_mut() {
        Some(matcher) => matcher.matched(rel, is_dir).is_ignore(),
        None => false,
    }
}

enum HashResult {
    File { size_bytes: u64, sha256: String },
    Skipped(SkipReason),
}

fn hash_text_file(path: &Path, max_file_bytes: usize) -> HashResult {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) => {
            return HashResult::Skipped(SkipReason::Unreadable {
                message: err.to_string(),
            });
        }
    };

    if meta.file_type().is_symlink() {
        return HashResult::Skipped(SkipReason::OutsideRoot);
    }

    let size_bytes = meta.len();
    if size_bytes > max_file_bytes as u64 {
        return HashResult::Skipped(SkipReason::TooLarge { size_bytes });
    }

    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) => {
            return HashResult::Skipped(SkipReason::Unreadable {
                message: err.to_string(),
            });
        }
    };

    let mut hasher = Sha256::new();
    let mut buf = vec![0_u8; READ_CHUNK_BYTES];
    let mut probed = 0_usize;

    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(err) => {
                return HashResult::Skipped(SkipReason::Unreadable {
                    message: err.to_string(),
                });
            }
        };

        if probed < BINARY_PROBE_BYTES {
            let remaining = BINARY_PROBE_BYTES - probed;
            let check = n.min(remaining);
            if buf.get(..check).is_some_and(|slice| slice.contains(&0)) {
                return HashResult::Skipped(SkipReason::Binary);
            }
            probed = probed.saturating_add(check);
        }

        if let Some(slice) = buf.get(..n) {
            hasher.update(slice);
        }
    }

    HashResult::File {
        size_bytes,
        sha256: hex::encode(hasher.finalize()),
    }
}

fn relative_path(root: &Path, path: &Path) -> Option<PathBuf> {
    path.strip_prefix(root)
        .ok()
        .map(Path::to_path_buf)
        .filter(|p| !p.components().any(|c| matches!(c, Component::ParentDir)))
}

fn path_string_lossy(root: &Path, path: &Path) -> String {
    relative_path(root, path).map_or_else(
        || path.display().to_string(),
        |p| p.to_string_lossy().replace('\\', "/"),
    )
}
