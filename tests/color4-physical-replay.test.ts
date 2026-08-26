import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  decodeCanonicalColor4Raster,
  shardPosition,
  unwrapColor4Frame,
  type CanonicalRasterObservation,
  type Color4Profile,
} from "../shared/color4/index.ts";
import { color4SequencePhaseMatches } from "../receive/color4-binding.ts";
import { assertClassifierDistribution } from "./helpers/classifier-distribution.ts";
import {
  runColor4ErasurePolicy,
  type Color4ErasureBudgetFraction,
  type Color4ErasurePolicy,
} from "../receive/color4-erasure-policy.ts";
import {
  canonicalDiagnosticReason,
  fecDiagnosticReason,
} from "../receive/color4-diagnostic-reason.ts";
import {
  normalizeColor4WithOpenCv,
  type OpenCvRuntime,
  type VisionCanonicalScale,
  type VisionDetectionLimit,
} from "../receive/color4-vision.ts";

const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/color4/physical/", import.meta.url),
);
const REQUIRE_PHYSICAL_FIXTURES = process.env.CVTP_REQUIRE_PHYSICAL_FIXTURES === "1";
const REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE =
  process.env.CVTP_REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE === "1";
const SHA256 = /^[0-9a-f]{64}$/;

type ProfileName = "ROBUST" | "EXPERIMENTAL";
type PaletteName = "KCMY" | "KRGB";
type OracleBasisKind = "crc-derived-regression" | "independent-tx-ground-truth";

interface OracleBasis {
  readonly kind: OracleBasisKind;
  readonly description: string;
}

interface ErasureDistributionOracle {
  readonly total: number;
  readonly byShard: readonly number[];
}

interface ClassifierDistributionOracle {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface PhysicalCaptureConfiguration {
  readonly carrier: "COLOR_4";
  readonly expectedProfile: ProfileName;
  readonly palette: PaletteName;
  readonly paletteId: 0 | 1;
  readonly txFps: 1 | 2 | 5 | 10;
  readonly prefilterMode: "observe" | "enabled";
  readonly brightness: "high" | "maximum";
  readonly canonicalScale: VisionCanonicalScale;
  readonly maxDetectionDimension: VisionDetectionLimit;
}

type VisionOracle =
  | { readonly status: "valid" }
  | { readonly status: "rejected"; readonly reason: string };

type ClassifierOracle =
  | {
      readonly status: "valid";
      readonly profile: ProfileName;
      readonly paletteId: 0 | 1;
      readonly sequencePhase: 0 | 1 | 2 | 3;
      readonly uncertainCells: number;
      readonly candidateErasures: ErasureDistributionOracle;
      readonly erasureCandidateScore: ClassifierDistributionOracle;
      readonly codedBytesSha256: string;
    }
  | { readonly status: "rejected"; readonly reason: string };

type UnwrapOracle =
  | {
      readonly status: "valid";
      readonly sessionId: number;
      readonly sequence: number;
      readonly selectedPolicy: Color4ErasurePolicy;
      readonly selectedBudgetFraction: Color4ErasureBudgetFraction;
      readonly selectedMaxErasuresPerShard: number;
      readonly attempts: number;
      readonly selectedErasures: ErasureDistributionOracle;
      readonly correctedErrors: number;
      readonly correctedBytes: number;
      readonly correctedShards: number;
      readonly innerFrameSha256: string;
    }
  | { readonly status: "rejected"; readonly reason: string };

interface PhysicalCaptureOracle {
  readonly basis: OracleBasis;
  readonly vision: VisionOracle;
  readonly classifier?: ClassifierOracle;
  readonly unwrap?: UnwrapOracle;
  readonly rejection?: RejectionOracle;
}

type RejectionStage =
  | "geometry"
  | "bootstrap"
  | "calibration"
  | "classification"
  | "rs"
  | "crc"
  | "wire";

interface RejectionOracle {
  readonly stage: RejectionStage;
  readonly publicReason: string;
  readonly internalReason: string;
  /** `null` explicitly records that the runtime produced no actionable code. */
  readonly diagnosticReason: string | null;
}

interface CaptureSettings {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

interface PhysicalCaptureMetadata {
  readonly rawFrame: Readonly<{
    width: number;
    height: number;
    pngSha256: string;
    rgbaSha256: string;
    preparation: "unaltered-export" | "privacy-crop" | "privacy-redacted";
    scope: "full-camera-frame" | "limited-evidence";
  }>;
  readonly configuration: PhysicalCaptureConfiguration;
  readonly oracle: PhysicalCaptureOracle;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    assert.ok(Object.hasOwn(value, key), `${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    assert.ok(allowed.has(key), `${label}.${key} is not part of metadata version 1`);
  }
}

function stringValue(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  assert.ok(typeof value === "number", `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  return value;
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = numberValue(value, label);
  assert.ok(Number.isInteger(parsed), `${label} must be an integer`);
  assert.ok(parsed >= minimum && parsed <= maximum, `${label} is outside its valid range`);
  return parsed;
}

function choice<T extends string | number>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  assert.ok(choices.some((candidate) => candidate === value), `${label} has an unsupported value`);
  return value as T;
}

function sha256Value(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  assert.match(parsed, SHA256, `${label} must be a lowercase SHA-256 digest`);
  return parsed;
}

function diagnosticReasonValue(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function parseOracleBasis(value: unknown, label: string): OracleBasis {
  const parsed = record(value, label);
  assertKeys(parsed, ["kind", "description"], [], label);
  return {
    kind: choice(
      parsed.kind,
      ["crc-derived-regression", "independent-tx-ground-truth"],
      `${label}.kind`,
    ),
    description: stringValue(parsed.description, `${label}.description`),
  };
}

function parseErasureDistribution(
  value: unknown,
  label: string,
): ErasureDistributionOracle {
  const parsed = record(value, label);
  assertKeys(parsed, ["total", "byShard"], [], label);
  const total = integerValue(parsed.total, `${label}.total`, 0, 65_535);
  assert.ok(Array.isArray(parsed.byShard), `${label}.byShard must be an array`);
  assert.ok(parsed.byShard.length > 0, `${label}.byShard must not be empty`);
  const byShard = parsed.byShard.map((entry, index) =>
    integerValue(entry, `${label}.byShard[${index}]`, 0, 255)
  );
  assert.equal(
    byShard.reduce((sum, count) => sum + count, 0),
    total,
    `${label}.total must equal the sum of byShard`,
  );
  return { total, byShard };
}

function parseClassifierDistribution(
  value: unknown,
  label: string,
): ClassifierDistributionOracle {
  const parsed = record(value, label);
  assertKeys(parsed, ["count", "min", "p50", "p95", "max"], [], label);
  const distribution = {
    count: integerValue(parsed.count, `${label}.count`, 0, 65_535),
    min: numberValue(parsed.min, `${label}.min`),
    p50: numberValue(parsed.p50, `${label}.p50`),
    p95: numberValue(parsed.p95, `${label}.p95`),
    max: numberValue(parsed.max, `${label}.max`),
  };
  assert.ok(distribution.min >= 0, `${label}.min must be non-negative`);
  assert.ok(distribution.min <= distribution.p50, `${label}.min must be <= p50`);
  assert.ok(distribution.p50 <= distribution.p95, `${label}.p50 must be <= p95`);
  assert.ok(distribution.p95 <= distribution.max, `${label}.p95 must be <= max`);
  return distribution;
}

function parseCaptureSettings(value: unknown, label: string): CaptureSettings {
  const parsed = record(value, label);
  assertKeys(parsed, ["width", "height", "frameRate"], [], label);
  const settings = {
    width: integerValue(parsed.width, `${label}.width`, 1, 32_768),
    height: integerValue(parsed.height, `${label}.height`, 1, 32_768),
    frameRate: numberValue(parsed.frameRate, `${label}.frameRate`),
  };
  assert.ok(settings.frameRate > 0, `${label}.frameRate must be positive`);
  return settings;
}

function parseRejectionOracle(value: unknown, label: string): RejectionOracle {
  const parsed = record(value, label);
  assertKeys(
    parsed,
    ["stage", "publicReason", "internalReason", "diagnosticReason"],
    [],
    label,
  );
  return {
    stage: choice(
      parsed.stage,
      ["geometry", "bootstrap", "calibration", "classification", "rs", "crc", "wire"],
      `${label}.stage`,
    ),
    publicReason: stringValue(parsed.publicReason, `${label}.publicReason`),
    internalReason: stringValue(parsed.internalReason, `${label}.internalReason`),
    diagnosticReason: diagnosticReasonValue(
      parsed.diagnosticReason,
      `${label}.diagnosticReason`,
    ),
  };
}

function parseVisionOracle(value: unknown, label: string): VisionOracle {
  const parsed = record(value, label);
  if (parsed.status === "valid") {
    assertKeys(parsed, ["status"], [], label);
    return { status: "valid" };
  }
  assert.equal(parsed.status, "rejected", `${label}.status must be valid or rejected`);
  assertKeys(parsed, ["status", "reason"], [], label);
  return { status: "rejected", reason: stringValue(parsed.reason, `${label}.reason`) };
}

function parseClassifierOracle(value: unknown, label: string): ClassifierOracle {
  const parsed = record(value, label);
  if (parsed.status === "rejected") {
    assertKeys(parsed, ["status", "reason"], [], label);
    return { status: "rejected", reason: stringValue(parsed.reason, `${label}.reason`) };
  }
  assert.equal(parsed.status, "valid", `${label}.status must be valid or rejected`);
  assertKeys(
    parsed,
    [
      "status",
      "profile",
      "paletteId",
      "sequencePhase",
      "uncertainCells",
      "candidateErasures",
      "erasureCandidateScore",
      "codedBytesSha256",
    ],
    [],
    label,
  );
  return {
    status: "valid",
    profile: choice(parsed.profile, ["ROBUST", "EXPERIMENTAL"], `${label}.profile`),
    paletteId: choice(parsed.paletteId, [0, 1], `${label}.paletteId`),
    sequencePhase: choice(parsed.sequencePhase, [0, 1, 2, 3], `${label}.sequencePhase`),
    uncertainCells: integerValue(parsed.uncertainCells, `${label}.uncertainCells`, 0, 65_535),
    candidateErasures: parseErasureDistribution(
      parsed.candidateErasures,
      `${label}.candidateErasures`,
    ),
    erasureCandidateScore: parseClassifierDistribution(
      parsed.erasureCandidateScore,
      `${label}.erasureCandidateScore`,
    ),
    codedBytesSha256: sha256Value(parsed.codedBytesSha256, `${label}.codedBytesSha256`),
  };
}

function parseUnwrapOracle(value: unknown, label: string): UnwrapOracle {
  const parsed = record(value, label);
  if (parsed.status === "rejected") {
    assertKeys(parsed, ["status", "reason"], [], label);
    return { status: "rejected", reason: stringValue(parsed.reason, `${label}.reason`) };
  }
  assert.equal(parsed.status, "valid", `${label}.status must be valid or rejected`);
  assertKeys(
    parsed,
    [
      "status",
      "sessionId",
      "sequence",
      "selectedPolicy",
      "selectedBudgetFraction",
      "selectedMaxErasuresPerShard",
      "attempts",
      "selectedErasures",
      "correctedErrors",
      "correctedBytes",
      "correctedShards",
      "innerFrameSha256",
    ],
    [],
    label,
  );
  return {
    status: "valid",
    sessionId: integerValue(parsed.sessionId, `${label}.sessionId`, 0, 0xffff),
    sequence: integerValue(parsed.sequence, `${label}.sequence`, 0, 0xffff_ffff),
    selectedPolicy: choice(
      parsed.selectedPolicy,
      ["classifier-budgeted", "hard-decision"],
      `${label}.selectedPolicy`,
    ),
    selectedBudgetFraction: choice(
      parsed.selectedBudgetFraction,
      [0, 0.5, 0.75, 1],
      `${label}.selectedBudgetFraction`,
    ),
    selectedMaxErasuresPerShard: integerValue(
      parsed.selectedMaxErasuresPerShard,
      `${label}.selectedMaxErasuresPerShard`,
      0,
      32,
    ),
    attempts: integerValue(parsed.attempts, `${label}.attempts`, 1, 4),
    selectedErasures: parseErasureDistribution(
      parsed.selectedErasures,
      `${label}.selectedErasures`,
    ),
    correctedErrors: integerValue(parsed.correctedErrors, `${label}.correctedErrors`, 0, 65_535),
    correctedBytes: integerValue(parsed.correctedBytes, `${label}.correctedBytes`, 0, 65_535),
    correctedShards: integerValue(parsed.correctedShards, `${label}.correctedShards`, 0, 255),
    innerFrameSha256: sha256Value(parsed.innerFrameSha256, `${label}.innerFrameSha256`),
  };
}

function parseMetadata(value: unknown, fixtureName: string): PhysicalCaptureMetadata {
  const label = `${fixtureName}/metadata.json`;
  const parsed = record(value, label);
  assertKeys(
    parsed,
    ["$schema", "schema", "version", "provenance", "rawFrame", "camera", "configuration", "oracle"],
    [],
    label,
  );
  assert.equal(parsed.$schema, "../metadata.schema.json", `${label} must reference the checked-in schema`);
  assert.equal(parsed.schema, "cvtp-color4-physical-capture", `${label}.schema is unsupported`);
  assert.equal(parsed.version, 1, `${label}.version is unsupported`);

  const provenance = record(parsed.provenance, `${label}.provenance`);
  assertKeys(
    provenance,
    ["kind", "device", "browser"],
    ["operatingSystem", "capturedAt", "notes"],
    `${label}.provenance`,
  );
  assert.equal(
    provenance.kind,
    "physical-camera",
    `${label} must attest a real optical camera capture; synthetic images do not belong here`,
  );
  stringValue(provenance.device, `${label}.provenance.device`);
  stringValue(provenance.browser, `${label}.provenance.browser`);
  if (provenance.operatingSystem !== undefined) {
    stringValue(provenance.operatingSystem, `${label}.provenance.operatingSystem`);
  }
  if (provenance.notes !== undefined) stringValue(provenance.notes, `${label}.provenance.notes`);
  if (provenance.capturedAt !== undefined) {
    const capturedAt = stringValue(provenance.capturedAt, `${label}.provenance.capturedAt`);
    assert.ok(Number.isFinite(Date.parse(capturedAt)), `${label}.provenance.capturedAt must be ISO-8601`);
  }

  const rawFrame = record(parsed.rawFrame, `${label}.rawFrame`);
  assertKeys(
    rawFrame,
    ["width", "height", "pngSha256", "rgbaSha256", "preparation", "scope"],
    [],
    `${label}.rawFrame`,
  );
  const parsedRawFrameBase = {
    width: integerValue(rawFrame.width, `${label}.rawFrame.width`, 1, 32_768),
    height: integerValue(rawFrame.height, `${label}.rawFrame.height`, 1, 32_768),
    pngSha256: sha256Value(rawFrame.pngSha256, `${label}.rawFrame.pngSha256`),
    rgbaSha256: sha256Value(rawFrame.rgbaSha256, `${label}.rawFrame.rgbaSha256`),
  };
  const preparation = choice(
    rawFrame.preparation,
    ["unaltered-export", "privacy-crop", "privacy-redacted"],
    `${label}.rawFrame.preparation`,
  );
  const scope = choice(
    rawFrame.scope,
    ["full-camera-frame", "limited-evidence"],
    `${label}.rawFrame.scope`,
  );
  assert.equal(
    scope,
    preparation === "unaltered-export" ? "full-camera-frame" : "limited-evidence",
    `${label}.rawFrame: cropped or redacted pixels must have limited-evidence scope`,
  );
  const parsedRawFrame = { ...parsedRawFrameBase, preparation, scope } as const;

  const camera = record(parsed.camera, `${label}.camera`);
  assertKeys(
    camera,
    ["requested", "actual", "distanceM", "angleDeg"],
    [],
    `${label}.camera`,
  );
  parseCaptureSettings(camera.requested, `${label}.camera.requested`);
  const actualCapture = parseCaptureSettings(camera.actual, `${label}.camera.actual`);
  if (scope === "full-camera-frame") {
    assert.equal(
      parsedRawFrame.width,
      actualCapture.width,
      `${label}: full-frame PNG width must match actual camera width`,
    );
    assert.equal(
      parsedRawFrame.height,
      actualCapture.height,
      `${label}: full-frame PNG height must match actual camera height`,
    );
  }
  assert.ok(numberValue(camera.distanceM, `${label}.camera.distanceM`) >= 0);
  const angle = numberValue(camera.angleDeg, `${label}.camera.angleDeg`);
  assert.ok(angle >= -90 && angle <= 90, `${label}.camera.angleDeg is outside -90..90`);

  const configuration = record(parsed.configuration, `${label}.configuration`);
  assertKeys(
    configuration,
    [
      "carrier",
      "expectedProfile",
      "palette",
      "paletteId",
      "txFps",
      "prefilterMode",
      "brightness",
      "canonicalScale",
      "maxDetectionDimension",
    ],
    [],
    `${label}.configuration`,
  );
  assert.equal(configuration.carrier, "COLOR_4", `${label}.configuration.carrier must be COLOR_4`);
  const expectedProfile = choice(
    configuration.expectedProfile,
    ["ROBUST", "EXPERIMENTAL"],
    `${label}.configuration.expectedProfile`,
  );
  const palette = choice(configuration.palette, ["KCMY", "KRGB"], `${label}.configuration.palette`);
  const paletteId = choice(configuration.paletteId, [0, 1], `${label}.configuration.paletteId`);
  assert.equal(paletteId, palette === "KCMY" ? 0 : 1, `${label} palette name/id disagree`);
  const parsedConfiguration: PhysicalCaptureConfiguration = {
    carrier: "COLOR_4",
    expectedProfile,
    palette,
    paletteId,
    txFps: choice(configuration.txFps, [1, 2, 5, 10], `${label}.configuration.txFps`),
    prefilterMode: choice(
      configuration.prefilterMode,
      ["observe", "enabled"],
      `${label}.configuration.prefilterMode`,
    ),
    brightness: choice(
      configuration.brightness,
      ["high", "maximum"],
      `${label}.configuration.brightness`,
    ),
    canonicalScale: choice(
      configuration.canonicalScale,
      [4, 6, 8],
      `${label}.configuration.canonicalScale`,
    ),
    maxDetectionDimension: choice(
      configuration.maxDetectionDimension,
      [960, 1280, "source"],
      `${label}.configuration.maxDetectionDimension`,
    ),
  };

  const oracleRecord = record(parsed.oracle, `${label}.oracle`);
  const basis = parseOracleBasis(oracleRecord.basis, `${label}.oracle.basis`);
  const vision = parseVisionOracle(oracleRecord.vision, `${label}.oracle.vision`);
  let oracle: PhysicalCaptureOracle;
  if (vision.status === "rejected") {
    assertKeys(oracleRecord, ["basis", "vision", "rejection"], [], `${label}.oracle`);
    const rejection = parseRejectionOracle(
      oracleRecord.rejection,
      `${label}.oracle.rejection`,
    );
    assert.equal(
      rejection.internalReason,
      vision.reason,
      `${label}.oracle rejection/internal vision reasons disagree`,
    );
    oracle = { basis, vision, rejection };
  } else {
    const classifier = parseClassifierOracle(
      oracleRecord.classifier,
      `${label}.oracle.classifier`,
    );
    if (classifier.status === "rejected") {
      assertKeys(
        oracleRecord,
        ["basis", "vision", "classifier", "rejection"],
        [],
        `${label}.oracle`,
      );
      const rejection = parseRejectionOracle(
        oracleRecord.rejection,
        `${label}.oracle.rejection`,
      );
      assert.equal(
        rejection.internalReason,
        classifier.reason,
        `${label}.oracle rejection/internal classifier reasons disagree`,
      );
      oracle = { basis, vision, classifier, rejection };
    } else {
      const unwrap = parseUnwrapOracle(oracleRecord.unwrap, `${label}.oracle.unwrap`);
      if (unwrap.status === "rejected") {
        assertKeys(
          oracleRecord,
          ["basis", "vision", "classifier", "unwrap", "rejection"],
          [],
          `${label}.oracle`,
        );
        const rejection = parseRejectionOracle(
          oracleRecord.rejection,
          `${label}.oracle.rejection`,
        );
        assert.equal(
          rejection.internalReason,
          unwrap.reason,
          `${label}.oracle rejection/internal unwrap reasons disagree`,
        );
        oracle = { basis, vision, classifier, unwrap, rejection };
      } else {
        assertKeys(
          oracleRecord,
          ["basis", "vision", "classifier", "unwrap"],
          [],
          `${label}.oracle`,
        );
        oracle = { basis, vision, classifier, unwrap };
      }
    }
  }

  if (scope === "limited-evidence" && oracle.vision.status === "rejected") {
    assert.notEqual(
      oracle.vision.reason,
      "CANDIDATE_BUDGET_EXCEEDED",
      `${label}: cropped or redacted pixels cannot serve as a candidate-budget oracle`,
    );
  }
  if (basis.kind === "crc-derived-regression") {
    assert.equal(
      oracle.unwrap?.status,
      "valid",
      `${label}: a CRC-derived regression oracle must pin a CRC-valid unwrap`,
    );
  }

  return { rawFrame: parsedRawFrame, configuration: parsedConfiguration, oracle };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function erasureDistribution(
  erasures: ArrayLike<number>,
  shards: number,
): ErasureDistributionOracle {
  const byShard = Array.from({ length: shards }, () => 0);
  for (const index of Array.from(erasures)) {
    const shard = shardPosition(index, shards).shard;
    byShard[shard] = (byShard[shard] ?? 0) + 1;
  }
  return { total: erasures.length, byShard };
}

function legacySaturatedShardErasures(
  byteErasures: ArrayLike<number>,
  profile: Color4Profile,
): Uint16Array {
  const counts = erasureDistribution(byteErasures, profile.shards).byShard;
  const parity = profile.rsN - profile.rsK;
  return Uint16Array.from(Array.from(byteErasures).filter((index) =>
    counts[shardPosition(index, profile.shards).shard]! <= parity
  ));
}

function classifierRejectionStage(reason: string): RejectionStage {
  if (reason === "invalid_geometry" || reason === "invalid_dimensions") return "geometry";
  if (reason === "calibration_failed") return "calibration";
  if (
    reason === "invalid_bootstrap" ||
    reason === "unsupported_version" ||
    reason === "unsupported_profile" ||
    reason === "unsupported_palette" ||
    reason === "phase_mismatch"
  ) {
    return "bootstrap";
  }
  return "classification";
}

function assertRejection(
  fixtureName: string,
  expected: RejectionOracle | undefined,
  actual: RejectionOracle,
): void {
  assert.ok(expected, `${fixtureName}: a rejected oracle requires explicit rejection metadata`);
  assert.deepEqual(expected, actual, `${fixtureName}: rejection diagnostics changed`);
}

function installImageData(): void {
  if (typeof ImageData !== "undefined") return;
  class PhysicalReplayImageData {
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
    value: PhysicalReplayImageData,
  });
}

async function loadOpenCv(): Promise<OpenCvRuntime> {
  const imported = (await import("@techstark/opencv-js")) as unknown as Record<string, unknown>;
  const candidate = (imported.default ?? imported) as
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;
  const runtime = await Promise.resolve(candidate);
  if (runtime.ready && typeof (runtime.ready as Promise<unknown>).then === "function") {
    await runtime.ready;
  } else if (runtime.Mat === undefined) {
    await new Promise<void>((resolve) => {
      runtime.onRuntimeInitialized = resolve;
    });
  }
  return runtime as unknown as OpenCvRuntime;
}

async function replayFixture(
  context: TestContext,
  cv: OpenCvRuntime,
  fixtureName: string,
): Promise<boolean> {
  const directory = join(FIXTURE_ROOT, fixtureName);
  const [pngBytes, metadataBytes] = await Promise.all([
    readFile(join(directory, "raw-frame.png")),
    readFile(join(directory, "metadata.json")),
  ]);
  const metadata = parseMetadata(JSON.parse(metadataBytes.toString("utf8")), fixtureName);
  assert.equal(
    sha256(pngBytes),
    metadata.rawFrame.pngSha256,
    `${fixtureName}: compressed PNG SHA-256 differs from metadata`,
  );
  const png = PNG.sync.read(pngBytes, { checkCRC: true });
  assert.equal(png.width, metadata.rawFrame.width, `${fixtureName}: PNG width differs from metadata`);
  assert.equal(png.height, metadata.rawFrame.height, `${fixtureName}: PNG height differs from metadata`);
  assert.equal(
    png.data.length,
    png.width * png.height * 4,
    `${fixtureName}: pngjs did not produce a complete RGBA plane`,
  );
  assert.equal(
    sha256(png.data),
    metadata.rawFrame.rgbaSha256,
    `${fixtureName}: decoded RGBA SHA-256 differs from metadata`,
  );

  const normalized = normalizeColor4WithOpenCv(
    cv,
    png.width,
    png.height,
    Uint8ClampedArray.from(png.data),
    {
      canonicalScale: metadata.configuration.canonicalScale,
      maxDetectionDimension: metadata.configuration.maxDetectionDimension,
    },
  );
  assert.equal(
    normalized.diagnostics.config.canonicalScale,
    metadata.configuration.canonicalScale,
    `${fixtureName}: OpenCV canonical scale differs from metadata`,
  );
  assert.equal(
    normalized.diagnostics.config.maxDetectionDimension,
    metadata.configuration.maxDetectionDimension,
    `${fixtureName}: OpenCV detection limit differs from metadata`,
  );
  assert.equal(
    normalized.status,
    metadata.oracle.vision.status,
    `${fixtureName}: vision outcome changed`,
  );
  if (normalized.status === "rejected") {
    assert.equal(metadata.oracle.vision.status, "rejected");
    assert.equal(normalized.reason, metadata.oracle.vision.reason, `${fixtureName}: vision reason changed`);
    assertRejection(fixtureName, metadata.oracle.rejection, {
      stage: "geometry",
      publicReason: "invalid-inner-frame",
      internalReason: normalized.reason,
      diagnosticReason: canonicalDiagnosticReason(normalized.reason, undefined) ?? null,
    });
    return false;
  }
  assert.equal(metadata.oracle.vision.status, "valid");

  const classifierObservations: CanonicalRasterObservation[] = [];
  const classified = decodeCanonicalColor4Raster(normalized.image, {
    observer: (observation) => classifierObservations.push(observation),
  });
  const classifierOracle = metadata.oracle.classifier;
  assert.ok(classifierOracle, `${fixtureName}: a valid vision oracle requires a classifier oracle`);
  assert.equal(classified.status, classifierOracle.status, `${fixtureName}: classifier outcome changed`);
  if (classified.status === "rejected") {
    assert.equal(classifierOracle.status, "rejected");
    assert.equal(classified.reason, classifierOracle.reason, `${fixtureName}: classifier reason changed`);
    const rejectedStage = classifierObservations.find(
      (observation) => observation.outcome === "rejected",
    )?.stage;
    assertRejection(fixtureName, metadata.oracle.rejection, {
      stage: classifierRejectionStage(classified.reason),
      publicReason: "invalid-inner-frame",
      internalReason: classified.reason,
      diagnosticReason: canonicalDiagnosticReason(
        classified.reason,
        classified.diagnostics,
        rejectedStage,
      ) ?? null,
    });
    return false;
  }
  assert.equal(classifierOracle.status, "valid");
  assert.equal(classified.profile.name, metadata.configuration.expectedProfile, `${fixtureName}: profile differs from configuration`);
  assert.equal(classified.profile.name, classifierOracle.profile, `${fixtureName}: profile differs from oracle`);
  assert.equal(classified.paletteId, metadata.configuration.paletteId, `${fixtureName}: palette differs from configuration`);
  assert.equal(classified.paletteId, classifierOracle.paletteId, `${fixtureName}: palette differs from oracle`);
  assert.equal(classified.sequencePhase, classifierOracle.sequencePhase, `${fixtureName}: phase changed`);
  assert.equal(
    classified.diagnostics.uncertainCells,
    classifierOracle.uncertainCells,
    `${fixtureName}: uncertain cell count changed`,
  );
  assert.deepEqual(
    erasureDistribution(classified.byteErasures, classified.profile.shards),
    classifierOracle.candidateErasures,
    `${fixtureName}: classifier candidate erasures changed`,
  );
  assertClassifierDistribution(
    classified.diagnostics.erasureCandidateScore,
    classifierOracle.erasureCandidateScore,
    `${fixtureName}: classifier erasure severity distribution changed`,
  );
  assert.equal(
    classifierOracle.candidateErasures.byShard.length,
    classified.profile.shards,
    `${fixtureName}: candidate erasure shard count differs from the profile`,
  );
  assert.equal(
    sha256(classified.codedBytes),
    classifierOracle.codedBytesSha256,
    `${fixtureName}: classified coded bytes changed`,
  );

  const coordinated = runColor4ErasurePolicy({
    codedBytes: classified.codedBytes,
    profile: classified.profile,
    paletteId: classified.paletteId,
    erasureCandidates: classified.byteErasureCandidates,
    expectedSequencePhase: classified.sequencePhase,
  });
  const unwrapped = coordinated.result;
  const unwrapObservations = coordinated.selectedObservations;
  const unwrapOracle = metadata.oracle.unwrap;
  assert.ok(unwrapOracle, `${fixtureName}: a valid classifier oracle requires an unwrap oracle`);
  assert.equal(unwrapped.status, unwrapOracle.status, `${fixtureName}: unwrap outcome changed`);
  if (unwrapped.status === "rejected") {
    assert.equal(unwrapOracle.status, "rejected");
    assert.equal(unwrapped.reason, unwrapOracle.reason, `${fixtureName}: unwrap reason changed`);
    const diagnosticReason = fecDiagnosticReason(
      unwrapped.reason,
      unwrapObservations.flatMap((observation) =>
        observation.stage === "rs"
          ? observation.shards.map((shard) => shard.reason)
          : [],
      ),
      coordinated.saturatedErasureShards.length > 0,
    ) ?? null;
    assertRejection(fixtureName, metadata.oracle.rejection, {
      stage: unwrapped.reason === "fec-uncorrectable"
        ? "rs"
        : unwrapped.reason === "crc-mismatch"
          ? "crc"
          : "wire",
      publicReason: unwrapped.reason,
      internalReason: unwrapped.reason,
      diagnosticReason,
    });
    return false;
  }
  assert.equal(unwrapOracle.status, "valid");
  assert.equal(
    coordinated.selectedPolicy,
    unwrapOracle.selectedPolicy,
    `${fixtureName}: selected erasure policy changed`,
  );
  assert.equal(
    coordinated.selectedBudgetFraction,
    unwrapOracle.selectedBudgetFraction,
    `${fixtureName}: selected erasure budget fraction changed`,
  );
  assert.equal(
    coordinated.selectedMaxErasuresPerShard,
    unwrapOracle.selectedMaxErasuresPerShard,
    `${fixtureName}: selected per-shard erasure budget changed`,
  );
  assert.equal(
    coordinated.attempts.length,
    unwrapOracle.attempts,
    `${fixtureName}: erasure-policy attempt count changed`,
  );
  assert.deepEqual(
    erasureDistribution(coordinated.selectedErasures, classified.profile.shards),
    unwrapOracle.selectedErasures,
    `${fixtureName}: selected erasures changed`,
  );
  assert.equal(
    unwrapOracle.selectedErasures.byShard.length,
    classified.profile.shards,
    `${fixtureName}: selected erasure shard count differs from the profile`,
  );
  assert.equal(unwrapped.header.sessionId, unwrapOracle.sessionId, `${fixtureName}: session changed`);
  assert.equal(unwrapped.header.sequence, unwrapOracle.sequence, `${fixtureName}: sequence changed`);
  assert.equal(
    color4SequencePhaseMatches(unwrapped.header.sequence, classified.sequencePhase),
    true,
    `${fixtureName}: unwrapped sequence no longer matches the physical Gray phase`,
  );
  assert.equal(
    unwrapped.diagnostics.correctedErrors,
    unwrapOracle.correctedErrors,
    `${fixtureName}: corrected error count changed`,
  );
  assert.equal(
    unwrapped.diagnostics.correctedBytes,
    unwrapOracle.correctedBytes,
    `${fixtureName}: corrected byte count changed`,
  );
  assert.equal(
    unwrapped.diagnostics.correctedShards,
    unwrapOracle.correctedShards,
    `${fixtureName}: corrected shard count changed`,
  );
  const crc = unwrapObservations.find((observation) => observation.stage === "crc");
  assert.equal(crc?.stage, "crc", `${fixtureName}: CRC observation is missing`);
  if (crc?.stage === "crc") {
    assert.equal(crc.valid, true, `${fixtureName}: CRC32C must validate`);
    assert.equal(crc.outcome, "completed", `${fixtureName}: CRC stage must complete`);
  }
  const wire = unwrapObservations.find((observation) => observation.stage === "wire");
  assert.equal(wire?.stage, "wire", `${fixtureName}: wire observation is missing`);
  if (wire?.stage === "wire") {
    assert.equal(wire.outerHeaderValid, true, `${fixtureName}: outer header must validate`);
    assert.equal(wire.innerFrameValid, true, `${fixtureName}: inner frame must validate`);
    assert.equal(wire.identityValid, true, `${fixtureName}: frame identity must validate`);
  }
  assert.equal(
    sha256(unwrapped.innerFrame),
    unwrapOracle.innerFrameSha256,
    `${fixtureName}: unwrapped inner frame changed`,
  );
  const isIndependentFullFrame =
    metadata.oracle.basis.kind === "independent-tx-ground-truth" &&
    metadata.rawFrame.scope === "full-camera-frame";
  let differentiatesLegacyPolicy = false;
  if (isIndependentFullFrame) {
    const legacyAttempts = [
      legacySaturatedShardErasures(classified.byteErasures, classified.profile),
      new Uint16Array(),
    ].map((erasures) => unwrapColor4Frame(classified.codedBytes, {
      profileId: classified.profile.id,
      paletteId: classified.paletteId,
      erasures,
    }));
    differentiatesLegacyPolicy = legacyAttempts.every((attempt) =>
      attempt.status === "rejected" ||
      !color4SequencePhaseMatches(attempt.header.sequence, classified.sequencePhase)
    );
  }
  context.diagnostic(
    `${fixtureName}: ${png.width}x${png.height}, ${classified.profile.name}/${metadata.configuration.palette}, oracle=${metadata.oracle.basis.kind}, differentiatesLegacy=${differentiatesLegacyPolicy}`,
  );
  return isIndependentFullFrame && differentiatesLegacyPolicy;
}

test("real COLOR_4 camera captures replay through OpenCV and the carrier", {
  timeout: 120_000,
}, async (context) => {
  const fixtureDirectories = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (fixtureDirectories.length === 0) {
    const message =
      `No physical COLOR_4 fixtures found in ${FIXTURE_ROOT}. ` +
      "Add <case>/raw-frame.png + metadata.json; synthetic images must stay in the synthetic corpus.";
    if (REQUIRE_PHYSICAL_FIXTURES || REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE) {
      assert.fail(message);
    }
    context.skip(`${message} Set CVTP_REQUIRE_PHYSICAL_FIXTURES=1 to make this an acceptance failure.`);
    return;
  }

  if (REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE) {
    const fixtureMetadata = await Promise.all(fixtureDirectories.map(async (fixtureName) => {
      const metadataBytes = await readFile(join(FIXTURE_ROOT, fixtureName, "metadata.json"));
      return parseMetadata(
        JSON.parse(metadataBytes.toString("utf8")),
        fixtureName,
      );
    }));
    assert.ok(
      fixtureMetadata.some((metadata) =>
        metadata.oracle.basis.kind === "independent-tx-ground-truth" &&
        metadata.oracle.unwrap?.status === "valid" &&
        metadata.rawFrame.scope === "full-camera-frame"
      ),
      "Release acceptance requires at least one valid, full-camera-frame physical " +
        "COLOR_4 unwrap with oracle.basis.kind=independent-tx-ground-truth.",
    );
  }

  installImageData();
  const cv = await loadOpenCv();
  let differentiatingIndependentFixtures = 0;
  for (const fixtureName of fixtureDirectories) {
    await context.test(fixtureName, async (fixtureContext) => {
      if (await replayFixture(fixtureContext, cv, fixtureName)) {
        differentiatingIndependentFixtures++;
      }
    });
  }
  if (REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE) {
    assert.ok(
      differentiatingIndependentFixtures > 0,
      "Release acceptance requires an independent full-camera fixture where both " +
        "legacy erasure selection and hard decision reject, while ranked erasures " +
        "recover the exact inner frame.",
    );
  }
});
