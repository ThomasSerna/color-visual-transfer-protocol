import {
  COLOR4_PROFILES,
  getColor4Profile,
  type Color4Profile,
} from "./profiles";
import {
  createSpatialBinaryAnchorModel,
  createSpatialRgbBinaryAnchorModel,
  type BinaryAnchors,
  type BinaryAnchorsByFiducial,
  type RgbBinaryAnchors,
  type RgbBinaryAnchorsByFiducial,
  type SpatialBinaryAnchorModel,
  type SpatialRgbBinaryAnchorModel,
} from "./binary-anchors";
import {
  BINARY_BLACK_MAXIMUM,
  BINARY_WHITE_MINIMUM,
  classifyWithLocalBinaryRail,
  evaluateLocalBinaryRail,
  normalizeLumaThreshold,
  sampleDifferentialBootstrap,
  type BootstrapSamplingSummary,
  type LocalBinaryRailEvaluation,
  type LocalBinaryRailModel,
} from "./binary-photometry";
import { crc8Atm } from "./crc";
import { shardPosition } from "./interleave";
import {
  ACTIVE_MODULES,
  BOOTSTRAP_COLUMNS,
  BOOTSTRAP_ROWS,
  COLOR4_MAX_FIDUCIAL_ERRORS,
  FIDUCIALS,
  PHY_VERSION,
  QUIET_MODULES,
  TOTAL_MODULES,
  createPhysicalLayout,
  decodeBootstrap,
  decodePhasePilot,
  fiducialModule,
  getColor4Palette,
  type BootstrapFields,
  type CalibrationPlacement,
  type CalibrationSwatchName,
  type Dibit,
  type FiducialId,
  type ModuleRect,
  type PhysicalLayout,
} from "./physical";

export interface CanonicalRasterImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA bytes, as produced by ImageData. */
  readonly pixels: Uint8Array | Uint8ClampedArray;
}

export interface LabColor {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

export type FloatRgb = readonly [red: number, green: number, blue: number];

export interface ClassifierThresholds {
  /** Minimum observed white/black luminance range on both calibration banks. */
  readonly minimumContrast: number;
  /** Minimum CIE76 distance between any two palette centroids. */
  readonly minimumPaletteDistance: number;
  /** Baseline maximum distance from a cell to its winning centroid. */
  readonly maximumDeltaE: number;
  /** Baseline gap between the closest and second-closest centroids. */
  readonly minimumDeltaEGap: number;
  /** Mismatches tolerated in each marker after canonical normalization. */
  readonly maximumFiducialErrors: number;
  /** Maximum fraction of timing-rail modules that may be wrong or uncertain. */
  readonly maximumTimingErrorRate: number;
  /** Minimum reliable middle-to-outer luminance delta in a bootstrap column. */
  readonly minimumBootstrapDifferentialLuma: number;
  /** Minimum local white-minus-black luminance contrast on every timing rail. */
  readonly minimumTimingRailContrastLuma: number;
}

export const DEFAULT_CLASSIFIER_THRESHOLDS: ClassifierThresholds = Object.freeze({
  minimumContrast: 40,
  minimumPaletteDistance: 12,
  maximumDeltaE: 24,
  minimumDeltaEGap: 6,
  maximumFiducialErrors: COLOR4_MAX_FIDUCIAL_ERRORS,
  maximumTimingErrorRate: 0.08,
  minimumBootstrapDifferentialLuma: 16,
  minimumTimingRailContrastLuma: 40,
});

export type CanonicalRasterRejectReason =
  | "invalid_dimensions"
  | "invalid_geometry"
  | "invalid_bootstrap"
  | "unsupported_version"
  | "unsupported_profile"
  | "unsupported_palette"
  | "phase_mismatch"
  | "calibration_failed";

/** Bounded, persistence-safe summary of one classifier confidence metric. */
export interface ClassifierDistributionSummary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface Color4ByteErasureCandidate {
  readonly index: number;
  /** Unbounded heuristic severity used for ranking; this is not a probability. */
  readonly score: number;
}

export interface CanonicalRasterDiagnostics {
  readonly moduleScale: number;
  /** Sum across all four fiducials, retained for schema compatibility. */
  readonly fiducialErrors: number;
  readonly fiducialErrorsById: Readonly<Record<FiducialId, number>>;
  readonly fiducialErrorMax: number;
  readonly quietZoneErrors: number;
  /** Luminance failures and per-channel RGB failures are reported separately. */
  readonly quietZoneLumaErrors: number;
  readonly quietZoneRgbErrors: number;
  readonly bootstrapSampling?: BootstrapSamplingDiagnostics;
  readonly timingErrors: number;
  readonly timingUncertainModules: number;
  readonly timingModules: number;
  readonly timingRails?: TimingRailsDiagnostics;
  /**
   * Inter-symbol interference strength the colour stage corrected for. Zero
   * means the estimator found the capture sharp enough to leave alone; values
   * approaching 0.4 mean a module's own light was a minority of its sample.
   */
  readonly isiStrength: number;
  readonly calibrationMad: number;
  readonly observedContrast: number;
  readonly minimumPaletteDistance: number;
  readonly uncertainCells: number;
  readonly erasureBytes: number;
  /** Cells rejected by the distance predicate, including cells rejected by both predicates. */
  readonly distanceRejectedCells: number;
  /** Cells rejected by the gap predicate, including cells rejected by both predicates. */
  readonly gapRejectedCells: number;
  readonly bothRejectedCells: number;
  /** Erased bytes per interleaved Reed-Solomon shard. */
  readonly erasuresByShard: readonly number[];
  readonly parityByShard: number;
  /** May be negative when a shard already exceeds its erasure-only FEC budget. */
  readonly remainingErasureBudgetByShard: readonly number[];
  /** Uncertain cells (not byte or payload indices) aggregated by raster row and column. */
  readonly uncertainCellsByRow: readonly number[];
  readonly uncertainCellsByColumn: readonly number[];
  readonly effectiveMaximumDeltaE: number;
  readonly effectiveMinimumDeltaEGap: number;
  readonly bestDeltaE: ClassifierDistributionSummary;
  readonly deltaEGap: ClassifierDistributionSummary;
  readonly erasureCandidateScore: ClassifierDistributionSummary;
  readonly meanBestDeltaE: number;
  readonly maximumBestDeltaE: number;
}

export type BootstrapSamplingDiagnostics = BootstrapSamplingSummary;

export interface TimingRailDiagnostics {
  readonly valid: boolean;
  readonly blackLuma: number;
  readonly whiteLuma: number;
  readonly thresholdLuma: number;
  readonly contrastLuma: number;
  readonly errors: number;
  readonly uncertainModules: number;
  readonly modules: number;
}

export interface TimingRailsDiagnostics {
  readonly top: TimingRailDiagnostics;
  readonly right: TimingRailDiagnostics;
  readonly bottom: TimingRailDiagnostics;
  readonly left: TimingRailDiagnostics;
}

export interface ValidCanonicalRaster {
  readonly status: "valid";
  readonly profile: Color4Profile;
  readonly paletteId: 0 | 1;
  readonly sequencePhase: 0 | 1 | 2 | 3;
  /** Whitened/interleaved coded stream, ready for unwrapColor4Frame(). */
  readonly codedBytes: Uint8Array;
  /** Global coded-stream byte indices; accepted directly by the core decoder. */
  readonly byteErasures: Uint16Array;
  /** Ranked-policy inputs; one immutable candidate for every byte erasure. */
  readonly byteErasureCandidates: readonly Color4ByteErasureCandidate[];
  readonly diagnostics: CanonicalRasterDiagnostics;
}

export interface RejectedCanonicalRaster {
  readonly status: "rejected";
  readonly reason: CanonicalRasterRejectReason;
  readonly diagnostics: CanonicalRasterDiagnostics;
}

export type CanonicalRasterResult = ValidCanonicalRaster | RejectedCanonicalRaster;

export interface DecodeCanonicalRasterOptions {
  /** Defaults to the normative COLOR4_PROFILES registry. */
  readonly profiles?: readonly Color4Profile[];
  readonly thresholds?: Partial<ClassifierThresholds>;
  /** Optional monotonic clock used only by diagnostic observations. */
  readonly clock?: () => number;
  /** Include calibration banks and the bounded cell trace (debug mode only). */
  readonly observerDetail?: boolean;
  /**
   * Receives structured-clone-safe diagnostic observations. Observer failures
   * are isolated and can never change a decode result.
   */
  readonly observer?: CanonicalRasterObserver;
}

export type CanonicalRasterStage =
  | "canonicalGeometry"
  | "bootstrapPhase"
  | "calibration"
  | "classification";

export interface CanonicalRasterObservationBase {
  readonly stage: CanonicalRasterStage;
  readonly durationMs: number;
  readonly outcome: "completed" | "rejected";
  readonly reason?: CanonicalRasterRejectReason;
  readonly diagnostics: CanonicalRasterDiagnostics;
}

export interface BinaryAnchorObservation {
  readonly black: number;
  readonly white: number;
  readonly contrast: number;
}

export interface CanonicalGeometryObservation extends CanonicalRasterObservationBase {
  readonly stage: "canonicalGeometry";
  readonly image: Readonly<{ width: number; height: number }>;
  readonly thresholds: ClassifierThresholds;
  readonly binaryAnchors?: BinaryAnchorObservation;
  readonly binaryAnchorsByFiducial?: Readonly<Record<FiducialId, BinaryAnchorObservation>>;
}

export interface BootstrapPhaseObservation extends CanonicalRasterObservationBase {
  readonly stage: "bootstrapPhase";
  readonly bootstrap?: BootstrapFields;
  /** Debug-only raw bytes, available when all bootstrap columns were decided. */
  readonly bootstrapBytes?: readonly [number, number, number];
  /** Debug-only CRC comparison; decodeBootstrap() remains authoritative. */
  readonly bootstrapCrc?: Readonly<{ expected: number; observed: number }>;
  readonly topPhase?: 0 | 1 | 2 | 3 | null;
  readonly bottomPhase?: 0 | 1 | 2 | 3 | null;
}

export interface CalibrationBankObservation {
  readonly raw: Readonly<Record<CalibrationSwatchName, FloatRgb>>;
  readonly normalized: Readonly<Record<CalibrationSwatchName, FloatRgb>>;
  readonly mad: number;
  readonly contrast: number;
  /** Raw camera channels at or near 8-bit clipping (<=1 or >=254). */
  readonly clippedChannels: number;
  readonly samples: Readonly<
    Record<CalibrationSwatchName, readonly CalibrationSampleObservation[]>
  >;
}

export interface CalibrationSampleObservation {
  readonly raw: FloatRgb;
  readonly normalized: FloatRgb;
}

export interface CalibrationObservation extends CanonicalRasterObservationBase {
  readonly stage: "calibration";
  readonly detailIncluded: boolean;
  readonly left?: CalibrationBankObservation;
  readonly right?: CalibrationBankObservation;
  readonly thresholds: Readonly<{
    minimumContrast: number;
    minimumPaletteDistance: number;
  }>;
}

export interface CellClassificationObservation {
  readonly cellIndex: number;
  readonly byteIndex: number;
  readonly dibitIndex: 0 | 1 | 2 | 3;
  readonly column: number;
  readonly row: number;
  readonly raw: FloatRgb;
  readonly normalized: FloatRgb;
  readonly dibit: Dibit;
  readonly erased: boolean;
  readonly bestDeltaE: number;
  readonly secondDeltaE: number;
  readonly deltaEGap: number;
  readonly clippedChannels: number;
}

export interface ClassificationObservation extends CanonicalRasterObservationBase {
  readonly stage: "classification";
  readonly detailIncluded: boolean;
  readonly effectiveThresholds: Readonly<{
    maximumDeltaE: number;
    minimumDeltaEGap: number;
  }>;
  readonly clippedChannels: number;
  /** The erased and least-confident cells, capped at 128 entries. */
  readonly cells: readonly CellClassificationObservation[];
}

export type CanonicalRasterObservation =
  | CanonicalGeometryObservation
  | BootstrapPhaseObservation
  | CalibrationObservation
  | ClassificationObservation;

export type CanonicalRasterObserver = (observation: CanonicalRasterObservation) => void;

export const MAX_CLASSIFIER_CELL_OBSERVATIONS = 128;
const QUIET_ZONE_SAMPLES_PER_EDGE = 8;
const MAXIMUM_QUIET_ZONE_ERRORS = 2;
const ERASURE_SEVERITY_EPSILON = Number.EPSILON;

interface MutableDiagnostics {
  moduleScale: number;
  fiducialErrors: number;
  fiducialErrorsById: Readonly<Record<FiducialId, number>>;
  fiducialErrorMax: number;
  quietZoneErrors: number;
  quietZoneLumaErrors: number;
  quietZoneRgbErrors: number;
  bootstrapSampling?: BootstrapSamplingDiagnostics;
  timingErrors: number;
  timingUncertainModules: number;
  timingModules: number;
  timingRails?: TimingRailsDiagnostics;
  isiStrength: number;
  calibrationMad: number;
  observedContrast: number;
  minimumPaletteDistance: number;
  uncertainCells: number;
  erasureBytes: number;
  distanceRejectedCells: number;
  gapRejectedCells: number;
  bothRejectedCells: number;
  erasuresByShard: readonly number[];
  parityByShard: number;
  remainingErasureBudgetByShard: readonly number[];
  uncertainCellsByRow: readonly number[];
  uncertainCellsByColumn: readonly number[];
  effectiveMaximumDeltaE: number;
  effectiveMinimumDeltaEGap: number;
  bestDeltaE: ClassifierDistributionSummary;
  deltaEGap: ClassifierDistributionSummary;
  erasureCandidateScore: ClassifierDistributionSummary;
  meanBestDeltaE: number;
  maximumBestDeltaE: number;
}

interface BankSamples {
  readonly K: FloatRgb;
  readonly W: FloatRgb;
  readonly C: FloatRgb;
  readonly M: FloatRgb;
  readonly Y: FloatRgb;
  readonly G50: FloatRgb;
  readonly modules: Readonly<Record<CalibrationSwatchName, readonly FloatRgb[]>>;
}

interface CalibrationModel {
  readonly left: BankSamples;
  readonly right: BankSamples;
  readonly leftMad: number;
  readonly rightMad: number;
  readonly mad: number;
  readonly contrast: number;
  readonly minimumPaletteDistance: number;
}

function emptyClassifierDistribution(): ClassifierDistributionSummary {
  return Object.freeze({ count: 0, min: 0, p50: 0, p95: 0, max: 0 });
}

function classifierDistribution(values: readonly number[]): ClassifierDistributionSummary {
  if (values.length === 0) return emptyClassifierDistribution();
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (position: number): number =>
    sorted[Math.floor((sorted.length - 1) * position)]!;
  return Object.freeze({
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
  });
}

function assertClassifierDistribution(
  name: string,
  summary: ClassifierDistributionSummary,
  expectedCount: number,
): void {
  const ordered = summary.min <= summary.p50 &&
    summary.p50 <= summary.p95 &&
    summary.p95 <= summary.max;
  if (summary.count !== expectedCount ||
      !Number.isInteger(summary.count) ||
      ![summary.min, summary.p50, summary.p95, summary.max].every(Number.isFinite) ||
      !ordered) {
    throw new Error(`Invalid COLOR_4 ${name} distribution invariant.`);
  }
}

function assertCompletedClassificationDiagnostics(
  value: MutableDiagnostics,
  profile: Color4Profile,
): void {
  const cells = profile.columns * profile.rows;
  const sum = (entries: readonly number[]): number =>
    entries.reduce((total, entry) => total + entry, 0);
  assertClassifierDistribution("bestDeltaE", value.bestDeltaE, cells);
  assertClassifierDistribution("deltaEGap", value.deltaEGap, cells);
  assertClassifierDistribution(
    "erasureCandidateScore",
    value.erasureCandidateScore,
    value.erasureBytes,
  );
  if (value.uncertainCells !==
      value.distanceRejectedCells + value.gapRejectedCells - value.bothRejectedCells ||
      value.bothRejectedCells > value.distanceRejectedCells ||
      value.bothRejectedCells > value.gapRejectedCells ||
      value.uncertainCellsByRow.length !== profile.rows ||
      value.uncertainCellsByColumn.length !== profile.columns ||
      sum(value.uncertainCellsByRow) !== value.uncertainCells ||
      sum(value.uncertainCellsByColumn) !== value.uncertainCells ||
      value.erasuresByShard.length !== profile.shards ||
      value.remainingErasureBudgetByShard.length !== profile.shards ||
      sum(value.erasuresByShard) !== value.erasureBytes ||
      value.parityByShard !== profile.rsN - profile.rsK ||
      value.remainingErasureBudgetByShard.some(
        (remaining, shard) => remaining !== value.parityByShard - value.erasuresByShard[shard]!,
      ) ||
      value.maximumBestDeltaE !== value.bestDeltaE.max) {
    throw new Error("Invalid COLOR_4 classification diagnostics invariant.");
  }
}

function diagnostics(initial?: Partial<MutableDiagnostics>): MutableDiagnostics {
  return {
    moduleScale: 0,
    fiducialErrors: 0,
    fiducialErrorsById: Object.freeze({ TL: 0, TR: 0, BR: 0, BL: 0 }),
    fiducialErrorMax: 0,
    quietZoneErrors: 0,
    quietZoneLumaErrors: 0,
    quietZoneRgbErrors: 0,
    timingErrors: 0,
    timingUncertainModules: 0,
    timingModules: 0,
    isiStrength: 0,
    calibrationMad: 0,
    observedContrast: 0,
    minimumPaletteDistance: 0,
    uncertainCells: 0,
    erasureBytes: 0,
    distanceRejectedCells: 0,
    gapRejectedCells: 0,
    bothRejectedCells: 0,
    erasuresByShard: [],
    parityByShard: 0,
    remainingErasureBudgetByShard: [],
    uncertainCellsByRow: [],
    uncertainCellsByColumn: [],
    effectiveMaximumDeltaE: 0,
    effectiveMinimumDeltaEGap: 0,
    bestDeltaE: emptyClassifierDistribution(),
    deltaEGap: emptyClassifierDistribution(),
    erasureCandidateScore: emptyClassifierDistribution(),
    meanBestDeltaE: 0,
    maximumBestDeltaE: 0,
    ...initial,
  };
}

function freezeDiagnostics(value: MutableDiagnostics): CanonicalRasterDiagnostics {
  return Object.freeze({
    ...value,
    fiducialErrorsById: Object.freeze({ ...value.fiducialErrorsById }),
    erasuresByShard: Object.freeze([...value.erasuresByShard]),
    remainingErasureBudgetByShard: Object.freeze([...value.remainingErasureBudgetByShard]),
    uncertainCellsByRow: Object.freeze([...value.uncertainCellsByRow]),
    uncertainCellsByColumn: Object.freeze([...value.uncertainCellsByColumn]),
    bestDeltaE: Object.freeze({ ...value.bestDeltaE }),
    deltaEGap: Object.freeze({ ...value.deltaEGap }),
    erasureCandidateScore: Object.freeze({ ...value.erasureCandidateScore }),
    ...(value.bootstrapSampling === undefined
      ? {}
      : { bootstrapSampling: Object.freeze({ ...value.bootstrapSampling }) }),
    ...(value.timingRails === undefined
      ? {}
      : {
          timingRails: Object.freeze({
            top: Object.freeze({ ...value.timingRails.top }),
            right: Object.freeze({ ...value.timingRails.right }),
            bottom: Object.freeze({ ...value.timingRails.bottom }),
            left: Object.freeze({ ...value.timingRails.left }),
          }),
        }),
  });
}

function rejected(
  reason: CanonicalRasterRejectReason,
  value: MutableDiagnostics,
): RejectedCanonicalRaster {
  return Object.freeze({ status: "rejected", reason, diagnostics: freezeDiagnostics(value) });
}

function defaultClock(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function readClock(clock: (() => number) | undefined): number {
  try {
    const value = (clock ?? defaultClock)();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function elapsedSince(clock: (() => number) | undefined, startedAt: number): {
  readonly endedAt: number;
  readonly durationMs: number;
} {
  const endedAt = readClock(clock);
  return { endedAt, durationMs: Math.max(0, endedAt - startedAt) };
}

function notifyObserver(
  observer: CanonicalRasterObserver | undefined,
  observation: CanonicalRasterObservation,
): void {
  if (observer === undefined) return;
  try {
    observer(Object.freeze(observation));
  } catch {
    // Diagnostic consumers must never influence wire decoding.
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("Cannot take the median of an empty sample.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >>> 1;
  return sorted.length & 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianRgb(values: readonly FloatRgb[]): FloatRgb {
  return [
    median(values.map((value) => value[0])),
    median(values.map((value) => value[1])),
    median(values.map((value) => value[2])),
  ];
}

function luminance(rgb: FloatRgb): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rawClippedChannels(rgb: FloatRgb): number {
  return (
    (rgb[0] <= 1 || rgb[0] >= 254 ? 1 : 0) +
    (rgb[1] <= 1 || rgb[1] >= 254 ? 1 : 0) +
    (rgb[2] <= 1 || rgb[2] >= 254 ? 1 : 0)
  );
}

function mix(left: number, right: number, position: number): number {
  return left + (right - left) * position;
}

function mixRgb(left: FloatRgb, right: FloatRgb, position: number): FloatRgb {
  return [
    mix(left[0], right[0], position),
    mix(left[1], right[1], position),
    mix(left[2], right[2], position),
  ];
}

/** Convert normalized sRGB (0..1 per channel) to CIE Lab using a D65 white. */
export function normalizedRgbToLab(rgb: FloatRgb): LabColor {
  const linear = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const x = linear[0]! * 0.4124564 + linear[1]! * 0.3575761 + linear[2]! * 0.1804375;
  const y = linear[0]! * 0.2126729 + linear[1]! * 0.7151522 + linear[2]! * 0.072175;
  const z = linear[0]! * 0.0193339 + linear[1]! * 0.119192 + linear[2]! * 0.9503041;
  const transform = (component: number): number =>
    component > 216 / 24389
      ? Math.cbrt(component)
      : (841 / 108) * component + 4 / 29;
  const fx = transform(x / 0.95047);
  const fy = transform(y);
  const fz = transform(z / 1.08883);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function deltaE76(left: LabColor, right: LabColor): number {
  return Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b);
}

interface ModuleSampler {
  readonly scale: number;
  sampleActive(x: number, y: number): FloatRgb;
  sampleLogical(x: number, y: number): FloatRgb;
}

function createSampler(image: CanonicalRasterImage, scale: number): ModuleSampler {
  const sampleLogical = (logicalX: number, logicalY: number): FloatRgb => {
    const inset = Math.floor(scale / 4);
    const span = Math.max(1, scale - 2 * inset);
    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    const startX = logicalX * scale + inset;
    const startY = logicalY * scale + inset;
    for (let y = 0; y < span; y++) {
      for (let x = 0; x < span; x++) {
        const offset = ((startY + y) * image.width + startX + x) * 4;
        reds.push(image.pixels[offset]!);
        greens.push(image.pixels[offset + 1]!);
        blues.push(image.pixels[offset + 2]!);
      }
    }
    return [median(reds), median(greens), median(blues)];
  };
  return {
    scale,
    sampleLogical,
    sampleActive: (x, y) => sampleLogical(x + QUIET_MODULES, y + QUIET_MODULES),
  };
}

/**
 * Inter-symbol interference correction.
 *
 * A camera resolving only a handful of pixels per module cannot keep a module's
 * light inside its own cell: each sample is a blend of its neighbours. The
 * effect is invisible to the geometry stages, whose features are large or
 * repeated, but it dominates colour classification, whose features are single
 * modules with arbitrary neighbours.
 *
 * It also breaks calibration in a way that is easy to miss. Reference swatches
 * are 2x2 blocks, so their centres are mostly surrounded by their own colour and
 * read close to the true value. Data cells are 1x1 with random neighbours and
 * read pulled toward the local average. Measured on a real 3.95 px/module
 * capture: an isolated black module read 46 luma brighter than a 2x2 black
 * block, and cells with no same-coloured neighbour sat at 22.9 dE from their
 * centroid against 12.4 dE for cells surrounded by their own colour. The
 * centroids were not wrong; they described a different spatial frequency than
 * the data they were being compared against.
 *
 * Undoing a first-order blur on the module lattice puts both back on the same
 * footing. It must happen in linear light — blurring is linear in radiance, and
 * doing it on gamma-encoded values lifts darks far more than it lowers lights.
 */
const ISI_DIAGONAL_WEIGHT = 0.25;
/**
 * Strengths tried when estimating the blur. Zero is included and, on ties, wins:
 * a sharp capture must not be sharpened, and the estimator has to be able to
 * conclude that no correction is the right answer.
 */
const ISI_STRENGTH_CANDIDATES: readonly number[] = Object.freeze([
  0, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4,
]);
/** Guards the separation score when a synthetic frame has literally zero spread. */
const ISI_SCORE_EPSILON = 1e-6;

function linearFromDevice(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function deviceFromLinear(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return 255 * (clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055);
}

/**
 * A rectangle of active modules held in linear light, row-major, three channels
 * per module. The outermost ring is never corrected; it exists so the modules
 * inside it have neighbours to be corrected against.
 */
interface ModuleLattice {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly values: Float64Array;
}

function sampleModuleLattice(
  sampler: ModuleSampler,
  x: number,
  y: number,
  width: number,
  height: number,
): ModuleLattice {
  const values = new Float64Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const rgb = sampler.sampleActive(x + column, y + row);
      const offset = (row * width + column) * 3;
      values[offset] = linearFromDevice(rgb[0]);
      values[offset + 1] = linearFromDevice(rgb[1]);
      values[offset + 2] = linearFromDevice(rgb[2]);
    }
  }
  return { x, y, width, height, values };
}

/**
 * Invert `observed = (1 - strength) * true + strength * neighbourhood` on the
 * module lattice. Border modules keep their observed value: they have no full
 * neighbourhood, and inventing one would corrupt the very cells the quiet zone
 * exists to protect.
 */
function deconvolveModuleLattice(lattice: ModuleLattice, strength: number): ModuleLattice {
  if (strength <= 0) return lattice;
  const { width, height, values } = lattice;
  const out = new Float64Array(values);
  const crossWeight = (1 - ISI_DIAGONAL_WEIGHT) / 4;
  const diagonalWeight = ISI_DIAGONAL_WEIGHT / 4;
  const at = (column: number, row: number, channel: number) =>
    values[(row * width + column) * 3 + channel]!;

  for (let row = 1; row < height - 1; row++) {
    for (let column = 1; column < width - 1; column++) {
      const offset = (row * width + column) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const cross =
          at(column - 1, row, channel) + at(column + 1, row, channel) +
          at(column, row - 1, channel) + at(column, row + 1, channel);
        const diagonal =
          at(column - 1, row - 1, channel) + at(column + 1, row - 1, channel) +
          at(column - 1, row + 1, channel) + at(column + 1, row + 1, channel);
        const neighbourhood = cross * crossWeight + diagonal * diagonalWeight;
        out[offset + channel] =
          (values[offset + channel]! - strength * neighbourhood) / (1 - strength);
      }
    }
  }
  return { ...lattice, values: out };
}

function latticeLuminance(lattice: ModuleLattice, column: number, row: number): number {
  const offset = ((row - lattice.y) * lattice.width + (column - lattice.x)) * 3;
  return luminance([
    deviceFromLinear(lattice.values[offset]!),
    deviceFromLinear(lattice.values[offset + 1]!),
    deviceFromLinear(lattice.values[offset + 2]!),
  ]);
}

/** Same-colour neighbours that make a module "clustered" rather than isolated. */
const ISI_CLUSTERED_NEIGHBOURS = 2;
const ISI_ISOLATED_NEIGHBOURS = 1;
/** Luma the correction must recover before it is worth applying at all. */
const ISI_MINIMUM_RECOVERED_LUMA = 8;

interface IsiContrastGroups {
  readonly clusteredDark: number[];
  readonly isolatedDark: number[];
  readonly clusteredLight: number[];
  readonly isolatedLight: number[];
}

/**
 * Measure how much contrast a module loses purely for being isolated.
 *
 * The fiducial patterns are frozen in the spec, so inside a marker it is known
 * in advance which modules sit in a run of their own colour and which stand
 * alone. Without blur the two read identically. Under blur the isolated ones are
 * dragged toward their neighbours and their black-to-white span collapses, so
 * the disagreement between the two spans measures the interference directly.
 *
 * Crucially it measures *only* interference. An earlier version scored how
 * cleanly black separated from white in units of its own spread, which a
 * brightness gradient across the frame inflates just as effectively as blur
 * does: on a synthetic, perfectly sharp frame carrying a measured corner
 * photometric field it recommended the strongest correction available and
 * corrupted 46 bytes that had decoded exactly. Comparing two groups that share
 * the same gradient cancels it.
 */
function isiContrastGroups(
  lattices: readonly ModuleLattice[],
  strength: number,
): IsiContrastGroups {
  const groups: IsiContrastGroups = {
    clusteredDark: [], isolatedDark: [], clusteredLight: [], isolatedLight: [],
  };
  for (let index = 0; index < FIDUCIALS.length; index++) {
    const marker = FIDUCIALS[index]!;
    const corrected = deconvolveModuleLattice(lattices[index]!, strength);
    // The interior only: an edge module's neighbourhood runs outside the marker,
    // where the pattern is not known ahead of decoding.
    for (let y = 1; y < marker.height - 1; y++) {
      for (let x = 1; x < marker.width - 1; x++) {
        const own = fiducialModule(marker.id, x, y);
        let same = 0;
        if (fiducialModule(marker.id, x - 1, y) === own) same++;
        if (fiducialModule(marker.id, x + 1, y) === own) same++;
        if (fiducialModule(marker.id, x, y - 1) === own) same++;
        if (fiducialModule(marker.id, x, y + 1) === own) same++;
        const value = latticeLuminance(corrected, marker.x + x, marker.y + y);
        if (same >= ISI_CLUSTERED_NEIGHBOURS) {
          (own === 1 ? groups.clusteredDark : groups.clusteredLight).push(value);
        } else if (same <= ISI_ISOLATED_NEIGHBOURS) {
          (own === 1 ? groups.isolatedDark : groups.isolatedLight).push(value);
        }
      }
    }
  }
  return groups;
}

function isiContrastDisagreement(groups: IsiContrastGroups): number | undefined {
  if (
    groups.clusteredDark.length === 0 || groups.isolatedDark.length === 0 ||
    groups.clusteredLight.length === 0 || groups.isolatedLight.length === 0
  ) {
    return undefined;
  }
  const clustered = median(groups.clusteredLight) - median(groups.clusteredDark);
  const isolated = median(groups.isolatedLight) - median(groups.isolatedDark);
  return Math.abs(clustered - isolated);
}

/**
 * Pick the correction strength that best equalises isolated and clustered
 * contrast. Zero is a candidate and wins ties, and the winner must also close a
 * meaningful amount of the gap, so a sharp capture is left untouched rather than
 * sharpened on the strength of measurement noise.
 */
function estimateIsiStrength(sampler: ModuleSampler): number {
  const lattices = FIDUCIALS.map((marker) =>
    sampleModuleLattice(sampler, marker.x - 1, marker.y - 1, marker.width + 2, marker.height + 2),
  );
  const baseline = isiContrastDisagreement(isiContrastGroups(lattices, 0));
  if (baseline === undefined || baseline < ISI_MINIMUM_RECOVERED_LUMA) return 0;

  let bestStrength = 0;
  let bestDisagreement = baseline;
  for (const strength of ISI_STRENGTH_CANDIDATES) {
    if (strength === 0) continue;
    const disagreement = isiContrastDisagreement(isiContrastGroups(lattices, strength));
    if (disagreement === undefined) continue;
    if (disagreement < bestDisagreement - ISI_SCORE_EPSILON) {
      bestDisagreement = disagreement;
      bestStrength = strength;
    }
  }
  // Reject a correction that barely moved the measurement it was chosen for.
  return baseline - bestDisagreement >= ISI_MINIMUM_RECOVERED_LUMA ? bestStrength : 0;
}

/**
 * A sampler backed by the corrected lattice, falling through to the raw image
 * outside it. Only the colour stage uses this: the geometry stages are already
 * reliable on raw samples, and re-deriving them from corrected values would
 * change checks that currently pass for reasons unrelated to colour.
 */
function createLatticeSampler(base: ModuleSampler, lattice: ModuleLattice): ModuleSampler {
  const sampleActive = (x: number, y: number): FloatRgb => {
    const column = x - lattice.x;
    const row = y - lattice.y;
    if (column < 0 || row < 0 || column >= lattice.width || row >= lattice.height) {
      return base.sampleActive(x, y);
    }
    const offset = (row * lattice.width + column) * 3;
    return [
      deviceFromLinear(lattice.values[offset]!),
      deviceFromLinear(lattice.values[offset + 1]!),
      deviceFromLinear(lattice.values[offset + 2]!),
    ];
  };
  return { scale: base.scale, sampleActive, sampleLogical: base.sampleLogical };
}

/** Active-module bounds covering the data grid and both calibration banks, plus
 *  the one-module ring the correction needs as neighbourhood. */
function colourLatticeBounds(layout: PhysicalLayout): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const columns = [
    layout.data.x,
    layout.data.x + layout.data.width - 1,
    ...layout.calibration.left.flatMap((p) => [p.x, p.x + p.width - 1]),
    ...layout.calibration.right.flatMap((p) => [p.x, p.x + p.width - 1]),
  ];
  const rows = [
    layout.data.y,
    layout.data.y + layout.data.height - 1,
    ...layout.calibration.left.flatMap((p) => [p.y, p.y + p.height - 1]),
    ...layout.calibration.right.flatMap((p) => [p.y, p.y + p.height - 1]),
  ];
  const limit = ACTIVE_MODULES - 1;
  const x = Math.max(0, Math.min(...columns) - 1);
  const y = Math.max(0, Math.min(...rows) - 1);
  const right = Math.min(limit, Math.max(...columns) + 1);
  const bottom = Math.min(limit, Math.max(...rows) + 1);
  return { x, y, width: right - x + 1, height: bottom - y + 1 };
}

interface CollectedBinaryAnchors {
  readonly pooled: BinaryAnchors;
  readonly byFiducial: BinaryAnchorsByFiducial;
  readonly rgbByFiducial: RgbBinaryAnchorsByFiducial;
}

function collectBinaryAnchors(sampler: ModuleSampler): CollectedBinaryAnchors {
  const dark: number[] = [];
  const light: number[] = [];
  const byFiducial = {} as Record<FiducialId, BinaryAnchors>;
  const rgbByFiducial = {} as Record<FiducialId, RgbBinaryAnchors>;
  for (const marker of FIDUCIALS) {
    const localDark: number[] = [];
    const localLight: number[] = [];
    const localDarkRgb: FloatRgb[] = [];
    const localLightRgb: FloatRgb[] = [];
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const isBorder = x === 0 || y === 0 || x === 8 || y === 8;
        const isRing = !isBorder && (x === 1 || y === 1 || x === 7 || y === 7);
        if (!isBorder && !isRing) continue;
        const rgb = sampler.sampleActive(marker.x + x, marker.y + y);
        const value = luminance(rgb);
        if (isBorder) {
          dark.push(value);
          localDark.push(value);
          localDarkRgb.push(rgb);
        } else {
          light.push(value);
          localLight.push(value);
          localLightRgb.push(rgb);
        }
      }
    }
    byFiducial[marker.id] = Object.freeze({
      black: median(localDark),
      white: median(localLight),
    });
    rgbByFiducial[marker.id] = Object.freeze({
      black: Object.freeze(medianRgb(localDarkRgb)),
      white: Object.freeze(medianRgb(localLightRgb)),
    });
  }
  return Object.freeze({
    pooled: Object.freeze({ black: median(dark), white: median(light) }),
    byFiducial: Object.freeze(byFiducial),
    rgbByFiducial: Object.freeze(rgbByFiducial),
  });
}

function binaryModule(rgb: FloatRgb, anchors: BinaryAnchors): 0 | 1 | -1 {
  const range = anchors.white - anchors.black;
  if (!Number.isFinite(range) || range <= 0) return -1;
  const normalized = (luminance(rgb) - anchors.black) / range;
  if (normalized <= BINARY_BLACK_MAXIMUM) return 1;
  if (normalized >= BINARY_WHITE_MINIMUM) return 0;
  return -1;
}

function sampleLuminanceRect(
  sampler: ModuleSampler,
  rect: ModuleRect,
): Float64Array {
  const out = new Float64Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const activeX = rect.x + x;
      const activeY = rect.y + y;
      out[y * rect.width + x] = luminance(sampler.sampleActive(activeX, activeY));
    }
  }
  return out;
}

function sampleRectWithRailModel(
  sampler: ModuleSampler,
  rect: ModuleRect,
  model: LocalBinaryRailModel,
): Int8Array {
  const luminances = sampleLuminanceRect(sampler, rect);
  return Int8Array.from(luminances, (value) => classifyWithLocalBinaryRail(value, model));
}

interface FiducialErrorSummary {
  readonly byId: Readonly<Record<FiducialId, number>>;
  readonly total: number;
  readonly maximum: number;
}

function countFiducialErrors(
  sampler: ModuleSampler,
  anchors: SpatialBinaryAnchorModel,
): FiducialErrorSummary {
  const byId: Record<FiducialId, number> = { TL: 0, TR: 0, BR: 0, BL: 0 };
  for (const marker of FIDUCIALS) {
    let errors = 0;
    const markerAnchors = anchors.byFiducial[marker.id];
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const sampled = binaryModule(
          sampler.sampleActive(marker.x + x, marker.y + y),
          markerAnchors,
        );
        if (sampled !== fiducialModule(marker.id, x, y)) errors++;
      }
    }
    byId[marker.id] = errors;
  }
  const counts = Object.values(byId);
  return Object.freeze({
    byId: Object.freeze(byId),
    total: counts.reduce((sum, errors) => sum + errors, 0),
    maximum: Math.max(...counts),
  });
}

function countQuietZoneErrors(
  sampler: ModuleSampler,
  anchors: SpatialBinaryAnchorModel,
  rgbAnchors: SpatialRgbBinaryAnchorModel,
): { readonly combined: number; readonly luma: number; readonly rgb: number } {
  const depth = Math.floor(QUIET_MODULES / 2);
  const far = TOTAL_MODULES - 1 - depth;
  let errors = 0;
  let lumaErrors = 0;
  let rgbErrors = 0;
  const check = (x: number, y: number): void => {
    const sample = sampler.sampleLogical(x, y);
    const localRgb = rgbAnchors.atLogical(x, y);
    const lumaWhite = binaryModule(sample, anchors.atLogical(x, y)) === 0;
    const rgbWhite = sample.every((channel, index) => {
        const black = localRgb.black[index]!;
        const white = localRgb.white[index]!;
        const normalized = (channel - black) / (white - black);
        return Number.isFinite(normalized) && normalized >= BINARY_WHITE_MINIMUM;
      });
    if (!lumaWhite) lumaErrors++;
    if (!rgbWhite) rgbErrors++;
    if (!lumaWhite || !rgbWhite) errors++;
  };
  for (let index = 0; index < QUIET_ZONE_SAMPLES_PER_EDGE; index++) {
    const position = QUIET_MODULES + Math.floor(
      ((index + 0.5) * ACTIVE_MODULES) / QUIET_ZONE_SAMPLES_PER_EDGE,
    );
    check(position, depth);
    check(position, far);
    check(depth, position);
    check(far, position);
  }
  return { combined: errors, luma: lumaErrors, rgb: rgbErrors };
}

interface TimingRailEvaluations {
  readonly top: LocalBinaryRailEvaluation;
  readonly right: LocalBinaryRailEvaluation;
  readonly bottom: LocalBinaryRailEvaluation;
  readonly left: LocalBinaryRailEvaluation;
}

interface TimingEvaluation {
  readonly rails: TimingRailEvaluations;
  readonly errors: number;
  readonly uncertainModules: number;
  readonly modules: number;
  readonly allRailsValid: boolean;
}

function evaluateTimingRail(
  sampler: ModuleSampler,
  rect: ModuleRect,
  inverted: boolean,
  minimumContrastLuma: number,
): LocalBinaryRailEvaluation {
  const luminances = sampleLuminanceRect(sampler, rect);
  const expected = new Int8Array(luminances.length);
  for (let index = 0; index < expected.length; index++) {
    const alternating = (index & 1) === 0 ? 1 : 0;
    expected[index] = inverted ? alternating ^ 1 : alternating;
  }
  return evaluateLocalBinaryRail(luminances, expected, minimumContrastLuma);
}

function evaluateTimingRails(
  sampler: ModuleSampler,
  layout: PhysicalLayout,
  minimumContrastLuma: number,
): TimingEvaluation {
  const rails: TimingRailEvaluations = {
    top: evaluateTimingRail(sampler, layout.timing.top, false, minimumContrastLuma),
    right: evaluateTimingRail(sampler, layout.timing.right, true, minimumContrastLuma),
    bottom: evaluateTimingRail(sampler, layout.timing.bottom, true, minimumContrastLuma),
    left: evaluateTimingRail(sampler, layout.timing.left, false, minimumContrastLuma),
  };
  const values = Object.values(rails);
  return {
    rails,
    errors: values.reduce((sum, rail) => sum + rail.errors, 0),
    uncertainModules: values.reduce((sum, rail) => sum + rail.uncertainModules, 0),
    modules: values.reduce((sum, rail) => sum + rail.modules, 0),
    allRailsValid: values.every((rail) => rail.valid),
  };
}

function observeTimingRail(rail: LocalBinaryRailEvaluation): TimingRailDiagnostics {
  return Object.freeze({
    valid: rail.valid,
    blackLuma: rail.blackLuma,
    whiteLuma: rail.whiteLuma,
    thresholdLuma: rail.thresholdLuma,
    contrastLuma: rail.contrastLuma,
    errors: rail.errors,
    uncertainModules: rail.uncertainModules,
    modules: rail.modules,
  });
}

function observeTimingRails(rails: TimingRailEvaluations): TimingRailsDiagnostics {
  return Object.freeze({
    top: observeTimingRail(rails.top),
    right: observeTimingRail(rails.right),
    bottom: observeTimingRail(rails.bottom),
    left: observeTimingRail(rails.left),
  });
}

function samplesForPlacement(
  sampler: ModuleSampler,
  placement: CalibrationPlacement,
): readonly FloatRgb[] {
  const out: FloatRgb[] = [];
  for (let y = 0; y < placement.height; y++) {
    for (let x = 0; x < placement.width; x++) {
      out.push(sampler.sampleActive(placement.x + x, placement.y + y));
    }
  }
  return out;
}

function sampleBank(
  sampler: ModuleSampler,
  placements: readonly CalibrationPlacement[],
): BankSamples {
  const modules = {} as Record<CalibrationSwatchName, readonly FloatRgb[]>;
  const centers = {} as Record<CalibrationSwatchName, FloatRgb>;
  for (const placement of placements) {
    const values = samplesForPlacement(sampler, placement);
    modules[placement.name] = values;
    centers[placement.name] = medianRgb(values);
  }
  return {
    K: centers.K,
    W: centers.W,
    C: centers.C,
    M: centers.M,
    Y: centers.Y,
    G50: centers.G50,
    modules,
  };
}

function normalizedWithAnchors(sample: FloatRgb, black: FloatRgb, white: FloatRgb): FloatRgb {
  return [
    clamp01((sample[0] - black[0]) / Math.max(1, white[0] - black[0])),
    clamp01((sample[1] - black[1]) / Math.max(1, white[1] - black[1])),
    clamp01((sample[2] - black[2]) / Math.max(1, white[2] - black[2])),
  ];
}

function normalizedBankColor(bank: BankSamples, name: CalibrationSwatchName): FloatRgb {
  return normalizedWithAnchors(bank[name], bank.K, bank.W);
}

function paletteTargets(bank: BankSamples, paletteId: 0 | 1): readonly FloatRgb[] {
  const black: FloatRgb = [0, 0, 0];
  const cyan = normalizedBankColor(bank, "C");
  const magenta = normalizedBankColor(bank, "M");
  const yellow = normalizedBankColor(bank, "Y");
  if (paletteId === 0) return [black, cyan, magenta, yellow];
  return [
    black,
    [1 - cyan[0], 1 - cyan[1], 1 - cyan[2]],
    [1 - magenta[0], 1 - magenta[1], 1 - magenta[2]],
    [1 - yellow[0], 1 - yellow[1], 1 - yellow[2]],
  ];
}

function targetAt(model: CalibrationModel, paletteId: 0 | 1, dibit: number, x: number): FloatRgb {
  const left = paletteTargets(model.left, paletteId)[dibit]!;
  const right = paletteTargets(model.right, paletteId)[dibit]!;
  return mixRgb(left, right, x);
}

function minimumTargetDistance(
  left: BankSamples,
  right: BankSamples,
  paletteId: 0 | 1,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  const placeholder: CalibrationModel = {
    left,
    right,
    leftMad: 0,
    rightMad: 0,
    mad: 0,
    contrast: 0,
    minimumPaletteDistance: 0,
  };
  for (const position of [0, 0.5, 1]) {
    const labs = [0, 1, 2, 3].map((dibit) =>
      normalizedRgbToLab(targetAt(placeholder, paletteId, dibit, position)),
    );
    for (let first = 0; first < labs.length; first++) {
      for (let second = first + 1; second < labs.length; second++) {
        minimum = Math.min(minimum, deltaE76(labs[first]!, labs[second]!));
      }
    }
  }
  return minimum;
}

function bankMad(bank: BankSamples): number {
  const distances: number[] = [];
  for (const name of ["K", "W", "C", "M", "Y", "G50"] as const) {
    const center = normalizedBankColor(bank, name);
    const centerLab = normalizedRgbToLab(center);
    for (const sample of bank.modules[name]) {
      const normalized = normalizedWithAnchors(sample, bank.K, bank.W);
      distances.push(deltaE76(normalizedRgbToLab(normalized), centerLab));
    }
  }
  const center = median(distances);
  return median(distances.map((distance) => Math.abs(distance - center)));
}

function buildCalibration(
  sampler: ModuleSampler,
  layout: PhysicalLayout,
  paletteId: 0 | 1,
): CalibrationModel {
  const left = sampleBank(sampler, layout.calibration.left);
  const right = sampleBank(sampler, layout.calibration.right);
  const leftMad = bankMad(left);
  const rightMad = bankMad(right);
  return {
    left,
    right,
    leftMad,
    rightMad,
    mad: Math.max(leftMad, rightMad),
    contrast: Math.min(luminance(left.W) - luminance(left.K), luminance(right.W) - luminance(right.K)),
    minimumPaletteDistance: minimumTargetDistance(left, right, paletteId),
  };
}

function cloneRgb(rgb: FloatRgb): FloatRgb {
  return Object.freeze([rgb[0], rgb[1], rgb[2]]) as FloatRgb;
}

function observeCalibrationBank(bank: BankSamples, mad: number): CalibrationBankObservation {
  const names = ["K", "W", "C", "M", "Y", "G50"] as const;
  const raw = {} as Record<CalibrationSwatchName, FloatRgb>;
  const normalized = {} as Record<CalibrationSwatchName, FloatRgb>;
  const samples = {} as Record<
    CalibrationSwatchName,
    readonly CalibrationSampleObservation[]
  >;
  for (const name of names) {
    raw[name] = cloneRgb(bank[name]);
    normalized[name] = cloneRgb(normalizedBankColor(bank, name));
    samples[name] = Object.freeze(bank.modules[name].map((sample) => Object.freeze({
      raw: cloneRgb(sample),
      normalized: cloneRgb(normalizedWithAnchors(sample, bank.K, bank.W)),
    })));
  }
  let clippedChannels = 0;
  for (const samples of Object.values(bank.modules)) {
    for (const sample of samples) {
      clippedChannels += rawClippedChannels(sample);
    }
  }
  return Object.freeze({
    raw: Object.freeze(raw),
    normalized: Object.freeze(normalized),
    mad,
    contrast: luminance(bank.W) - luminance(bank.K),
    clippedChannels,
    samples: Object.freeze(samples),
  });
}

interface RankedCellObservation {
  readonly score: number;
  readonly observation: CellClassificationObservation;
}

interface RankedCellBuffer {
  readonly entries: RankedCellObservation[];
  leastIndex: number;
  leastScore: number;
}

function cellObservationScore(
  erased: boolean,
  bestDeltaE: number,
  deltaEGap: number,
  minimumDeltaEGap: number,
): number {
  const gapPenalty = Math.max(0, minimumDeltaEGap - deltaEGap);
  return (erased ? 1_000_000 : 0) + bestDeltaE + gapPenalty;
}

function cellErasureCandidateScore(
  bestDeltaE: number,
  deltaEGap: number,
  effectiveMaximumDeltaE: number,
  effectiveMinimumDeltaEGap: number,
): number {
  const distanceSeverity =
    bestDeltaE / Math.max(effectiveMaximumDeltaE, ERASURE_SEVERITY_EPSILON);
  const gapSeverity =
    effectiveMinimumDeltaEGap / Math.max(deltaEGap, ERASURE_SEVERITY_EPSILON);
  return Math.max(distanceSeverity, gapSeverity);
}

function retainWorstCell(
  buffer: RankedCellBuffer,
  score: number,
  createObservation: () => CellClassificationObservation,
): void {
  if (buffer.entries.length < MAX_CLASSIFIER_CELL_OBSERVATIONS) {
    const index = buffer.entries.length;
    buffer.entries.push({ score, observation: createObservation() });
    if (score < buffer.leastScore) {
      buffer.leastIndex = index;
      buffer.leastScore = score;
    }
    return;
  }
  if (score <= buffer.leastScore) return;
  buffer.entries[buffer.leastIndex] = { score, observation: createObservation() };
  buffer.leastIndex = 0;
  buffer.leastScore = buffer.entries[0]!.score;
  for (let index = 1; index < buffer.entries.length; index++) {
    if (buffer.entries[index]!.score < buffer.leastScore) {
      buffer.leastIndex = index;
      buffer.leastScore = buffer.entries[index]!.score;
    }
  }
}

export interface LabClassification {
  readonly dibit: Dibit;
  readonly erased: boolean;
  readonly bestDeltaE: number;
  readonly secondDeltaE: number;
}

/**
 * Decision-directed centroid refinement.
 *
 * The reference swatches are 2x2 blocks and the data is 1x1 modules, so even a
 * perfectly measured palette describes a slightly different thing than the cells
 * it is used to classify. The cells themselves are the better reference: there
 * are thousands of them, they are exactly the geometry in question, and most are
 * classified confidently even when the absolute distances are poor.
 *
 * So the swatch centroids are used once to label the field, and then each
 * centroid is re-estimated as the median of the cells that chose it. Medians
 * make this safe: a minority of misclassified cells cannot drag a centroid, and
 * a class must be well populated in both halves of the frame before its
 * refinement is trusted at all.
 */
const DECISION_DIRECTED_PASSES = 2;
/** Cells a class needs in each half before its refined centroid is believed. */
const DECISION_DIRECTED_MINIMUM_SAMPLES = 32;
/** Frame positions the two half-centroids are treated as sitting at. */
const DECISION_DIRECTED_LEFT_ANCHOR = 0.25;
const DECISION_DIRECTED_RIGHT_ANCHOR = 0.75;

type CentroidField = (position: number) => readonly LabColor[];

function medianLab(values: readonly LabColor[]): LabColor {
  return {
    l: median(values.map((value) => value.l)),
    a: median(values.map((value) => value.a)),
    b: median(values.map((value) => value.b)),
  };
}

function mixLab(left: LabColor, right: LabColor, position: number): LabColor {
  return {
    l: mix(left.l, right.l, position),
    a: mix(left.a, right.a, position),
    b: mix(left.b, right.b, position),
  };
}

/**
 * Re-estimate the four centroids from labelled cells, split into left and right
 * halves so the existing horizontal interpolation survives. Returns undefined
 * when any class is too sparse to trust, which leaves the swatch centroids in
 * place rather than inventing one from a handful of samples.
 */
function refineCentroids(
  labels: Uint8Array,
  labs: readonly LabColor[],
  positions: readonly number[],
): CentroidField | undefined {
  const halves: LabColor[][][] = [0, 1, 2, 3].map(() => [[], []]);
  for (let index = 0; index < labels.length; index++) {
    halves[labels[index]!]![positions[index]! < 0.5 ? 0 : 1]!.push(labs[index]!);
  }
  const anchors: (readonly [LabColor, LabColor])[] = [];
  for (const [left, right] of halves) {
    if (
      left!.length < DECISION_DIRECTED_MINIMUM_SAMPLES ||
      right!.length < DECISION_DIRECTED_MINIMUM_SAMPLES
    ) {
      return undefined;
    }
    anchors.push([medianLab(left!), medianLab(right!)]);
  }
  const span = DECISION_DIRECTED_RIGHT_ANCHOR - DECISION_DIRECTED_LEFT_ANCHOR;
  return (position) => {
    const t = clamp01((position - DECISION_DIRECTED_LEFT_ANCHOR) / span);
    return anchors.map(([left, right]) => mixLab(left, right, t));
  };
}

/** Mean distance from each cell to its winning centroid: lower is a better fit. */
function meanWinningDistance(
  labs: readonly LabColor[],
  positions: Float64Array,
  centroids: CentroidField,
): number {
  if (labs.length === 0) return 0;
  let total = 0;
  for (let index = 0; index < labs.length; index++) {
    total += nearestCentroid(labs[index]!, centroids(positions[index]!)).bestDeltaE;
  }
  return total / labs.length;
}

function nearestCentroid(
  lab: LabColor,
  centroids: readonly LabColor[],
): { dibit: Dibit; bestDeltaE: number; secondDeltaE: number } {
  let best = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  let dibit: Dibit = 0;
  for (let candidate = 0; candidate < centroids.length; candidate++) {
    const distance = deltaE76(lab, centroids[candidate]!);
    if (distance < best) {
      second = best;
      best = distance;
      dibit = candidate as Dibit;
    } else if (distance < second) {
      second = distance;
    }
  }
  return { dibit, bestDeltaE: best, secondDeltaE: second };
}

/** Classify one normalized RGB cell against four normalized RGB centroids. */
export function classifyLabCell(
  sample: FloatRgb,
  centroids: readonly FloatRgb[],
  maximumDeltaE: number,
  minimumGap: number,
): LabClassification {
  if (centroids.length !== 4) throw new RangeError("COLOR_4 needs exactly four centroids.");
  const sampleLab = normalizedRgbToLab(sample);
  const ranked = centroids
    .map((centroid, dibit) => ({
      dibit: dibit as Dibit,
      distance: deltaE76(sampleLab, normalizedRgbToLab(centroid)),
    }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0]!;
  const second = ranked[1]!;
  return {
    dibit: best.dibit,
    erased: best.distance > maximumDeltaE || second.distance - best.distance < minimumGap,
    bestDeltaE: best.distance,
    secondDeltaE: second.distance,
  };
}

function interpolatedAnchors(model: CalibrationModel, position: number): {
  black: FloatRgb;
  white: FloatRgb;
} {
  return {
    black: mixRgb(model.left.K, model.right.K, position),
    white: mixRgb(model.left.W, model.right.W, position),
  };
}

function resolveProfile(
  id: number,
  profiles: readonly Color4Profile[] | undefined,
): Color4Profile | undefined {
  if (profiles === undefined || profiles === COLOR4_PROFILES) return getColor4Profile(id);
  return profiles.find((profile) => profile.id === id);
}

function resolveThresholds(
  overrides: Partial<ClassifierThresholds> | undefined,
): ClassifierThresholds {
  const requestedFiducialErrors =
    overrides?.maximumFiducialErrors ?? DEFAULT_CLASSIFIER_THRESHOLDS.maximumFiducialErrors;
  const maximumFiducialErrors = Number.isNaN(requestedFiducialErrors)
    ? DEFAULT_CLASSIFIER_THRESHOLDS.maximumFiducialErrors
    : Math.max(0, Math.min(COLOR4_MAX_FIDUCIAL_ERRORS, requestedFiducialErrors));
  const minimumBootstrapDifferentialLuma = normalizeLumaThreshold(
    overrides?.minimumBootstrapDifferentialLuma,
    DEFAULT_CLASSIFIER_THRESHOLDS.minimumBootstrapDifferentialLuma,
  );
  const minimumTimingRailContrastLuma = normalizeLumaThreshold(
    overrides?.minimumTimingRailContrastLuma,
    DEFAULT_CLASSIFIER_THRESHOLDS.minimumTimingRailContrastLuma,
  );
  return {
    ...DEFAULT_CLASSIFIER_THRESHOLDS,
    ...overrides,
    maximumFiducialErrors,
    minimumBootstrapDifferentialLuma,
    minimumTimingRailContrastLuma,
  };
}

function observeBinaryAnchors(anchors: BinaryAnchors): BinaryAnchorObservation {
  return Object.freeze({
    black: anchors.black,
    white: anchors.white,
    contrast: anchors.white - anchors.black,
  });
}

function observeBinaryAnchorsByFiducial(
  anchors: BinaryAnchorsByFiducial,
): Readonly<Record<FiducialId, BinaryAnchorObservation>> {
  return Object.freeze({
    TL: observeBinaryAnchors(anchors.TL),
    TR: observeBinaryAnchors(anchors.TR),
    BR: observeBinaryAnchors(anchors.BR),
    BL: observeBinaryAnchors(anchors.BL),
  });
}

/**
 * Decode a square, orientation-correct, homography-normalized COLOR_4 raster.
 * Camera location and perspective recovery intentionally live outside this
 * pure routine. The returned erasure indices feed unwrapColor4Frame directly.
 */
export function decodeCanonicalColor4Raster(
  image: CanonicalRasterImage,
  options: DecodeCanonicalRasterOptions = {},
): CanonicalRasterResult {
  const values = diagnostics();
  const observing = options.observer !== undefined;
  const thresholds = resolveThresholds(options.thresholds);
  const observedThresholds = observing ? Object.freeze({ ...thresholds }) : thresholds;
  const observingDetail = observing && options.observerDetail === true;
  let observedBootstrapBytes: readonly [number, number, number] | undefined;
  let observedBootstrapCrc: Readonly<{ expected: number; observed: number }> | undefined;
  let stageStartedAt = observing ? readClock(options.clock) : 0;
  const finishGeometry = (
    outcome: "completed" | "rejected",
    reason?: CanonicalRasterRejectReason,
    anchors?: BinaryAnchors,
    anchorsByFiducial?: BinaryAnchorsByFiducial,
  ): void => {
    if (!observing) return;
    const timing = elapsedSince(options.clock, stageStartedAt);
    notifyObserver(options.observer, {
      stage: "canonicalGeometry",
      durationMs: timing.durationMs,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      diagnostics: freezeDiagnostics(values),
      image: Object.freeze({ width: image.width, height: image.height }),
      thresholds: observedThresholds,
      ...(anchors === undefined
        ? {}
        : {
            binaryAnchors: observeBinaryAnchors(anchors),
          }),
      ...(anchorsByFiducial === undefined
        ? {}
        : { binaryAnchorsByFiducial: observeBinaryAnchorsByFiducial(anchorsByFiducial) }),
    });
    stageStartedAt = readClock(options.clock);
  };
  const finishBootstrap = (
    outcome: "completed" | "rejected",
    reason: CanonicalRasterRejectReason | undefined,
    bootstrap: BootstrapFields | undefined,
    topPhase?: 0 | 1 | 2 | 3 | null,
    bottomPhase?: 0 | 1 | 2 | 3 | null,
  ): void => {
    if (!observing) return;
    const timing = elapsedSince(options.clock, stageStartedAt);
    notifyObserver(options.observer, {
      stage: "bootstrapPhase",
      durationMs: timing.durationMs,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      diagnostics: freezeDiagnostics(values),
      ...(bootstrap === undefined ? {} : { bootstrap }),
      ...(observingDetail && observedBootstrapBytes !== undefined
        ? { bootstrapBytes: observedBootstrapBytes }
        : {}),
      ...(observingDetail && observedBootstrapCrc !== undefined
        ? { bootstrapCrc: observedBootstrapCrc }
        : {}),
      ...(topPhase === undefined ? {} : { topPhase }),
      ...(bottomPhase === undefined ? {} : { bottomPhase }),
    });
    stageStartedAt = readClock(options.clock);
  };
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.width !== image.height ||
    image.width % TOTAL_MODULES !== 0 ||
    image.pixels.length < image.width * image.height * 4
  ) {
    finishGeometry("rejected", "invalid_dimensions");
    return rejected("invalid_dimensions", values);
  }
  const scale = image.width / TOTAL_MODULES;
  values.moduleScale = scale;
  const sampler = createSampler(image, scale);
  const collectedAnchors = collectBinaryAnchors(sampler);
  const anchors = createSpatialBinaryAnchorModel(collectedAnchors.byFiducial);
  const rgbAnchors = createSpatialRgbBinaryAnchorModel(collectedAnchors.rgbByFiducial);
  if (anchors === null || rgbAnchors === null) {
    finishGeometry(
      "rejected",
      "invalid_geometry",
      collectedAnchors.pooled,
      collectedAnchors.byFiducial,
    );
    return rejected("invalid_geometry", values);
  }
  const fiducialErrors = countFiducialErrors(sampler, anchors);
  values.fiducialErrors = fiducialErrors.total;
  values.fiducialErrorsById = fiducialErrors.byId;
  values.fiducialErrorMax = fiducialErrors.maximum;
  const quietZone = countQuietZoneErrors(sampler, anchors, rgbAnchors);
  values.quietZoneErrors = quietZone.combined;
  values.quietZoneLumaErrors = quietZone.luma;
  values.quietZoneRgbErrors = quietZone.rgb;
  if (
    values.fiducialErrorMax > thresholds.maximumFiducialErrors ||
    values.quietZoneErrors > MAXIMUM_QUIET_ZONE_ERRORS
  ) {
    finishGeometry(
      "rejected",
      "invalid_geometry",
      collectedAnchors.pooled,
      anchors.byFiducial,
    );
    return rejected("invalid_geometry", values);
  }
  finishGeometry("completed", undefined, collectedAnchors.pooled, anchors.byFiducial);

  const bootstrapRect: ModuleRect = {
    x: (ACTIVE_MODULES - BOOTSTRAP_COLUMNS) / 2,
    y: 14,
    width: BOOTSTRAP_COLUMNS,
    height: BOOTSTRAP_ROWS,
  };
  const bootstrapSampling = sampleDifferentialBootstrap(
    sampleLuminanceRect(sampler, bootstrapRect),
    thresholds.minimumBootstrapDifferentialLuma,
  );
  values.bootstrapSampling = bootstrapSampling.diagnostics;
  if (observingDetail && bootstrapSampling.decidedBytes !== undefined) {
    observedBootstrapBytes = bootstrapSampling.decidedBytes;
    observedBootstrapCrc = Object.freeze({
      expected: crc8Atm(Uint8Array.from(bootstrapSampling.decidedBytes.slice(0, 2))),
      observed: bootstrapSampling.decidedBytes[2],
    });
  }
  const bootstrap = decodeBootstrap(bootstrapSampling.modules);
  if (bootstrap === null) {
    finishBootstrap("rejected", "invalid_bootstrap", undefined);
    return rejected("invalid_bootstrap", values);
  }
  if (bootstrap.version !== PHY_VERSION) {
    finishBootstrap("rejected", "unsupported_version", bootstrap);
    return rejected("unsupported_version", values);
  }
  const profile = resolveProfile(bootstrap.profileId, options.profiles);
  if (profile === undefined) {
    finishBootstrap("rejected", "unsupported_profile", bootstrap);
    return rejected("unsupported_profile", values);
  }
  const palette = getColor4Palette(bootstrap.paletteId);
  if (palette === undefined) {
    finishBootstrap("rejected", "unsupported_palette", bootstrap);
    return rejected("unsupported_palette", values);
  }
  const paletteId = palette.id;
  const layout = createPhysicalLayout(profile);

  const timing = evaluateTimingRails(
    sampler,
    layout,
    thresholds.minimumTimingRailContrastLuma,
  );
  values.timingErrors = timing.errors;
  values.timingUncertainModules = timing.uncertainModules;
  values.timingModules = timing.modules;
  values.timingRails = observeTimingRails(timing.rails);
  if (
    !timing.allRailsValid ||
    timing.errors / timing.modules > thresholds.maximumTimingErrorRate
  ) {
    finishBootstrap("rejected", "invalid_geometry", bootstrap);
    return rejected("invalid_geometry", values);
  }

  const topPhase = decodePhasePilot(
    sampleRectWithRailModel(sampler, layout.phasePilots.top, timing.rails.top),
  );
  const bottomPhase = decodePhasePilot(
    sampleRectWithRailModel(sampler, layout.phasePilots.bottom, timing.rails.bottom),
  );
  if (
    topPhase === null ||
    bottomPhase === null ||
    topPhase !== bottomPhase ||
    topPhase !== bootstrap.sequencePhase
  ) {
    finishBootstrap("rejected", "phase_mismatch", bootstrap, topPhase, bottomPhase);
    return rejected("phase_mismatch", values);
  }
  finishBootstrap("completed", undefined, bootstrap, topPhase, bottomPhase);

  // From here on the colour stage works from an ISI-corrected view of the
  // frame. Geometry above this point deliberately keeps the raw samples.
  const isiStrength = estimateIsiStrength(sampler);
  const latticeBounds = colourLatticeBounds(layout);
  const colourSampler = isiStrength <= 0 ? sampler : createLatticeSampler(
    sampler,
    deconvolveModuleLattice(
      sampleModuleLattice(
        sampler,
        latticeBounds.x,
        latticeBounds.y,
        latticeBounds.width,
        latticeBounds.height,
      ),
      isiStrength,
    ),
  );
  values.isiStrength = isiStrength;

  const model = buildCalibration(colourSampler, layout, paletteId);
  values.calibrationMad = model.mad;
  values.observedContrast = model.contrast;
  values.minimumPaletteDistance = model.minimumPaletteDistance;
  const calibrationRejected =
    model.contrast < thresholds.minimumContrast ||
    model.minimumPaletteDistance < thresholds.minimumPaletteDistance;
  if (observing) {
    const calibrationTiming = elapsedSince(options.clock, stageStartedAt);
    notifyObserver(options.observer, {
      stage: "calibration",
      durationMs: calibrationTiming.durationMs,
      outcome: calibrationRejected ? "rejected" : "completed",
      ...(calibrationRejected ? { reason: "calibration_failed" as const } : {}),
      diagnostics: freezeDiagnostics(values),
      detailIncluded: observingDetail,
      ...(observingDetail
        ? {
            left: observeCalibrationBank(model.left, model.leftMad),
            right: observeCalibrationBank(model.right, model.rightMad),
          }
        : {}),
      thresholds: Object.freeze({
        minimumContrast: thresholds.minimumContrast,
        minimumPaletteDistance: thresholds.minimumPaletteDistance,
      }),
    });
    stageStartedAt = readClock(options.clock);
  }
  if (calibrationRejected) {
    return rejected("calibration_failed", values);
  }

  const dynamicMaximumDeltaE = Math.min(
    45,
    Math.max(thresholds.maximumDeltaE, thresholds.maximumDeltaE + model.mad * 6),
  );
  const dynamicMinimumGap = Math.max(thresholds.minimumDeltaEGap, model.mad * 2 + 4);
  values.effectiveMaximumDeltaE = dynamicMaximumDeltaE;
  values.effectiveMinimumDeltaEGap = dynamicMinimumGap;
  const codedBytes = new Uint8Array(profile.codedBytes);
  const erasures: number[] = [];
  const erasureCandidates: Color4ByteErasureCandidate[] = [];
  const erasureCandidateScores: number[] = [];
  const erasuresByShard = Array<number>(profile.shards).fill(0);
  const uncertainCellsByRow = Array<number>(profile.rows).fill(0);
  const uncertainCellsByColumn = Array<number>(profile.columns).fill(0);
  const bestDeltaEValues: number[] = [];
  const deltaEGapValues: number[] = [];
  const observedCells: RankedCellBuffer | undefined = !observingDetail
    ? undefined
    : { entries: [], leastIndex: 0, leastScore: Number.POSITIVE_INFINITY };
  let clippedChannels = 0;
  let cell = 0;
  let totalBestDeltaE = 0;

  // Sample every cell once. The field is then classified more than once — first
  // to label it, then against centroids re-estimated from those labels — and
  // re-reading pixels for each pass would cost more than the refinement saves.
  const cellCount = profile.columns * profile.rows;
  const cellRaw: FloatRgb[] = new Array<FloatRgb>(cellCount);
  const cellNormalized: FloatRgb[] = new Array<FloatRgb>(cellCount);
  const cellLab: LabColor[] = new Array<LabColor>(cellCount);
  const cellPosition = new Float64Array(cellCount);
  for (let index = 0; index < cellCount; index++) {
    const column = index % profile.columns;
    const row = (index - column) / profile.columns;
    const position = profile.columns === 1 ? 0.5 : column / (profile.columns - 1);
    const raw = colourSampler.sampleActive(layout.data.x + column, layout.data.y + row);
    const cellAnchors = interpolatedAnchors(model, position);
    const normalized = normalizedWithAnchors(raw, cellAnchors.black, cellAnchors.white);
    cellRaw[index] = raw;
    cellNormalized[index] = normalized;
    cellLab[index] = normalizedRgbToLab(normalized);
    cellPosition[index] = position;
  }

  const swatchCentroids: CentroidField = (position) =>
    [0, 1, 2, 3].map((candidate) =>
      normalizedRgbToLab(targetAt(model, paletteId, candidate, position)),
    );
  let centroidsAt = swatchCentroids;
  // The swatches remain the reference until a refinement demonstrably beats
  // them. Refining collapses each class to two half-medians, which discards any
  // vertical structure the vertically-distributed swatches carry, so on a frame
  // whose palette is already well described this trade is a loss. Measuring it
  // rather than assuming it keeps the change strictly non-regressive.
  let bestFit = meanWinningDistance(cellLab, cellPosition, centroidsAt);
  const labels = new Uint8Array(cellCount);
  const positions = Array.from(cellPosition);
  for (let pass = 0; pass < DECISION_DIRECTED_PASSES; pass++) {
    for (let index = 0; index < cellCount; index++) {
      labels[index] = nearestCentroid(cellLab[index]!, centroidsAt(cellPosition[index]!)).dibit;
    }
    const refined = refineCentroids(labels, cellLab, positions);
    if (refined === undefined) break;
    const fit = meanWinningDistance(cellLab, cellPosition, refined);
    if (fit >= bestFit) break;
    bestFit = fit;
    centroidsAt = refined;
  }

  for (let byteIndex = 0; byteIndex < codedBytes.length; byteIndex++) {
    let byte = 0;
    let byteErased = false;
    let byteErasureScore = 0;
    for (let dibitIndex = 0; dibitIndex < 4; dibitIndex++) {
      const column = cell % profile.columns;
      const row = Math.floor(cell / profile.columns);
      const position = cellPosition[cell]!;
      const raw = cellRaw[cell]!;
      const normalized = cellNormalized[cell]!;
      const nearest = nearestCentroid(cellLab[cell]!, centroidsAt(position));
      const classified: LabClassification = {
        dibit: nearest.dibit,
        erased: nearest.bestDeltaE > dynamicMaximumDeltaE ||
          nearest.secondDeltaE - nearest.bestDeltaE < dynamicMinimumGap,
        bestDeltaE: nearest.bestDeltaE,
        secondDeltaE: nearest.secondDeltaE,
      };
      const deltaEGap = classified.secondDeltaE - classified.bestDeltaE;
      const distanceRejected = classified.bestDeltaE > dynamicMaximumDeltaE;
      const gapRejected = deltaEGap < dynamicMinimumGap;
      const erasureScore = cellErasureCandidateScore(
        classified.bestDeltaE,
        deltaEGap,
        dynamicMaximumDeltaE,
        dynamicMinimumGap,
      );
      byteErasureScore = Math.max(byteErasureScore, erasureScore);
      byte = (byte << 2) | classified.dibit;
      if (classified.erased) {
        byteErased = true;
        values.uncertainCells++;
        uncertainCellsByRow[row] = (uncertainCellsByRow[row] ?? 0) + 1;
        uncertainCellsByColumn[column] = (uncertainCellsByColumn[column] ?? 0) + 1;
      }
      if (distanceRejected) values.distanceRejectedCells++;
      if (gapRejected) values.gapRejectedCells++;
      if (distanceRejected && gapRejected) values.bothRejectedCells++;
      if (observing) {
        const clipped = rawClippedChannels(raw);
        clippedChannels += clipped;
        if (observedCells !== undefined) {
          const score = cellObservationScore(
            classified.erased,
            classified.bestDeltaE,
            deltaEGap,
            dynamicMinimumGap,
          );
          retainWorstCell(observedCells, score, () => Object.freeze({
            cellIndex: cell,
            byteIndex,
            dibitIndex: dibitIndex as 0 | 1 | 2 | 3,
            column,
            row,
            raw: cloneRgb(raw),
            normalized: cloneRgb(normalized),
            dibit: classified.dibit,
            erased: classified.erased,
            bestDeltaE: classified.bestDeltaE,
            secondDeltaE: classified.secondDeltaE,
            deltaEGap,
            clippedChannels: clipped,
          }));
        }
      }
      totalBestDeltaE += classified.bestDeltaE;
      bestDeltaEValues.push(classified.bestDeltaE);
      deltaEGapValues.push(deltaEGap);
      values.maximumBestDeltaE = Math.max(values.maximumBestDeltaE, classified.bestDeltaE);
      cell++;
    }
    codedBytes[byteIndex] = byte;
    if (byteErased) {
      erasures.push(byteIndex);
      erasureCandidates.push(Object.freeze({ index: byteIndex, score: byteErasureScore }));
      erasureCandidateScores.push(byteErasureScore);
      const shard = shardPosition(byteIndex, profile.shards).shard;
      erasuresByShard[shard] = (erasuresByShard[shard] ?? 0) + 1;
    }
  }

  values.erasureBytes = erasures.length;
  values.erasuresByShard = erasuresByShard;
  values.parityByShard = profile.rsN - profile.rsK;
  values.remainingErasureBudgetByShard = erasuresByShard.map(
    (count) => values.parityByShard - count,
  );
  values.uncertainCellsByRow = uncertainCellsByRow;
  values.uncertainCellsByColumn = uncertainCellsByColumn;
  values.bestDeltaE = classifierDistribution(bestDeltaEValues);
  values.deltaEGap = classifierDistribution(deltaEGapValues);
  values.erasureCandidateScore = classifierDistribution(erasureCandidateScores);
  values.meanBestDeltaE = totalBestDeltaE / bestDeltaEValues.length;
  assertCompletedClassificationDiagnostics(values, profile);
  const classificationTiming = observing
    ? elapsedSince(options.clock, stageStartedAt)
    : { endedAt: 0, durationMs: 0 };
  const cells = Object.freeze(
    (observedCells?.entries ?? [])
      .sort((left, right) => right.score - left.score)
      .map(({ observation }) => observation),
  );
  notifyObserver(options.observer, {
    stage: "classification",
    durationMs: classificationTiming.durationMs,
    outcome: "completed",
    diagnostics: freezeDiagnostics(values),
    detailIncluded: observingDetail,
    effectiveThresholds: Object.freeze({
      maximumDeltaE: dynamicMaximumDeltaE,
      minimumDeltaEGap: dynamicMinimumGap,
    }),
    clippedChannels,
    cells,
  });
  return Object.freeze({
    status: "valid",
    profile,
    paletteId,
    sequencePhase: bootstrap.sequencePhase,
    codedBytes,
    byteErasures: Uint16Array.from(erasures),
    byteErasureCandidates: Object.freeze(erasureCandidates),
    diagnostics: freezeDiagnostics(values),
  });
}
