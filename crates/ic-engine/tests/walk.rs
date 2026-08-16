//! Integration tests for the repository walker.

use std::fs;
use std::path::{Path, PathBuf};

use ic_engine::{ManifestDiff, SkipReason, WalkError, WalkOptions, walk};

fn write_file(root: &Path, rel: &str, contents: &[u8]) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    fs::write(&path, contents).expect("write file");
}

fn walk_root(root: &Path) -> ic_engine::RepoManifest {
    walk(&WalkOptions::new(root)).expect("walk should succeed")
}

#[test]
fn walks_a_tree_and_records_every_text_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_file(dir.path(), "README.md", b"# hello");
    write_file(dir.path(), "src/main.rs", b"fn main() {}");
    write_file(dir.path(), "src/lib.rs", b"pub fn f() {}");

    let manifest = walk_root(dir.path());
    let paths: Vec<_> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["README.md", "src/lib.rs", "src/main.rs"]);
    assert!(manifest.files.iter().all(|f| !f.sha256.is_empty()));
    assert!(manifest.bytes_read > 0);
}

#[test]
fn honours_gitignore_without_a_git_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_file(dir.path(), ".gitignore", b"secret.txt\n");
    write_file(dir.path(), "keep.txt", b"visible");
    write_file(dir.path(), "secret.txt", b"hidden");

    // No `.git` directory — require_git(false) must still honour .gitignore.
    assert!(!dir.path().join(".git").exists());

    let manifest = walk_root(dir.path());
    assert!(manifest.get("keep.txt").is_some());
    assert!(manifest.get("secret.txt").is_none());

    let skipped = manifest
        .skipped
        .iter()
        .find(|s| s.path == "secret.txt")
        .expect("secret.txt recorded as skipped");
    assert_eq!(skipped.reason, SkipReason::Ignored);
}

#[test]
fn applies_the_builtin_deny_list_on_top_of_ignore_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_file(dir.path(), "app.js", b"console.log(1)");
    write_file(dir.path(), "app.min.js", b"console.log(1)");
    write_file(
        dir.path(),
        "node_modules/left-pad/index.js",
        b"module.exports=0",
    );
    write_file(dir.path(), "Cargo.lock", b"# lock");

    let manifest = walk_root(dir.path());
    assert!(manifest.get("app.js").is_some());
    assert!(manifest.get("app.min.js").is_none());
    assert!(manifest.get("Cargo.lock").is_none());
    assert!(manifest.get("node_modules/left-pad/index.js").is_none());

    let min_js = manifest
        .skipped
        .iter()
        .find(|s| s.path == "app.min.js")
        .expect("min.js skipped");
    assert_eq!(min_js.reason, SkipReason::Ignored);

    // Denied directories are pruned: contents are not recorded as skipped entries.
    assert!(
        !manifest
            .skipped
            .iter()
            .any(|s| s.path.starts_with("node_modules/"))
    );
}

#[test]
fn skips_a_file_over_the_size_cap_without_reading_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let big = vec![b'x'; 64];
    write_file(dir.path(), "big.txt", &big);

    // Marker file that would change if someone truncated/replaced big.txt while reading.
    // We only assert TooLarge with the metadata size and that it is not in `files`.
    let mut options = WalkOptions::new(dir.path());
    options.max_file_bytes = 32;

    let before = fs::metadata(dir.path().join("big.txt"))
        .expect("metadata")
        .modified()
        .expect("mtime");

    let manifest = walk(&options).expect("walk");
    assert!(manifest.get("big.txt").is_none());
    let skipped = manifest
        .skipped
        .iter()
        .find(|s| s.path == "big.txt")
        .expect("skipped");
    assert_eq!(skipped.reason, SkipReason::TooLarge { size_bytes: 64 });
    assert_eq!(manifest.bytes_read, 0);

    let after = fs::metadata(dir.path().join("big.txt"))
        .expect("metadata")
        .modified()
        .expect("mtime");
    assert_eq!(
        before, after,
        "too-large files must not be opened for hashing"
    );
}

#[test]
fn skips_a_binary_file_detected_by_a_nul_byte() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_file(dir.path(), "text.txt", b"plain");
    write_file(dir.path(), "blob.bin", b"abc\0def");

    let manifest = walk_root(dir.path());
    assert!(manifest.get("text.txt").is_some());
    assert!(manifest.get("blob.bin").is_none());
    let skipped = manifest
        .skipped
        .iter()
        .find(|s| s.path == "blob.bin")
        .expect("binary skipped");
    assert_eq!(skipped.reason, SkipReason::Binary);
}

#[test]
fn never_reads_through_a_symlink_that_escapes_the_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let outside = tempfile::tempdir().expect("outside");
    let secret = outside.path().join("passwd");
    fs::write(&secret, b"root:x:0:0").expect("write outside secret");

    let link = dir.path().join("escape");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&secret, &link).expect("symlink");
    #[cfg(not(unix))]
    {
        let _ = (secret, link);
        return;
    }

    // If the walker followed the symlink it would hash outside content.
    let manifest = walk_root(dir.path());
    assert!(manifest.get("escape").is_none());
    let skipped = manifest
        .skipped
        .iter()
        .find(|s| s.path == "escape")
        .expect("symlink skipped");
    assert_eq!(skipped.reason, SkipReason::OutsideRoot);
    // Outside content must never appear as a hashed file path.
    assert!(manifest.files.is_empty());
}

#[test]
fn root_hash_is_stable_across_two_walks_and_moves_on_a_one_byte_change() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_file(dir.path(), "a.txt", b"alpha");
    write_file(dir.path(), "b.txt", b"beta");

    let first = walk_root(dir.path());
    let second = walk_root(dir.path());
    assert_eq!(first.root_hash, second.root_hash);

    write_file(dir.path(), "a.txt", b"alphB");
    let third = walk_root(dir.path());
    assert_ne!(first.root_hash, third.root_hash);

    // Crossing the size cap without changing contents still moves the root hash
    // because the entry becomes a skipped leaf in the Merkle tree.
    let mut over = WalkOptions::new(dir.path());
    over.max_file_bytes = 2;
    let capped = walk(&over).expect("walk with cap");
    assert_ne!(third.root_hash, capped.root_hash);
}

#[test]
fn diff_reports_only_the_changed_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_file(dir.path(), "keep.txt", b"same");
    write_file(dir.path(), "old.txt", b"gone");
    write_file(dir.path(), "edit.txt", b"v1");

    let previous = walk_root(dir.path());

    fs::remove_file(dir.path().join("old.txt")).expect("remove");
    write_file(dir.path(), "edit.txt", b"v2");
    write_file(dir.path(), "new.txt", b"fresh");

    let current = walk_root(dir.path());
    let diff = current.diff(&previous);

    assert_eq!(diff.added, vec!["new.txt"]);
    assert_eq!(diff.modified, vec!["edit.txt"]);
    assert_eq!(diff.removed, vec!["old.txt"]);
    assert_eq!(diff.unchanged, vec!["keep.txt"]);
    assert_eq!(diff.changed_count(), 3);
    assert!(!diff.is_empty());
    assert_eq!(
        diff,
        ManifestDiff {
            added: vec!["new.txt".into()],
            modified: vec!["edit.txt".into()],
            removed: vec!["old.txt".into()],
            unchanged: vec!["keep.txt".into()],
        }
    );
}

#[test]
fn returns_an_error_rather_than_panicking_for_a_missing_root() {
    let missing = PathBuf::from("/definitely/not/a/real/path/for/ic-engine-walk");
    let err = walk(&WalkOptions::new(&missing)).expect_err("must error");
    match err {
        WalkError::RootMissing(path) => assert_eq!(path, missing),
        other => panic!("expected RootMissing, got {other:?}"),
    }
}
