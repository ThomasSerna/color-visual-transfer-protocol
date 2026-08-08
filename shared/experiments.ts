import type { BrowserCarrierDiagnostics, CarrierId } from "./carrier";

const DATABASE = "decimen-experiments";
const VERSION = 1;
const PREFERENCES = "preferences";
const RUNS = "runs";
const MAX_STORED_RUNS = 100;

export type ExperimentDirection = "send" | "receive";

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
  decodeLatencyMs: Readonly<{
    count: number;
    average: number;
    min: number;
    max: number;
    p50: number;
  }>;
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

export class ExperimentMetrics {
  readonly startedAt = new Date().toISOString();
  readonly startedAtMs: number;
  captures = 0;
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

  recordSkippedWhileBusy(): void {
    this.skippedWhileBusy++;
  }

  setProfile(profile: string | undefined): void {
    if (profile) this.profile = profile;
  }

  recordAttempt(status: "valid" | "rejected", diagnostics?: BrowserCarrierDiagnostics): void {
    this.carrierAttempts++;
    this.candidates += diagnostics?.candidates ?? 0;
    this.uncertainCells += diagnostics?.uncertainCells ?? 0;
    this.rsCorrectedSymbols += diagnostics?.rsCorrectedSymbols ?? 0;
    this.rsFailures += diagnostics?.rsFailures ?? 0;
    this.crcFailures += diagnostics?.crcFailures ?? 0;
    this.erasureBytes += diagnostics?.erasureBytes ?? 0;
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
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const latencyTotal = sorted.reduce((total, value) => total + value, 0);
    const p50 = sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;
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
      decodeLatencyMs: {
        count: sorted.length,
        average: sorted.length === 0 ? 0 : latencyTotal / sorted.length,
        min: sorted[0] ?? 0,
        max: sorted.at(-1) ?? 0,
        p50,
      },
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
