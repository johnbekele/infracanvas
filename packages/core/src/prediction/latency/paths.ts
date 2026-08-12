import {
  convolve,
  fromSurvival,
  gridSpanning,
  maximumOf,
  meanOf,
  pointMass,
  quantile,
  type Distribution,
  type Grid,
} from './distribution';
import { sojournPercentile, sojournSurvival, type QueueContribution } from './queue';

/**
 * How the per-resource figures become a path figure. This file takes
 * contributions rather than resources, so composition can be tested without a
 * document and so the rule that percentiles do not add lives in one place.
 */

export interface PathLatency {
  /** Resource ids in path order, both branches of a fan-out included. */
  path: string[];
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  contributions: QueueContribution[];
  /** Resource ids at or above the saturation threshold, in path order. */
  saturatedAt: string[];
}

/**
 * A step of the path: one resource, or a fan-out whose branches all serve the
 * same request and which therefore finishes when its slowest branch does.
 */
export type ComposedSegment =
  | { kind: 'resource'; contribution: QueueContribution }
  | { kind: 'fan-out'; branches: QueueContribution[][] };

/** The grid spans four times the sum of the resource p99 values, per the issue. */
const GRID_SPAN_MULTIPLE = 4;

/**
 * The tail is where a percentile is read, so a grid that stopped at the sum of
 * the p99 values would put every answer above it in the last bin.
 */
function gridFor(contributions: readonly QueueContribution[]): Grid {
  let sum = 0;
  for (const contribution of contributions) {
    const p99 = sojournPercentile(contribution, 0.99);
    if (Number.isFinite(p99)) sum += p99;
  }
  return gridSpanning(GRID_SPAN_MULTIPLE * sum);
}

function distributionFor(contribution: QueueContribution, grid: Grid): Distribution {
  if (contribution.model === 'fixed') return pointMass(contribution.serviceTimeMs, grid);
  return fromSurvival((tMs) => sojournSurvival(contribution, tMs), grid);
}

function convolveAll(distributions: readonly Distribution[], grid: Grid): Distribution {
  let total = pointMass(0, grid);
  for (const distribution of distributions) total = convolve(total, distribution, grid);
  return total;
}

function contributionsOf(segments: readonly ComposedSegment[]): QueueContribution[] {
  return segments.flatMap((segment) =>
    segment.kind === 'resource' ? [segment.contribution] : segment.branches.flat()
  );
}

export function composePath(segments: readonly ComposedSegment[]): PathLatency {
  const contributions = contributionsOf(segments);
  const grid = gridFor(contributions);

  const distributions: Distribution[] = [];
  let meanMs = 0;

  for (const segment of segments) {
    if (segment.kind === 'resource') {
      distributions.push(distributionFor(segment.contribution, grid));
      // Exactly the sum of the resource means, by linearity of expectation,
      // which holds whatever the distributions and whatever the correlations.
      meanMs += segment.contribution.totalMs;
      continue;
    }
    const branches = segment.branches.map((branch) =>
      convolveAll(
        branch.map((contribution) => distributionFor(contribution, grid)),
        grid
      )
    );
    const slowest = maximumOf(branches, grid);
    distributions.push(slowest);
    // A fan-out's mean is the mean of the maximum, which has no closed form and
    // is read off the grid. Adding the branches instead would report a request
    // that visited both in turn rather than one that waited for the slower.
    meanMs += meanOf(slowest, grid);
  }

  const path = convolveAll(distributions, grid);
  return {
    path: contributions.map((contribution) => contribution.resourceId),
    meanMs,
    p50Ms: quantile(path, 0.5, grid),
    p95Ms: quantile(path, 0.95, grid),
    p99Ms: quantile(path, 0.99, grid),
    contributions,
    saturatedAt: contributions
      .filter((contribution) => contribution.saturated)
      .map((contribution) => contribution.resourceId),
  };
}
