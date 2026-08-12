import { BOOTSTRAP_COLUMNS, BOOTSTRAP_ROWS } from "./physical";

export const BINARY_BLACK_MAXIMUM = 0.35;
export const BINARY_WHITE_MINIMUM = 0.65;

export interface BootstrapSamplingSummary {
  readonly doubleVoteColumns: number;
  readonly singleVoteColumns: number;
  /** All undecided columns, including contradictory columns. */
  readonly uncertainColumns: number;
  /** Undecided columns whose two reliable votes disagree. */
  readonly contradictoryColumns: number;
  readonly minimumDifferentialLuma: number;
  readonly medianDifferentialLuma: number;
}

export interface DifferentialBootstrapSampling {
  /** Row-major word/complement/word modules suitable for decodeBootstrap(). */
  readonly modules: readonly number[];
  readonly decidedColumns: number;
  /** Present only when all 24 columns were decided. */
  readonly decidedBytes?: readonly [number, number, number];
  readonly diagnostics: BootstrapSamplingSummary;
}

export interface LocalBinaryRailModel {
  readonly valid: boolean;
  readonly blackLuma: number;
  readonly whiteLuma: number;
  readonly thresholdLuma: number;
  readonly contrastLuma: number;
}

export interface LocalBinaryRailEvaluation extends LocalBinaryRailModel {
  readonly errors: number;
  readonly uncertainModules: number;
  readonly modules: number;
  /** Per-module black=1/white=0 decisions; -1 means uncertain. */
  readonly sampledModules: readonly number[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >>> 1;
  return sorted.length & 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Normalize additive receiver thresholds without changing any PHY value. */
export function normalizeLumaThreshold(value: number | undefined, fallback: number): number {
  const requested = value ?? fallback;
  const normalized = Number.isNaN(requested) ? fallback : requested;
  return Math.max(1, Math.min(255, normalized));
}

function differentialVote(deltaLuma: number, minimumDifferentialLuma: number): 0 | 1 | null {
  if (!Number.isFinite(deltaLuma) || Math.abs(deltaLuma) < minimumDifferentialLuma) {
    return null;
  }
  return deltaLuma > 0 ? 1 : 0;
}

/**
 * Sample the bootstrap from its own local word/complement contrast. The input
 * is the canonical 24 x 3 rectangle in row-major top/middle/bottom order.
 */
export function sampleDifferentialBootstrap(
  luminances: ArrayLike<number>,
  minimumDifferentialLuma: number,
): DifferentialBootstrapSampling {
  if (luminances.length !== BOOTSTRAP_COLUMNS * BOOTSTRAP_ROWS) {
    throw new RangeError("COLOR_4 bootstrap sampling requires exactly 24 x 3 luminances.");
  }

  const threshold = normalizeLumaThreshold(minimumDifferentialLuma, 16);
  const modules = Array<number>(BOOTSTRAP_COLUMNS * BOOTSTRAP_ROWS).fill(-1);
  const margins: number[] = [];
  let doubleVoteColumns = 0;
  let singleVoteColumns = 0;
  let uncertainColumns = 0;
  let contradictoryColumns = 0;
  let decidedColumns = 0;

  for (let column = 0; column < BOOTSTRAP_COLUMNS; column++) {
    const top = luminances[column]!;
    const middle = luminances[BOOTSTRAP_COLUMNS + column]!;
    const bottom = luminances[2 * BOOTSTRAP_COLUMNS + column]!;
    const topDelta = middle - top;
    const bottomDelta = middle - bottom;
    const topVote = differentialVote(topDelta, threshold);
    const bottomVote = differentialVote(bottomDelta, threshold);

    let bit: 0 | 1 | null = null;
    let margin = 0;
    if (topVote !== null && bottomVote !== null) {
      if (topVote === bottomVote) {
        bit = topVote;
        margin = Math.min(Math.abs(topDelta), Math.abs(bottomDelta));
        doubleVoteColumns++;
      } else {
        contradictoryColumns++;
      }
    } else if (topVote !== null || bottomVote !== null) {
      bit = topVote ?? bottomVote;
      margin = Math.abs(topVote !== null ? topDelta : bottomDelta);
      singleVoteColumns++;
    }

    if (bit === null) {
      uncertainColumns++;
      continue;
    }
    decidedColumns++;
    margins.push(margin);
    modules[column] = bit;
    modules[BOOTSTRAP_COLUMNS + column] = bit ^ 1;
    modules[2 * BOOTSTRAP_COLUMNS + column] = bit;
  }

  let decidedBytes: readonly [number, number, number] | undefined;
  if (decidedColumns === BOOTSTRAP_COLUMNS) {
    const bytes: [number, number, number] = [0, 0, 0];
    for (let column = 0; column < BOOTSTRAP_COLUMNS; column++) {
      const byteIndex = column >>> 3;
      bytes[byteIndex] = bytes[byteIndex]! | (modules[column]! << (7 - (column & 7)));
    }
    decidedBytes = Object.freeze(bytes);
  }

  return Object.freeze({
    modules: Object.freeze(modules),
    decidedColumns,
    ...(decidedBytes === undefined ? {} : { decidedBytes }),
    diagnostics: Object.freeze({
      doubleVoteColumns,
      singleVoteColumns,
      uncertainColumns,
      contradictoryColumns,
      minimumDifferentialLuma: margins.length === 0 ? 0 : Math.min(...margins),
      medianDifferentialLuma: median(margins),
    }),
  });
}

export function buildLocalBinaryRailModel(
  luminances: ArrayLike<number>,
  expectedModules: ArrayLike<number>,
  minimumContrastLuma: number,
): LocalBinaryRailModel {
  if (luminances.length === 0 || luminances.length !== expectedModules.length) {
    throw new RangeError("COLOR_4 rail samples and expected modules must have equal non-zero length.");
  }
  const blackSamples: number[] = [];
  const whiteSamples: number[] = [];
  for (let index = 0; index < luminances.length; index++) {
    const expected = expectedModules[index];
    if (expected === 1) blackSamples.push(luminances[index]!);
    else if (expected === 0) whiteSamples.push(luminances[index]!);
    else throw new RangeError("COLOR_4 expected rail modules must be binary.");
  }

  const blackLuma = median(blackSamples);
  const whiteLuma = median(whiteSamples);
  const contrastLuma = whiteLuma - blackLuma;
  const thresholdLuma = (blackLuma + whiteLuma) / 2;
  const threshold = normalizeLumaThreshold(minimumContrastLuma, 40);
  const valid =
    blackSamples.length > 0 &&
    whiteSamples.length > 0 &&
    Number.isFinite(blackLuma) &&
    Number.isFinite(whiteLuma) &&
    contrastLuma >= threshold;
  return Object.freeze({ valid, blackLuma, whiteLuma, thresholdLuma, contrastLuma });
}

/** Classify with the existing 0.35/0.65 deadband around a local rail model. */
export function classifyWithLocalBinaryRail(
  luminance: number,
  model: LocalBinaryRailModel,
): 0 | 1 | -1 {
  if (!model.valid || !Number.isFinite(luminance) || model.contrastLuma <= 0) return -1;
  const normalized = (luminance - model.blackLuma) / model.contrastLuma;
  if (normalized <= BINARY_BLACK_MAXIMUM) return 1;
  if (normalized >= BINARY_WHITE_MINIMUM) return 0;
  return -1;
}

/** Build, apply and summarize one mandatory local timing-rail model. */
export function evaluateLocalBinaryRail(
  luminances: ArrayLike<number>,
  expectedModules: ArrayLike<number>,
  minimumContrastLuma: number,
): LocalBinaryRailEvaluation {
  const model = buildLocalBinaryRailModel(
    luminances,
    expectedModules,
    minimumContrastLuma,
  );
  const sampledModules: number[] = [];
  let errors = 0;
  let uncertainModules = 0;
  for (let index = 0; index < luminances.length; index++) {
    const sampled = classifyWithLocalBinaryRail(luminances[index]!, model);
    sampledModules.push(sampled);
    if (sampled === -1) uncertainModules++;
    if (sampled !== expectedModules[index]) errors++;
  }
  return Object.freeze({
    ...model,
    errors,
    uncertainModules,
    modules: luminances.length,
    sampledModules: Object.freeze(sampledModules),
  });
}
