//! Community detection benchmarks.
//!
//! The budget Gate 6 holds this to is 100,000 nodes and 400,000 edges
//! partitioned in under five seconds on one thread, which is the size of a large
//! monorepo's symbol graph. The graph is a planted partition rather than a real
//! repository: it is reproducible from a seed, it costs nothing to keep in the
//! tree, and its density per node is what decides the runtime.

use std::hint::black_box;
use std::time::Duration;

use criterion::{Criterion, SamplingMode, criterion_group, criterion_main};
use ic_engine::{CodeGraph, LeidenConfig, detect_communities};
use petgraph::graph::UnGraph;
use rand::{Rng, SeedableRng, rngs::StdRng};

const NODES: usize = 100_000;
const EDGES: usize = 400_000;
const COMMUNITIES: usize = 2_000;
/// Share of edges that stay inside a planted community. Real code graphs are
/// more clustered than this; a weaker signal means more local moves before the
/// partition settles, so the measurement errs towards pessimistic.
const INTERNAL_SHARE: f64 = 0.85;

/// A planted-partition graph of `NODES` symbols in `COMMUNITIES` modules.
fn planted_partition(seed: u64) -> CodeGraph {
    let mut rng = StdRng::seed_from_u64(seed);
    let per_community = NODES / COMMUNITIES;

    let node_names: Vec<String> = (0..NODES)
        .map(|node| {
            let module = node / per_community;
            format!("src/mod{module:05}/index.ts::symbol{node:06}")
        })
        .collect();

    let mut graph: UnGraph<u32, f32> = UnGraph::with_capacity(NODES, EDGES);
    for node in 0..NODES {
        graph.add_node(u32::try_from(node).unwrap_or(u32::MAX));
    }

    let mut placed = 0usize;
    while placed < EDGES {
        let source = rng.random_range(0..NODES);
        let target = if rng.random::<f64>() < INTERNAL_SHARE {
            let module = source / per_community;
            module * per_community + rng.random_range(0..per_community)
        } else {
            rng.random_range(0..NODES)
        };
        if source == target {
            continue;
        }
        let weight = if source / per_community == target / per_community {
            2.0
        } else {
            1.0
        };
        graph.add_edge(
            u32::try_from(source).unwrap_or(u32::MAX).into(),
            u32::try_from(target).unwrap_or(u32::MAX).into(),
            weight,
        );
        placed += 1;
    }

    CodeGraph { node_names, graph }
}

fn detect_large_graph(c: &mut Criterion) {
    let graph = planted_partition(0x5eed_0092);
    let config = LeidenConfig::default();

    let mut group = c.benchmark_group("communities");
    // Ten flat samples rather than the default hundred on a linear ramp, which
    // would be some 5,000 partitions of a 100,000 node graph. Flat also keeps
    // the iteration count low enough that the run's resident set still resembles
    // one partition's: each pass allocates and frees a member name per node per
    // level, and the system allocator holds those pages rather than returning
    // them.
    group
        .sample_size(10)
        .sampling_mode(SamplingMode::Flat)
        .warm_up_time(Duration::from_millis(500))
        .measurement_time(Duration::from_millis(1_500));
    group.bench_function("detect_100k_nodes", |b| {
        b.iter(|| detect_communities(black_box(&graph), black_box(config)));
    });
    group.finish();
}

criterion_group!(benches, detect_large_graph);
criterion_main!(benches);
