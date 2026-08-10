import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import schemaJson from '../schema/architecture-ir.schema.json';
import { IR_SCHEMA_ID, IR_VERSION } from './generated/ir-version.js';

const packageRoot = join(__dirname, '..');

describe('schema version', () => {
  it('fails when the schema id and the version file disagree', () => {
    const version = readFileSync(join(packageRoot, 'VERSION'), 'utf8').trim();
    expect(schemaJson.$id).toBe(`https://infracanvas.dev/schema/architecture-ir/${version}.json`);
  });

  it('exposes the generated constants that consumers pin against', () => {
    const version = readFileSync(join(packageRoot, 'VERSION'), 'utf8').trim();
    expect(IR_VERSION).toBe(version);
    expect(IR_SCHEMA_ID).toBe(schemaJson.$id);
  });

  it('accepts only documents whose irVersion is in the current major', () => {
    expect(IR_VERSION).toMatch(/^1\.\d+\.\d+$/);
    expect(schemaJson.properties.irVersion.pattern).toBe('^1\\.\\d+\\.\\d+$');
  });
});
