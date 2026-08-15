import assert from "node:assert/strict";
import test from "node:test";
import {
  QUIET_MODULES,
  ROBUST_PROFILE,
  decodeCanonicalColor4Raster,
  rasterizeColor4,
  wrapColor4Frame,
  type Color4Raster,
} from "../shared/color4/index.ts";
import { packFrame } from "../shared/protocol.ts";
import type {
  Color4WorkerRequest,
  Color4WorkerResponse,
} from "../receive/color4-worker-protocol.ts";

const CAMERA_WIDTH = 1_280;
const CAMERA_HEIGHT = 960;

function installImageData(): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
  if (previous !== undefined) return previous;
  class TestImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  Object.defineProperty(globalThis, "ImageData", {
    configurable: true,
    value: TestImageData,
  });
  return previous;
}

function centeredCamera(
  frame: ReturnType<typeof rasterizeColor4>,
): Uint8ClampedArray<ArrayBuffer> {
  assert.ok(frame.width < CAMERA_WIDTH);
  assert.ok(frame.height < CAMERA_HEIGHT);
  const pixels = new Uint8ClampedArray(CAMERA_WIDTH * CAMERA_HEIGHT * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 0xf4;
    pixels[offset + 1] = 0xf4;
    pixels[offset + 2] = 0xf4;
    pixels[offset + 3] = 0xff;
  }
  const left = Math.floor((CAMERA_WIDTH - frame.width) / 2);
  const top = Math.floor((CAMERA_HEIGHT - frame.height) / 2);
  const rowBytes = frame.width * 4;
  for (let y = 0; y < frame.height; y++) {
    const source = y * rowBytes;
    const destination = ((top + y) * CAMERA_WIDTH + left) * 4;
    pixels.set(frame.pixels.subarray(source, source + rowBytes), destination);
  }
  return pixels;
}

function paintActiveModule(
  raster: Color4Raster,
  activeX: number,
  activeY: number,
  rgb: readonly [number, number, number],
): void {
  const startX = (activeX + QUIET_MODULES) * raster.moduleScale;
  const startY = (activeY + QUIET_MODULES) * raster.moduleScale;
  for (let y = 0; y < raster.moduleScale; y++) {
    for (let x = 0; x < raster.moduleScale; x++) {
      const offset = ((startY + y) * raster.width + startX + x) * 4;
      raster.pixels[offset] = rgb[0];
      raster.pixels[offset + 1] = rgb[1];
      raster.pixels[offset + 2] = rgb[2];
    }
  }
}

function paintFirstDibit(
  raster: Color4Raster,
  byteIndex: number,
  rgb: readonly [number, number, number],
): void {
  const cell = byteIndex * 4;
  paintActiveModule(
    raster,
    raster.layout.data.x + (cell % ROBUST_PROFILE.columns),
    raster.layout.data.y + Math.floor(cell / ROBUST_PROFILE.columns),
    rgb,
  );
}

function damagedRankedRaster(codedBytes: Uint8Array): {
  readonly raster: Color4Raster;
  readonly trueErrorIndices: readonly number[];
  readonly falsePositiveIndices: readonly number[];
} {
  const raster = rasterizeColor4(codedBytes, {
    profile: ROBUST_PROFILE,
    paletteId: 0,
    sequence: 0,
    moduleScale: 4,
  });
  const shardZero = Array.from(
    { length: ROBUST_PROFILE.rsN },
    (_, position) => position * ROBUST_PROFILE.shards,
  );
  const falsePositiveIndices = shardZero
    .filter((index) => (codedBytes[index]! >>> 6) === 0)
    .slice(0, 16);
  const falsePositiveSet = new Set(falsePositiveIndices);
  const trueErrorIndices = shardZero
    .filter((index) => !falsePositiveSet.has(index) && (codedBytes[index]! >>> 6) !== 1)
    .slice(0, 17);
  assert.equal(falsePositiveIndices.length, 16);
  assert.equal(trueErrorIndices.length, 17);

  // White is decoded as dibit 01 with higher severity. Neutral gray remains
  // dibit 00 but crosses the classifier threshold with lower severity.
  for (const index of trueErrorIndices) paintFirstDibit(raster, index, [255, 255, 255]);
  for (const index of falsePositiveIndices) paintFirstDibit(raster, index, [96, 96, 96]);

  return Object.freeze({
    raster,
    trueErrorIndices: Object.freeze(trueErrorIndices),
    falsePositiveIndices: Object.freeze(falsePositiveIndices),
  });
}

test("real worker integrates ranked erasures and authenticated physical phase", {
  timeout: 180_000,
}, async (t) => {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const previousImageData = installImageData();
  const pendingResponses = new Map<number, (response: Color4WorkerResponse) => void>();
  const workerScope: {
    onmessage: ((event: MessageEvent<Color4WorkerRequest>) => void) | null;
    postMessage(message: Color4WorkerResponse, transfer?: Transferable[]): void;
  } = {
    onmessage: null,
    postMessage: (message) => {
      const resolve = pendingResponses.get(message.id);
      assert.notEqual(resolve, undefined, `unexpected worker response ${message.id}`);
      pendingResponses.delete(message.id);
      resolve?.(message);
    },
  };
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: workerScope,
  });

  try {
    await import("../receive/color4-worker.ts");
    const onmessage = workerScope.onmessage;
    assert.ok(onmessage, "worker import must install its message entrypoint");
    const decode = (request: Color4WorkerRequest): Promise<Color4WorkerResponse> =>
      new Promise((resolve) => {
        pendingResponses.set(request.id, resolve);
        onmessage({ data: request } as MessageEvent<Color4WorkerRequest>);
      });
    const debug = {
      enabled: false,
      view: "raw" as const,
      generation: 0,
      canonicalScale: 6 as const,
      maxDetectionDimension: 1_280 as const,
      emitPlane: false,
      snapshot: false,
    };

    await t.test("recovers a saturated shard by ranking true errors above false positives", async () => {
      const block = Uint8Array.from(
        { length: ROBUST_PROFILE.blockBytes },
        (_, index) => (index * 53 + 7) & 0xff,
      );
      const inner = packFrame({
        sessionId: 0x5a31,
        seq: 0,
        k: 1,
        blockLen: block.length,
        totalLen: block.length,
        payloadFnv: 0xa161_972c,
      }, block);
      const encoded = wrapColor4Frame(inner, {
        profileId: ROBUST_PROFILE.id,
        paletteId: 0,
      });
      const damaged = damagedRankedRaster(encoded.codedBytes);

      const canonical = decodeCanonicalColor4Raster(damaged.raster);
      assert.equal(canonical.status, "valid");
      if (canonical.status !== "valid") return;
      assert.deepEqual([...canonical.byteErasures].sort((left, right) => left - right), [
        ...damaged.trueErrorIndices,
        ...damaged.falsePositiveIndices,
      ].sort((left, right) => left - right));
      assert.equal(
        damaged.trueErrorIndices.filter(
          (index) => canonical.codedBytes[index] !== encoded.codedBytes[index],
        ).length,
        17,
      );
      assert.equal(
        damaged.falsePositiveIndices.filter(
          (index) => canonical.codedBytes[index] !== encoded.codedBytes[index],
        ).length,
        0,
      );
      const scores = new Map(
        canonical.byteErasureCandidates.map((candidate) => [candidate.index, candidate.score]),
      );
      const weakestTrueError = Math.min(
        ...damaged.trueErrorIndices.map((index) => scores.get(index) ?? Number.NEGATIVE_INFINITY),
      );
      const strongestFalsePositive = Math.max(
        ...damaged.falsePositiveIndices.map((index) => scores.get(index) ?? Number.POSITIVE_INFINITY),
      );
      assert.ok(weakestTrueError > strongestFalsePositive);

      const response = await decode({
        kind: "decode",
        id: 18,
        width: CAMERA_WIDTH,
        height: CAMERA_HEIGHT,
        rgba: centeredCamera(damaged.raster).buffer,
        paletteId: 0,
        capturedAt: 0,
        captureMs: 0,
        debug,
      });

      assert.equal(response.kind, "result");
      if (response.kind !== "result") return;
      assert.equal(response.status, "valid");
      if (response.status !== "valid") return;
      assert.deepEqual(new Uint8Array(response.innerFrame), inner);
      assert.equal(response.diagnostics.erasurePolicy, "classifier-budgeted");
      assert.equal(response.diagnostics.selectedBudgetFraction, 1);
      assert.equal(response.diagnostics.selectedMaxErasuresPerShard, 32);
      assert.deepEqual(response.diagnostics.suggestedErasuresByShard, [33, 0, 0, 0, 0, 0]);
      assert.deepEqual(response.diagnostics.saturatedErasureShards, [0]);
      assert.deepEqual(response.diagnostics.selectedErasuresByShard, [32, 0, 0, 0, 0, 0]);
      assert.equal(response.diagnostics.unwrapAttempts?.length, 1);
      assert.deepEqual(response.diagnostics.unwrapAttempts?.[0], {
        policy: "classifier-budgeted",
        budgetFraction: 1,
        maxErasuresPerShard: 32,
        erasures: 32,
        erasuresByShard: [32, 0, 0, 0, 0, 0],
        phaseMatched: true,
        durationMs: response.diagnostics.unwrapAttempts?.[0]?.durationMs,
        status: "valid",
      });
      assert.ok((response.diagnostics.unwrapAttempts?.[0]?.durationMs ?? -1) >= 0);
      assert.equal(response.diagnostics.rsFailures, 0);
      assert.equal(response.diagnostics.crcFailures, 0);
    });

    await t.test("preserves phase-mismatch diagnostics on the deduplicated hard-decision rung", async () => {
      const block = Uint8Array.from(
        { length: ROBUST_PROFILE.blockBytes },
        (_, index) => (index * 37 + 11) & 0xff,
      );
      const inner = packFrame({
        sessionId: 0x7319,
        seq: 0,
        k: 1,
        blockLen: block.length,
        totalLen: block.length,
        payloadFnv: 0x81f0_4a2d,
      }, block);
      const encoded = wrapColor4Frame(inner, {
        profileId: ROBUST_PROFILE.id,
        paletteId: 0,
      });
      const raster = rasterizeColor4(encoded.codedBytes, {
        profile: ROBUST_PROFILE,
        paletteId: 0,
        sequence: 1,
        moduleScale: 4,
      });
      const response = await decode({
        kind: "decode",
        id: 17,
        width: CAMERA_WIDTH,
        height: CAMERA_HEIGHT,
        rgba: centeredCamera(raster).buffer,
        paletteId: 0,
        capturedAt: 0,
        captureMs: 0,
        debug,
      });

      assert.equal(response.kind, "result");
      if (response.kind !== "result") return;
      assert.equal(response.status, "rejected");
      if (response.status !== "rejected") return;
      assert.equal(response.reason, "identity-mismatch");
      assert.equal(response.diagnostics.stage, "bootstrap");
      assert.equal(response.diagnostics.rejectReason, "sequence-phase-mismatch");
      assert.equal(response.diagnostics.vision?.diagnosticReason, "PHASE");
      assert.equal(response.diagnostics.erasurePolicy, "hard-decision");
      assert.equal(response.diagnostics.selectedBudgetFraction, 0);
      assert.equal(response.diagnostics.selectedMaxErasuresPerShard, 0);
      assert.equal(response.diagnostics.unwrapAttempts?.length, 1);
      assert.deepEqual(response.diagnostics.unwrapAttempts?.[0], {
        policy: "hard-decision",
        budgetFraction: 0,
        maxErasuresPerShard: 0,
        erasures: 0,
        erasuresByShard: [0, 0, 0, 0, 0, 0],
        phaseMatched: false,
        durationMs: response.diagnostics.unwrapAttempts?.[0]?.durationMs,
        status: "valid",
      });
      assert.ok((response.diagnostics.unwrapAttempts?.[0]?.durationMs ?? -1) >= 0);
      assert.equal(response.diagnostics.rsFailures, 0);
      assert.equal(response.diagnostics.crcFailures, 0);
    });
  } finally {
    if (previousSelf === undefined) delete (globalThis as { self?: unknown }).self;
    else Object.defineProperty(globalThis, "self", previousSelf);
    if (previousImageData === undefined) delete (globalThis as { ImageData?: unknown }).ImageData;
    else Object.defineProperty(globalThis, "ImageData", previousImageData);
  }
});
