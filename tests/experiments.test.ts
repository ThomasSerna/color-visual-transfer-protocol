import assert from "node:assert/strict";
import test from "node:test";
import { ExperimentMetrics, makeExperimentExport } from "../shared/experiments.ts";

test("experiment summaries contain measurements but no payload identity", () => {
  const metrics = new ExperimentMetrics("receive", "COLOR_4", "ROBUST", 1_000);
  metrics.recordCapture();
  metrics.recordCapture();
  metrics.recordAttempt("valid", { rsCorrectedSymbols: 3, erasureBytes: 5, decodeMs: 9 });
  metrics.recordAttempt("rejected", { stage: "crc", rejectReason: "crc", crcFailures: 1, decodeMs: 11 });
  const summary = metrics.snapshot({
    success: true,
    now: 3_500,
    payloadBytes: 1_048_576,
    newFrames: 42,
    duplicateFrames: 2,
  });

  assert.equal(summary.elapsedMs, 2_500);
  assert.equal(summary.captures, 2);
  assert.equal(summary.validFrames, 1);
  assert.equal(summary.carrierRejected, 1);
  assert.equal(summary.rsCorrectedSymbols, 3);
  assert.equal(summary.erasureBytes, 5);
  assert.equal(summary.crcFailures, 1);
  assert.equal(summary.decodeLatencyMs.p50, 9);
  assert.equal("fileName" in summary, false);
  assert.equal("hash" in summary, false);
});

test("experiment export has a pinned, portable envelope", () => {
  const exported = makeExperimentExport([], undefined, new Date("2026-08-08T12:00:00Z"));
  assert.deepEqual(exported, {
    schema: "decimen-experiment-export",
    version: 1,
    exportedAt: "2026-08-08T12:00:00.000Z",
    current: undefined,
    history: [],
  });
});
