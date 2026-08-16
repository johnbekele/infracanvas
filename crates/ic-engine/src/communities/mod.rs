//! Leiden community detection over the extracted code graph.
//!
//! Graph RAG answers architecture questions by summarising clusters rather than
//! individual chunks, so something has to decide what a cluster is. Detection
//! partitions the graph into groups that talk to each other far more than to the
//! rest of the repository, which in practice recovers the modules a codebase
//! has rather than the directories someone once created.
//!
//! Leiden rather than Louvain because Louvain can return a community whose
//! members do not reach one another through the community's own edges. That is
//! a curiosity in a citation network and a defect here, where the next stage
//! turns each community into a summary a user reads.
//!
//! The whole pass is deterministic. Nodes are visited in `qualified_name` order
//! and the generator is a seeded [`rand::rngs::StdRng`], so two ingests of the
//! same commit partition identically and the summaries cached against those
//! communities survive a re-index.

use petgraph::graph::UnGraph;
use petgraph::visit::EdgeRef;
use serde::{Deserialize, Serialize};

mod leiden;
mod quality;

pub use quality::{cpm_quality, is_internally_connected};

use leiden::{WorkGraph, as_u32, enforce_nesting, merge_small, partition_levels};
use quality::split_disconnected;

/// Kinds of relationship extraction reports. `Imports`, `Calls` and `Extends`
/// are read from the grammar; the rest are recognised from call shapes and are
/// heuristics.
///
/// This mirrors the extraction contract rather than importing it: extraction
/// lands in its own module and this one only ever reads the result, so the
/// coupling is the field names, not a build order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Imports,
    Calls,
    Extends,
    ReadsEnv,
    HttpCall,
    DbQuery,
}

impl EdgeKind {
    /// How much this kind of edge argues that its two ends belong together.
    ///
    /// An import or an inheritance is a structural commitment and weighs 2.0, a
    /// call 1.0, and a heuristic kind 0.5 — a guessed edge should not be what
    /// decides a module boundary. The extraction weight, which counts call
    /// sites, is deliberately not folded in: one loop-heavy caller would
    /// otherwise outrank an import.
    #[must_use]
    pub fn belonging_weight(self) -> f32 {
        match self {
            Self::Imports | Self::Extends => 2.0,
            Self::Calls => 1.0,
            Self::ReadsEnv | Self::HttpCall | Self::DbQuery => 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    File,
    Module,
    Class,
    Function,
    Method,
    Route,
    EnvVar,
    ExternalService,
}

/// One symbol as extraction saw it. Only `qualified_name` is required, because
/// clustering reads nothing else and a fixture should not have to carry the
/// fields it does not exercise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedNode {
    /// `path/to/file.ts::ClassName::methodName`, unique within a run.
    pub qualified_name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub kind: Option<NodeKind>,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedEdge {
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
}

/// The nodes and edges one extraction pass produced.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedGraph {
    #[serde(default)]
    pub nodes: Vec<ExtractedNode>,
    #[serde(default)]
    pub edges: Vec<ExtractedEdge>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LeidenConfig {
    /// CPM resolution. Higher yields more, smaller communities. The default was
    /// chosen to put a typical module in one community on the fixture corpus;
    /// changing it means rerunning that measurement.
    pub resolution: f64,
    /// Stop aggregating past this many levels even if quality still improves.
    pub max_levels: u8,
    /// Seeded so two runs over the same commit partition identically.
    pub seed: u64,
    /// Communities below this size are merged into their strongest neighbour
    /// rather than summarised on their own.
    pub min_community_size: usize,
    /// Give up on a level once an iteration improves quality by less than this.
    pub tolerance: f64,
}

impl Default for LeidenConfig {
    fn default() -> Self {
        Self {
            resolution: 0.05,
            max_levels: 3,
            seed: 0x1c_ca_11_5e,
            min_community_size: 3,
            tolerance: 1e-6,
        }
    }
}

/// Weighted, undirected view of the extracted graph.
///
/// Direction is dropped because "A calls B" and "B calls A" are the same
/// evidence of belonging together; the weights differ by edge kind instead.
/// `node_names[i]` names the node with index `i`, and each node also carries
/// that index as its weight so a subgraph stays self-describing.
pub struct CodeGraph {
    pub node_names: Vec<String>,
    pub graph: UnGraph<u32, f32>,
}

impl CodeGraph {
    /// Build the clustering view of an extraction result.
    ///
    /// Parallel edges between the same pair are summed rather than kept apart,
    /// so a pair that both imports and calls counts as the stronger link it is.
    /// An edge naming a symbol that is not in `nodes`, and an edge from a symbol
    /// to itself, are dropped: neither says anything about a boundary between
    /// two groups.
    #[must_use]
    pub fn from_extracted(extracted: &ExtractedGraph) -> Self {
        let mut graph: UnGraph<u32, f32> =
            UnGraph::with_capacity(extracted.nodes.len(), extracted.edges.len());
        let mut node_names = Vec::with_capacity(extracted.nodes.len());
        let mut index_of: std::collections::HashMap<&str, u32> =
            std::collections::HashMap::with_capacity(extracted.nodes.len());

        for node in &extracted.nodes {
            if index_of.contains_key(node.qualified_name.as_str()) {
                continue;
            }
            let index = as_u32(node_names.len());
            index_of.insert(node.qualified_name.as_str(), index);
            graph.add_node(index);
            node_names.push(node.qualified_name.clone());
        }

        let mut weights: std::collections::HashMap<(u32, u32), f32> =
            std::collections::HashMap::with_capacity(extracted.edges.len());
        for edge in &extracted.edges {
            let (Some(&source), Some(&target)) = (
                index_of.get(edge.source.as_str()),
                index_of.get(edge.target.as_str()),
            ) else {
                continue;
            };
            if source == target {
                continue;
            }
            let key = (source.min(target), source.max(target));
            *weights.entry(key).or_insert(0.0) += edge.kind.belonging_weight();
        }

        // Sorted before insertion so the edge indices, and everything derived
        // from them, do not depend on the hash map's iteration order.
        let mut pairs: Vec<((u32, u32), f32)> = weights.into_iter().collect();
        pairs.sort_unstable_by_key(|&(pair, _)| pair);
        for ((source, target), weight) in pairs {
            graph.add_edge(source.into(), target.into(), weight);
        }

        Self { node_names, graph }
    }

    fn name_of(&self, index: u32) -> &str {
        self.node_names
            .get(index as usize)
            .map_or("", String::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Community {
    pub level: u8,
    pub ordinal: u32,
    pub parent_ordinal: Option<u32>,
    /// Member qualified names, sorted.
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Communities {
    pub communities: Vec<Community>,
    /// CPM quality per level, index 0 being the finest partition.
    pub quality: Vec<f64>,
}

/// Local moving, refinement, aggregation, repeated per level.
///
/// Guarantees: every node belongs to exactly one community per level, every
/// community is internally connected, a community at one level sits inside
/// exactly one community at the level above, and the result is a pure function
/// of the graph and the config.
#[must_use]
pub fn detect_communities(graph: &CodeGraph, config: LeidenConfig) -> Communities {
    let node_count = graph.graph.node_count();
    if node_count == 0 {
        return Communities {
            communities: Vec::new(),
            quality: Vec::new(),
        };
    }

    // Everything below works in canonical order — ascending qualified name —
    // so the partition depends on the graph rather than on the order the caller
    // happened to hand the nodes over in.
    let order = canonical_order(graph);
    let mut rank = vec![0u32; node_count];
    for (position, &index) in order.iter().enumerate() {
        if let Some(slot) = rank.get_mut(index as usize) {
            *slot = as_u32(position);
        }
    }

    let base = build_work_graph(graph, &rank);
    let levels = shape_levels(&base, config);

    let mut communities = Vec::new();
    let mut quality = Vec::new();
    for (depth, level) in levels.iter().enumerate() {
        quality.push(cpm_quality(
            graph,
            &restore_order(level, &rank),
            config.resolution,
        ));
        let parents = levels.get(depth + 1);
        communities.extend(describe_level(graph, &order, level, parents, depth));
    }

    Communities {
        communities,
        quality,
    }
}

/// Run the algorithm and reconcile the levels it produced into a hierarchy the
/// rest of the system can store: connected, no community too small to summarise,
/// and each level a strict coarsening of the one below.
fn shape_levels(base: &WorkGraph, config: LeidenConfig) -> Vec<Vec<u32>> {
    let mut levels = partition_levels(base, config);
    if levels.is_empty() {
        // Nothing merged, which is the right answer for a graph of isolated
        // nodes; each still has to come out in a community of its own.
        levels.push((0..base.node_count()).map(as_u32).collect());
    }

    for level in &mut levels {
        split_disconnected(base, level);
    }
    if let Some(finest) = levels.first_mut() {
        merge_small(base, finest, config.min_community_size);
    }

    // Sizes above level 0 are unions of level 0 communities, so only a group the
    // minimum deliberately keeps — an isolated symbol with nothing to fold into
    // — is still small up here. Nesting is re-established after the merge
    // because a fold can cross the boundary of the level above.
    let mut nested: Vec<Vec<u32>> = Vec::new();
    for level in levels {
        match nested.last() {
            None => nested.push(level),
            Some(finer) => {
                let coarser = enforce_nesting(finer, &level);
                if &coarser == finer {
                    break;
                }
                nested.push(coarser);
            }
        }
    }
    nested
}

/// Canonical position of each node: ascending qualified name, then ascending
/// index so two nodes sharing a name still order deterministically.
fn canonical_order(graph: &CodeGraph) -> Vec<u32> {
    let mut order: Vec<u32> = (0..graph.graph.node_count()).map(as_u32).collect();
    order.sort_unstable_by(|&left, &right| {
        graph
            .name_of(left)
            .cmp(graph.name_of(right))
            .then(left.cmp(&right))
    });
    order
}

fn build_work_graph(graph: &CodeGraph, rank: &[u32]) -> WorkGraph {
    let mut edges: Vec<(u32, u32, f64)> = graph
        .graph
        .edge_references()
        .filter_map(|edge| {
            let source = rank.get(edge.source().index()).copied()?;
            let target = rank.get(edge.target().index()).copied()?;
            if source == target {
                return None;
            }
            Some((
                source.min(target),
                source.max(target),
                f64::from(*edge.weight()),
            ))
        })
        .collect();
    edges.sort_unstable_by_key(|&(source, target, _)| (source, target));
    edges.dedup_by(|later, kept| {
        if later.0 == kept.0 && later.1 == kept.1 {
            kept.2 += later.2;
            true
        } else {
            false
        }
    });
    WorkGraph::new(vec![1u32; graph.graph.node_count()], &edges)
}

/// A membership in canonical order, put back into the caller's node order.
fn restore_order(level: &[u32], rank: &[u32]) -> Vec<u32> {
    rank.iter()
        .map(|&position| level.get(position as usize).copied().unwrap_or(0))
        .collect()
}

/// Turn one level's membership into communities.
///
/// Labels are already ordinals: every stage relabels in ascending canonical
/// order, and canonical order is by name, so a label is assigned in ascending
/// order of its community's smallest member name — which is what makes an
/// ordinal mean the same thing across two runs.
fn describe_level(
    graph: &CodeGraph,
    order: &[u32],
    level: &[u32],
    parents: Option<&Vec<u32>>,
    depth: usize,
) -> Vec<Community> {
    let count = level
        .iter()
        .copied()
        .max()
        .map_or(0, |max| max as usize + 1);
    let mut members: Vec<Vec<String>> = vec![Vec::new(); count];
    let mut parent_ordinal: Vec<Option<u32>> = vec![None; count];

    for (position, &label) in level.iter().enumerate() {
        let Some(&index) = order.get(position) else {
            continue;
        };
        if let Some(slot) = members.get_mut(label as usize) {
            slot.push(graph.name_of(index).to_owned());
        }
        if let Some(slot) = parent_ordinal.get_mut(label as usize) {
            *slot = parents.and_then(|above| above.get(position).copied());
        }
    }

    members
        .into_iter()
        .zip(parent_ordinal)
        .enumerate()
        .filter(|(_, (names, _))| !names.is_empty())
        .map(|(ordinal, (names, parent))| Community {
            level: u8::try_from(depth).unwrap_or(u8::MAX),
            ordinal: as_u32(ordinal),
            parent_ordinal: parent,
            members: names,
        })
        .collect()
}

#[cfg(feature = "python")]
pub(crate) mod python {
    use pyo3::exceptions::PyValueError;
    use pyo3::prelude::*;

    use super::{CodeGraph, ExtractedGraph, LeidenConfig, detect_communities};

    /// Partition an extracted graph handed over as JSON, and return the
    /// communities as JSON.
    ///
    /// JSON rather than a bound type because the brain calls this once per
    /// ingest: the cost of one serialisation is invisible next to the cost of
    /// keeping a `PyO3` class in step with the Rust types.
    #[pyfunction]
    pub(crate) fn detect_communities_json(
        graph_json: &str,
        resolution: f64,
        seed: u64,
    ) -> PyResult<String> {
        let extracted: ExtractedGraph = serde_json::from_str(graph_json)
            .map_err(|error| PyValueError::new_err(format!("invalid extracted graph: {error}")))?;
        let config = LeidenConfig {
            resolution,
            seed,
            ..LeidenConfig::default()
        };
        let communities = detect_communities(&CodeGraph::from_extracted(&extracted), config);
        serde_json::to_string(&communities).map_err(|error| {
            PyValueError::new_err(format!("cannot serialise communities: {error}"))
        })
    }
}
