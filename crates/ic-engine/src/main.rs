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

use clap::{Parser, Subcommand};

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
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        // With no subcommand the binary reports what it is. `--version` and
        // `--help` are handled by clap before this point, and Gate 6 relies on
        // both exiting zero.
        None | Some(Command::Version) => println!("ic-engine {}", ic_engine::version()),
    }
}
