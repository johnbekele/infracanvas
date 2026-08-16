//! How good a partition is, and whether it is one a reader can be shown.
//!
//! Quality is the Constant Potts Model rather than modularity. Modularity has a
//! resolution limit: past a few tens of thousands of nodes it merges genuinely
//! separate modules, which on a large repository leaves three enormous
//! communities and nothing worth summarising. CPM's penalty is a function of
//! community size alone, so the size a resolution produces does not drift as
//! the graph grows.

use petgraph::visit::EdgeRef;

use super::CodeGraph;
use super::leiden::{WorkGraph, as_u32};

/// Quality of a partition under the Constant Potts Model.
///
/// `membership[i]` is the community of node `i`. Every edge inside a community
/// pays in, and every community pays `resolution` for each pair of members it
/// holds, so the resolution is the density a group has to beat to be worth
/// keeping together. Nodes beyond the end of `membership` are treated as absent.
#[must_use]
pub fn cpm_quality(graph: &CodeGraph, membership: &[u32], resolution: f64) -> f64 {
    let sizes = vec![1u32; graph.graph.node_count()];
    let edges = graph.graph.edge_references().map(|edge| {
        (
            edge.source().index(),
            edge.target().index(),
            f64::from(*edge.weight()),
        )
    });
    cpm(membership, &sizes, edges, resolution)
}

/// The same measure over the engine's internal graph, where a node can stand
/// for many original ones.
pub(super) fn work_quality(graph: &WorkGraph, membership: &[u32], resolution: f64) -> f64 {
    let sizes: Vec<u32> = (0..graph.node_count())
        .map(|node| graph.size(node))
        .collect();
    cpm(membership, &sizes, graph.edges(), resolution)
}

fn cpm(
    membership: &[u32],
    sizes: &[u32],
    edges: impl Iterator<Item = (usize, usize, f64)>,
    resolution: f64,
) -> f64 {
    let community_count = membership
        .iter()
        .copied()
        .max()
        .map_or(0, |max| max as usize + 1);
    let mut internal = vec![0f64; community_count];
    let mut occupancy = vec![0f64; community_count];

    for (node, &label) in membership.iter().enumerate() {
        if let Some(slot) = occupancy.get_mut(label as usize) {
            *slot += f64::from(sizes.get(node).copied().unwrap_or(1));
        }
    }
    for (from, to, weight) in edges {
        let (Some(&left), Some(&right)) = (membership.get(from), membership.get(to)) else {
            continue;
        };
        if left != right {
            continue;
        }
        if let Some(slot) = internal.get_mut(left as usize) {
            *slot += weight;
        }
    }

    internal
        .iter()
        .zip(occupancy.iter())
        .map(|(&weight, &size)| weight - resolution * size * (size - 1.0) / 2.0)
        .sum()
}

/// True when every community can be walked end to end without leaving itself.
///
/// A community that fails this is a set of unrelated symbols wearing one name,
/// and the summary built from it in the next stage would be worse than no
/// summary at all.
#[must_use]
pub fn is_internally_connected(graph: &CodeGraph, membership: &[u32]) -> bool {
    let node_count = graph.graph.node_count();
    if membership.len() < node_count {
        return false;
    }
    let edges: Vec<(u32, u32, f64)> = graph
        .graph
        .edge_references()
        .map(|edge| {
            (
                as_u32(edge.source().index()),
                as_u32(edge.target().index()),
                f64::from(*edge.weight()),
            )
        })
        .collect();
    let work = WorkGraph::new(vec![1u32; node_count], &edges);
    let mut split = membership.to_vec();
    split_disconnected(&work, &mut split);
    group_count(&split) == group_count(membership)
}

/// Give each connected part of a community a community of its own.
///
/// Refinement makes this a formality on a partition the algorithm produced, and
/// it is not a formality on one that has since been coarsened or reconciled
/// against the level below, which is where a disconnected group would otherwise
/// slip through.
pub(super) fn split_disconnected(graph: &WorkGraph, membership: &mut [u32]) {
    let node_count = graph.node_count();
    let mut assigned: Vec<u32> = vec![u32::MAX; node_count];
    let mut next = 0u32;
    let mut stack: Vec<usize> = Vec::new();

    for node in 0..node_count {
        if assigned.get(node).copied() != Some(u32::MAX) {
            continue;
        }
        let Some(&label) = membership.get(node) else {
            continue;
        };
        let component = next;
        next += 1;
        if let Some(slot) = assigned.get_mut(node) {
            *slot = component;
        }
        stack.push(node);
        while let Some(current) = stack.pop() {
            for (other, _) in graph.neighbours(current) {
                if membership.get(other).copied() != Some(label) {
                    continue;
                }
                if assigned.get(other).copied() != Some(u32::MAX) {
                    continue;
                }
                if let Some(slot) = assigned.get_mut(other) {
                    *slot = component;
                }
                stack.push(other);
            }
        }
    }

    for (slot, component) in membership.iter_mut().zip(assigned) {
        *slot = component;
    }
}

fn group_count(membership: &[u32]) -> usize {
    let mut seen: Vec<u32> = membership.to_vec();
    seen.sort_unstable();
    seen.dedup();
    seen.len()
}
