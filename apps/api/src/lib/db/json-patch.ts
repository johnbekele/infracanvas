// RFC 6902 operations over an Architecture IR document.
//
// A revision stores the whole document as the authority and the patch alongside
// it as derived data, so the timeline can say what changed and the copilot can
// show its own edit as a diff. Everything here is therefore about producing and
// checking that derived array, never about reconstructing a document from it.
// Imported as a default and destructured rather than with named imports.
// `fast-json-patch` ships CommonJS as its `main` and points `module` at an ESM
// build, which only bundlers read. Under Node's ESM loader the CommonJS file is
// what gets loaded, and its exports are assigned in a way the named-export
// detector cannot see, so `import { applyPatch }` throws at startup -- in the dev
// server and the built output, but not under Vitest, which interops it for us.
import fastJsonPatch from 'fast-json-patch';

const { applyPatch, compare } = fastJsonPatch;

/** RFC 6902. Structural only; `value` is whatever the IR holds at that pointer. */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  from?: string;
  value?: unknown;
}

/** A JSON document, which for our purposes is always an IR object. */
type JsonObject = Record<string, unknown>;

/** The operations taking `parent` to `child`. */
export function computePatch(parent: JsonObject, child: JsonObject): JsonPatchOperation[] {
  return compare(parent, child) as JsonPatchOperation[];
}

/**
 * Apply `patch` to a copy of `document`.
 *
 * `mutateDocument` is false so the caller's parent document is never altered --
 * the parent is a row we just read and may still compare against. Prototype
 * modifications stay banned, which is the library default and matters here
 * because a patch can arrive from a browser: a `__proto__` pointer in an
 * attacker's operation array would otherwise reach Object.prototype.
 */
export function applyJsonPatch(
  document: JsonObject,
  patch: readonly JsonPatchOperation[]
): JsonObject {
  const result = applyPatch(
    document,
    patch as Parameters<typeof applyPatch>[1],
    /* validateOperation */ true,
    /* mutateDocument */ false,
    /* banPrototypeModifications */ true
  );
  return result.newDocument as JsonObject;
}

/**
 * Whether applying `patch` to `parent` produces `child` exactly.
 *
 * Returns false rather than throwing for a malformed patch, because the caller
 * is answering a request and a bad operation array is the client's mistake, not
 * a server fault. Equality is asked of the patch algebra itself: two documents
 * are the same when there is no operation that would take one to the other,
 * which avoids a hand-written deep comparison disagreeing with the library that
 * produced the patch in the first place.
 */
export function patchReproduces(
  parent: JsonObject,
  patch: readonly JsonPatchOperation[],
  child: JsonObject
): boolean {
  try {
    return compare(applyJsonPatch(parent, patch), child).length === 0;
  } catch {
    return false;
  }
}
