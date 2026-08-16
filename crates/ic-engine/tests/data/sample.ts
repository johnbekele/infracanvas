import { readFile as _readFile } from 'fs';
import _path from 'path';
import { createHash as _createHash } from 'crypto';

export function alpha(value: number): number {
  return value + 1;
}

export function beta(value: string): string {
  return value.toUpperCase();
}

export function gamma(items: number[]): number {
  return items.reduce((sum, n) => sum + n, 0);
}
