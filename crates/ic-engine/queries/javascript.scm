; JavaScript declaration and import captures.

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
  name: (identifier) @name) @declaration

(import_statement) @import
