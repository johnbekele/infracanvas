//! Ingest benchmarks.
//!
//! Gate 6 compares each run against a stored baseline. Establishing the harness
//! alongside the code it measures means the first real benchmark has somewhere
//! to land. The `walk` bench exercises the repository walker over a generated
//! tree; the epic's 100k-file fixture is owned by the index issue / Gate 6.

use std::fs;
use std::hint::black_box;
use std::path::Path;

use criterion::{Criterion, criterion_group, criterion_main};
use ic_engine::{EngineConfig, WalkOptions, walk};
use tempfile::TempDir;

fn config_resolution(c: &mut Criterion) {
    c.bench_function("worker_threads", |b| {
        b.iter(|| black_box(EngineConfig::default()).worker_threads());
    });
}

fn write_tree(root: &Path, files: usize) {
    for i in 0..files {
        let dir = root.join(format!("d{:04}", i % 64));
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join(format!("f{i:05}.txt"));
        fs::write(&path, format!("content-{i}\n")).expect("write");
    }
}

fn walk_generated_tree(c: &mut Criterion) {
    let dir = TempDir::new().expect("tempdir");
    // Large enough to exercise parallel hashing; the Gate 6 fixture is separate.
    write_tree(dir.path(), 2_048);

    let mut options = WalkOptions::new(dir.path());
    options.concurrency = 8;

    c.bench_function("walk", |b| {
        b.iter(|| {
            let manifest = walk(black_box(&options)).expect("walk");
            black_box(manifest.root_hash);
        });
    });
}

criterion_group!(benches, config_resolution, walk_generated_tree);
criterion_main!(benches);
