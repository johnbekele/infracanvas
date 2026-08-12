import { describe, expect, it } from 'vitest';
import { parseAnalyzePayload } from './analyze-repository.js';
import { NonRetryableJobError } from '../types.js';

const valid = {
  analysisId: '2f1c8d2e-6d4a-4f52-9a5b-1c0f5e6a7b8c',
  repositoryId: 'c7b1a0d3-8e2f-4a91-b6d5-0e3f2a1c9b74',
  userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  ref: 'main',
};

describe('parseAnalyzePayload', () => {
  it('reads a payload written by the current version', () => {
    expect(parseAnalyzePayload({ ...valid })).toEqual(valid);
  });

  it('names every field that is missing', () => {
    // A job enqueued before a payload change and claimed after it is an ordinary
    // deployment, and it should say what it could not read rather than fail with
    // a TypeError from somewhere inside the analysis.
    expect(() => parseAnalyzePayload({ analysisId: valid.analysisId })).toThrow(
      /repositoryId, userId, ref/
    );
  });

  it('rejects a field of the wrong type', () => {
    expect(() => parseAnalyzePayload({ ...valid, ref: 42 })).toThrow(/ref/);
  });

  it('rejects an empty string, which is not a usable identifier', () => {
    expect(() => parseAnalyzePayload({ ...valid, analysisId: '' })).toThrow(/analysisId/);
  });

  it('does not ask the queue to retry a payload that will never parse', () => {
    // Retrying a malformed payload three times finds the same malformed payload
    // three times, and delays telling anyone.
    expect(() => parseAnalyzePayload({})).toThrow(NonRetryableJobError);
  });
});
