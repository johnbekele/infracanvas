/**
 * Shorthand for declaring service properties.
 *
 * The catalog is data, and a service that needs six lines of object literal per
 * field ends up with two fields. These constructors keep a definition readable
 * enough that adding the properties a service actually has is the easy path.
 */
import type { ServiceProperty } from '../aws-services';

export function text(
  name: string,
  label: string,
  fallback = '',
  required = false
): ServiceProperty {
  return { name, label, type: 'text', default: fallback, required };
}

export function num(name: string, label: string, fallback: number): ServiceProperty {
  return { name, label, type: 'number', default: fallback };
}

export function bool(name: string, label: string, fallback: boolean): ServiceProperty {
  return { name, label, type: 'boolean', default: fallback };
}

/** Options given as `value` or `[value, label]` when the label differs. */
export function select(
  name: string,
  label: string,
  options: (string | [string, string])[],
  fallback?: string
): ServiceProperty {
  const normalised = options.map((option) =>
    typeof option === 'string'
      ? { value: option, label: option }
      : { value: option[0], label: option[1] }
  );

  return {
    name,
    label,
    type: 'select',
    default: fallback ?? normalised[0].value,
    options: normalised,
  };
}
