//! Language detection and tree-sitter grammar wiring.
//!
//! Adding a language is a grammar crate dependency plus a query file under
//! `queries/`; this module only maps paths and shebangs onto the six supported
//! grammars.

use tree_sitter::Language as TsLanguage;

/// Languages with a committed grammar and query file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    /// `.ts` — not `.tsx` or `.d.ts` declaration files treated as TypeScript.
    TypeScript,
    /// `.tsx`.
    Tsx,
    /// `.js`, `.mjs`, `.cjs`, `.jsx`.
    JavaScript,
    /// `.py`, `.pyi`.
    Python,
    /// `.rs`.
    Rust,
    /// `.go`.
    Go,
}

impl Language {
    /// By extension, then by shebang for extensionless files. `None` means no grammar.
    #[must_use]
    pub fn from_path(path: &str) -> Option<Self> {
        let file_name = path.rsplit('/').next().unwrap_or(path);
        let (stem, ext) = match file_name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => (stem, ext),
            _ => return None,
        };
        // `file.d.ts` keeps the TypeScript grammar; plain `.ts` / `.tsx` as usual.
        if stem.to_ascii_lowercase().ends_with(".d") && ext.eq_ignore_ascii_case("ts") {
            return Some(Self::TypeScript);
        }
        match ext.to_ascii_lowercase().as_str() {
            "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "js" | "mjs" | "cjs" | "jsx" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            "rs" => Some(Self::Rust),
            "go" => Some(Self::Go),
            _ => None,
        }
    }

    /// Detect from a `#!` line when [`Self::from_path`] has nothing to go on.
    #[must_use]
    pub fn from_shebang(first_line: &str) -> Option<Self> {
        let line = first_line.trim_start();
        if !line.starts_with("#!") {
            return None;
        }
        let lower = line.to_ascii_lowercase();
        if lower.contains("python") {
            return Some(Self::Python);
        }
        if lower.contains("node") || lower.contains("nodejs") {
            return Some(Self::JavaScript);
        }
        None
    }

    /// Stable lowercase name written to `files.language`, for example `typescript`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Rust => "rust",
            Self::Go => "go",
        }
    }

    /// Tree-sitter grammar for this language.
    #[must_use]
    pub fn grammar(self) -> TsLanguage {
        match self {
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
        }
    }

    /// Declaration / import query source committed under `queries/`.
    #[must_use]
    pub const fn query_source(self) -> &'static str {
        match self {
            Self::TypeScript => include_str!("../queries/typescript.scm"),
            Self::Tsx => include_str!("../queries/tsx.scm"),
            Self::JavaScript => include_str!("../queries/javascript.scm"),
            Self::Python => include_str!("../queries/python.scm"),
            Self::Rust => include_str!("../queries/rust.scm"),
            Self::Go => include_str!("../queries/go.scm"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Language;

    #[test]
    fn detects_common_extensions() {
        assert_eq!(Language::from_path("src/a.ts"), Some(Language::TypeScript));
        assert_eq!(Language::from_path("src/a.tsx"), Some(Language::Tsx));
        assert_eq!(Language::from_path("src/a.js"), Some(Language::JavaScript));
        assert_eq!(Language::from_path("src/a.py"), Some(Language::Python));
        assert_eq!(Language::from_path("src/a.rs"), Some(Language::Rust));
        assert_eq!(Language::from_path("src/a.go"), Some(Language::Go));
        assert_eq!(Language::from_path("src/a.rb"), None);
    }

    #[test]
    fn shebang_detects_python_and_node() {
        assert_eq!(
            Language::from_shebang("#!/usr/bin/env python3"),
            Some(Language::Python)
        );
        assert_eq!(
            Language::from_shebang("#!/usr/bin/env node"),
            Some(Language::JavaScript)
        );
        assert_eq!(Language::from_shebang("not a shebang"), None);
    }
}
