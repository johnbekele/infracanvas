//! Integration tests for the local embedder.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::thread;

use ic_engine::{EmbedError, Embedder, LocalEmbedder, LocalEmbedderOptions};
use tempfile::TempDir;

static SHARED: OnceLock<Arc<LocalEmbedder>> = OnceLock::new();

fn load_shared() -> Arc<LocalEmbedder> {
    SHARED
        .get_or_init(|| {
            let mut options = LocalEmbedderOptions::default();
            if LocalEmbedder::is_cached(&options) {
                options.offline = true;
            }
            Arc::new(LocalEmbedder::load(&options).expect("load local embedder"))
        })
        .clone()
}

fn l2_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

#[test]
fn embeds_a_batch_into_384_dimension_vectors() {
    let embedder = load_shared();
    assert_eq!(embedder.dim(), 384);
    assert_eq!(embedder.model_id(), "bge-small-en-v1.5-q");

    let texts = ["alpha function", "beta class", "gamma module"];
    let vectors = embedder.embed_batch(&texts).expect("embed batch");
    assert_eq!(vectors.len(), texts.len());
    for vector in &vectors {
        assert_eq!(vector.len(), 384);
    }
}

#[test]
fn returns_unit_length_vectors() {
    let embedder = load_shared();
    let vectors = embedder.embed_batch(&["unit length check"]).expect("embed");
    let norm = l2_norm(vectors.first().expect("one vector"));
    assert!((norm - 1.0).abs() < 1e-6, "norm was {norm}");
}

#[test]
fn is_deterministic_for_the_same_input() {
    let embedder = load_shared();
    let text = ["deterministic input for re-index"];
    let first = embedder.embed_batch(&text).expect("first");
    let second = embedder.embed_batch(&text).expect("second");
    assert_eq!(first, second);
}

#[test]
fn truncates_an_input_longer_than_the_model_window() {
    let embedder = load_shared();
    let max = embedder.max_tokens();
    // Far more tokens than the window; must embed rather than error.
    let long = "token ".repeat(max * 4);
    let vectors = embedder
        .embed_batch(&[long.as_str()])
        .expect("truncate long input");
    assert_eq!(vectors.len(), 1);
    assert_eq!(vectors[0].len(), 384);
    assert!((l2_norm(&vectors[0]) - 1.0).abs() < 1e-6);
}

#[test]
fn returns_an_empty_result_for_an_empty_batch() {
    let embedder = load_shared();
    let vectors = embedder.embed_batch(&[]).expect("empty batch");
    assert!(vectors.is_empty());
}

#[test]
fn fails_with_model_not_cached_when_offline_and_the_cache_is_empty() {
    let dir = TempDir::new().expect("tempdir");
    let options = LocalEmbedderOptions {
        cache_dir: dir.path().to_path_buf(),
        offline: true,
        ..LocalEmbedderOptions::default()
    };
    assert!(!LocalEmbedder::is_cached(&options));
    match LocalEmbedder::load(&options) {
        Err(EmbedError::ModelNotCached {
            model_id,
            cache_dir,
        }) => {
            assert_eq!(model_id, "bge-small-en-v1.5-q");
            assert_eq!(cache_dir, PathBuf::from(dir.path()));
        }
        Ok(_) => panic!("expected ModelNotCached, load succeeded"),
        Err(other) => panic!("expected ModelNotCached, got {other:?}"),
    }
}

#[test]
fn loads_from_the_cache_with_no_network_after_the_first_fetch() {
    // Warm the shared cache (may fetch once), then prove a second load works offline.
    let online = LocalEmbedderOptions {
        offline: false,
        ..LocalEmbedderOptions::default()
    };
    let _first = LocalEmbedder::load(&online).expect("first fetch into cache");
    assert!(LocalEmbedder::is_cached(&online));

    let offline = LocalEmbedderOptions {
        offline: true,
        ..LocalEmbedderOptions::default()
    };
    let embedder = LocalEmbedder::load(&offline).expect("offline load from cache");
    let vectors = embedder
        .embed_batch(&["cached model works offline"])
        .expect("embed after offline load");
    assert_eq!(vectors.len(), 1);
    assert_eq!(vectors[0].len(), 384);
}

#[test]
fn embeds_from_several_threads_through_one_shared_embedder() {
    let embedder = load_shared();
    let mut handles = Vec::new();
    for i in 0..4 {
        let embedder = Arc::clone(&embedder);
        handles.push(thread::spawn(move || {
            let text = format!("concurrent embedding {i}");
            embedder
                .embed_batch(&[text.as_str()])
                .expect("concurrent embed")
        }));
    }
    for handle in handles {
        let vectors = handle.join().expect("thread");
        assert_eq!(vectors.len(), 1);
        assert_eq!(vectors[0].len(), 384);
    }
}
