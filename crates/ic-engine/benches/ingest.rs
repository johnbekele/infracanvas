//! Ingest benchmarks.
//!
//! Wired but nearly empty. Gate 6 compares each run against a stored baseline,
//! and a harness that only appears alongside the code it measures has no
//! baseline to compare against on the day it is needed. Establishing it now
//! means the first real benchmark has somewhere to land.

use criterion::{Criterion, criterion_group, criterion_main};
use ic_engine::EngineConfig;
use std::hint::black_box;

fn config_resolution(c: &mut Criterion) {
    c.bench_function("worker_threads", |b| {
        b.iter(|| black_box(EngineConfig::default()).worker_threads());
    });
}

criterion_group!(benches, config_resolution);
criterion_main!(benches);
