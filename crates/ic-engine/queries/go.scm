; Go declaration and import captures.

(function_declaration
  name: (identifier) @name) @declaration

(method_declaration
  name: (field_identifier) @name) @declaration

(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (struct_type))) @declaration

(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (interface_type))) @declaration

(type_declaration
  (type_spec
    name: (type_identifier) @name)) @declaration

(import_declaration) @import
