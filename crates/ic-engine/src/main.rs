//! The `ic-engine` command line interface.
//!
//! Benchmarks and CI drive the engine through this binary, which keeps the
//! engine measurable without standing up the API, the database, or Python.

#![warn(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use ic_engine::{ChunkOptions, EmbedderChoice, EngineConfig, IndexError, IndexOptions, index};
use uuid::Uuid;

#[derive(Parser)]
#[command(
    name = "ic-engine",
    version,
    about = "InfraCanvas repository ingestion engine"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Print the engine version and exit.
    Version,
    /// Walk, chunk, embed, and write one ingestion run into Postgres.
    Index {
        /// Repository checkout to index.
        path: PathBuf,
        #[arg(long)]
        repository_id: Uuid,
        #[arg(long)]
        run_id: Uuid,
        #[arg(long)]
        previous_run_id: Option<Uuid>,
        /// Falls back to the `DATABASE_URL` environment variable.
        #[arg(long, env = "DATABASE_URL")]
        database_url: String,
        /// Skip embedding; write files and chunks only.
        #[arg(long)]
        no_embeddings: bool,
        /// Print `IndexStats` as one JSON object on stdout.
        #[arg(long)]
        json: bool,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    match cli.command {
        // With no subcommand the binary reports what it is. `--version` and
        // `--help` are handled by clap before this point, and Gate 6 relies on
        // both exiting zero.
        None | Some(Command::Version) => {
            println!("ic-engine {}", ic_engine::version());
            ExitCode::SUCCESS
        }
        Some(Command::Index {
            path,
            repository_id,
            run_id,
            previous_run_id,
            database_url,
            no_embeddings,
            json,
        }) => {
            let embedder = if no_embeddings {
                EmbedderChoice::Disabled
            } else {
                EmbedderChoice::Local {
                    cache_dir: None,
                    offline: false,
                }
            };
            let options = IndexOptions {
                root: path,
                repository_id,
                run_id,
                previous_run_id,
                database_url,
                engine: EngineConfig::default(),
                chunking: ChunkOptions::default(),
                embedder,
                files_per_transaction: 256,
            };
            match index(options) {
                Ok(stats) => {
                    if json {
                        match serde_json::to_string(&stats) {
                            Ok(payload) => {
                                println!("{payload}");
                                ExitCode::SUCCESS
                            }
                            Err(err) => {
                                eprintln!("failed to serialise IndexStats: {err}");
                                ExitCode::from(1)
                            }
                        }
                    } else {
                        println!(
                            "indexed {} files ({} unchanged, {} removed), {} chunks, {} embeddings in {} ms",
                            stats.files_indexed,
                            stats.files_unchanged,
                            stats.files_removed,
                            stats.chunks_written,
                            stats.embeddings_written,
                            stats.elapsed_ms
                        );
                        ExitCode::SUCCESS
                    }
                }
                Err(err) => {
                    eprintln!("{err}");
                    ExitCode::from(exit_code_for(&err))
                }
            }
        }
    }
}

fn exit_code_for(err: &IndexError) -> u8 {
    match err {
        IndexError::DatabaseUnavailable(_) => 3,
        _ => 1,
    }
}
