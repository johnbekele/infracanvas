; TypeScript declaration and import captures for AST-boundary chunking.
; `@declaration` is the span that becomes a chunk; `@name` is the symbol.

(function_declaration
  name: (identifier) @name) @declaration

(generator_function_declaration
  name: (identifier) @name) @declaration

(method_definition
  name: [
    (property_identifier) @name
    (private_property_identifier) @name
  ]) @declaration

(class_declaration
  name: (type_identifier) @name) @declaration

(abstract_class_declaration
  name: (type_identifier) @name) @declaration

(interface_declaration
  name: (type_identifier) @name) @declaration

(type_alias_declaration
  name: (type_identifier) @name) @declaration

(enum_declaration
  name: (identifier) @name) @declaration

(import_statement) @import
