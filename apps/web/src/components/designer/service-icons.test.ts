import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { awsServices } from '@infracanvas/core';
import { iconFor, isBrandedIcon, registeredIconNames } from './service-icons';

const AWS_ICON_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'icons', 'aws');

function generatedIcons(): { file: string; source: string }[] {
  return readdirSync(AWS_ICON_DIR)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => ({ file, source: readFileSync(join(AWS_ICON_DIR, file), 'utf8') }));
}

describe('the icon registry', () => {
  it('has an icon for every name the catalog declares', () => {
    const registered = new Set(registeredIconNames());

    for (const service of awsServices) {
      expect(
        registered.has(service.icon),
        `${service.id} asks for a missing "${service.icon}"`
      ).toBe(true);
    }
  });

  it('draws the analytics services on their AWS marks', () => {
    const branded = ['athena', 'glue', 'redshift', 'opensearch', 'kinesis', 'firehose', 'msk'];

    for (const id of branded) {
      const service = awsServices.find((entry) => entry.id === id);
      expect(service, `${id} is not in the catalog`).toBeDefined();
      expect(isBrandedIcon(service?.icon), `${id} still uses a generic glyph`).toBe(true);
    }
  });

  it('gives two services different glyphs', () => {
    // A canvas where the warehouse, the crawler and the catalog are all the same
    // shape tells the reader nothing about what they are looking at.
    const seen = new Map<string, string>();

    for (const service of awsServices) {
      const previous = seen.get(service.icon);
      expect(previous, `${service.id} and ${previous} share the "${service.icon}" icon`).toBe(
        undefined
      );
      seen.set(service.icon, service.id);
    }
  });

  it('falls back to a glyph rather than failing on an unknown name', () => {
    expect(iconFor('not-an-icon')).toBeDefined();
    expect(iconFor(undefined)).toBeDefined();
  });
});

describe('the generated AWS marks', () => {
  it('has one component per registered AWS icon', () => {
    const barrel = readFileSync(join(AWS_ICON_DIR, 'index.ts'), 'utf8');
    const exported = [...barrel.matchAll(/export \{ (\w+) \}/g)].map((match) => match[1]);

    expect(exported.length).toBe(generatedIcons().length);
  });

  it('shares no element id between two marks', () => {
    // The marks are inlined into one document, so an id that appears in two of
    // them makes every `url(#id)` in the page resolve to whichever rendered
    // first -- the whole palette drawn in one service's fill.
    const owner = new Map<string, string>();

    for (const { file, source } of generatedIcons()) {
      for (const [, id] of source.matchAll(/\bid="([^"]+)"/g)) {
        expect(owner.get(id), `${file} and ${owner.get(id)} both declare id="${id}"`).toBe(
          undefined
        );
        owner.set(id, file);
      }
    }
  });

  it('scales with the class it is given rather than a baked-in size', () => {
    for (const { file, source } of generatedIcons()) {
      expect(source, `${file} has no viewBox`).toMatch(/viewBox="/);
      expect(source, `${file} pins its own width`).not.toMatch(/<svg[^>]*\swidth=/);
    }
  });
});
