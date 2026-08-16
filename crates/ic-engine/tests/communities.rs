//! Behaviour of Leiden community detection over the code graph.
//!
//! The connectivity and partition checks here deliberately re-derive their
//! answer from the fixture rather than calling the crate's own helpers: a bug
//! shared between the algorithm and its checker would otherwise pass.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;

use ic_engine::communities::{
    Communities, Community, EdgeKind, ExtractedEdge, ExtractedGraph, ExtractedNode,
    is_internally_connected,
};
use ic_engine::{CodeGraph, LeidenConfig, cpm_quality, detect_communities};

const FIXTURES: [&str; 3] = ["three_cliques", "small_and_isolated", "hierarchical"];

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/communities")
        .join(format!("{name}.json"))
}

fn load_extracted(name: &str) -> ExtractedGraph {
    let path = fixture_path(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

fn load(name: &str) -> CodeGraph {
    CodeGraph::from_extracted(&load_extracted(name))
}

fn levels_of(result: &Communities) -> Vec<Vec<&Community>> {
    let depth = result
        .communities
        .iter()
        .map(|community| usize::from(community.level))
        .max()
        .map_or(0, |max| max + 1);
    let mut levels = vec![Vec::new(); depth];
    for community in &result.communities {
        if let Some(slot) = levels.get_mut(usize::from(community.level)) {
            slot.push(community);
        }
    }
    levels
}

/// Adjacency rebuilt from the fixture, independent of anything the crate built.
fn adjacency(extracted: &ExtractedGraph) -> HashMap<&str, Vec<&str>> {
    let names: HashSet<&str> = extracted
        .nodes
        .iter()
        .map(|node| node.qualified_name.as_str())
        .collect();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &extracted.edges {
        let (source, target) = (edge.source.as_str(), edge.target.as_str());
        if !names.contains(source) || !names.contains(target) || source == target {
            continue;
        }
        adjacency.entry(source).or_default().push(target);
        adjacency.entry(target).or_default().push(source);
    }
    adjacency
}

/// True when the members reach one another using only edges between members.
fn reaches_every_member(adjacency: &HashMap<&str, Vec<&str>>, members: &[String]) -> bool {
    let inside: HashSet<&str> = members.iter().map(String::as_str).collect();
    let Some(start) = members.first() else {
        return false;
    };
    let mut seen: HashSet<&str> = HashSet::new();
    seen.insert(start.as_str());
    let mut queue: VecDeque<&str> = VecDeque::new();
    queue.push_back(start.as_str());
    while let Some(current) = queue.pop_front() {
        for neighbour in adjacency.get(current).into_iter().flatten() {
            if !inside.contains(neighbour) || !seen.insert(neighbour) {
                continue;
            }
            queue.push_back(neighbour);
        }
    }
    seen.len() == members.len()
}

fn prefixed(members: &[String], directory: &str) -> bool {
    members.iter().all(|name| name.starts_with(directory))
}

fn community_of<'a>(level: &[&'a Community], member: &str) -> &'a Community {
    level
        .iter()
        .find(|community| community.members.iter().any(|name| name == member))
        .unwrap_or_else(|| panic!("{member} is in no community"))
}

fn singleton_quality(graph: &CodeGraph, resolution: f64) -> f64 {
    let membership: Vec<u32> = (0..graph.graph.node_count())
        .map(|node| u32::try_from(node).unwrap_or(u32::MAX))
        .collect();
    cpm_quality(graph, &membership, resolution)
}

#[test]
fn recovers_three_cliques_as_three_communities() {
    let graph = load("three_cliques");
    let result = detect_communities(&graph, LeidenConfig::default());
    let levels = levels_of(&result);
    let finest = levels.first().expect("a level 0");

    assert_eq!(finest.len(), 3, "expected one community per clique");
    for community in finest {
        assert_eq!(community.members.len(), 5);
    }
    assert!(finest.iter().any(|c| prefixed(&c.members, "src/auth/")));
    assert!(finest.iter().any(|c| prefixed(&c.members, "src/billing/")));
    assert!(finest.iter().any(|c| prefixed(&c.members, "src/cache/")));
}

#[test]
fn produces_only_internally_connected_communities() {
    for name in FIXTURES {
        let extracted = load_extracted(name);
        let graph = CodeGraph::from_extracted(&extracted);
        let links = adjacency(&extracted);
        let result = detect_communities(&graph, LeidenConfig::default());

        for community in &result.communities {
            assert!(
                reaches_every_member(&links, &community.members),
                "{name} level {} community {} is disconnected: {:?}",
                community.level,
                community.ordinal,
                community.members
            );
        }

        // The crate's own check has to agree with the independent traversal.
        let mut membership = vec![0u32; graph.graph.node_count()];
        let index_of: HashMap<&str, usize> = graph
            .node_names
            .iter()
            .enumerate()
            .map(|(index, name)| (name.as_str(), index))
            .collect();
        for community in result.communities.iter().filter(|c| c.level == 0) {
            for member in &community.members {
                let index = index_of[member.as_str()];
                membership[index] = community.ordinal;
            }
        }
        assert!(is_internally_connected(&graph, &membership), "{name}");
    }
}

#[test]
fn is_deterministic_for_a_fixed_seed() {
    for name in FIXTURES {
        let graph = load(name);
        let first = detect_communities(&graph, LeidenConfig::default());
        let second = detect_communities(&graph, LeidenConfig::default());
        assert_eq!(first, second, "{name} partitioned differently on a rerun");
    }
}

#[test]
fn is_stable_in_quality_across_seeds() {
    for name in FIXTURES {
        let graph = load(name);
        let config = LeidenConfig::default();
        let baseline = detect_communities(&graph, config)
            .quality
            .first()
            .copied()
            .expect("a level 0 quality");

        for seed in [1u64, 7, 4_242, u64::MAX] {
            let quality = detect_communities(&graph, LeidenConfig { seed, ..config })
                .quality
                .first()
                .copied()
                .expect("a level 0 quality");
            let drift = (quality - baseline).abs() / baseline.abs().max(1.0);
            assert!(
                drift <= 0.01,
                "{name} seed {seed}: quality {quality} drifted from {baseline}"
            );
        }
    }
}

#[test]
fn is_invariant_to_input_node_order() {
    for name in FIXTURES {
        let extracted = load_extracted(name);
        let expected = detect_communities(
            &CodeGraph::from_extracted(&extracted),
            LeidenConfig::default(),
        );

        // Reversed, and interleaved from both ends, so the shuffle is neither
        // the original order nor a single rotation of it.
        let mut nodes: Vec<ExtractedNode> = extracted.nodes.clone();
        nodes.reverse();
        let mut edges: Vec<ExtractedEdge> = Vec::with_capacity(extracted.edges.len());
        let (mut head, mut tail) = (0usize, extracted.edges.len());
        while head < tail {
            tail -= 1;
            edges.push(extracted.edges[tail].clone());
            if head < tail {
                edges.push(extracted.edges[head].clone());
                head += 1;
            }
        }

        let shuffled = ExtractedGraph { nodes, edges };
        let actual = detect_communities(
            &CodeGraph::from_extracted(&shuffled),
            LeidenConfig::default(),
        );
        assert_eq!(actual, expected, "{name} depended on input order");
    }
}

#[test]
fn produces_more_communities_at_a_higher_resolution() {
    let graph = load("three_cliques");
    // The minimum is switched off so the comparison measures the resolution
    // rather than the merge that follows it.
    let config = LeidenConfig {
        min_community_size: 1,
        ..LeidenConfig::default()
    };
    let coarse = detect_communities(&graph, config);
    let fine = detect_communities(
        &graph,
        LeidenConfig {
            resolution: 3.0,
            ..config
        },
    );

    let coarse_count = levels_of(&coarse).first().map_or(0, Vec::len);
    let fine_count = levels_of(&fine).first().map_or(0, Vec::len);
    assert!(
        fine_count > coarse_count,
        "resolution 3.0 gave {fine_count} communities, 0.05 gave {coarse_count}"
    );
}

#[test]
fn partitions_every_node_exactly_once_per_level() {
    for name in FIXTURES {
        let graph = load(name);
        let all: HashSet<&str> = graph.node_names.iter().map(String::as_str).collect();
        let result = detect_communities(&graph, LeidenConfig::default());
        let levels = levels_of(&result);
        assert!(!levels.is_empty(), "{name} produced no levels");

        for (depth, level) in levels.iter().enumerate() {
            let mut seen: HashSet<&str> = HashSet::new();
            for community in level {
                for member in &community.members {
                    assert!(
                        seen.insert(member.as_str()),
                        "{name} level {depth}: {member} is in two communities"
                    );
                }
            }
            assert_eq!(seen, all, "{name} level {depth} does not cover every node");

            let Some(above) = levels.get(depth + 1) else {
                continue;
            };
            for community in level {
                let parent = community
                    .parent_ordinal
                    .unwrap_or_else(|| panic!("{name} level {depth} community has no parent"));
                let holder = above
                    .iter()
                    .find(|candidate| candidate.ordinal == parent)
                    .unwrap_or_else(|| panic!("{name}: no community {parent} above level {depth}"));
                for member in &community.members {
                    assert!(
                        holder.members.contains(member),
                        "{name}: {member} left its parent community"
                    );
                }
            }
        }
    }
}

#[test]
fn merges_a_community_below_the_minimum_size_into_its_neighbour() {
    let graph = load("small_and_isolated");
    let kept = detect_communities(
        &graph,
        LeidenConfig {
            min_community_size: 1,
            ..LeidenConfig::default()
        },
    );
    let kept_levels = levels_of(&kept);
    let kept_level = kept_levels.first().expect("a level 0");
    let pair = community_of(kept_level, "src/pair/mod.ts::pair0");
    assert_eq!(
        pair.members.len(),
        2,
        "the pair should stand alone without the minimum"
    );

    let merged = detect_communities(&graph, LeidenConfig::default());
    let merged_levels = levels_of(&merged);
    let merged_level = merged_levels.first().expect("a level 0");
    let host = community_of(merged_level, "src/pair/mod.ts::pair0");
    assert!(
        host.members.contains(&"src/pair/mod.ts::pair1".to_owned()),
        "the pair was split apart by the merge"
    );
    assert!(
        host.members
            .contains(&"src/alpha/mod.ts::alpha0".to_owned()),
        "the pair should fold into the neighbour it shares an edge with, got {:?}",
        host.members
    );
}

#[test]
fn keeps_an_isolated_node_in_its_own_community() {
    let graph = load("small_and_isolated");
    let result = detect_communities(&graph, LeidenConfig::default());
    let levels = levels_of(&result);
    let finest = levels.first().expect("a level 0");
    let isolated = community_of(finest, "src/zeta/mod.ts::zeta0");
    assert_eq!(
        isolated.members,
        vec!["src/zeta/mod.ts::zeta0".to_owned()],
        "an unreferenced symbol has nothing to be folded into"
    );
}

#[test]
fn returns_no_communities_for_an_empty_graph() {
    let graph = CodeGraph::from_extracted(&ExtractedGraph::default());
    let result = detect_communities(&graph, LeidenConfig::default());
    assert!(result.communities.is_empty());
    assert!(result.quality.is_empty());

    // An edge naming symbols that were never extracted is the other empty case.
    let dangling = ExtractedGraph {
        nodes: Vec::new(),
        edges: vec![ExtractedEdge {
            source: "src/a.ts::a".to_owned(),
            target: "src/b.ts::b".to_owned(),
            kind: EdgeKind::Imports,
        }],
    };
    let result = detect_communities(
        &CodeGraph::from_extracted(&dangling),
        LeidenConfig::default(),
    );
    assert!(result.communities.is_empty());
}

#[test]
fn never_lowers_quality_below_the_singleton_partition() {
    for name in FIXTURES {
        let graph = load(name);
        let config = LeidenConfig::default();
        let floor = singleton_quality(&graph, config.resolution);
        let result = detect_communities(&graph, config);
        assert!(!result.quality.is_empty(), "{name} reported no quality");
        for (depth, &quality) in result.quality.iter().enumerate() {
            assert!(
                quality >= floor - 1e-9,
                "{name} level {depth}: {quality} is below the singleton floor {floor}"
            );
        }
    }
}
