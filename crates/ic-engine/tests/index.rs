//! Integration tests for `ic_engine::index`.
//!
//! Reads `TEST_DATABASE_URL` and skips when absent (unless `CI` is set, in which
//! case a missing URL is a hard failure).

use std::path::{Path, PathBuf};

use ic_engine::{
    ChunkOptions, Embedder, EmbedderChoice, EngineConfig, IndexError, IndexOptions, IndexStats,
    index, index_with_embedder,
};
use postgres::{Client, NoTls};
use tempfile::TempDir;
use uuid::Uuid;

fn test_database_url() -> Option<String> {
    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.is_empty() => Some(url),
        _ => {
            assert!(
                std::env::var_os("CI").is_none(),
                "TEST_DATABASE_URL must be set in CI"
            );
            None
        }
    }
}

fn connect() -> Client {
    let url = test_database_url().expect("TEST_DATABASE_URL");
    Client::connect(&url, NoTls).expect("connect to TEST_DATABASE_URL")
}

struct SeededRun {
    repository_id: Uuid,
    run_id: Uuid,
    database_url: String,
}

fn seed_run(client: &mut Client, database_url: &str) -> SeededRun {
    let user_id = Uuid::now_v7();
    let repository_id = Uuid::now_v7();
    let run_id = Uuid::now_v7();
    // github_id is UNIQUE; keep the value in the positive i64 range.
    let github_id = i64::try_from(user_id.as_u128() & ((1u128 << 63) - 1)).expect("github id");

    client
        .execute(
            "INSERT INTO users (id, github_id, github_username, github_avatar)
             VALUES ($1, $2, $3, $4)",
            &[
                &user_id,
                &github_id,
                &format!("index-test-{user_id}"),
                &"https://example.com/a.png",
            ],
        )
        .expect("insert user");
    client
        .execute(
            "INSERT INTO repositories (id, user_id, github_id, github_owner, github_name, default_branch)
             VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &repository_id,
                &user_id,
                &github_id,
                &"owner",
                &format!("repo-{repository_id}"),
                &"main",
            ],
        )
        .expect("insert repository");
    client
        .execute(
            "INSERT INTO ingestion_runs (id, repository_id, commit_sha, ref, status)
             VALUES ($1, $2, $3, $4, 'pending')",
            &[&run_id, &repository_id, &"abc123", &"main"],
        )
        .expect("insert run");

    SeededRun {
        repository_id,
        run_id,
        database_url: database_url.to_owned(),
    }
}

fn write_fixture(root: &Path, files: &[(&str, &str)]) {
    for (rel, content) in files {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(&path, content).expect("write file");
    }
}

fn options_for(seed: &SeededRun, root: PathBuf, previous: Option<Uuid>) -> IndexOptions {
    IndexOptions {
        root,
        repository_id: seed.repository_id,
        run_id: seed.run_id,
        previous_run_id: previous,
        database_url: seed.database_url.clone(),
        engine: EngineConfig::default(),
        chunking: ChunkOptions::default(),
        embedder: EmbedderChoice::Disabled,
        files_per_transaction: 256,
    }
}

fn count_files(client: &mut Client, run_id: Uuid) -> usize {
    let n: i64 = client
        .query_one(
            "SELECT count(*)::bigint FROM files WHERE run_id = $1",
            &[&run_id],
        )
        .expect("count files")
        .get(0);
    usize::try_from(n).expect("files count fits usize")
}

fn count_chunks(client: &mut Client, run_id: Uuid) -> usize {
    let n: i64 = client
        .query_one(
            "SELECT count(*)::bigint FROM chunks c
             JOIN files f ON f.id = c.file_id
             WHERE f.run_id = $1",
            &[&run_id],
        )
        .expect("count chunks")
        .get(0);
    usize::try_from(n).expect("chunks count fits usize")
}

fn count_embeddings(client: &mut Client, run_id: Uuid) -> usize {
    let n: i64 = client
        .query_one(
            "SELECT count(*)::bigint FROM chunk_embeddings e
             JOIN chunks c ON c.id = e.chunk_id
             JOIN files f ON f.id = c.file_id
             WHERE f.run_id = $1",
            &[&run_id],
        )
        .expect("count embeddings")
        .get(0);
    usize::try_from(n).expect("embeddings count fits usize")
}

fn count_chunks_for_path(client: &mut Client, run_id: Uuid, path: &str) -> usize {
    let n: i64 = client
        .query_one(
            "SELECT count(*)::bigint FROM chunks c
             JOIN files f ON f.id = c.file_id
             WHERE f.run_id = $1 AND f.path = $2",
            &[&run_id, &path],
        )
        .expect("count chunks for path")
        .get(0);
    usize::try_from(n).expect("chunks count fits usize")
}

struct FakeEmbedder {
    dim: usize,
}

impl Embedder for FakeEmbedder {
    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, ic_engine::EmbedError> {
        Ok(texts
            .iter()
            .map(|_| {
                let mut v = vec![0.0_f32; self.dim];
                if let Some(first) = v.first_mut() {
                    *first = 1.0;
                }
                v
            })
            .collect())
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn model_id(&self) -> &'static str {
        "fake-embedder"
    }

    fn max_tokens(&self) -> usize {
        512
    }
}

#[test]
fn indexes_a_fixture_and_writes_files_chunks_and_embeddings() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let seed = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(
        dir.path(),
        &[
            (
                "src/a.ts",
                "export function alpha(): number { return 1; }\n",
            ),
            ("src/b.py", "def beta():\n    return 2\n"),
        ],
    );

    let embedder = FakeEmbedder { dim: 384 };
    let opts = options_for(&seed, dir.path().to_path_buf(), None);
    // Force the dyn-embedder path so we write embeddings without the ONNX model.
    let stats = index_with_embedder(opts, &embedder).expect("index");

    assert_eq!(stats.files_indexed, 2);
    assert!(stats.chunks_written >= 2);
    assert_eq!(stats.embeddings_written, stats.chunks_written);
    assert_eq!(count_files(&mut client, seed.run_id), 2);
    assert_eq!(count_chunks(&mut client, seed.run_id), stats.chunks_written);
    assert_eq!(
        count_embeddings(&mut client, seed.run_id),
        stats.embeddings_written
    );
}

#[test]
fn stats_counts_match_the_rows_in_the_database() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let seed = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(
        dir.path(),
        &[("hello.ts", "export const x = 1;\n"), ("note.md", "# hi\n")],
    );

    let stats = index(options_for(&seed, dir.path().to_path_buf(), None)).expect("index");
    assert_eq!(count_files(&mut client, seed.run_id), stats.files_indexed);
    assert_eq!(count_chunks(&mut client, seed.run_id), stats.chunks_written);
    assert_eq!(count_embeddings(&mut client, seed.run_id), 0);
    assert_eq!(stats.embeddings_written, 0);
}

#[test]
fn re_indexing_an_unchanged_checkout_parses_and_embeds_nothing() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let first = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(
        dir.path(),
        &[
            ("a.ts", "export function a() { return 1; }\n"),
            ("b.ts", "export function b() { return 2; }\n"),
        ],
    );
    let first_stats = index(options_for(&first, dir.path().to_path_buf(), None)).expect("first");
    assert!(first_stats.files_indexed > 0);

    let second = seed_run_for_repo(&mut client, &url, first.repository_id);
    let stats = index(options_for(
        &second,
        dir.path().to_path_buf(),
        Some(first.run_id),
    ))
    .expect("reindex");

    assert_eq!(stats.files_indexed, 0);
    assert_eq!(
        stats.files_unchanged,
        stats.files_scanned - stats.files_skipped
    );
    assert!(stats.files_unchanged > 0);
}

fn seed_run_for_repo(client: &mut Client, database_url: &str, repository_id: Uuid) -> SeededRun {
    // At most one pending/running run per repository.
    client
        .execute(
            "UPDATE ingestion_runs SET status = 'succeeded', finished_at = now()
             WHERE repository_id = $1 AND status IN ('pending', 'running')",
            &[&repository_id],
        )
        .expect("close active runs");
    let run_id = Uuid::now_v7();
    client
        .execute(
            "INSERT INTO ingestion_runs (id, repository_id, commit_sha, ref, status)
             VALUES ($1, $2, $3, $4, 'pending')",
            &[&run_id, &repository_id, &"def456", &"main"],
        )
        .expect("insert second run");
    SeededRun {
        repository_id,
        run_id,
        database_url: database_url.to_owned(),
    }
}

#[test]
fn copies_unchanged_chunks_and_embeddings_forward_to_the_new_run() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let first = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(
        dir.path(),
        &[("svc.ts", "export function serve() { return true; }\n")],
    );
    let embedder = FakeEmbedder { dim: 384 };
    index_with_embedder(
        options_for(&first, dir.path().to_path_buf(), None),
        &embedder,
    )
    .expect("first");

    let old_chunks: Vec<(Uuid, String, Option<String>, String)> = client
        .query(
            "SELECT c.id, c.content, c.symbol, c.kind FROM chunks c
             JOIN files f ON f.id = c.file_id WHERE f.run_id = $1 ORDER BY c.start_line",
            &[&first.run_id],
        )
        .expect("old chunks")
        .into_iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect();
    assert!(!old_chunks.is_empty());

    let second = seed_run_for_repo(&mut client, &url, first.repository_id);
    index_with_embedder(
        options_for(&second, dir.path().to_path_buf(), Some(first.run_id)),
        &embedder,
    )
    .expect("second");

    let new_chunks: Vec<(Uuid, String, Option<String>, String)> = client
        .query(
            "SELECT c.id, c.content, c.symbol, c.kind FROM chunks c
             JOIN files f ON f.id = c.file_id WHERE f.run_id = $1 ORDER BY c.start_line",
            &[&second.run_id],
        )
        .expect("new chunks")
        .into_iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect();
    assert_eq!(old_chunks.len(), new_chunks.len());
    for (old, new) in old_chunks.iter().zip(new_chunks.iter()) {
        assert_ne!(old.0, new.0, "copied chunk must get a new id");
        assert_eq!(old.1, new.1);
        assert_eq!(old.2, new.2);
        assert_eq!(old.3, new.3);
    }

    let old_emb: Vec<String> = client
        .query(
            "SELECT e.embedding::text FROM chunk_embeddings e
             JOIN chunks c ON c.id = e.chunk_id
             JOIN files f ON f.id = c.file_id
             WHERE f.run_id = $1 ORDER BY c.start_line",
            &[&first.run_id],
        )
        .expect("old emb")
        .into_iter()
        .map(|r| r.get(0))
        .collect();
    let new_emb: Vec<String> = client
        .query(
            "SELECT e.embedding::text FROM chunk_embeddings e
             JOIN chunks c ON c.id = e.chunk_id
             JOIN files f ON f.id = c.file_id
             WHERE f.run_id = $1 ORDER BY c.start_line",
            &[&second.run_id],
        )
        .expect("new emb")
        .into_iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(old_emb, new_emb);
}

#[test]
fn drops_chunks_of_a_file_that_changed() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let first = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(
        dir.path(),
        &[
            ("keep.ts", "export function keep() { return 1; }\n"),
            ("change.ts", "export function oldName() { return 2; }\n"),
        ],
    );
    index(options_for(&first, dir.path().to_path_buf(), None)).expect("first");

    std::fs::write(
        dir.path().join("change.ts"),
        "export function newName() { return 99; }\n",
    )
    .expect("modify");

    let second = seed_run_for_repo(&mut client, &url, first.repository_id);
    let stats = index(options_for(
        &second,
        dir.path().to_path_buf(),
        Some(first.run_id),
    ))
    .expect("second");
    assert_eq!(stats.files_indexed, 1);
    assert_eq!(stats.files_unchanged, 1);

    let symbols: Vec<Option<String>> = client
        .query(
            "SELECT c.symbol FROM chunks c
             JOIN files f ON f.id = c.file_id
             WHERE f.run_id = $1 AND f.path = 'change.ts'",
            &[&second.run_id],
        )
        .expect("symbols")
        .into_iter()
        .map(|r| r.get(0))
        .collect();
    assert!(
        symbols.iter().any(|s| s.as_deref() == Some("newName")),
        "expected newName in {symbols:?}"
    );
    assert!(
        symbols.iter().all(|s| s.as_deref() != Some("oldName")),
        "oldName must not be carried forward: {symbols:?}"
    );
}

#[test]
fn omits_a_deleted_file_from_the_new_run() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let first = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(
        dir.path(),
        &[
            ("stay.ts", "export const stay = 1;\n"),
            ("gone.ts", "export const gone = 2;\n"),
        ],
    );
    index(options_for(&first, dir.path().to_path_buf(), None)).expect("first");
    std::fs::remove_file(dir.path().join("gone.ts")).expect("delete");

    let second = seed_run_for_repo(&mut client, &url, first.repository_id);
    let stats = index(options_for(
        &second,
        dir.path().to_path_buf(),
        Some(first.run_id),
    ))
    .expect("second");
    assert_eq!(stats.files_removed, 1);

    let paths: Vec<String> = client
        .query(
            "SELECT path FROM files WHERE run_id = $1 ORDER BY path",
            &[&second.run_id],
        )
        .expect("paths")
        .into_iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(paths, vec!["stay.ts".to_owned()]);
    let gone_chunks = count_chunks_for_path(&mut client, second.run_id, "gone.ts");
    assert_eq!(gone_chunks, 0);
}

#[test]
fn rolls_back_a_batch_that_fails_partway_through() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let seed = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(
        dir.path(),
        &[
            ("one.ts", "export const one = 1;\n"),
            ("two.ts", "export const two = 2;\n"),
        ],
    );

    // Scope the trigger to this run_id so parallel tests are unaffected.
    let run_literal = seed.run_id.to_string();
    client
        .batch_execute(&format!(
            "
            CREATE OR REPLACE FUNCTION fail_second_file_{id}() RETURNS trigger AS $$
            BEGIN
              IF NEW.run_id = '{run}'::uuid
                 AND (SELECT count(*) FROM files WHERE run_id = NEW.run_id) >= 1 THEN
                RAISE EXCEPTION 'forced batch failure';
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            DROP TRIGGER IF EXISTS fail_second_file_trg_{id} ON files;
            CREATE TRIGGER fail_second_file_trg_{id}
              BEFORE INSERT ON files
              FOR EACH ROW EXECUTE FUNCTION fail_second_file_{id}();
            ",
            id = run_literal.replace('-', ""),
            run = run_literal,
        ))
        .expect("install trigger");

    let mut opts = options_for(&seed, dir.path().to_path_buf(), None);
    opts.files_per_transaction = 2;
    let result = index(opts);

    let id = run_literal.replace('-', "");
    client
        .batch_execute(&format!(
            "DROP TRIGGER IF EXISTS fail_second_file_trg_{id} ON files;
             DROP FUNCTION IF EXISTS fail_second_file_{id}();"
        ))
        .expect("drop trigger");

    assert!(result.is_err(), "expected batch failure, got {result:?}");
    assert_eq!(count_files(&mut client, seed.run_id), 0);
    assert_eq!(count_chunks(&mut client, seed.run_id), 0);
}

#[test]
fn returns_database_unavailable_rather_than_panicking() {
    let dir = TempDir::new().expect("tempdir");
    write_fixture(dir.path(), &[("a.ts", "export const a = 1;\n")]);
    let opts = IndexOptions {
        root: dir.path().to_path_buf(),
        repository_id: Uuid::now_v7(),
        run_id: Uuid::now_v7(),
        previous_run_id: None,
        database_url: "postgres://nobody:wrong@127.0.0.1:1/missing".to_owned(),
        engine: EngineConfig::default(),
        chunking: ChunkOptions::default(),
        embedder: EmbedderChoice::Disabled,
        files_per_transaction: 256,
    };
    let err = index(opts).expect_err("should fail");
    assert!(
        matches!(err, IndexError::DatabaseUnavailable(_)),
        "got {err:?}"
    );
}

#[test]
fn rejects_an_embedder_whose_dimension_is_not_384() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let seed = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(dir.path(), &[("a.ts", "export const a = 1;\n")]);

    let embedder = FakeEmbedder { dim: 768 };
    let err = index_with_embedder(
        options_for(&seed, dir.path().to_path_buf(), None),
        &embedder,
    )
    .expect_err("dimension mismatch");
    assert!(
        matches!(
            err,
            IndexError::DimensionMismatch {
                actual: 768,
                expected: 384
            }
        ),
        "got {err:?}"
    );
    assert_eq!(count_files(&mut client, seed.run_id), 0);
}

#[test]
fn cli_index_json_prints_one_index_stats_object() {
    let Some(url) = test_database_url() else {
        return;
    };
    let mut client = connect();
    let seed = seed_run(&mut client, &url);
    let dir = TempDir::new().expect("tempdir");
    write_fixture(dir.path(), &[("cli.ts", "export const cli = 1;\n")]);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ic-engine"))
        .args([
            "index",
            dir.path().to_str().expect("utf8 path"),
            "--repository-id",
            &seed.repository_id.to_string(),
            "--run-id",
            &seed.run_id.to_string(),
            "--database-url",
            &url,
            "--no-embeddings",
            "--json",
        ])
        .output()
        .expect("run cli");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8");
    let stats: IndexStats = serde_json::from_str(stdout.trim()).expect("parse IndexStats");
    assert!(stats.files_indexed >= 1);
}
