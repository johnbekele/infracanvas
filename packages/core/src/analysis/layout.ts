/**
 * Placing proposed nodes on the canvas.
 *
 * The previous engine used fixed coordinates, which worked because it always
 * emitted the same seven nodes. Once the number of services follows the
 * repository, positions have to be computed: a subnet holding one service and a
 * subnet holding nine are different sizes, and a container that does not grow
 * clips its children rather than showing them.
 *
 * Everything here is pure arithmetic on sizes. It produces the same coordinates
 * for the same input, which matters because a proposal is compared against
 * itself in tests and stored as part of an experiment.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
}

/** Matches the rendered service card, so packing reflects what is drawn. */
export const NODE_SIZE: Size = { width: 144, height: 96 };

/** Space between siblings. Vertical is larger to leave room for edge labels. */
export const GAP = { x: 46, y: 56 } as const;

/** Inset inside a container. The top is deeper because containers carry a title. */
export const PADDING = { top: 62, right: 26, bottom: 26, left: 26 } as const;

/** Minimums matching what the container node components enforce when resized. */
export const MIN_CONTAINER: Record<'vpc' | 'subnet' | 'cluster', Size> = {
  vpc: { width: 400, height: 300 },
  subnet: { width: 200, height: 150 },
  cluster: { width: 200, height: 150 },
};

export interface Sized<T> {
  item: T;
  size: Size;
}

export interface Placed<T> {
  item: T;
  position: Position;
  size: Size;
}

export interface Block<T> {
  placed: Placed<T>[];
  size: Size;
}

const EMPTY_SIZE: Size = { width: 0, height: 0 };

/**
 * Arrange items in a grid, relative to the origin.
 *
 * Columns are as wide as their widest member and rows as tall as their tallest,
 * so a cluster sitting beside a database does not overlap it. Items are placed
 * in the order given, which keeps the result stable.
 */
export function gridLayout<T>(items: Sized<T>[], columns: number, gap = GAP): Block<T> {
  if (items.length === 0) return { placed: [], size: EMPTY_SIZE };

  const columnCount = Math.max(1, Math.min(columns, items.length));
  const rowCount = Math.ceil(items.length / columnCount);

  const columnWidths = new Array<number>(columnCount).fill(0);
  const rowHeights = new Array<number>(rowCount).fill(0);

  items.forEach((entry, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    columnWidths[column] = Math.max(columnWidths[column], entry.size.width);
    rowHeights[row] = Math.max(rowHeights[row], entry.size.height);
  });

  const columnOffsets: number[] = [];
  let x = 0;
  for (const width of columnWidths) {
    columnOffsets.push(x);
    x += width + gap.x;
  }

  const rowOffsets: number[] = [];
  let y = 0;
  for (const height of rowHeights) {
    rowOffsets.push(y);
    y += height + gap.y;
  }

  const placed = items.map((entry, index) => ({
    item: entry.item,
    position: {
      x: columnOffsets[index % columnCount],
      y: rowOffsets[Math.floor(index / columnCount)],
    },
    size: entry.size,
  }));

  return {
    placed,
    size: {
      width: columnWidths.reduce((sum, width) => sum + width, 0) + gap.x * (columnCount - 1),
      height: rowHeights.reduce((sum, height) => sum + height, 0) + gap.y * (rowCount - 1),
    },
  };
}

/** Place blocks one under another, left-aligned. */
export function stack<T>(blocks: Block<T>[], gapY = GAP.y): Block<T> {
  const present = blocks.filter((block) => block.placed.length > 0);
  if (present.length === 0) return { placed: [], size: EMPTY_SIZE };

  const placed: Placed<T>[] = [];
  let y = 0;
  let width = 0;

  for (const block of present) {
    placed.push(...offset(block.placed, { x: 0, y }));
    width = Math.max(width, block.size.width);
    y += block.size.height + gapY;
  }

  return { placed, size: { width, height: y - gapY } };
}

/** Shift placements by a fixed amount, for moving a block inside a container. */
export function offset<T>(placed: Placed<T>[], by: Position): Placed<T>[] {
  return placed.map((entry) => ({
    ...entry,
    position: { x: entry.position.x + by.x, y: entry.position.y + by.y },
  }));
}

/**
 * Wrap a content block in a container: inset the children and size the box.
 *
 * The minimum keeps a container holding one small node from rendering smaller
 * than the resize handles it carries.
 */
export function contain<T>(
  content: Block<T>,
  minimum: Size = { width: 0, height: 0 }
): { placed: Placed<T>[]; size: Size } {
  return {
    placed: offset(content.placed, { x: PADDING.left, y: PADDING.top }),
    size: {
      width: Math.max(minimum.width, content.size.width + PADDING.left + PADDING.right),
      height: Math.max(minimum.height, content.size.height + PADDING.top + PADDING.bottom),
    },
  };
}

/**
 * How many columns to use for a set of siblings.
 *
 * Roughly square, capped so a wide repository does not produce a canvas that has
 * to be scrolled horizontally before anything can be read.
 */
export function columnsFor(count: number, max = 3): number {
  if (count <= 1) return 1;
  return Math.min(max, Math.ceil(Math.sqrt(count)));
}
