import assert from "node:assert/strict";

/**
 * The five-number summary the classifier reports for a score distribution.
 *
 * `count` is a cardinality; the rest are continuous statistics over Lab
 * distances, so they carry whatever rounding the pipeline that produced them
 * carried.
 */
export interface ClassifierDistributionSummaryLike {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/**
 * How far a replayed statistic may drift from its recorded value.
 *
 * Pinning these as exact doubles is what put CI in the red: a classifier change
 * moved `erasureCandidateScore.min` by two ULPs — a relative difference of
 * 4.4e-16 — and `assert.deepEqual` reported it as "the severity distribution
 * changed", which is not what the oracle is for. The question it should answer
 * is whether classification *behaves* differently, and a behavioural change
 * moves these numbers by orders of magnitude, not by the last bit: the same
 * fixture spans a `min` near 1 and a `max` near 455.
 *
 * 1e-12 is roughly two thousand times the arithmetic noise this pipeline
 * produces and still many orders of magnitude below any real regression, so it
 * absorbs the one without hiding the other.
 */
export const CLASSIFIER_DISTRIBUTION_TOLERANCE = 1e-12;

function withinTolerance(actual: number, expected: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  if (actual === expected) return true;
  // Relative to the expected magnitude, with an absolute floor so a statistic
  // legitimately at or near zero is not held to an impossible relative bound.
  return Math.abs(actual - expected) <=
    CLASSIFIER_DISTRIBUTION_TOLERANCE * Math.max(1, Math.abs(expected));
}

/**
 * Compare a computed classifier distribution against a recorded oracle.
 *
 * `count` is asserted exactly: it is a cardinality, it has no rounding, and a
 * change in it is precisely the kind of behavioural difference this oracle
 * exists to catch. Only the four continuous statistics get the tolerance.
 *
 * Use this only where a *computed* value meets a recorded one. Two static
 * values — a fixture read from disk against a literal in a test — must stay
 * exactly equal: that comparison exists to keep the fixture and the test in
 * sync, and a tolerance there would let them silently diverge.
 */
export function assertClassifierDistribution(
  actual: ClassifierDistributionSummaryLike,
  expected: ClassifierDistributionSummaryLike,
  message: string,
): void {
  assert.equal(actual.count, expected.count, `${message}: count`);
  for (const key of ["min", "p50", "p95", "max"] as const) {
    assert.ok(
      withinTolerance(actual[key], expected[key]),
      `${message}: ${key} moved beyond the replay tolerance — ` +
        `expected ${expected[key]}, got ${actual[key]} ` +
        `(relative ${Math.abs(actual[key] - expected[key]) / Math.max(1, Math.abs(expected[key]))}, ` +
        `tolerance ${CLASSIFIER_DISTRIBUTION_TOLERANCE})`,
    );
  }
}
