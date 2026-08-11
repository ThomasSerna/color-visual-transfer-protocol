import type {
  BrowserCarrierDiagnostics,
  BrowserVisionDiagnostics,
  CarrierId,
  VisionDetectionDiagnostics,
  VisionTimingKey,
} from "./carrier";

const DATABASE = "decimen-experiments";
const VERSION = 1;
const PREFERENCES = "preferences";
const RUNS = "runs";
const MAX_STORED_RUNS = 100;

export type ExperimentDirection = "send" | "receive";

/** Capture-quality classes are diagnostic policy, not protocol outcomes. */
export type CaptureQualityClass = "UNKNOWN" | "UNUSABLE" | "BORDERLINE" | "GOOD";

export interface TimingDistribution {
  readonly count: number;
  readonly average: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
}

export interface VisionExperimentConditions {
  readonly label?: string;
  readonly expectedTxFps?: 1 | 2 | 5 | 10;
  readonly expectedProfile?: "ROBUST" | "EXPERIMENTAL";
  readonly prefilterMode?: "observe" | "enabled";
  readonly distanceM?: 0.3 | 0.5 | 1;
  readonly angleDeg?: 0 | 15;
  readonly brightness?: "high" | "maximum";
}

export interface VisionExperimentSummary {
  readonly debugEnabled: boolean;
  readonly configuration?: Readonly<{
    canonicalScale: 4 | 6 | 8;
    detectionDimension: 960 | 1280 | "source";
  }>;
  readonly conditions?: VisionExperimentConditions;
  readonly rejectReasons: Readonly<Record<string, number>>;
  readonly stageRejections: Readonly<Record<string, number>>;
  readonly detection: Readonly<{
    contours: number;
    areaTooSmall: number;
    areaTooLarge: number;
    nonQuads: number;
    nonConvex: number;
    quads: number;
    /** Absent in schema-v1 records written before multi-pass detection. */
    mergedCandidates?: number;
    candidateCountRaw?: number;
    candidateCountRanked?: number;
    decodedMarkers: number;
    /** Absent in schema-v1 records written before the fiducial contrast gate. */
    lowContrastCandidates?: number;
    uniqueFiducials: number;
    duplicateIds: number;
    ambiguousCandidates: number;
    tooManyErrorCandidates: number;
    decodeFailures: number;
  }>;
  /** Canonical errors when available; detector Hamming errors otherwise. */
  readonly fiducials: Readonly<Record<"TL" | "TR" | "BR" | "BL", Readonly<{
    observations: number;
    found: number;
    errorSamples: number;
    averageErrors: number;
    maximumErrors: number;
  }>>>;
  readonly timingsMs: Readonly<Partial<Record<VisionTimingKey, TimingDistribution>>>;
  readonly warnings?: Readonly<Record<string, number>>;
  readonly optical?: Readonly<Partial<Record<
    keyof NonNullable<BrowserVisionDiagnostics["optical"]>,
    TimingDistribution
  >>>;
  /**
   * Derived only when both worker timing samples and an expected transmitter
   * rate are available. Absent in older schema-v1 records.
   */
  readonly workerP95ExceedsTxFrameInterval?: boolean;
  /** Absent in schema-v1 records written before homography instrumentation. */
  readonly homography?: Readonly<{
    methods: Readonly<Record<string, number>>;
    refinementAttempts: number;
    refinementsApplied: number;
    residualRmsModules: TimingDistribution;
    residualMaxModules: TimingDistribution;
    refinementResidualBeforeRmsModules: TimingDistribution;
    refinementResidualAfterRmsModules: TimingDistribution;
  }>;
}

export interface ExperimentSummary {
  schemaVersion: 1;
  startedAt: string;
  finishedAt?: string;
  direction: ExperimentDirection;
  carrier: CarrierId;
  profile?: string;
  success: boolean;
  elapsedMs: number;
  payloadBytes?: number;
  cameraWidth?: number;
  cameraHeight?: number;
  cameraFps?: number;
  captures: number;
  /** COLOR_4 capture-prefilter telemetry; absent in older schema-v1 records. */
  stableCaptures?: number;
  unstableCaptures?: number;
  stabilityWarmupCaptures?: number;
  visionSubmissions?: number;
  skippedUnstable?: number;
  skippedRedundantStable?: number;
  /** Bounded distribution of normalized inter-frame difference scores. */
  stabilityScore?: TimingDistribution;
  qualityClassCounts?: Readonly<Record<CaptureQualityClass, number>>;
  skippedWhileBusy: number;
  carrierAttempts: number;
  candidates: number;
  geometryRejections: number;
  bootstrapRejections: number;
  calibrationRejections: number;
  uncertainCells: number;
  rsCorrectedSymbols: number;
  rsFailures: number;
  crcFailures: number;
  validFrames: number;
  newFrames: number;
  duplicateFrames: number;
  resolvedBlocks: number;
  carrierRejected: number;
  erasureBytes: number;
  /** Distribution of erasure bytes per carrier attempt; absent in legacy records. */
  erasureBytesPerAttempt?: TimingDistribution;
  decodeLatencyMs: TimingDistribution;
  vision?: VisionExperimentSummary;
  containerBitrateBps?: number;
  fileGoodputBps?: number;
  failureReason?: string;
}

export interface ExperimentExport {
  schema: "decimen-experiment-export";
  version: 1;
  exportedAt: string;
  current?: ExperimentSummary;
  history: ExperimentSummary[];
}

/**
 * A worker that takes longer than one transmitted-frame interval cannot keep
 * pace with every distinct sender frame. Invalid or unavailable inputs are
 * deliberately non-warning so optional diagnostics never break a transfer.
 */
export function workerP95ExceedsTxFrameInterval(
  workerP95Ms: number | undefined,
  expectedTxFps: number | undefined,
): boolean {
  return workerP95Ms !== undefined &&
    expectedTxFps !== undefined &&
    Number.isFinite(workerP95Ms) &&
    Number.isFinite(expectedTxFps) &&
    workerP95Ms >= 0 &&
    expectedTxFps > 0 &&
    workerP95Ms > 1_000 / expectedTxFps;
}

export class ExperimentMetrics {
  readonly startedAt = new Date().toISOString();
  readonly startedAtMs: number;
  captures = 0;
  stableCaptures = 0;
  unstableCaptures = 0;
  stabilityWarmupCaptures = 0;
  visionSubmissions = 0;
  skippedUnstable = 0;
  skippedRedundantStable = 0;
  skippedWhileBusy = 0;
  carrierAttempts = 0;
  candidates = 0;
  geometryRejections = 0;
  bootstrapRejections = 0;
  calibrationRejections = 0;
  uncertainCells = 0;
  rsCorrectedSymbols = 0;
  rsFailures = 0;
  crcFailures = 0;
  validFrames = 0;
  carrierRejected = 0;
  erasureBytes = 0;
  private readonly latencySamples: number[] = [];
  private readonly erasureSamples: number[] = [];
  private readonly stabilityScoreSamples: number[] = [];
  private readonly qualityClassCounts: Record<CaptureQualityClass, number> = {
    UNKNOWN: 0,
    UNUSABLE: 0,
    BORDERLINE: 0,
    GOOD: 0,
  };
  private visionSeen = false;
  private visionDebugEnabled = false;
  private visionConfiguration: VisionExperimentSummary["configuration"];
  private visionConditions: VisionExperimentConditions | undefined;
  private readonly visionRejectReasons = new Map<string, number>();
  private readonly visionStageRejections = new Map<string, number>();
  private readonly visionWarnings = new Map<string, number>();
  private readonly visionTimings = new Map<VisionTimingKey, number[]>();
  private readonly visionOptical = new Map<
    keyof NonNullable<BrowserVisionDiagnostics["optical"]>,
    number[]
  >();
  private readonly visionDetection: Record<
    | "contours"
    | "areaTooSmall"
    | "areaTooLarge"
    | "nonQuads"
    | "nonConvex"
    | "quads"
    | "mergedCandidates"
    | "candidateCountRaw"
    | "candidateCountRanked"
    | "decodedMarkers"
    | "lowContrastCandidates"
    | "uniqueFiducials"
    | "duplicateIds"
    | "ambiguousCandidates"
    | "tooManyErrorCandidates"
    | "decodeFailures",
    number
  > = {
    contours: 0,
    areaTooSmall: 0,
    areaTooLarge: 0,
    nonQuads: 0,
    nonConvex: 0,
    quads: 0,
    mergedCandidates: 0,
    candidateCountRaw: 0,
    candidateCountRanked: 0,
    decodedMarkers: 0,
    lowContrastCandidates: 0,
    uniqueFiducials: 0,
    duplicateIds: 0,
    ambiguousCandidates: 0,
    tooManyErrorCandidates: 0,
    decodeFailures: 0,
  };
  private readonly visionFiducials = {
    TL: { observations: 0, found: 0, errorSamples: 0, totalErrors: 0, maximumErrors: 0 },
    TR: { observations: 0, found: 0, errorSamples: 0, totalErrors: 0, maximumErrors: 0 },
    BR: { observations: 0, found: 0, errorSamples: 0, totalErrors: 0, maximumErrors: 0 },
    BL: { observations: 0, found: 0, errorSamples: 0, totalErrors: 0, maximumErrors: 0 },
  };
  private readonly homographyMethods = new Map<string, number>();
  private homographyRefinementAttempts = 0;
  private homographyRefinementsApplied = 0;
  private readonly homographyResidualRms: number[] = [];
  private readonly homographyResidualMax: number[] = [];
  private readonly refinementResidualBeforeRms: number[] = [];
  private readonly refinementResidualAfterRms: number[] = [];

  constructor(
    readonly direction: ExperimentDirection,
    readonly carrier: CarrierId,
    public profile?: string,
    now = Date.now(),
  ) {
    this.startedAtMs = now;
  }

  recordCapture(): void {
    this.captures++;
  }

  recordStableCapture(stabilityScore?: number): void {
    this.stableCaptures++;
    this.recordStabilityScore(stabilityScore);
  }

  recordUnstableCapture(stabilityScore?: number): void {
    this.unstableCaptures++;
    this.recordStabilityScore(stabilityScore);
  }

  recordStabilityWarmupCapture(): void {
    this.stabilityWarmupCaptures++;
  }

  recordVisionSubmission(): void {
    this.visionSubmissions++;
  }

  recordSkippedUnstable(): void {
    this.skippedUnstable++;
  }

  recordSkippedRedundantStable(): void {
    this.skippedRedundantStable++;
  }

  recordQualityClass(qualityClass: CaptureQualityClass): void {
    this.qualityClassCounts[qualityClass]++;
  }

  recordSkippedWhileBusy(): void {
    this.skippedWhileBusy++;
  }

  private recordStabilityScore(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value)) return;
    this.pushBounded(this.stabilityScoreSamples, Math.min(1, Math.max(0, value)));
  }

  setProfile(profile: string | undefined): void {
    if (profile) this.profile = profile;
  }

  setVisionContext(input: {
    debugEnabled: boolean;
    canonicalScale: 4 | 6 | 8;
    detectionDimension: 960 | 1280 | "source";
    conditions?: VisionExperimentConditions;
  }): void {
    this.visionSeen = true;
    this.visionDebugEnabled ||= input.debugEnabled;
    this.visionConfiguration = {
      canonicalScale: input.canonicalScale,
      detectionDimension: input.detectionDimension,
    };
    this.visionConditions = input.conditions;
  }

  recordAttempt(status: "valid" | "rejected", diagnostics?: BrowserCarrierDiagnostics): void {
    this.carrierAttempts++;
    this.candidates += diagnostics?.candidates ?? 0;
    this.uncertainCells += diagnostics?.uncertainCells ?? 0;
    this.rsCorrectedSymbols += diagnostics?.rsCorrectedSymbols ?? 0;
    this.rsFailures += diagnostics?.rsFailures ?? 0;
    this.crcFailures += diagnostics?.crcFailures ?? 0;
    this.erasureBytes += diagnostics?.erasureBytes ?? 0;
    this.pushBounded(this.erasureSamples, Math.max(0, diagnostics?.erasureBytes ?? 0));
    if (status === "valid") this.validFrames++;
    else {
      this.carrierRejected++;
      if (diagnostics?.stage === "geometry") this.geometryRejections++;
      else if (diagnostics?.stage === "bootstrap") this.bootstrapRejections++;
      else if (diagnostics?.stage === "calibration") this.calibrationRejections++;
    }
    if (diagnostics?.decodeMs !== undefined && Number.isFinite(diagnostics.decodeMs)) {
      // A bounded deterministic reservoir: recent latency is more useful than
      // an unbounded list in a long-running optical experiment.
      if (this.latencySamples.length === 256) this.latencySamples.shift();
      this.latencySamples.push(Math.max(0, diagnostics.decodeMs));
    }
    if (diagnostics?.vision) this.recordVision(status, diagnostics, diagnostics.vision);
  }

  private recordVision(
    status: "valid" | "rejected",
    diagnostics: BrowserCarrierDiagnostics,
    vision: BrowserVisionDiagnostics,
  ): void {
    this.visionSeen = true;
    this.visionDebugEnabled ||= vision.debugEnabled === true;
    if (vision.canonicalScale !== undefined && vision.detectionDimension !== undefined) {
      this.visionConfiguration = {
        canonicalScale: vision.canonicalScale,
        detectionDimension: vision.detectionDimension,
      };
    }
    if (status === "rejected") {
      const reason = vision.diagnosticReason ?? vision.rejectReason ?? diagnostics.rejectReason ?? "unknown";
      this.increment(this.visionRejectReasons, reason);
      this.increment(this.visionStageRejections, diagnostics.stage ?? "unknown");
    }
    this.addDetection(vision.detection);
    for (const warning of vision.warnings ?? []) this.increment(this.visionWarnings, warning);
    if (vision.optical) {
      for (const [key, raw] of Object.entries(vision.optical) as Array<
        [keyof NonNullable<BrowserVisionDiagnostics["optical"]>, number]
      >) {
        if (!Number.isFinite(raw)) continue;
        let samples = this.visionOptical.get(key);
        if (!samples) {
          samples = [];
          this.visionOptical.set(key, samples);
        }
        this.pushBounded(samples, Math.max(0, raw));
      }
    }
    if (vision.homography) {
      this.increment(this.homographyMethods, vision.homography.method);
      if (vision.homography.refinementAttempted) this.homographyRefinementAttempts++;
      if (vision.homography.refinementApplied) this.homographyRefinementsApplied++;
      if (vision.homography.residualRmsModules !== undefined &&
          Number.isFinite(vision.homography.residualRmsModules)) {
        this.pushBounded(this.homographyResidualRms, Math.max(0, vision.homography.residualRmsModules));
      }
      if (vision.homography.residualMaxModules !== undefined &&
          Number.isFinite(vision.homography.residualMaxModules)) {
        this.pushBounded(this.homographyResidualMax, Math.max(0, vision.homography.residualMaxModules));
      }
      if (vision.homography.refinementResidualBeforeRmsModules !== undefined &&
          Number.isFinite(vision.homography.refinementResidualBeforeRmsModules)) {
        this.pushBounded(
          this.refinementResidualBeforeRms,
          Math.max(0, vision.homography.refinementResidualBeforeRmsModules),
        );
      }
      if (vision.homography.refinementResidualAfterRmsModules !== undefined &&
          Number.isFinite(vision.homography.refinementResidualAfterRmsModules)) {
        this.pushBounded(
          this.refinementResidualAfterRms,
          Math.max(0, vision.homography.refinementResidualAfterRmsModules),
        );
      }
    }
    const canonicalFiducialErrors = vision.canonical?.fiducialErrorsById;
    for (const id of ["TL", "TR", "BR", "BL"] as const) {
      const observed = canonicalFiducialErrors === undefined
        ? vision.fiducials?.[id]
        : { found: true, errors: canonicalFiducialErrors[id] };
      if (observed === undefined) continue;
      const aggregate = this.visionFiducials[id];
      aggregate.observations++;
      if (observed.found) aggregate.found++;
      if (observed.errors !== undefined && Number.isFinite(observed.errors)) {
        const errors = Math.max(0, observed.errors);
        aggregate.errorSamples++;
        aggregate.totalErrors += errors;
        aggregate.maximumErrors = Math.max(aggregate.maximumErrors, errors);
      }
    }
    if (vision.timings) {
      for (const [stage, raw] of Object.entries(vision.timings) as Array<
        [VisionTimingKey, number | undefined]
      >) {
        if (raw === undefined || !Number.isFinite(raw)) continue;
        let samples = this.visionTimings.get(stage);
        if (!samples) {
          samples = [];
          this.visionTimings.set(stage, samples);
        }
        this.pushBounded(samples, Math.max(0, raw));
      }
    }
  }

  private increment(values: Map<string, number>, key: string): void {
    values.set(key, (values.get(key) ?? 0) + 1);
  }

  private pushBounded(values: number[], value: number): void {
    if (values.length === 256) values.shift();
    values.push(value);
  }

  private addDetection(detection: VisionDetectionDiagnostics | undefined): void {
    if (!detection) return;
    for (const key of Object.keys(this.visionDetection) as Array<keyof typeof this.visionDetection>) {
      const value = detection[key];
      if (value !== undefined && Number.isFinite(value)) this.visionDetection[key] += value;
    }
  }

  snapshot(input: {
    success: boolean;
    now?: number;
    payloadBytes?: number;
    newFrames?: number;
    duplicateFrames?: number;
    resolvedBlocks?: number;
    cameraWidth?: number;
    cameraHeight?: number;
    cameraFps?: number;
    failureReason?: string;
    fileBytes?: number;
  }): ExperimentSummary {
    const now = input.now ?? Date.now();
    const elapsedMs = Math.max(0, now - this.startedAtMs);
    const decodeLatencyMs = distribution(this.latencySamples);
    const color4CaptureTelemetry = this.carrier !== "COLOR_4"
      ? {}
      : {
          stableCaptures: this.stableCaptures,
          unstableCaptures: this.unstableCaptures,
          stabilityWarmupCaptures: this.stabilityWarmupCaptures,
          visionSubmissions: this.visionSubmissions,
          skippedUnstable: this.skippedUnstable,
          skippedRedundantStable: this.skippedRedundantStable,
          stabilityScore: distribution(this.stabilityScoreSamples),
          qualityClassCounts: { ...this.qualityClassCounts },
        };
    return {
      schemaVersion: 1,
      startedAt: this.startedAt,
      finishedAt: new Date(now).toISOString(),
      direction: this.direction,
      carrier: this.carrier,
      profile: this.profile,
      success: input.success,
      elapsedMs,
      payloadBytes: input.payloadBytes,
      cameraWidth: input.cameraWidth,
      cameraHeight: input.cameraHeight,
      cameraFps: input.cameraFps,
      captures: this.captures,
      ...color4CaptureTelemetry,
      skippedWhileBusy: this.skippedWhileBusy,
      carrierAttempts: this.carrierAttempts,
      candidates: this.candidates,
      geometryRejections: this.geometryRejections,
      bootstrapRejections: this.bootstrapRejections,
      calibrationRejections: this.calibrationRejections,
      uncertainCells: this.uncertainCells,
      rsCorrectedSymbols: this.rsCorrectedSymbols,
      rsFailures: this.rsFailures,
      crcFailures: this.crcFailures,
      validFrames: this.validFrames,
      newFrames: input.newFrames ?? 0,
      duplicateFrames: input.duplicateFrames ?? 0,
      resolvedBlocks: input.resolvedBlocks ?? 0,
      carrierRejected: this.carrierRejected,
      erasureBytes: this.erasureBytes,
      erasureBytesPerAttempt: distribution(this.erasureSamples),
      decodeLatencyMs,
      vision: this.visionSnapshot(),
      containerBitrateBps:
        input.payloadBytes === undefined || elapsedMs === 0
          ? undefined
          : (input.payloadBytes * 8_000) / elapsedMs,
      fileGoodputBps:
        input.fileBytes === undefined || elapsedMs === 0
          ? undefined
          : (input.fileBytes * 1_000) / elapsedMs,
      failureReason: input.failureReason,
    };
  }


  private visionSnapshot(): VisionExperimentSummary | undefined {
    if (!this.visionSeen) return undefined;
    const timingsMs: Partial<Record<VisionTimingKey, TimingDistribution>> = {};
    for (const [stage, samples] of this.visionTimings) timingsMs[stage] = distribution(samples);
    const workerP95Ms = timingsMs.workerTotal?.p95;
    const expectedTxFps = this.visionConditions?.expectedTxFps;
    const hasWorkerPressureInputs = workerP95Ms !== undefined && expectedTxFps !== undefined;
    const fiducials = Object.fromEntries(
      (["TL", "TR", "BR", "BL"] as const).map((id) => {
        const value = this.visionFiducials[id];
        return [id, {
          observations: value.observations,
          found: value.found,
          errorSamples: value.errorSamples,
          averageErrors: value.errorSamples === 0 ? 0 : value.totalErrors / value.errorSamples,
          maximumErrors: value.maximumErrors,
        }];
      }),
    ) as VisionExperimentSummary["fiducials"];
    const optical = Object.fromEntries(
      [...this.visionOptical].map(([key, samples]) => [key, distribution(samples)]),
    ) as VisionExperimentSummary["optical"];
    return {
      debugEnabled: this.visionDebugEnabled,
      configuration: this.visionConfiguration,
      conditions: this.visionConditions,
      rejectReasons: Object.fromEntries(this.visionRejectReasons),
      stageRejections: Object.fromEntries(this.visionStageRejections),
      detection: { ...this.visionDetection },
      fiducials,
      timingsMs,
      ...(this.visionWarnings.size === 0 ? {} : { warnings: Object.fromEntries(this.visionWarnings) }),
      ...(this.visionOptical.size === 0 ? {} : { optical }),
      ...(hasWorkerPressureInputs
        ? {
            workerP95ExceedsTxFrameInterval: workerP95ExceedsTxFrameInterval(
              workerP95Ms,
              expectedTxFps,
            ),
          }
        : {}),
      homography: {
        methods: Object.fromEntries(this.homographyMethods),
        refinementAttempts: this.homographyRefinementAttempts,
        refinementsApplied: this.homographyRefinementsApplied,
        residualRmsModules: distribution(this.homographyResidualRms),
        residualMaxModules: distribution(this.homographyResidualMax),
        refinementResidualBeforeRmsModules: distribution(this.refinementResidualBeforeRms),
        refinementResidualAfterRmsModules: distribution(this.refinementResidualAfterRms),
      },
    };
  }
}

function distribution(values: readonly number[]): TimingDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const percentile = (position: number): number =>
    sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) * position)]!;
  return {
    count: sorted.length,
    average: sorted.length === 0 ? 0 : total / sorted.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PREFERENCES)) db.createObjectStore(PREFERENCES);
      if (!db.objectStoreNames.contains(RUNS)) {
        db.createObjectStore(RUNS, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    // Metrics must never prevent a transfer from running.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function loadPreference<T>(key: string, fallback: T): Promise<T> {
  const db = await openDatabase();
  if (!db) return fallback;
  return new Promise((resolve) => {
    const transaction = db.transaction(PREFERENCES, "readonly");
    const request = transaction.objectStore(PREFERENCES).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? fallback);
    request.onerror = () => resolve(fallback);
    transaction.oncomplete = () => db.close();
  });
}

export async function savePreference<T>(key: string, value: T): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  const transaction = db.transaction(PREFERENCES, "readwrite");
  transaction.objectStore(PREFERENCES).put(value, key);
  await transactionDone(transaction);
  db.close();
}

export async function saveExperiment(summary: ExperimentSummary): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  const transaction = db.transaction(RUNS, "readwrite");
  const store = transaction.objectStore(RUNS);
  store.add({ ...summary });
  const count = store.count();
  count.onsuccess = () => {
    let remaining = Math.max(0, count.result - MAX_STORED_RUNS);
    if (remaining === 0) return;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item || remaining-- <= 0) return;
      item.delete();
      item.continue();
    };
  };
  await transactionDone(transaction);
  db.close();
}

export async function listExperiments(): Promise<ExperimentSummary[]> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve) => {
    const transaction = db.transaction(RUNS, "readonly");
    const request = transaction.objectStore(RUNS).getAll();
    request.onsuccess = () => {
      const rows = (request.result as Array<ExperimentSummary & { id?: number }>).map(({ id: _, ...run }) => run);
      resolve(rows.reverse());
    };
    request.onerror = () => resolve([]);
    transaction.oncomplete = () => db.close();
  });
}

export async function clearExperiments(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  const transaction = db.transaction(RUNS, "readwrite");
  transaction.objectStore(RUNS).clear();
  await transactionDone(transaction);
  db.close();
}

export function makeExperimentExport(
  history: ExperimentSummary[],
  current?: ExperimentSummary,
  now = new Date(),
): ExperimentExport {
  return {
    schema: "decimen-experiment-export",
    version: 1,
    exportedAt: now.toISOString(),
    current,
    history,
  };
}

export function downloadExperimentExport(data: ExperimentExport): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cvtp-experiments-${data.exportedAt.replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
