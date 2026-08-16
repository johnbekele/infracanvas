; Rust declaration and import captures.
; Methods inside `impl` are `function_item` nodes; the outer impl is dropped
; when it contains smaller declarations.

(function_item
  name: (identifier) @name) @declaration

(struct_item
  name: (type_identifier) @name) @declaration

(enum_item
  name: (type_identifier) @name) @declaration

(union_item
  name: (type_identifier) @name) @declaration

(type_item
  name: (type_identifier) @name) @declaration

(trait_item
  name: (type_identifier) @name) @declaration

(impl_item) @declaration

(use_declaration) @import
