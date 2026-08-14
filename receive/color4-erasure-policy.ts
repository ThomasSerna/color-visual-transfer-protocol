import {
  shardPosition,
  unwrapColor4Frame,
  type Color4ErasureInput,
  type Color4PaletteId,
  type Color4Profile,
  type Color4UnwrapObservation,
  type Color4UnwrapResult,
} from "../shared/color4";

export const COLOR4_MAX_ERASURE_POLICY_ATTEMPTS = 2 as const;

export type Color4ErasurePolicy = "classifier-budgeted" | "hard-decision";

export interface Color4ErasurePolicyAttempt {
  readonly policy: Color4ErasurePolicy;
  readonly erasures: Uint16Array;
  readonly erasuresByShard: readonly number[];
  readonly observations: readonly Color4UnwrapObservation[];
  readonly result: Color4UnwrapResult;
}

export interface Color4ErasurePolicyResult {
  readonly result: Color4UnwrapResult;
  readonly selectedPolicy: Color4ErasurePolicy;
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
  readonly erasures: Color4ErasureInput;
  /** Optional monotonic clock used only by diagnostic observations. */
  readonly clock?: () => number;
  /** Receive-internal seam for deterministic coordinator tests. */
  readonly unwrap?: typeof unwrapColor4Frame;
}

function erasureValues(input: Color4ErasureInput): number[] {
  return input instanceof Set ? [...input] : Array.from(input);
}

interface FecBudgetedSelection {
  readonly erasures: Uint16Array;
  readonly suggestedErasuresByShard: readonly number[];
  readonly saturatedErasureShards: readonly number[];
}

function countByShard(profile: Color4Profile, erasures: ArrayLike<number>): readonly number[] {
  const counts = new Uint16Array(profile.shards);
  for (const index of Array.from(erasures)) {
    const shard = shardPosition(index, profile.shards).shard;
    counts[shard] = counts[shard]! + 1;
  }
  return Object.freeze(Array.from(counts));
}

function fecBudgetedSelection(
  profile: Color4Profile,
  input: Color4ErasureInput,
): FecBudgetedSelection {
  const unique = [...new Set(erasureValues(input))].sort((left, right) => left - right);
  for (const index of unique) {
    if (!Number.isInteger(index) || index < 0 || index >= profile.codedBytes) {
      throw new RangeError(`Invalid COLOR_4 erasure index: ${index}.`);
    }
  }
  const counts = countByShard(profile, unique);
  const parity = profile.rsN - profile.rsK;
  const saturatedErasureShards = Object.freeze(
    counts.flatMap((count, shard) => count > parity ? [shard] : []),
  );
  return Object.freeze({
    erasures: Uint16Array.from(
      unique.filter((index) => counts[shardPosition(index, profile.shards).shard]! <= parity),
    ),
    suggestedErasuresByShard: counts,
    saturatedErasureShards,
  });
}

/**
 * Keep classifier hints only for shards whose complete hint set fits in the
 * Reed-Solomon erasure budget. Without confidence metadata, truncating an
 * overflowing shard would assign meaning to an arbitrary byte order.
 */
export function selectFecBudgetedErasures(
  profile: Color4Profile,
  input: Color4ErasureInput,
): Uint16Array {
  return fecBudgetedSelection(profile, input).erasures;
}

function attempt(
  options: RunColor4ErasurePolicyOptions,
  policy: Color4ErasurePolicy,
  erasures: Uint16Array,
): Color4ErasurePolicyAttempt {
  const observations: Color4UnwrapObservation[] = [];
  const result = (options.unwrap ?? unwrapColor4Frame)(options.codedBytes, {
    profileId: options.profile.id,
    paletteId: options.paletteId,
    erasures,
    observer: (observation) => observations.push(observation),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return Object.freeze({
    policy,
    erasures,
    erasuresByShard: countByShard(options.profile, erasures),
    observations: Object.freeze(observations),
    result,
  });
}

/**
 * Try at most two deterministic interpretations of optical erasure hints.
 * A failed fallback never replaces the primary rejection, so this policy can
 * promote a rejected frame to valid but cannot rewrite its final failure.
 */
export function runColor4ErasurePolicy(
  options: RunColor4ErasurePolicyOptions,
): Color4ErasurePolicyResult {
  const selection = fecBudgetedSelection(options.profile, options.erasures);
  const primary = attempt(options, "classifier-budgeted", selection.erasures);
  const attempts: Color4ErasurePolicyAttempt[] = [primary];
  let selected = primary;

  if (primary.result.status === "rejected" && selection.erasures.length > 0) {
    const fallback = attempt(options, "hard-decision", new Uint16Array());
    attempts.push(fallback);
    if (fallback.result.status === "valid") selected = fallback;
  }

  if (attempts.length > COLOR4_MAX_ERASURE_POLICY_ATTEMPTS) {
    throw new Error("COLOR_4 erasure policy exceeded its bounded attempt count.");
  }

  return Object.freeze({
    result: selected.result,
    selectedPolicy: selected.policy,
    selectedErasures: selected.erasures,
    selectedObservations: selected.observations,
    suggestedErasuresByShard: selection.suggestedErasuresByShard,
    saturatedErasureShards: selection.saturatedErasureShards,
    attempts: Object.freeze(attempts),
  });
}
