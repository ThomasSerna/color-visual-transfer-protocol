import { color4SequencePhaseMatches } from "./color4-binding";
import {
  shardPosition,
  unwrapColor4Frame,
  type Color4ByteErasureCandidate,
  type Color4PaletteId,
  type Color4Profile,
  type Color4UnwrapObservation,
  type Color4UnwrapResult,
} from "../shared/color4";

export const COLOR4_MAX_ERASURE_POLICY_ATTEMPTS = 4 as const;

export type Color4ErasureBudgetFraction = 1 | 0.75 | 0.5 | 0;
export type Color4ErasurePolicy = "classifier-budgeted" | "hard-decision";

const CLASSIFIER_BUDGET_FRACTIONS = Object.freeze([
  1,
  0.75,
  0.5,
] as const satisfies readonly Color4ErasureBudgetFraction[]);

/**
 * The full rung deliberately spends the whole parity budget. That leaves
 * Reed-Solomon exactly enough equations to solve for the marked positions, so
 * its closing syndrome check cannot fail and the shard result carries no
 * self-verification (see `verificationMargin` in reed-solomon.ts). The rung is
 * still worth trying: it genuinely recovers a shard damaged in exactly `parity`
 * known positions, every later rung is attempted regardless of what it returns,
 * and the outer header, CRC32C and sequence phase all re-validate the payload
 * before a frame is accepted.
 */

export interface Color4ErasurePolicyAttempt {
  readonly policy: Color4ErasurePolicy;
  readonly budgetFraction: Color4ErasureBudgetFraction;
  readonly maxErasuresPerShard: number;
  readonly erasures: Uint16Array;
  readonly erasuresByShard: readonly number[];
  readonly observations: readonly Color4UnwrapObservation[];
  readonly result: Color4UnwrapResult;
  /** Present only when the core unwrap produced a valid frame. */
  readonly phaseMatched?: boolean;
  /** Sum of the bounded core unwrap observation durations. */
  readonly durationMs: number;
}

export interface Color4ErasurePolicyResult {
  readonly result: Color4UnwrapResult;
  readonly selectedPolicy: Color4ErasurePolicy;
  readonly selectedBudgetFraction: Color4ErasureBudgetFraction;
  readonly selectedMaxErasuresPerShard: number;
  readonly selectedErasures: Uint16Array;
  readonly selectedObservations: readonly Color4UnwrapObservation[];
  readonly suggestedErasuresByShard: readonly number[];
  readonly saturatedErasureShards: readonly number[];
  readonly attempts: readonly Color4ErasurePolicyAttempt[];
}

export interface RunColor4ErasurePolicyOptions {
  readonly codedBytes: Uint8Array;
  readonly profile: Color4Profile;
  readonly paletteId: Color4PaletteId;
  readonly erasureCandidates: readonly Color4ByteErasureCandidate[];
  readonly expectedSequencePhase: 0 | 1 | 2 | 3;
  /** Optional monotonic clock used only by diagnostic observations. */
  readonly clock?: () => number;
  /** Receive-internal seam for deterministic coordinator tests. */
  readonly unwrap?: typeof unwrapColor4Frame;
}

interface NormalizedErasureCandidate {
  readonly index: number;
  readonly score: number;
}

interface ErasureAttemptSpec {
  readonly policy: Color4ErasurePolicy;
  readonly budgetFraction: Color4ErasureBudgetFraction;
  readonly maxErasuresPerShard: number;
  readonly erasures: Uint16Array;
}

function normalizeCandidates(
  profile: Color4Profile,
  input: readonly Color4ByteErasureCandidate[],
): readonly NormalizedErasureCandidate[] {
  const scoresByIndex = new Map<number, number>();
  for (const candidate of input) {
    if (
      !Number.isInteger(candidate.index) ||
      candidate.index < 0 ||
      candidate.index >= profile.codedBytes
    ) {
      throw new RangeError(`Invalid COLOR_4 erasure candidate index: ${candidate.index}.`);
    }
    if (!Number.isFinite(candidate.score) || candidate.score < 0) {
      throw new RangeError(
        `Invalid COLOR_4 erasure candidate score at index ${candidate.index}: ${candidate.score}.`,
      );
    }
    const previous = scoresByIndex.get(candidate.index);
    if (previous === undefined || candidate.score > previous) {
      scoresByIndex.set(candidate.index, candidate.score);
    }
  }

  return Object.freeze(
    [...scoresByIndex]
      .map(([index, score]) => Object.freeze({ index, score }))
      .sort((left, right) => right.score - left.score || left.index - right.index),
  );
}

function countByShard(profile: Color4Profile, erasures: ArrayLike<number>): readonly number[] {
  const counts = new Uint16Array(profile.shards);
  for (const index of Array.from(erasures)) {
    const shard = shardPosition(index, profile.shards).shard;
    counts[shard] = counts[shard]! + 1;
  }
  return Object.freeze(Array.from(counts));
}

function rankedSelection(
  profile: Color4Profile,
  candidates: readonly NormalizedErasureCandidate[],
  maxErasuresPerShard: number,
): Uint16Array {
  if (maxErasuresPerShard === 0 || candidates.length === 0) return new Uint16Array();

  const selectedByShard = new Uint16Array(profile.shards);
  const selected: number[] = [];
  for (const candidate of candidates) {
    const shard = shardPosition(candidate.index, profile.shards).shard;
    if (selectedByShard[shard]! >= maxErasuresPerShard) continue;
    selectedByShard[shard] = selectedByShard[shard]! + 1;
    selected.push(candidate.index);
  }
  return Uint16Array.from(selected.sort((left, right) => left - right));
}

/** Select the highest-severity candidates up to the full RS parity budget per shard. */
export function selectFecBudgetedErasures(
  profile: Color4Profile,
  erasureCandidates: readonly Color4ByteErasureCandidate[],
): Uint16Array {
  const parity = profile.rsN - profile.rsK;
  return rankedSelection(profile, normalizeCandidates(profile, erasureCandidates), parity);
}

function erasureAttemptSpecs(
  profile: Color4Profile,
  candidates: readonly NormalizedErasureCandidate[],
): readonly ErasureAttemptSpec[] {
  const parity = profile.rsN - profile.rsK;
  const seen = new Set<string>();
  const specs: ErasureAttemptSpec[] = [];

  for (const budgetFraction of CLASSIFIER_BUDGET_FRACTIONS) {
    const maxErasuresPerShard = Math.floor(parity * budgetFraction);
    const erasures = rankedSelection(profile, candidates, maxErasuresPerShard);
    if (erasures.length === 0) continue;
    const key = Array.from(erasures).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(Object.freeze({
      policy: "classifier-budgeted",
      budgetFraction,
      maxErasuresPerShard,
      erasures,
    }));
  }

  specs.push(Object.freeze({
    policy: "hard-decision",
    budgetFraction: 0,
    maxErasuresPerShard: 0,
    erasures: new Uint16Array(),
  }));

  if (specs.length > COLOR4_MAX_ERASURE_POLICY_ATTEMPTS) {
    throw new Error("COLOR_4 erasure policy exceeded its bounded attempt count.");
  }
  return Object.freeze(specs);
}

function attempt(
  options: RunColor4ErasurePolicyOptions,
  spec: ErasureAttemptSpec,
): Color4ErasurePolicyAttempt {
  const observations: Color4UnwrapObservation[] = [];
  const result = (options.unwrap ?? unwrapColor4Frame)(options.codedBytes, {
    profileId: options.profile.id,
    paletteId: options.paletteId,
    erasures: spec.erasures,
    observer: (observation) => observations.push(observation),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const phaseMatched = result.status === "valid"
    ? color4SequencePhaseMatches(result.header.sequence, options.expectedSequencePhase)
    : undefined;
  return Object.freeze({
    ...spec,
    erasuresByShard: countByShard(options.profile, spec.erasures),
    observations: Object.freeze(observations),
    result,
    ...(phaseMatched === undefined ? {} : { phaseMatched }),
    durationMs: observations.reduce((total, observation) => total + observation.durationMs, 0),
  });
}

/**
 * Try the deterministic 100/75/50/0 erasure-budget ladder. A frame is accepted
 * only after the core unwrap and the redundant physical sequence phase agree.
 */
export function runColor4ErasurePolicy(
  options: RunColor4ErasurePolicyOptions,
): Color4ErasurePolicyResult {
  const candidates = normalizeCandidates(options.profile, options.erasureCandidates);
  const suggestedErasuresByShard = countByShard(
    options.profile,
    candidates.map(({ index }) => index),
  );
  const parity = options.profile.rsN - options.profile.rsK;
  const saturatedErasureShards = Object.freeze(
    suggestedErasuresByShard.flatMap((count, shard) => count > parity ? [shard] : []),
  );
  const attempts: Color4ErasurePolicyAttempt[] = [];
  let firstPhaseMismatch: Color4ErasurePolicyAttempt | undefined;
  let accepted: Color4ErasurePolicyAttempt | undefined;

  for (const spec of erasureAttemptSpecs(options.profile, candidates)) {
    const current = attempt(options, spec);
    attempts.push(current);
    if (current.result.status === "valid") {
      if (current.phaseMatched) {
        accepted = current;
        break;
      }
      firstPhaseMismatch ??= current;
    }
  }

  const selected = accepted ?? firstPhaseMismatch ?? attempts[0];
  if (selected === undefined) {
    throw new Error("COLOR_4 erasure policy produced no attempts.");
  }

  return Object.freeze({
    result: selected.result,
    selectedPolicy: selected.policy,
    selectedBudgetFraction: selected.budgetFraction,
    selectedMaxErasuresPerShard: selected.maxErasuresPerShard,
    selectedErasures: selected.erasures,
    selectedObservations: selected.observations,
    suggestedErasuresByShard,
    saturatedErasureShards,
    attempts: Object.freeze(attempts),
  });
}
