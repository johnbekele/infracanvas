//! Integration tests for the shared `bge-small-en-v1.5` tokeniser.

use std::path::Path;

use ic_engine::{count_tokens, tokenizer, tokenizer_path};

#[test]
fn loads_the_committed_tokeniser() {
    assert!(tokenizer().is_ok());
}

#[test]
fn tokenizer_json_is_committed() {
    assert!(Path::new(tokenizer_path()).is_file());
}

#[test]
fn counts_a_short_string() {
    let n = count_tokens("hello world").expect("count");
    assert!(n > 0);
    assert!(n < 16);
}

#[test]
fn counts_grow_with_the_input() {
    let short = count_tokens("hello").expect("count short");
    let long = count_tokens("hello world, this is a longer sentence").expect("count long");
    assert!(long > short);
}
