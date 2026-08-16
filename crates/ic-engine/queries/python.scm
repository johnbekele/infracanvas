; Python declaration and import captures.
; A function_definition node already includes its docstring body statement.

(function_definition
  name: (identifier) @name) @declaration

(class_definition
  name: (identifier) @name) @declaration

(decorated_definition
  definition: (function_definition
    name: (identifier) @name)) @declaration

(decorated_definition
  definition: (class_definition
    name: (identifier) @name)) @declaration

(import_statement) @import

(import_from_statement) @import
