//! The three phases of a Leiden iteration: local moving, refinement, and
//! aggregation, plus the level loop that repeats them.
//!
//! Everything here works on [`WorkGraph`], a compressed adjacency structure
//! rebuilt once per level, rather than on `petgraph` directly. The inner loop
//! reads every neighbour of every node many times per level, and a contiguous
//! row per node is what keeps a 400,000 edge graph inside the five second
//! budget.
//!
//! Node order is the caller's canonical order — ascending `qualified_name` —
//! and every tie in this file is broken towards the lower index. Together with
//! the seeded generator that makes the partition a pure function of the graph.

use std::cmp::Ordering;
use std::collections::VecDeque;

use rand::Rng;
use rand::SeedableRng;
use rand::rngs::StdRng;

use super::LeidenConfig;
use super::quality::work_quality;

/// Spread of the refinement's random choice, `theta` in the paper. Small enough
/// that a merge which barely improves quality is picked rarely, non-zero so the
/// refinement can escape the first subcommunity it happens to reach.
const RANDOMNESS: f64 = 0.01;

/// Node counts come from a repository's symbol table, which is orders of
/// magnitude below the `u32` ceiling; a graph that large exhausts memory long
/// before it reaches this.
pub(super) fn as_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// A weighted undirected graph in compressed adjacency form.
///
/// Self-loops, which aggregation would otherwise produce for every collapsed
/// community, are dropped on construction. They add a constant to every
/// partition's quality and cancel out of every move delta, so storing them
/// would cost memory to compute nothing.
#[derive(Clone)]
pub(super) struct WorkGraph {
    offsets: Vec<usize>,
    targets: Vec<u32>,
    weights: Vec<f64>,
    /// How many original nodes each node stands for: one until aggregation
    /// collapses a community into a single node.
    sizes: Vec<u32>,
}

impl WorkGraph {
    /// `edges` are undirected and must be deduplicated: a pair appears once, in
    /// either direction. Self-loops and endpoints outside `sizes` are ignored.
    pub(super) fn new(sizes: Vec<u32>, edges: &[(u32, u32, f64)]) -> Self {
        let node_count = sizes.len();
        let mut arcs: Vec<(u32, u32, f64)> = Vec::with_capacity(edges.len() * 2);
        for &(u, v, w) in edges {
            if u == v || u as usize >= node_count || v as usize >= node_count {
                continue;
            }
            arcs.push((u, v, w));
            arcs.push((v, u, w));
        }
        // Sorted so a row's neighbours are in ascending order, which is what
        // makes the scan over candidate communities order-independent.
        arcs.sort_unstable_by_key(|&(u, v, _)| (u, v));

        let mut offsets = vec![0usize; node_count + 1];
        for &(u, _, _) in &arcs {
            if let Some(slot) = offsets.get_mut(u as usize + 1) {
                *slot += 1;
            }
        }
        let mut running = 0usize;
        for slot in &mut offsets {
            running += *slot;
            *slot = running;
        }

        Self {
            offsets,
            targets: arcs.iter().map(|&(_, v, _)| v).collect(),
            weights: arcs.iter().map(|&(_, _, w)| w).collect(),
            sizes,
        }
    }

    pub(super) fn node_count(&self) -> usize {
        self.sizes.len()
    }

    pub(super) fn size(&self, node: usize) -> u32 {
        self.sizes.get(node).copied().unwrap_or(0)
    }

    pub(super) fn neighbours(&self, node: usize) -> impl Iterator<Item = (usize, f64)> + '_ {
        let start = self.offsets.get(node).copied().unwrap_or(0);
        let end = self.offsets.get(node + 1).copied().unwrap_or(start);
        let targets = self.targets.get(start..end).unwrap_or(&[]);
        let weights = self.weights.get(start..end).unwrap_or(&[]);
        targets
            .iter()
            .zip(weights.iter())
            .map(|(&target, &weight)| (target as usize, weight))
    }

    /// Every edge once, as `(lower, higher, weight)`.
    pub(super) fn edges(&self) -> impl Iterator<Item = (usize, usize, f64)> + '_ {
        (0..self.node_count()).flat_map(move |node| {
            self.neighbours(node)
                .filter(move |&(other, _)| other > node)
                .map(move |(other, weight)| (node, other, weight))
        })
    }

    fn total_size(&self, members: impl Iterator<Item = usize>) -> u32 {
        members.map(|node| self.size(node)).sum()
    }
}

/// Relabel a membership so its labels are `0..k` in order of first appearance.
///
/// Two partitions that group the same nodes then compare equal, which is what
/// lets the level loop notice that an iteration changed nothing.
pub(super) fn canonicalise(membership: &[u32]) -> Vec<u32> {
    let mut mapping: Vec<u32> = vec![u32::MAX; membership.len()];
    let mut next = 0u32;
    let mut out = Vec::with_capacity(membership.len());
    for &label in membership {
        let slot = mapping.get_mut(label as usize);
        let Some(slot) = slot else {
            out.push(0);
            continue;
        };
        if *slot == u32::MAX {
            *slot = next;
            next += 1;
        }
        out.push(*slot);
    }
    out
}

/// Move each node to the neighbouring community that improves CPM quality most,
/// until no single move improves it.
///
/// The queue is what makes this cheap: only a node whose neighbourhood changed
/// can have a better home than it had a moment ago, so a pass over the whole
/// graph per iteration is wasted work after the first one.
pub(super) fn local_move(graph: &WorkGraph, membership: &mut [u32], resolution: f64) -> bool {
    let node_count = graph.node_count();
    let mut community_size = vec![0u32; node_count];
    for (node, &label) in membership.iter().enumerate() {
        if let Some(slot) = community_size.get_mut(label as usize) {
            *slot += graph.size(node);
        }
    }

    let mut queue: VecDeque<u32> = (0..node_count).map(as_u32).collect();
    let mut queued = vec![true; node_count];
    let mut weight_to = vec![0f64; node_count];
    let mut touched: Vec<u32> = Vec::new();
    let mut moved = false;

    while let Some(node) = queue.pop_front() {
        let index = node as usize;
        if let Some(flag) = queued.get_mut(index) {
            *flag = false;
        }
        let Some(&current) = membership.get(index) else {
            continue;
        };

        for (other, weight) in graph.neighbours(index) {
            let Some(&label) = membership.get(other) else {
                continue;
            };
            let Some(slot) = weight_to.get_mut(label as usize) else {
                continue;
            };
            if *slot == 0.0 {
                touched.push(label);
            }
            *slot += weight;
        }

        // Out of its own community first: otherwise staying put looks better
        // than it is by exactly this node's contribution to the size penalty.
        if let Some(slot) = community_size.get_mut(current as usize) {
            *slot = slot.saturating_sub(graph.size(index));
        }
        let target = best_community(
            graph,
            &community_size,
            &weight_to,
            &touched,
            index,
            current,
            resolution,
        );

        if let Some(slot) = community_size.get_mut(target as usize) {
            *slot += graph.size(index);
        }
        if target != current {
            moved = true;
            if let Some(slot) = membership.get_mut(index) {
                *slot = target;
            }
            requeue_neighbours(graph, membership, &mut queue, &mut queued, index, target);
        }

        for &label in &touched {
            if let Some(slot) = weight_to.get_mut(label as usize) {
                *slot = 0.0;
            }
        }
        touched.clear();
    }

    moved
}

/// The community `node` belongs in, given that `community_size` already has the
/// node taken out of its own. Under CPM the gain of joining community `c` is
/// the weight from the node into `c` less `resolution` times the two sizes
/// multiplied together.
fn best_community(
    graph: &WorkGraph,
    community_size: &[u32],
    weight_to: &[f64],
    touched: &[u32],
    node: usize,
    current: u32,
    resolution: f64,
) -> u32 {
    let size = f64::from(graph.size(node));
    let gain_of = |label: u32, occupancy: u32| -> f64 {
        let weight = weight_to.get(label as usize).copied().unwrap_or(0.0);
        weight - resolution * size * f64::from(occupancy)
    };

    let mut best = current;
    let mut best_gain = gain_of(
        current,
        community_size.get(current as usize).copied().unwrap_or(0),
    );

    // An empty community, so a node that belongs nowhere can leave rather than
    // stay in a group it drags down. The node's own index is free exactly when
    // no other node is using it as a label.
    let own = as_u32(node);
    if own != current && community_size.get(node).copied().unwrap_or(0) == 0 && best_gain < 0.0 {
        best = own;
        best_gain = 0.0;
    }

    for &label in touched {
        if label == current {
            continue;
        }
        let occupancy = community_size.get(label as usize).copied().unwrap_or(0);
        let gain = gain_of(label, occupancy);
        // Exact comparison on purpose: two candidates only tie when the same
        // arithmetic produced the same bits, and the lower label then wins so a
        // rerun of the same graph lands on the same partition.
        let better = match gain.partial_cmp(&best_gain) {
            Some(Ordering::Greater) => true,
            Some(Ordering::Equal) => label < best,
            _ => false,
        };
        if better {
            best = label;
            best_gain = gain;
        }
    }
    best
}

fn requeue_neighbours(
    graph: &WorkGraph,
    membership: &[u32],
    queue: &mut VecDeque<u32>,
    queued: &mut [bool],
    node: usize,
    target: u32,
) {
    for (other, _) in graph.neighbours(node) {
        if membership.get(other).copied() == Some(target) {
            continue;
        }
        let Some(flag) = queued.get_mut(other) else {
            continue;
        };
        if !*flag {
            *flag = true;
            queue.push_back(as_u32(other));
        }
    }
}

/// Split each community into connected, well-connected subcommunities.
///
/// This is the phase that separates Leiden from Louvain. Aggregating by the
/// refined partition rather than by the community lets a subcommunity leave a
/// group it was merged into too eagerly, and it is why a community can never
/// come out internally disconnected.
pub(super) fn refine(
    graph: &WorkGraph,
    membership: &[u32],
    resolution: f64,
    rng: &mut StdRng,
) -> Vec<u32> {
    let node_count = graph.node_count();
    let mut refined: Vec<u32> = (0..node_count).map(as_u32).collect();
    let (offsets, members) = group_by_label(membership, node_count);

    let mut sub_size = vec![0u32; node_count];
    let mut external = vec![0f64; node_count];
    let mut weight_to = vec![0f64; node_count];
    let mut touched: Vec<u32> = Vec::new();

    for label in 0..node_count {
        let start = offsets.get(label).copied().unwrap_or(0);
        let end = offsets.get(label + 1).copied().unwrap_or(start);
        let Some(group) = members.get(start..end) else {
            continue;
        };
        if group.len() < 2 {
            continue;
        }
        let community_size = graph.total_size(group.iter().map(|&node| node as usize));
        prepare_subcommunities(graph, membership, group, &mut sub_size, &mut external);

        for &node in group {
            let index = node as usize;
            if refined.get(index).copied() != Some(node)
                || sub_size.get(index).copied() != Some(graph.size(index))
            {
                continue;
            }
            let size = graph.size(index);
            let rest = community_size.saturating_sub(size);
            if external.get(index).copied().unwrap_or(0.0)
                < resolution * f64::from(size) * f64::from(rest)
            {
                continue;
            }
            collect_subcommunity_weights(
                graph,
                membership,
                &refined,
                index,
                label,
                &mut weight_to,
                &mut touched,
            );
            let chosen = choose_subcommunity(
                &weight_to,
                &touched,
                &sub_size,
                &external,
                index,
                size,
                community_size,
                resolution,
                rng,
            );
            if let Some(target) = chosen {
                join_subcommunity(
                    &mut refined,
                    &mut sub_size,
                    &mut external,
                    &weight_to,
                    index,
                    target,
                );
            }
            for &other in &touched {
                if let Some(slot) = weight_to.get_mut(other as usize) {
                    *slot = 0.0;
                }
            }
            touched.clear();
        }
    }
    refined
}

/// Every member starts as its own subcommunity, holding the weight it has to
/// the rest of the community it sits in.
fn prepare_subcommunities(
    graph: &WorkGraph,
    membership: &[u32],
    group: &[u32],
    sub_size: &mut [u32],
    external: &mut [f64],
) {
    for &node in group {
        let index = node as usize;
        let label = membership.get(index).copied();
        let inside: f64 = graph
            .neighbours(index)
            .filter(|&(other, _)| membership.get(other).copied() == label)
            .map(|(_, weight)| weight)
            .sum();
        if let Some(slot) = sub_size.get_mut(index) {
            *slot = graph.size(index);
        }
        if let Some(slot) = external.get_mut(index) {
            *slot = inside;
        }
    }
}

fn collect_subcommunity_weights(
    graph: &WorkGraph,
    membership: &[u32],
    refined: &[u32],
    node: usize,
    label: usize,
    weight_to: &mut [f64],
    touched: &mut Vec<u32>,
) {
    for (other, weight) in graph.neighbours(node) {
        if membership.get(other).copied() != Some(as_u32(label)) {
            continue;
        }
        let Some(&sub) = refined.get(other) else {
            continue;
        };
        let Some(slot) = weight_to.get_mut(sub as usize) else {
            continue;
        };
        if *slot == 0.0 {
            touched.push(sub);
        }
        *slot += weight;
    }
}

/// Pick a subcommunity to join, at random among those that improve quality and
/// are themselves well connected to the rest of the community.
///
/// The choice is weighted by `exp(gain / RANDOMNESS)`, shifted by the largest
/// exponent so a strongly preferred candidate cannot overflow to infinity and
/// take every other candidate's probability with it.
#[allow(clippy::too_many_arguments)] // every argument is a distinct scratch buffer
fn choose_subcommunity(
    weight_to: &[f64],
    touched: &[u32],
    sub_size: &[u32],
    external: &[f64],
    node: usize,
    size: u32,
    community_size: u32,
    resolution: f64,
    rng: &mut StdRng,
) -> Option<u32> {
    let mut candidates: Vec<(u32, f64)> = Vec::new();
    let mut best_gain = f64::NEG_INFINITY;
    for &sub in touched {
        if sub as usize == node {
            continue;
        }
        let occupancy = sub_size.get(sub as usize).copied().unwrap_or(0);
        let rest = community_size.saturating_sub(occupancy);
        if external.get(sub as usize).copied().unwrap_or(0.0)
            < resolution * f64::from(occupancy) * f64::from(rest)
        {
            continue;
        }
        let weight = weight_to.get(sub as usize).copied().unwrap_or(0.0);
        let gain = weight - resolution * f64::from(size) * f64::from(occupancy);
        if gain < 0.0 {
            continue;
        }
        best_gain = best_gain.max(gain);
        candidates.push((sub, gain));
    }
    if candidates.is_empty() {
        return None;
    }

    let mut total = 0.0;
    for (_, gain) in &mut *candidates {
        *gain = ((*gain - best_gain) / RANDOMNESS).exp();
        total += *gain;
    }
    if total <= 0.0 {
        return candidates.first().map(|&(sub, _)| sub);
    }

    let mut draw = rng.random::<f64>() * total;
    for &(sub, weight) in &candidates {
        draw -= weight;
        if draw <= 0.0 {
            return Some(sub);
        }
    }
    candidates.last().map(|&(sub, _)| sub)
}

fn join_subcommunity(
    refined: &mut [u32],
    sub_size: &mut [u32],
    external: &mut [f64],
    weight_to: &[f64],
    node: usize,
    target: u32,
) {
    let moved_size = sub_size.get(node).copied().unwrap_or(0);
    let moved_external = external.get(node).copied().unwrap_or(0.0);
    let shared = weight_to.get(target as usize).copied().unwrap_or(0.0);
    if let Some(slot) = refined.get_mut(node) {
        *slot = target;
    }
    if let Some(slot) = sub_size.get_mut(target as usize) {
        *slot += moved_size;
    }
    // The weight between the two was external to both and is now internal, so
    // it leaves the target's boundary twice.
    if let Some(slot) = external.get_mut(target as usize) {
        *slot += moved_external - 2.0 * shared;
    }
    if let Some(slot) = sub_size.get_mut(node) {
        *slot = 0;
    }
}

/// Members of each label, as one flat array with an offset per label.
fn group_by_label(membership: &[u32], node_count: usize) -> (Vec<usize>, Vec<u32>) {
    let mut offsets = vec![0usize; node_count + 1];
    for &label in membership {
        if let Some(slot) = offsets.get_mut(label as usize + 1) {
            *slot += 1;
        }
    }
    let mut running = 0usize;
    for slot in &mut offsets {
        running += *slot;
        *slot = running;
    }
    let mut cursor = offsets.clone();
    let mut members = vec![0u32; membership.len()];
    for (node, &label) in membership.iter().enumerate() {
        let Some(position) = cursor.get_mut(label as usize) else {
            continue;
        };
        if let Some(slot) = members.get_mut(*position) {
            *slot = as_u32(node);
        }
        *position += 1;
    }
    (offsets, members)
}

/// Collapse each group of `labels` into one node, summing the weight between
/// groups. Returns the collapsed graph and, per old node, its new node.
pub(super) fn aggregate(graph: &WorkGraph, labels: &[u32]) -> (WorkGraph, Vec<u32>) {
    let node_count = graph.node_count();
    let mut mapping = vec![u32::MAX; node_count];
    let mut renumbered = vec![u32::MAX; node_count];
    let mut sizes: Vec<u32> = Vec::new();
    for node in 0..node_count {
        let Some(&label) = labels.get(node) else {
            continue;
        };
        let Some(slot) = renumbered.get_mut(label as usize) else {
            continue;
        };
        if *slot == u32::MAX {
            *slot = as_u32(sizes.len());
            sizes.push(0);
        }
        let target = *slot;
        if let Some(size) = sizes.get_mut(target as usize) {
            *size += graph.size(node);
        }
        if let Some(slot) = mapping.get_mut(node) {
            *slot = target;
        }
    }

    let mut edges: Vec<(u32, u32, f64)> = graph
        .edges()
        .filter_map(|(from, to, weight)| {
            let a = mapping.get(from).copied().unwrap_or(u32::MAX);
            let b = mapping.get(to).copied().unwrap_or(u32::MAX);
            if a == b || a == u32::MAX || b == u32::MAX {
                None
            } else {
                Some((a.min(b), a.max(b), weight))
            }
        })
        .collect();
    edges.sort_unstable_by_key(|&(a, b, _)| (a, b));
    edges.dedup_by(|later, kept| {
        if later.0 == kept.0 && later.1 == kept.1 {
            kept.2 += later.2;
            true
        } else {
            false
        }
    });

    (WorkGraph::new(sizes, &edges), mapping)
}

/// One membership per level over the nodes of `base`, finest first.
///
/// Each iteration is a full Leiden pass: move nodes, refine, collapse. The
/// partition after each pass is a level, and the loop stops when a pass stops
/// paying for itself, when nothing collapses any further, or at `max_levels`.
pub(super) fn partition_levels(base: &WorkGraph, config: LeidenConfig) -> Vec<Vec<u32>> {
    let node_count = base.node_count();
    let mut levels: Vec<Vec<u32>> = Vec::new();
    if node_count == 0 {
        return levels;
    }

    let mut rng = StdRng::seed_from_u64(config.seed);
    let mut work = base.clone();
    // Where each original node currently lives in the collapsed graph.
    let mut flat: Vec<u32> = (0..node_count).map(as_u32).collect();
    let mut membership: Vec<u32> = (0..node_count).map(as_u32).collect();
    let max_levels = usize::from(config.max_levels).max(1);
    let mut last_quality = f64::NEG_INFINITY;

    loop {
        local_move(&work, &mut membership, config.resolution);
        let level = canonicalise(
            &flat
                .iter()
                .map(|&node| membership.get(node as usize).copied().unwrap_or(0))
                .collect::<Vec<u32>>(),
        );
        let quality = work_quality(base, &level, config.resolution);

        if levels.is_empty() {
            levels.push(level);
            last_quality = quality;
        } else if levels.last() == Some(&level) || quality - last_quality < config.tolerance {
            // A level that neither regroups anything nor pays for itself is one
            // more row per node in the database for nothing.
            break;
        } else {
            levels.push(level);
            last_quality = quality;
        }

        if levels.len() >= max_levels {
            break;
        }

        let refined = refine(&work, &membership, config.resolution, &mut rng);
        let (next, mapping) = aggregate(&work, &refined);
        if next.node_count() >= work.node_count() {
            break;
        }

        let mut next_membership = vec![0u32; next.node_count()];
        for (old, &new) in mapping.iter().enumerate() {
            if let Some(slot) = next_membership.get_mut(new as usize) {
                *slot = membership.get(old).copied().unwrap_or(0);
            }
        }
        for node in &mut flat {
            *node = mapping.get(*node as usize).copied().unwrap_or(0);
        }
        work = next;
        membership = canonicalise(&next_membership);
    }

    levels
}

/// Fold every community below `minimum` into the neighbouring community it
/// shares the most weight with.
///
/// A community of one or two symbols is not something a reader wants a summary
/// of, and it is usually a fragment of the module beside it. One with no
/// neighbours at all is left alone: an isolated symbol has nothing to be folded
/// into, and dropping it would lose it from the partition entirely.
pub(super) fn merge_small(graph: &WorkGraph, membership: &mut Vec<u32>, minimum: usize) {
    if minimum <= 1 {
        return;
    }
    let node_count = graph.node_count();
    // A merge can leave the receiving community still under the minimum, so the
    // pass repeats. The cap bounds a pathological chain; what survives it is a
    // handful of small communities, which is a worse summary rather than a
    // wrong one.
    for _ in 0..MERGE_PASSES {
        let (offsets, members) = group_by_label(membership, node_count);
        let mut changed = false;
        for label in 0..node_count {
            let start = offsets.get(label).copied().unwrap_or(0);
            let end = offsets.get(label + 1).copied().unwrap_or(start);
            let Some(group) = members.get(start..end) else {
                continue;
            };
            let occupancy = graph.total_size(group.iter().map(|&node| node as usize));
            if group.is_empty() || occupancy >= as_u32(minimum) {
                continue;
            }
            let Some(target) = strongest_neighbour(graph, membership, group, as_u32(label)) else {
                continue;
            };
            for &node in group {
                if let Some(slot) = membership.get_mut(node as usize) {
                    *slot = target;
                }
            }
            changed = true;
        }
        if !changed {
            break;
        }
    }
    *membership = canonicalise(membership);
}

const MERGE_PASSES: usize = 8;

fn strongest_neighbour(
    graph: &WorkGraph,
    membership: &[u32],
    group: &[u32],
    label: u32,
) -> Option<u32> {
    let mut weights: Vec<(u32, f64)> = Vec::new();
    for &node in group {
        for (other, weight) in graph.neighbours(node as usize) {
            let Some(&candidate) = membership.get(other) else {
                continue;
            };
            if candidate == label {
                continue;
            }
            match weights.iter_mut().find(|(seen, _)| *seen == candidate) {
                Some(entry) => entry.1 += weight,
                None => weights.push((candidate, weight)),
            }
        }
    }
    weights
        .into_iter()
        .reduce(|best, next| {
            // Exact tie-break again, for the same reason as in `best_community`.
            let better = match next.1.partial_cmp(&best.1) {
                Some(Ordering::Greater) => true,
                Some(Ordering::Equal) => next.0 < best.0,
                _ => false,
            };
            if better { next } else { best }
        })
        .map(|(candidate, _)| candidate)
}

/// Coarsen `coarse` until every community of `fine` sits inside exactly one of
/// its communities.
///
/// Refinement can move a subcommunity out of the group it was in at the level
/// below, which is good for quality and would leave a level that is not a
/// coarsening of the one under it. The database models the levels as a tree and
/// the retrieval that walks it assumes containment, so the two are reconciled
/// here by merging the coarse communities a fine one straddles.
pub(super) fn enforce_nesting(fine: &[u32], coarse: &[u32]) -> Vec<u32> {
    let mut parent: Vec<u32> = (0..coarse.len()).map(as_u32).collect();
    let mut first: Vec<u32> = vec![u32::MAX; fine.len()];

    for (node, &group) in fine.iter().enumerate() {
        let Some(&label) = coarse.get(node) else {
            continue;
        };
        let Some(slot) = first.get_mut(group as usize) else {
            continue;
        };
        if *slot == u32::MAX {
            *slot = label;
        } else {
            let (left, right) = (find(&mut parent, *slot), find(&mut parent, label));
            if left == right {
                continue;
            }
            if let Some(entry) = parent.get_mut(right as usize) {
                *entry = left;
            }
        }
    }

    let merged: Vec<u32> = coarse
        .iter()
        .map(|&label| find(&mut parent, label))
        .collect();
    canonicalise(&merged)
}

fn find(parent: &mut [u32], label: u32) -> u32 {
    let mut root = label;
    while let Some(&next) = parent.get(root as usize) {
        if next == root {
            break;
        }
        root = next;
    }
    let mut walk = label;
    while let Some(slot) = parent.get_mut(walk as usize) {
        let next = *slot;
        if next == root {
            break;
        }
        *slot = root;
        walk = next;
    }
    root
}
