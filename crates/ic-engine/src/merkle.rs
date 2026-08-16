//! Merkle tree construction over a repository walk.
//!
//! The hashes are arranged as a tree rather than a flat list so a single root
//! comparison answers "did anything change", and per-directory hashes let a
//! later diff descend only into subtrees whose hash moved.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::walk::{FileRecord, SkipReason, SkippedFile};

/// Kind marker embedded in a directory's Merkle preimage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// A hashed text file.
    File,
    /// A skipped entry (too large, binary, ignored, …).
    Skipped,
    /// A subdirectory that still has children after filtering.
    Directory,
}

impl EntryKind {
    fn as_byte(self) -> u8 {
        match self {
            Self::File => b'f',
            Self::Skipped => b's',
            Self::Directory => b'd',
        }
    }
}

/// Stable discriminant bytes for a skip reason.
///
/// Only the variant matters: including payloads (size, message) would make the
/// root hash churn for reasons that are not content or classification changes.
#[must_use]
pub fn skip_reason_discriminant(reason: &SkipReason) -> &'static [u8] {
    match reason {
        SkipReason::TooLarge { .. } => b"TooLarge",
        SkipReason::Binary => b"Binary",
        SkipReason::Ignored => b"Ignored",
        SkipReason::OutsideRoot => b"OutsideRoot",
        SkipReason::NonUtf8Path => b"NonUtf8Path",
        SkipReason::Unreadable { .. } => b"Unreadable",
    }
}

/// `sha256("skip\0" || reason_discriminant)`.
#[must_use]
pub fn hash_skipped(reason: &SkipReason) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"skip\0");
    hasher.update(skip_reason_discriminant(reason));
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Directory hash over children sorted by name as bytes.
///
/// Each child contributes `name || "\0" || kind || "\0" || child_hash || "\n"`.
#[must_use]
pub fn hash_directory(children: &[(Vec<u8>, EntryKind, [u8; 32])]) -> [u8; 32] {
    let mut sorted: Vec<&(Vec<u8>, EntryKind, [u8; 32])> = children.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (name, kind, child_hash) in sorted {
        hasher.update(name);
        hasher.update(b"\0");
        hasher.update([kind.as_byte()]);
        hasher.update(b"\0");
        hasher.update(child_hash);
        hasher.update(b"\n");
    }
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[derive(Debug, Default)]
struct DirNode {
    /// Immediate children keyed by path component bytes.
    children: BTreeMap<Vec<u8>, TreeNode>,
}

#[derive(Debug)]
enum TreeNode {
    File([u8; 32]),
    Skipped([u8; 32]),
    Dir(DirNode),
}

impl DirNode {
    fn insert_file(&mut self, components: &[&str], hash: [u8; 32]) {
        match components {
            [] => {}
            [name] => {
                self.children
                    .insert(name.as_bytes().to_vec(), TreeNode::File(hash));
            }
            [name, rest @ ..] => {
                let entry = self
                    .children
                    .entry(name.as_bytes().to_vec())
                    .or_insert_with(|| TreeNode::Dir(DirNode::default()));
                match entry {
                    TreeNode::Dir(dir) => dir.insert_file(rest, hash),
                    TreeNode::File(_) | TreeNode::Skipped(_) => {
                        // A path component cannot be both a leaf and a directory;
                        // prefer keeping the existing leaf and drop the conflict.
                    }
                }
            }
        }
    }

    fn insert_skipped(&mut self, components: &[&str], hash: [u8; 32]) {
        match components {
            [] => {}
            [name] => {
                self.children
                    .insert(name.as_bytes().to_vec(), TreeNode::Skipped(hash));
            }
            [name, rest @ ..] => {
                let entry = self
                    .children
                    .entry(name.as_bytes().to_vec())
                    .or_insert_with(|| TreeNode::Dir(DirNode::default()));
                match entry {
                    TreeNode::Dir(dir) => dir.insert_skipped(rest, hash),
                    TreeNode::File(_) | TreeNode::Skipped(_) => {}
                }
            }
        }
    }

    fn hash(&self) -> Option<[u8; 32]> {
        if self.children.is_empty() {
            return None;
        }
        let mut entries: Vec<(Vec<u8>, EntryKind, [u8; 32])> = Vec::new();
        for (name, node) in &self.children {
            match node {
                TreeNode::File(h) => {
                    entries.push((name.clone(), EntryKind::File, *h));
                }
                TreeNode::Skipped(h) => {
                    entries.push((name.clone(), EntryKind::Skipped, *h));
                }
                TreeNode::Dir(dir) => {
                    // Empty directories after filtering contribute nothing.
                    if let Some(h) = dir.hash() {
                        entries.push((name.clone(), EntryKind::Directory, h));
                    }
                }
            }
        }
        if entries.is_empty() {
            None
        } else {
            Some(hash_directory(&entries))
        }
    }
}

/// Hex SHA-256 of the Merkle root over `files` and `skipped`.
///
/// An empty tree hashes as the directory hash of no children (SHA-256 of empty
/// input), so two empty walks still share a stable root.
#[must_use]
pub fn root_hash(files: &[FileRecord], skipped: &[SkippedFile]) -> String {
    let mut root = DirNode::default();

    for file in files {
        let components: Vec<&str> = file.path.split('/').filter(|s| !s.is_empty()).collect();
        let digest = hex_to_digest(&file.sha256).unwrap_or([0_u8; 32]);
        root.insert_file(&components, digest);
    }

    for skipped_file in skipped {
        let components: Vec<&str> = skipped_file
            .path
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let digest = hash_skipped(&skipped_file.reason);
        root.insert_skipped(&components, digest);
    }

    let digest = root.hash().unwrap_or_else(|| hash_directory(&[]));
    hex::encode(digest)
}

fn hex_to_digest(hex_str: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(hex_str).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{EntryKind, hash_directory, hash_skipped};
    use crate::walk::SkipReason;
    use sha2::{Digest, Sha256};

    fn hash_file_bytes(contents: &[u8]) -> [u8; 32] {
        let digest = Sha256::digest(contents);
        let mut out = [0_u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    #[test]
    fn file_hash_matches_sha256_of_contents() {
        let hash = hash_file_bytes(b"hello");
        assert_eq!(
            hex::encode(hash),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn skipped_hash_depends_on_discriminant_only() {
        let a = hash_skipped(&SkipReason::TooLarge { size_bytes: 1 });
        let b = hash_skipped(&SkipReason::TooLarge { size_bytes: 99 });
        let c = hash_skipped(&SkipReason::Binary);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn directory_hash_is_order_independent_after_sort() {
        let a = (b"a".to_vec(), EntryKind::File, hash_file_bytes(b"1"));
        let b = (b"b".to_vec(), EntryKind::File, hash_file_bytes(b"2"));
        assert_eq!(
            hash_directory(&[a.clone(), b.clone()]),
            hash_directory(&[b, a])
        );
    }
}
