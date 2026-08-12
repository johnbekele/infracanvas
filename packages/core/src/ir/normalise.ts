import type { ArchitectureIr, IrNode } from '@infracanvas/ir-schema';

import { canvasToIr, irToCanvas, withSynthesisedClusters, type CanvasGraph } from './canvas';

/**
 * Losslessness is defined over normalised graphs rather than over raw input.
 *
 * Requiring exact equality on what a caller happens to pass sounds stronger and
 * is not: it would force the IR to carry the canvas's historical spellings
 * forever, and the first fixture using a legacy form would fail a test that is
 * really complaining about the catalogue. Normalising first says precisely
 * which differences are allowed - ordering, float positions, a legacy node
 * spelling, an omitted default - and holds the conversion to everything else.
 */

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Drops keys whose value is undefined, so an absent key and an explicit undefined compare equal. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function normaliseIr(ir: ArchitectureIr): ArchitectureIr {
  return {
    irVersion: ir.irVersion,
    name: ir.name,
    provider: ir.provider,
    region: ir.region,
    // Structural rules first, ordering second: a hand-written document and the
    // same document after a trip through the canvas must reach the same form,
    // and only one of them has had a missing cluster supplied.
    nodes: sortById(withSynthesisedClusters(ir.nodes)).map((node): IrNode => {
      const layout = node.layout ?? { x: 0, y: 0 };
      return defined({
        id: node.id,
        kind: node.kind,
        name: node.name,
        // `parent: null` and an absent parent both mean a root node.
        parent: node.parent ?? undefined,
        layout: defined({
          x: Math.round(layout.x),
          y: Math.round(layout.y),
          width: layout.width,
          height: layout.height,
        }),
        params: node.params,
      }) as IrNode;
    }),
    edges: sortById(ir.edges).map((edge) => defined({ ...edge })),
    presentation: { viewport: ir.presentation?.viewport ?? { x: 0, y: 0, zoom: 1 } },
  };
}

export function normaliseCanvas(graph: CanvasGraph): CanvasGraph {
  // Round-tripping through the IR is what applies the structural rules -
  // synthesising a cluster for a service drawn without one, rounding a position
  // a drag left at sub-pixel precision - rather than a second implementation of
  // them here that could disagree with the first. The result is still a graph
  // React Flow can mount, because `irToCanvas` orders parents before children
  // and `normaliseIr` has already made its input order canonical.
  const normalised = irToCanvas(normaliseIr(canvasToIr(graph)));

  return {
    ...normalised,
    nodes: normalised.nodes.map((node) => defined({ ...node })),
    edges: normalised.edges.map((edge) => defined({ ...edge })),
  };
}
