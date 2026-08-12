/**
 * M/M/c, with M/M/1 as its one-server case, and nothing in this file knows what
 * an architecture is. Keeping the queueing arithmetic free of the IR is what
 * lets it be tested against published Erlang values rather than against a
 * document that happens to contain a database.
 *
 * The alternative model - a constant per service, added along the path - has
 * one property that disqualifies it: the answer does not change with load. It
 * says the architecture behaves the same at ten requests per second as at ten
 * thousand, which hides the only latency problem worth predicting.
 *
 * Naming deviation from the issue, which calls this shape `LatencyContribution`.
 * `resources/contract.ts` already uses that name for a resource's service time,
 * which is an input to this model rather than its output; two meanings under
 * one name in one package makes every import a question, so the queueing figure
 * is a `QueueContribution`.
 */

export type QueueModel = 'm/m/1' | 'm/m/c' | 'fixed';

/**
 * Above this utilisation the queue length is dominated by the modelling error
 * rather than by the model, so the contribution is flagged and clamped here and
 * the bottleneck solver reports it as a finding. Printing forty seconds of
 * queueing would be arithmetic dressed as a prediction.
 */
export const SATURATION_THRESHOLD = 0.95;

export interface QueueContribution {
  resourceId: string;
  model: QueueModel;
  /** c. One for a single-threaded resource, the instance or task count otherwise. */
  servers: number;
  /** 1 / mu, in milliseconds. */
  serviceTimeMs: number;
  /** lambda, in requests per second, as offered to this resource. */
  arrivalRateRps: number;
  /** rho = lambda / (c * mu), reported before the saturation clamp. */
  utilisation: number;
  saturated: boolean;
  /** Wq, the time spent waiting rather than being served. */
  queueMs: number;
  /** W = Wq + 1/mu. */
  totalMs: number;
  assumptionIds: string[];
}

export interface QueueInput {
  resourceId: string;
  model: QueueModel;
  servers: number;
  serviceTimeMs: number;
  arrivalRateRps: number;
  /** ca, the coefficient of variation of the inter-arrival times. */
  arrivalCv: number;
  /** cs, the coefficient of variation of the service times. */
  serviceCv: number;
  assumptionIds: string[];
}

/**
 * Erlang C, the probability an arrival has to wait, computed through the
 * recursive Erlang B formulation.
 *
 * The textbook expression divides one factorial series by another and overflows
 * to NaN somewhere past a hundred and seventy servers, which is a plausible
 * Lambda concurrency and an ordinary ECS fleet. The recursion carries a ratio
 * that stays in [0, 1] at every step, so it holds for any server count the
 * caller can express.
 */
export function erlangC(servers: number, utilisation: number): number {
  const c = Math.max(1, Math.round(servers));
  if (!(utilisation > 0)) return 0;
  if (utilisation >= 1) return 1;

  const offered = c * utilisation;
  let blocking = 1;
  for (let n = 1; n <= c; n += 1) {
    blocking = (offered * blocking) / (n + offered * blocking);
  }
  return blocking / (1 - utilisation * (1 - blocking));
}

/**
 * Kingman's G/G/c correction. Both coefficients at one reduces it to exactly
 * one, which is why M/M/c is the honest default: nobody has the inter-arrival
 * and service time distributions of an application that has not been deployed,
 * and setting both to one is the only defensible guess. Supplying a measurement
 * is what turns the correction on.
 */
export function kingmanFactor(arrivalCv: number, serviceCv: number): number {
  return (arrivalCv * arrivalCv + serviceCv * serviceCv) / 2;
}

export function solveQueue(input: QueueInput): QueueContribution {
  const { serviceTimeMs, arrivalRateRps } = input;
  const servers = Math.max(1, Math.round(input.servers));

  if (input.model === 'fixed' || !(serviceTimeMs > 0)) {
    return {
      resourceId: input.resourceId,
      model: 'fixed',
      servers,
      serviceTimeMs: Math.max(0, serviceTimeMs),
      arrivalRateRps,
      utilisation: 0,
      saturated: false,
      queueMs: 0,
      totalMs: Math.max(0, serviceTimeMs),
      assumptionIds: input.assumptionIds,
    };
  }

  const serviceRate = 1000 / serviceTimeMs;
  const capacity = servers * serviceRate;
  const utilisation = Math.max(0, arrivalRateRps) / capacity;
  const saturated = utilisation >= SATURATION_THRESHOLD;

  // The clamp holds the queue at its value on the saturation boundary rather
  // than letting it run to infinity, so a resource past its capacity reports a
  // large number and a flag instead of a meaningless one.
  const clamped = Math.min(utilisation, SATURATION_THRESHOLD);
  const waitProbability = erlangC(servers, clamped);
  const queueSeconds = waitProbability / (capacity * (1 - clamped));
  const queueMs = queueSeconds * 1000 * kingmanFactor(input.arrivalCv, input.serviceCv);

  return {
    resourceId: input.resourceId,
    model: servers === 1 ? 'm/m/1' : 'm/m/c',
    servers,
    serviceTimeMs,
    arrivalRateRps,
    utilisation,
    saturated,
    queueMs,
    totalMs: queueMs + serviceTimeMs,
    assumptionIds: input.assumptionIds,
  };
}

/**
 * P(W > t) for the time a request spends at the resource, waiting and being
 * served.
 *
 * Waiting is an atom at zero with probability 1 - C and an exponential
 * otherwise, and service is exponential, so the sojourn time is the sum of two
 * independent exponentials whenever the request waited. The waiting rate is
 * read back from the mean rather than recomputed, which is what carries the
 * Kingman correction and the saturation clamp into the distribution instead of
 * leaving the percentiles describing a queue the mean no longer agrees with.
 */
export function sojournSurvival(contribution: QueueContribution, tMs: number): number {
  if (tMs <= 0) return 1;
  const { serviceTimeMs, queueMs, servers, utilisation } = contribution;
  if (contribution.model === 'fixed' || !(serviceTimeMs > 0)) {
    return tMs < serviceTimeMs ? 1 : 0;
  }

  const serviceRate = 1 / serviceTimeMs;
  const waitProbability = erlangC(servers, Math.min(utilisation, SATURATION_THRESHOLD));
  if (!(queueMs > 0) || !(waitProbability > 0)) return Math.exp(-serviceRate * tMs);

  const waitRate = waitProbability / queueMs;
  const gap = waitRate - serviceRate;
  // The two rates coincide when the queue happens to drain as fast as the
  // resource serves; the sum is then Erlang-2 rather than a difference of
  // exponentials, and the general form would divide by zero.
  if (Math.abs(gap) < 1e-12 * serviceRate) {
    const served = Math.exp(-serviceRate * tMs);
    return served * (1 - waitProbability + waitProbability * (1 + serviceRate * tMs));
  }

  const served = Math.exp(-serviceRate * tMs);
  const waited = (waitRate * served - serviceRate * Math.exp(-waitRate * tMs)) / gap;
  return (1 - waitProbability) * served + waitProbability * waited;
}

/**
 * Inverted by bisection rather than by the closed form. The closed form exists
 * only for one server and only without the Kingman correction, and a model with
 * two percentile routines is a model whose two routines disagree; this one
 * reproduces `ln(1 / (1 - q)) / (mu - lambda)` to within the tolerance below
 * when the closed form applies, which `queue.test.ts` holds it to.
 */
export function sojournPercentile(contribution: QueueContribution, quantile: number): number {
  if (contribution.model === 'fixed') return contribution.serviceTimeMs;
  if (!(quantile > 0)) return 0;
  if (quantile >= 1) return Number.POSITIVE_INFINITY;

  const target = 1 - quantile;
  let high = Math.max(contribution.totalMs, 1);
  for (
    let doubling = 0;
    doubling < 200 && sojournSurvival(contribution, high) > target;
    doubling++
  ) {
    high *= 2;
  }

  let low = 0;
  for (let step = 0; step < 80 && high - low > 1e-12 * Math.max(1, high); step += 1) {
    const middle = (low + high) / 2;
    if (sojournSurvival(contribution, middle) > target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
