//! Ingest benchmarks.
//!
//! Gate 6 compares each run against a stored baseline. Establishing the harness
//! alongside the code it measures means the first real benchmark has somewhere
//! to land. The `walk` bench exercises the repository walker over a generated
//! tree; the `chunk` bench measures AST-boundary chunking of `tests/data/sample.ts`;
//! the `embed` bench measures local embedding throughput for 128-token inputs.

use std::fs;
use std::hint::black_box;
use std::path::Path;

use criterion::{Criterion, Throughput, criterion_group, criterion_main};
use ic_engine::{
    ChunkOptions, Embedder, EngineConfig, Language, LocalEmbedder, LocalEmbedderOptions,
    WalkOptions, chunk_file, walk,
};
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

fn chunk_sample_typescript(c: &mut Criterion) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/sample.ts");
    let source = fs::read_to_string(&path).expect("sample.ts");
    let options = ChunkOptions::default();

    c.bench_function("chunk", |b| {
        b.iter(|| {
            let chunks = chunk_file(
                black_box(&source),
                Some(Language::TypeScript),
                black_box(&options),
            )
            .expect("chunk");
            black_box(chunks.len());
        });
    });
}

fn embed_batch_throughput(c: &mut Criterion) {
    let mut options = LocalEmbedderOptions {
        batch_size: 64,
        ..LocalEmbedderOptions::default()
    };
    if LocalEmbedder::is_cached(&options) {
        options.offline = true;
    }
    let embedder = LocalEmbedder::load(&options).expect("load embedder");

    // Roughly 128 WordPiece tokens: repeated short tokens keep length stable.
    let sample = "alpha beta gamma delta ".repeat(32);
    let batch: Vec<&str> = std::iter::repeat_n(sample.as_str(), 64).collect();
    let batch_len = batch.len() as u64;

    let mut group = c.benchmark_group("embed");
    group.throughput(Throughput::Elements(batch_len));
    group.bench_function("embed", |b| {
        b.iter(|| {
            let vectors = embedder
                .embed_batch(black_box(batch.as_slice()))
                .expect("embed");
            black_box(vectors.len());
        });
    });
    group.finish();
}

criterion_group!(
    benches,
    config_resolution,
    walk_generated_tree,
    chunk_sample_typescript,
    embed_batch_throughput
);
criterion_main!(benches);
