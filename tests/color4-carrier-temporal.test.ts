import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  COLOR4_WORKER_WATCHDOG_MS,
  Color4CameraDecoder,
  Color4WorkerFailure,
  LEGACY_HOLD_INITIAL_CAPTURES,
} from "../receive/color4-carrier.ts";
import type {
  Color4ClassifyRequest,
  Color4GeometryRejectedResponse,
  Color4GeometryRequest,
  Color4GeometrySnapshot,
  Color4GeometryValidResponse,
  Color4WorkerDiagnostics,
  Color4WorkerRequest,
  Color4WorkerResponse,
  Color4WorkerRole,
  Color4WorkerValidResponse,
} from "../receive/color4-worker-protocol.ts";
import type { CapturedFrame } from "../shared/color4/index.ts";

type WorkKind = "geometry" | "classifier";

interface SentMessage {
  readonly message: Color4WorkerRequest;
  readonly transfer: readonly Transferable[];
}

class FakeWorker {
  static created: FakeWorker[] = [];
  static active: Record<WorkKind, number> = { geometry: 0, classifier: 0 };
  static maximumActive: Record<WorkKind, number> = { geometry: 0, classifier: 0 };

  onmessage: ((event: MessageEvent<Color4WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly sent: SentMessage[] = [];
  role: Color4WorkerRole | undefined;
  terminated = false;
  private inFlight: WorkKind | undefined;

  constructor() {
    FakeWorker.created.push(this);
  }

  static reset(): void {
    FakeWorker.created = [];
    FakeWorker.active = { geometry: 0, classifier: 0 };
    FakeWorker.maximumActive = { geometry: 0, classifier: 0 };
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    const request = message as Color4WorkerRequest;
    this.sent.push({ message: request, transfer: [...transfer] });
    if (request.kind === "init") {
      this.role = request.role;
      return;
    }
    const work = request.kind === "geometry"
      ? "geometry"
      : request.kind === "classify" ? "classifier" : undefined;
    if (work === undefined) return;
    assert.equal(this.inFlight, undefined, `${work} worker received overlapping work`);
    this.inFlight = work;
    FakeWorker.active[work]++;
    FakeWorker.maximumActive[work] = Math.max(
      FakeWorker.maximumActive[work],
      FakeWorker.active[work],
    );
  }

  terminate(): void {
    this.completeWork();
    this.terminated = true;
  }

  replyReady(): void {
    this.reply({
      kind: "ready",
      id: -1,
      opencvInitMs: this.role === "geometry" ? 11 : 0,
      role: this.role,
    });
  }

  reply(response: Color4WorkerResponse, completesWork = true): void {
    if (completesWork) this.completeWork();
    this.onmessage?.({ data: response } as MessageEvent<Color4WorkerResponse>);
  }

  fail(): void {
    this.completeWork();
    this.onerror?.({ preventDefault: () => undefined } as ErrorEvent);
  }

  private completeWork(): void {
    if (this.inFlight === undefined) return;
    FakeWorker.active[this.inFlight]--;
    this.inFlight = undefined;
  }
}

class FakeImageData {
  readonly data: Uint8ClampedArray<ArrayBuffer>;

  constructor(readonly width = 4, readonly height = 4) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

class FakeBitmap {
  closeCalls = 0;

  constructor(readonly width = 4, readonly height = 4) {}

  close(): void {
    this.closeCalls++;
  }
}

const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const imageDataDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
Object.defineProperty(globalThis, "Worker", {
  configurable: true,
  writable: true,
  value: FakeWorker,
});
Object.defineProperty(globalThis, "ImageData", {
  configurable: true,
  writable: true,
  value: FakeImageData,
});

after(() => {
  if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
  else Reflect.deleteProperty(globalThis, "Worker");
  if (imageDataDescriptor) Object.defineProperty(globalThis, "ImageData", imageDataDescriptor);
  else Reflect.deleteProperty(globalThis, "ImageData");
});

function requests<K extends Color4WorkerRequest["kind"]>(
  worker: FakeWorker,
  kind: K,
): Extract<Color4WorkerRequest, { kind: K }>[] {
  return worker.sent
    .map(({ message }) => message)
    .filter((message): message is Extract<Color4WorkerRequest, { kind: K }> =>
      message.kind === kind,
    );
}

function imageFrame(timestamp: number): CapturedFrame {
  return {
    source: new FakeImageData() as unknown as ImageData,
    timestamp,
  };
}

function bitmapFrame(bitmap: FakeBitmap, timestamp: number): CapturedFrame {
  return { source: bitmap as unknown as ImageBitmap, timestamp };
}

function diagnostics(): Color4WorkerDiagnostics {
  return {
    candidates: 1,
    uncertainCells: 0,
    erasureBytes: 0,
    rsCorrectedSymbols: 0,
    rsFailures: 0,
    crcFailures: 0,
    decodeMs: 1,
    erasures: 0,
    correctedErrors: 0,
    correctedBytes: 0,
    correctedShards: 0,
  };
}

function geometryValid(
  request: Color4GeometryRequest,
  overrides: Partial<Pick<
    Color4GeometryValidResponse,
    "captureSequence" | "trackingGeneration" | "classifierSlot"
  >> = {},
): Color4GeometryValidResponse {
  return {
    kind: "geometry-result",
    id: request.id,
    captureSequence: overrides.captureSequence ?? request.captureSequence,
    trackingGeneration: overrides.trackingGeneration ?? request.trackingGeneration,
    classifierSlot: overrides.classifierSlot ?? request.classifierSlot,
    status: "valid",
    geometryPath: "cold",
    geometryMs: 2,
    trackingMs: 0,
    samplingMs: 1,
    guardMs: 0,
    geometry: {
      candidates: 1,
      diagnostics: {},
    } as unknown as Color4GeometrySnapshot,
    canonical: {
      kind: "samples",
      width: 172,
      height: 172,
      rgb: new ArrayBuffer(172 * 172 * 3 * Float32Array.BYTES_PER_ELEMENT),
    },
  };
}

function geometryRejected(
  request: Color4GeometryRequest,
  overrides: Partial<Pick<Color4GeometryRejectedResponse, "geometryPath" | "diagnostics">> = {},
): Color4GeometryRejectedResponse {
  return {
    kind: "geometry-result",
    id: request.id,
    captureSequence: request.captureSequence,
    trackingGeneration: request.trackingGeneration,
    classifierSlot: request.classifierSlot,
    status: "rejected",
    geometryPath: overrides.geometryPath ?? "cold",
    reason: "no-symbol",
    diagnostics: overrides.diagnostics ?? diagnostics(),
  };
}

function classifierValid(
  request: Color4ClassifyRequest,
  overrides: Partial<Pick<Color4WorkerValidResponse, "classifierSlot">> = {},
): Color4WorkerValidResponse {
  return {
    kind: "result",
    id: request.id,
    status: "valid",
    innerFrame: Uint8Array.from([request.id]).buffer,
    diagnostics: diagnostics(),
    captureSequence: request.captureSequence,
    trackingGeneration: request.trackingGeneration,
    classifierSlot: overrides.classifierSlot ?? request.classifierSlot,
    geometryPath: request.geometryPath,
  };
}

async function flushAsyncContinuation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface DecoderHarness {
  readonly decoder: Color4CameraDecoder;
  readonly geometry: FakeWorker;
  readonly classifiers: readonly FakeWorker[];
}

async function createHarness(workerCount = 2): Promise<DecoderHarness> {
  FakeWorker.reset();
  const decoder = new Color4CameraDecoder(0, workerCount);
  const initialWorkers = [...FakeWorker.created];
  assert.equal(initialWorkers.length, workerCount + 1);
  const geometry = initialWorkers.find((worker) => worker.role === "geometry");
  const classifiers = initialWorkers.filter((worker) => worker.role === "classifier");
  assert.ok(geometry);
  assert.equal(classifiers.length, workerCount);
  for (const worker of initialWorkers) worker.replyReady();
  assert.equal(await decoder.ready, 11);
  return { decoder, geometry, classifiers };
}

test("capture reservation atomically owns geometry and one classifier until cancellation", {
  concurrency: false,
}, async () => {
  const { decoder } = await createHarness(2);
  const first = decoder.tryReserveCapture();
  assert.ok(first);
  assert.equal(first.classifierSlot, 0);
  assert.equal(decoder.tryReserveCapture(), undefined);
  assert.equal(decoder.captureDropReason, "geometry-busy");

  assert.equal(decoder.cancelReservation(first), true);
  assert.equal(decoder.cancelReservation(first), false);
  const second = decoder.tryReserveCapture();
  assert.ok(second);
  assert.equal(second.captureSequence, first.captureSequence + 1);
  assert.equal(decoder.cancelReservation(second), true);
  assert.equal(decoder.busy, false);
  decoder.dispose();
});

test("the temporal pipeline runs at most one geometry job and N classifier jobs", {
  concurrency: false,
}, async () => {
  const { decoder, geometry, classifiers } = await createHarness(2);
  const firstToken = decoder.tryReserveCapture();
  assert.ok(firstToken);
  const firstResult = decoder.decodeReserved(firstToken, imageFrame(10));
  await flushAsyncContinuation();
  const firstGeometry = requests(geometry, "geometry")[0];
  assert.ok(firstGeometry);
  assert.equal(FakeWorker.active.geometry, 1);
  assert.equal(decoder.tryReserveCapture(), undefined);

  geometry.reply(geometryValid(firstGeometry));
  assert.equal(FakeWorker.active.geometry, 0);
  assert.equal(FakeWorker.active.classifier, 1);

  const secondToken = decoder.tryReserveCapture();
  assert.ok(secondToken);
  assert.equal(secondToken.classifierSlot, 1);
  const secondResult = decoder.decodeReserved(secondToken, imageFrame(11));
  await flushAsyncContinuation();
  const secondGeometry = requests(geometry, "geometry")[1];
  assert.ok(secondGeometry);
  assert.equal(FakeWorker.active.geometry, 1);
  assert.equal(FakeWorker.active.classifier, 1);

  geometry.reply(geometryValid(secondGeometry));
  assert.equal(FakeWorker.active.geometry, 0);
  assert.equal(FakeWorker.active.classifier, 2);
  assert.equal(decoder.tryReserveCapture(), undefined);
  assert.equal(decoder.captureDropReason, "classifier-busy");
  assert.equal(FakeWorker.maximumActive.geometry, 1);
  assert.equal(FakeWorker.maximumActive.classifier, 2);

  for (const classifier of classifiers) {
    const request = requests(classifier, "classify")[0];
    assert.ok(request);
    classifier.reply(classifierValid(request));
  }
  const results = await Promise.all([firstResult, secondResult]);
  assert.ok(results.every((result) => result.status === "valid"));
  assert.deepEqual(FakeWorker.active, { geometry: 0, classifier: 0 });
  decoder.dispose();
});

test("stale capture and tracking generations cannot advance a reservation", {
  concurrency: false,
}, async () => {
  const { decoder, geometry, classifiers } = await createHarness(1);
  const token = decoder.tryReserveCapture();
  assert.ok(token);
  let settled = false;
  const resultPromise = decoder.decodeReserved(token, imageFrame(20)).finally(() => {
    settled = true;
  });
  await flushAsyncContinuation();
  const request = requests(geometry, "geometry")[0];
  assert.ok(request);

  geometry.reply(geometryValid(request, {
    captureSequence: request.captureSequence + 1,
  }), false);
  geometry.reply(geometryValid(request, {
    trackingGeneration: request.trackingGeneration + 1,
  }), false);
  geometry.reply(geometryValid(request, {
    classifierSlot: request.classifierSlot + 1,
  }), false);
  await flushAsyncContinuation();
  assert.equal(settled, false);
  assert.equal(requests(classifiers[0]!, "classify").length, 0);
  assert.equal(FakeWorker.active.geometry, 1);

  geometry.reply(geometryValid(request));
  const classifierRequest = requests(classifiers[0]!, "classify")[0];
  assert.ok(classifierRequest);
  geometry.reply(geometryValid(request), false);
  assert.equal(requests(classifiers[0]!, "classify").length, 1);
  classifiers[0]!.reply(classifierValid(classifierRequest, {
    classifierSlot: classifierRequest.classifierSlot + 1,
  }), false);
  await flushAsyncContinuation();
  assert.equal(settled, false);
  classifiers[0]!.reply(classifierValid(classifierRequest));
  const result = await resultPromise;
  assert.equal(result.captureSequence, token.captureSequence);
  assert.equal(result.trackingGeneration, token.trackingGeneration);
  decoder.dispose();
});

test("two bitmap consumers cannot race the same reservation or classifier slot", {
  concurrency: false,
}, async () => {
  const { decoder, geometry } = await createHarness(1);
  const token = decoder.tryReserveCapture();
  assert.ok(token);
  const acceptedBitmap = new FakeBitmap();
  const staleBitmap = new FakeBitmap();
  const accepted = decoder.decodeReserved(token, bitmapFrame(acceptedBitmap, 30));
  const stale = decoder.decodeReserved(token, bitmapFrame(staleBitmap, 31));
  await flushAsyncContinuation();

  await assert.rejects(stale, /reservation is stale or already consumed/);
  assert.equal(staleBitmap.closeCalls, 1);
  assert.equal(acceptedBitmap.closeCalls, 0);
  assert.equal(requests(geometry, "geometry").length, 1);
  const sent = geometry.sent.find(({ message }) => message.kind === "geometry");
  assert.ok(sent);
  assert.strictEqual(sent.transfer[0], acceptedBitmap);
  assert.equal(decoder.cancelReservation(token), false);
  assert.equal(decoder.tryReserveCapture(), undefined);

  const request = requests(geometry, "geometry")[0];
  assert.ok(request);
  geometry.reply(geometryRejected(request));
  const result = await accepted;
  assert.equal(result.status, "rejected");
  const next = decoder.tryReserveCapture();
  assert.ok(next);
  assert.equal(decoder.cancelReservation(next), true);
  decoder.dispose();
});

test("three non-transition rejections probe legacy and a failed probe resets tracking", {
  concurrency: false,
}, async () => {
  const { decoder, geometry } = await createHarness(1);
  const rejectCapture = async (
    rejectedDiagnostics: Color4WorkerDiagnostics = diagnostics(),
  ) => {
    const token = decoder.tryReserveCapture();
    assert.ok(token);
    const resultPromise = decoder.decodeReserved(token, imageFrame(35 + token.captureSequence));
    await flushAsyncContinuation();
    const request = requests(geometry, "geometry").at(-1);
    assert.ok(request);
    geometry.reply(geometryRejected(request, { diagnostics: rejectedDiagnostics }));
    const result = await resultPromise;
    assert.equal(result.status, "rejected");
    return token;
  };

  const transitionDiagnostics: Color4WorkerDiagnostics = {
    ...diagnostics(),
    stage: "bootstrap",
    rejectReason: "phase_mismatch",
    vision: { rejectReason: "phase_mismatch" },
  };
  await rejectCapture(transitionDiagnostics);

  const first = await rejectCapture();
  const second = await rejectCapture();
  const third = await rejectCapture();
  assert.equal(first.mode, "fast");
  assert.equal(second.mode, "fast");
  assert.equal(third.mode, "fast");

  const legacyProbe = decoder.tryReserveCapture();
  assert.ok(legacyProbe);
  assert.equal(legacyProbe.mode, "legacy");
  const legacyResult = decoder.decodeReserved(legacyProbe, imageFrame(50));
  await flushAsyncContinuation();
  const legacyRequest = requests(geometry, "geometry").at(-1);
  assert.ok(legacyRequest);
  geometry.reply(geometryRejected(legacyRequest, { geometryPath: "legacy" }));
  assert.equal((await legacyResult).status, "rejected");

  const resumed = decoder.tryReserveCapture();
  assert.ok(resumed);
  assert.equal(resumed.mode, "fast");
  assert.equal(resumed.trackingGeneration, legacyProbe.trackingGeneration + 1);
  decoder.cancelReservation(resumed);
  decoder.dispose();
});

test("a successful legacy probe holds legacy for a bounded run and then resumes fast", {
  concurrency: false,
}, async () => {
  const { decoder, geometry, classifiers } = await createHarness(1);

  const rejectFast = async () => {
    const token = decoder.tryReserveCapture();
    assert.ok(token);
    assert.equal(token.mode, "fast");
    const pending = decoder.decodeReserved(token, imageFrame(60 + token.captureSequence));
    await flushAsyncContinuation();
    const request = requests(geometry, "geometry").at(-1);
    assert.ok(request);
    geometry.reply(geometryRejected(request));
    assert.equal((await pending).status, "rejected");
  };

  for (let attempt = 0; attempt < 3; attempt++) await rejectFast();

  // The probe decodes, so legacy takes over -- but only for a bounded run.
  const probe = decoder.tryReserveCapture();
  assert.ok(probe);
  assert.equal(probe.mode, "legacy");
  const probeResult = decoder.decodeReserved(probe, imageFrame(70));
  await flushAsyncContinuation();
  const probeRequest = requests(geometry, "geometry").at(-1);
  assert.ok(probeRequest);
  geometry.reply(geometryValid(probeRequest));
  await flushAsyncContinuation();
  const probeClassify = requests(classifiers[0]!, "classify").at(-1);
  assert.ok(probeClassify);
  classifiers[0]!.reply(classifierValid(probeClassify));
  assert.equal((await probeResult).status, "valid");
  assert.deepEqual(decoder.legacyFallbacks, { probes: 1, holds: 1, holding: true });

  // Every capture inside the hold is legacy, and the hold is finite.
  let heldCaptures = 0;
  let resumed = decoder.tryReserveCapture();
  assert.ok(resumed);
  while (resumed.mode === "legacy") {
    heldCaptures++;
    assert.ok(heldCaptures <= LEGACY_HOLD_INITIAL_CAPTURES, "the legacy hold never expired");
    decoder.cancelReservation(resumed);
    const next = decoder.tryReserveCapture();
    assert.ok(next);
    resumed = next;
  }
  assert.equal(heldCaptures, LEGACY_HOLD_INITIAL_CAPTURES);
  assert.equal(resumed.mode, "fast");
  // Expiring the hold retires the geometry worker's state so the fast path
  // restarts from a cold acquisition rather than from pre-trouble geometry.
  assert.equal(resumed.trackingGeneration, probe.trackingGeneration + 1);
  assert.equal(decoder.legacyFallbacks.holding, false);
  decoder.cancelReservation(resumed);
  decoder.dispose();
});

test("one worker restart is recoverable and a second failure is fatal", {
  concurrency: false,
}, async () => {
  const { decoder, geometry } = await createHarness(1);
  const restarted: string[] = [];
  let fatalError: Error | undefined;
  decoder.onWorkerRestart = (role) => restarted.push(role);
  decoder.onFatal = (error) => {
    fatalError = error;
  };

  const firstToken = decoder.tryReserveCapture();
  assert.ok(firstToken);
  const first = decoder.decodeReserved(firstToken, imageFrame(40));
  await flushAsyncContinuation();
  geometry.fail();
  await assert.rejects(first, (error: unknown) =>
    error instanceof Color4WorkerFailure &&
    error.role === "geometry" &&
    error.fatal === false,
  );
  assert.equal(geometry.terminated, true);
  assert.deepEqual(decoder.workerRestarts, { geometry: 1, classifier: 0 });
  assert.deepEqual(restarted, ["geometry"]);
  assert.equal(FakeWorker.created.length, 3, "exactly one replacement was created");

  const replacement = FakeWorker.created[2]!;
  assert.equal(replacement.role, "geometry");
  geometry.replyReady();
  assert.equal(decoder.tryReserveCapture(), undefined, "an obsolete ready callback is ignored");
  replacement.replyReady();
  const secondToken = decoder.tryReserveCapture();
  assert.ok(secondToken);
  const second = decoder.decodeReserved(secondToken, imageFrame(41));
  await flushAsyncContinuation();
  replacement.fail();
  await assert.rejects(second, (error: unknown) =>
    error instanceof Color4WorkerFailure &&
    error.role === "geometry" &&
    error.fatal === true,
  );

  assert.ok(fatalError instanceof Color4WorkerFailure);
  assert.equal(fatalError.fatal, true);
  assert.equal(FakeWorker.created.length, 3, "a fatal second failure cannot respawn");
  assert.deepEqual(decoder.workerRestarts, { geometry: 2, classifier: 0 });
  assert.equal(decoder.tryReserveCapture(), undefined);
  decoder.dispose();
});

test("each geometry and classifier job has the five-second watchdog", {
  concurrency: false,
}, async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nextTimer = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = ++nextTimer;
    pending.set(id, { callback: callback as () => void, delay: delay ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    pending.delete(handle as unknown as number);
  }) as unknown as typeof clearTimeout;

  let decoder: Color4CameraDecoder | undefined;
  try {
    const harness = await createHarness(1);
    decoder = harness.decoder;
    const token = decoder.tryReserveCapture();
    assert.ok(token);
    const result = decoder.decodeReserved(token, imageFrame(60));
    await flushAsyncContinuation();
    assert.deepEqual([...pending.values()].map(({ delay }) => delay), [
      COLOR4_WORKER_WATCHDOG_MS,
    ]);

    const geometryRequest = requests(harness.geometry, "geometry")[0];
    assert.ok(geometryRequest);
    harness.geometry.reply(geometryValid(geometryRequest));
    assert.deepEqual([...pending.values()].map(({ delay }) => delay), [
      COLOR4_WORKER_WATCHDOG_MS,
    ]);
    const classifierTimer = [...pending.values()][0];
    assert.ok(classifierTimer);
    classifierTimer.callback();
    await assert.rejects(result, (error: unknown) =>
      error instanceof Color4WorkerFailure &&
      error.role === "classifier" &&
      error.fatal === false,
    );
    assert.deepEqual(decoder.workerRestarts, { geometry: 0, classifier: 1 });
  } finally {
    decoder?.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
