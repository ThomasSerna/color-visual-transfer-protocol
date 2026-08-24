/**
 * Stage-latency gate for the COLOR_4 receive pipeline.
 *
 * The physical export that motivated this work showed a 1332 ms median worker
 * round trip against a 30 fps camera: the receiver could submit only 7% of its
 * captures, and the transfer starved regardless of how well any single frame
 * decoded. Correctness tests cannot see that — a frame that decodes in two
 * seconds passes every one of them — so latency needs a gate of its own.
 *
 * Budgets here are deliberately loose relative to the measured wins. They exist
 * to catch a regression that reintroduces per-cell transcendental work or a
 * full-frame contour sweep, not to pin a number to this machine's clock speed.
 * CI hardware varies; the ordering claims below do not.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  EXPERIMENTAL_PROFILE,
  ROBUST_PROFILE,
  decodeCanonicalColor4Raster,
  type CanonicalRasterObservation,
} from "../shared/color4/index.ts";
import { normalizeColor4WithOpenCv } from "../receive/color4-vision.ts";
import { loadOpenCvRuntime } from "./helpers/opencv-runtime.ts";
import {
  renderSyntheticCameraFrame,
  type SyntheticCameraCv,
} from "./helpers/color4-synthetic-camera.ts";

const PHYSICAL_FIXTURE = fileURLToPath(
  new URL("./fixtures/color4/physical/capture-000017/raw-frame.png", import.meta.url),
);

/**
 * Repetitions per case. The first pass through OpenCV and the JIT is not
 * representative of the steady state a running receiver sits in, so it is
 * measured and then discarded.
 */
const WARMUP_RUNS = 1;
const MEASURED_RUNS = 3;

interface StageTimings {
  readonly grayscaleMs: number;
  readonly resizeMs: number;
  readonly thresholdMs: number;
  readonly contoursMs: number;
  readonly fiducialDecodeMs: number;
  readonly homographyMs: number;
  readonly refinementMs: number;
  readonly totalMs: number;
}

interface BenchCase {
  readonly name: string;
  readonly visionMs: number;
  readonly classifierMs: number;
  readonly pipelineMs: number;
  readonly visionStatus: string;
  readonly classifierStatus: string;
  readonly stages: StageTimings;
  readonly classifierStages: Readonly<Record<string, number>>;
  readonly contours: number;
  readonly candidates: number;
  readonly pixelsPerModule?: number;
  readonly uncertainCells?: number;
  readonly erasureBytes?: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return (sorted.length & 1) === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

async function loadPhysicalFrame(): Promise<Frame> {
  const png = PNG.sync.read(await readFile(PHYSICAL_FIXTURE));
  return {
    width: png.width,
    height: png.height,
    pixels: Uint8ClampedArray.from(png.data),
  };
}

function runOnce(
  cv: Awaited<ReturnType<typeof loadOpenCvRuntime>>,
  frame: Frame,
): Omit<BenchCase, "name" | "pixelsPerModule"> {
  const visionStarted = performance.now();
  const normalized = normalizeColor4WithOpenCv(
    cv,
    frame.width,
    frame.height,
    // OpenCV takes ownership of the buffer it is handed; keep the caller's copy
    // intact so repeated runs measure the same input.
    Uint8ClampedArray.from(frame.pixels),
    { canonicalScale: 6, maxDetectionDimension: 1280 },
  );
  const visionMs = performance.now() - visionStarted;

  let classifierMs = 0;
  let classifierStatus = "skipped";
  const classifierStages: Record<string, number> = {};
  let uncertainCells: number | undefined;
  let erasureBytes: number | undefined;
  if (normalized.status === "valid") {
    const observations: CanonicalRasterObservation[] = [];
    const classifierStarted = performance.now();
    const classified = decodeCanonicalColor4Raster(normalized.image, {
      observer: (observation) => observations.push(observation),
    });
    classifierMs = performance.now() - classifierStarted;
    classifierStatus = classified.status === "valid" ? "valid" : classified.reason;
    uncertainCells = classified.diagnostics.uncertainCells;
    erasureBytes = classified.diagnostics.erasureBytes;
    for (const observation of observations) {
      classifierStages[observation.stage] =
        (classifierStages[observation.stage] ?? 0) + observation.durationMs;
    }
  }

  return {
    visionMs,
    classifierMs,
    pipelineMs: visionMs + classifierMs,
    visionStatus: normalized.status === "valid" ? "valid" : normalized.reason,
    classifierStatus,
    stages: { ...normalized.diagnostics.timings },
    classifierStages,
    contours: normalized.diagnostics.counters.contoursTotal,
    candidates: normalized.candidates,
    ...(uncertainCells === undefined ? {} : { uncertainCells }),
    ...(erasureBytes === undefined ? {} : { erasureBytes }),
  };
}

function benchmark(
  cv: Awaited<ReturnType<typeof loadOpenCvRuntime>>,
  name: string,
  frame: Frame,
  pixelsPerModule?: number,
): BenchCase {
  for (let run = 0; run < WARMUP_RUNS; run++) runOnce(cv, frame);
  const runs = Array.from({ length: MEASURED_RUNS }, () => runOnce(cv, frame));
  const last = runs[runs.length - 1]!;
  const stageKeys = Object.keys(last.stages) as (keyof StageTimings)[];
  const stages = Object.fromEntries(
    stageKeys.map((key) => [key, round(median(runs.map((run) => run.stages[key])))]),
  ) as unknown as StageTimings;
  const classifierStageKeys = [...new Set(runs.flatMap((run) => Object.keys(run.classifierStages)))];
  return {
    name,
    visionMs: round(median(runs.map((run) => run.visionMs))),
    classifierMs: round(median(runs.map((run) => run.classifierMs))),
    pipelineMs: round(median(runs.map((run) => run.pipelineMs))),
    visionStatus: last.visionStatus,
    classifierStatus: last.classifierStatus,
    stages,
    classifierStages: Object.fromEntries(
      classifierStageKeys.map((key) => [
        key,
        round(median(runs.map((run) => run.classifierStages[key] ?? 0))),
      ]),
    ),
    contours: last.contours,
    candidates: last.candidates,
    ...(pixelsPerModule === undefined ? {} : { pixelsPerModule: round(pixelsPerModule) }),
    ...(last.uncertainCells === undefined ? {} : { uncertainCells: last.uncertainCells }),
    ...(last.erasureBytes === undefined ? {} : { erasureBytes: last.erasureBytes }),
  };
}

/**
 * Ceilings, not targets. A machine several times slower than a mid-range phone
 * still clears these; a pipeline that has regressed to a full per-frame contour
 * sweep or per-cell Lab conversion does not.
 */
const PIPELINE_BUDGET_MS = 1_200;
const CLASSIFIER_BUDGET_MS = 400;

test("COLOR_4 receive pipeline stays inside its stage-latency budget", {
  timeout: 300_000,
}, async () => {
  const cv = await loadOpenCvRuntime();
  const cases: BenchCase[] = [];

  const physical = await loadPhysicalFrame();
  cases.push(benchmark(cv, "physical-capture-000017", physical));

  for (const [label, profile, pixelsPerModule] of [
    ["synthetic-robust-6px", ROBUST_PROFILE, 6],
    ["synthetic-experimental-6px", EXPERIMENTAL_PROFILE, 6],
    ["synthetic-experimental-8px", EXPERIMENTAL_PROFILE, 8],
  ] as const) {
    const rendered = renderSyntheticCameraFrame(cv as unknown as SyntheticCameraCv, {
      profile,
      paletteId: 0,
      sequence: 0,
      pixelsPerModule,
    });
    cases.push(benchmark(
      cv,
      label,
      { width: rendered.width, height: rendered.height, pixels: rendered.pixels },
      rendered.pixelsPerModule,
    ));
  }

  // A single machine-readable line, matching the STRESS_METRICS convention, so
  // a CI run or a local comparison can diff stage times without scraping TAP.
  console.log(`VISION_BENCH ${JSON.stringify({ cases })}`);

  for (const entry of cases) {
    assert.ok(
      entry.pipelineMs < PIPELINE_BUDGET_MS,
      `${entry.name}: ${entry.pipelineMs} ms exceeds the ${PIPELINE_BUDGET_MS} ms pipeline budget`,
    );
  }

  // The synthetic frames are clean and in-focus, so every stage after detection
  // must reach a verdict; a rejection here means the bench stopped measuring the
  // path it exists to measure.
  for (const entry of cases.filter((value) => value.name.startsWith("synthetic-"))) {
    assert.equal(entry.visionStatus, "valid", `${entry.name}: vision must locate the frame`);
    assert.equal(entry.classifierStatus, "valid", `${entry.name}: classification must complete`);
    assert.ok(
      entry.classifierMs < CLASSIFIER_BUDGET_MS,
      `${entry.name}: classification took ${entry.classifierMs} ms, budget ${CLASSIFIER_BUDGET_MS} ms`,
    );
  }
});
