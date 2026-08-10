import { describe, expect, it } from 'vitest';
import { GAP, NODE_SIZE, PADDING, columnsFor, contain, gridLayout, stack } from './layout';

const sized = (label: string, width = NODE_SIZE.width, height = NODE_SIZE.height) => ({
  item: label,
  size: { width, height },
});

describe('gridLayout', () => {
  it('places nothing for no items', () => {
    expect(gridLayout([], 3)).toEqual({ placed: [], size: { width: 0, height: 0 } });
  });

  it('leaves a gap between siblings', () => {
    const { placed } = gridLayout([sized('a'), sized('b')], 2);

    expect(placed[1].position.x - placed[0].position.x).toBe(NODE_SIZE.width + GAP.x);
    expect(placed[1].position.y).toBe(placed[0].position.y);
  });

  it('wraps onto a second row past the column count', () => {
    const { placed } = gridLayout([sized('a'), sized('b'), sized('c')], 2);

    expect(placed[2].position.x).toBe(0);
    expect(placed[2].position.y).toBe(NODE_SIZE.height + GAP.y);
  });

  it('widens a column to its widest member', () => {
    const { placed, size } = gridLayout([sized('wide', 300), sized('b'), sized('c')], 2);

    // The third item sits under the first, so it starts at the same x.
    expect(placed[2].position.x).toBe(0);
    expect(size.width).toBe(300 + GAP.x + NODE_SIZE.width);
  });

  it('never returns more columns than items', () => {
    const { size } = gridLayout([sized('only')], 4);
    expect(size.width).toBe(NODE_SIZE.width);
  });
});

describe('stack', () => {
  it('places blocks one under another', () => {
    const first = gridLayout([sized('a')], 1);
    const second = gridLayout([sized('b')], 1);
    const { placed } = stack([first, second]);

    expect(placed[1].position.y).toBe(NODE_SIZE.height + GAP.y);
  });

  it('ignores empty blocks rather than leaving a hole', () => {
    const { placed, size } = stack([gridLayout([], 1), gridLayout([sized('a')], 1)]);

    expect(placed[0].position.y).toBe(0);
    expect(size.height).toBe(NODE_SIZE.height);
  });
});

describe('contain', () => {
  it('insets children and sizes the box around them', () => {
    const content = gridLayout([sized('a')], 1);
    const { placed, size } = contain(content);

    expect(placed[0].position).toEqual({ x: PADDING.left, y: PADDING.top });
    expect(size.width).toBe(NODE_SIZE.width + PADDING.left + PADDING.right);
  });

  it('never shrinks below the minimum a container renders at', () => {
    const { size } = contain(gridLayout([], 1), { width: 400, height: 300 });
    expect(size).toEqual({ width: 400, height: 300 });
  });

  it('grows past the minimum when the children need it', () => {
    const many = Array.from({ length: 9 }, (_, index) => sized(`n${index}`));
    const { size } = contain(gridLayout(many, 3), { width: 400, height: 300 });

    expect(size.width).toBeGreaterThan(400);
    expect(size.height).toBeGreaterThan(300);
  });
});

describe('columnsFor', () => {
  it('keeps a single item in one column', () => {
    expect(columnsFor(1)).toBe(1);
  });

  it('caps the width so a wide repository still reads left to right', () => {
    expect(columnsFor(40)).toBe(3);
  });

  it('stays roughly square for a small count', () => {
    expect(columnsFor(4)).toBe(2);
  });
});
