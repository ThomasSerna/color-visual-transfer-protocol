import { parseFrame } from "../protocol";
import { appendCrc32c, hasValidCrc32c } from "./crc";
import { deinterleaveCodewords, interleaveCodewords, shardPosition } from "./interleave";
import {
  COLOR4_PROFILES,
  getColor4Profile,
  type Color4Profile,
  type Color4ProfileId,
} from "./profiles";
import { ReedSolomonCodec } from "./reed-solomon";
import type {
  Color4DecodeDiagnostics,
  Color4EncodedFrame,
  Color4ErasureInput,
  Color4OuterHeader,
  Color4PaletteId,
  Color4UnwrapOptions,
  Color4UnwrapResult,
  RejectReason,
} from "./types";
import { whiten, whitenInPlace } from "./whitening";

export const COLOR4_MAGIC = new Uint8Array([0x44, 0x43, 0x34]); // DC4
export const COLOR4_PHY_VERSION = 1 as const;
export const COLOR4_OUTER_HEADER_BYTES = 16;
export const COLOR4_FLAGS = 0x03 as const;
export const COLOR4_PALETTE_IDS: readonly Color4PaletteId[] = Object.freeze([0, 1]);

export interface Color4RsShardObservation {
  readonly shard: number;
  readonly erasuresRequested: number;
  readonly durationMs: number;
  readonly status: "corrected" | "uncorrectable" | "not-attempted";
  readonly reason?:
    | "invalid-length"
    | "invalid-erasure"
    | "too-many-erasures"
    | "locator"
    | "verification"
    | "invalid-global-erasure";
  readonly errors: number;
  readonly correctedBytes: number;
}

export interface Color4RsObservation {
  readonly stage: "rs";
  readonly durationMs: number;
  readonly outcome: "completed" | "rejected";
  readonly profileId: Color4ProfileId;
  readonly paletteId: Color4PaletteId;
  readonly requestedErasures: number;
  readonly uniqueErasures: number;
  readonly invalidErasures: number;
  readonly correctedErrors: number;
  readonly correctedBytes: number;
  readonly correctedShards: number;
  readonly shards: readonly Color4RsShardObservation[];
}

export interface Color4CrcObservation {
  readonly stage: "crc";
  readonly durationMs: number;
  readonly outcome: "completed" | "rejected";
  readonly profileId: Color4ProfileId;
  readonly paletteId: Color4PaletteId;
  readonly valid: boolean;
}

export interface Color4WireObservation {
  readonly stage: "wire";
  readonly durationMs: number;
  readonly outcome: "completed" | "rejected";
  readonly profileId: Color4ProfileId;
  readonly paletteId: Color4PaletteId;
  readonly reason?: RejectReason;
  readonly outerHeaderValid: boolean;
  readonly lengthValid: boolean;
  readonly innerFrameChecked: boolean;
  readonly innerFrameValid: boolean;
  readonly identityChecked: boolean;
  readonly identityValid: boolean;
}

export type Color4UnwrapObservation =
  | Color4RsObservation
  | Color4CrcObservation
  | Color4WireObservation;

export type Color4UnwrapObserver = (observation: Color4UnwrapObservation) => void;

/** Instrumentation is deliberately private to the unwrap call and never enters wire types. */
export interface InstrumentedColor4UnwrapOptions extends Color4UnwrapOptions {
  readonly clock?: () => number;
  readonly observer?: Color4UnwrapObserver;
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
  observer: Color4UnwrapObserver | undefined,
  observation: Color4UnwrapObservation,
): void {
  if (observer === undefined) return;
  try {
    observer(Object.freeze(observation));
  } catch {
    // Diagnostic consumers must never influence protocol validation.
  }
}

function isPaletteId(id: number): id is Color4PaletteId {
  return COLOR4_PALETTE_IDS.includes(id as Color4PaletteId);
}

function assertUint(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} is outside its wire range.`);
  }
}

function validateInnerFrame(
  innerFrame: Uint8Array,
  profile: Color4Profile,
): ReturnType<typeof parseFrame> {
  if (innerFrame.length !== profile.innerFrameBytes) return null;
  const parsed = parseFrame(innerFrame);
  if (parsed === null || parsed.header.blockLen !== profile.blockBytes) return null;
  const expectedK = Math.ceil(parsed.header.totalLen / parsed.header.blockLen);
  if (expectedK > 0xffff || parsed.header.k !== expectedK) return null;
  return parsed;
}

export function packColor4OuterHeader(header: Color4OuterHeader): Uint8Array {
  assertUint(header.profileId, 0xff, "profileId");
  assertUint(header.paletteId, 0xff, "paletteId");
  assertUint(header.innerLength, 0xffff, "innerLength");
  assertUint(header.sessionId, 0xffff, "sessionId");
  assertUint(header.sequence, 0xffffffff, "sequence");
  const out = new Uint8Array(COLOR4_OUTER_HEADER_BYTES);
  out.set(COLOR4_MAGIC);
  const view = new DataView(out.buffer);
  view.setUint8(3, header.phyVersion);
  view.setUint8(4, header.profileId);
  view.setUint8(5, header.paletteId);
  view.setUint8(6, header.flags);
  view.setUint8(7, header.headerLength);
  view.setUint16(8, header.innerLength, true);
  view.setUint16(10, header.sessionId, true);
  view.setUint32(12, header.sequence, true);
  return out;
}

export function parseColor4OuterHeader(bytes: Uint8Array): Color4OuterHeader | null {
  if (bytes.length < COLOR4_OUTER_HEADER_BYTES) return null;
  if (
    bytes[0] !== COLOR4_MAGIC[0] ||
    bytes[1] !== COLOR4_MAGIC[1] ||
    bytes[2] !== COLOR4_MAGIC[2]
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const phyVersion = view.getUint8(3);
  const profileId = view.getUint8(4);
  const paletteId = view.getUint8(5);
  const flags = view.getUint8(6);
  const headerLength = view.getUint8(7);
  if (
    phyVersion !== COLOR4_PHY_VERSION ||
    getColor4Profile(profileId) === undefined ||
    !isPaletteId(paletteId) ||
    flags !== COLOR4_FLAGS ||
    headerLength !== COLOR4_OUTER_HEADER_BYTES
  ) {
    return null;
  }
  return {
    phyVersion,
    profileId: profileId as Color4ProfileId,
    paletteId,
    flags,
    headerLength,
    innerLength: view.getUint16(8, true),
    sessionId: view.getUint16(10, true),
    sequence: view.getUint32(12, true),
  };
}

function encodePdu(pdu: Uint8Array, profile: Color4Profile): Uint8Array {
  if (pdu.length !== profile.pduBytes) throw new Error("COLOR_4 PDU/profile length mismatch.");
  const codec = new ReedSolomonCodec(profile.rsK, profile.rsN - profile.rsK);
  const codewords: Uint8Array[] = [];
  for (let shard = 0; shard < profile.shards; shard++) {
    codewords.push(codec.encode(pdu.subarray(shard * profile.rsK, (shard + 1) * profile.rsK)));
  }
  return interleaveCodewords(codewords, profile.rsN);
}

export interface WrapColor4Options {
  readonly profileId: Color4ProfileId;
  readonly paletteId: Color4PaletteId;
}

export function wrapColor4Frame(
  innerFrame: Uint8Array,
  options: WrapColor4Options,
): Color4EncodedFrame {
  const profile = getColor4Profile(options.profileId);
  if (profile === undefined) throw new Error("Unsupported COLOR_4 profile.");
  if (!isPaletteId(options.paletteId)) throw new Error("Unsupported COLOR_4 palette.");
  const parsed = validateInnerFrame(innerFrame, profile);
  if (parsed === null) {
    throw new Error(`Inner Decimen frame must be a valid ${profile.innerFrameBytes}-byte frame.`);
  }
  const header: Color4OuterHeader = {
    phyVersion: COLOR4_PHY_VERSION,
    profileId: profile.id,
    paletteId: options.paletteId,
    flags: COLOR4_FLAGS,
    headerLength: COLOR4_OUTER_HEADER_BYTES,
    innerLength: innerFrame.length,
    sessionId: parsed.header.sessionId,
    sequence: parsed.header.seq,
  };
  const body = new Uint8Array(COLOR4_OUTER_HEADER_BYTES + innerFrame.length);
  body.set(packColor4OuterHeader(header));
  body.set(innerFrame, COLOR4_OUTER_HEADER_BYTES);
  const pdu = appendCrc32c(body);
  const codedBytes = encodePdu(pdu, profile);
  whitenInPlace(codedBytes, profile.id, options.paletteId);
  return { profile, header, pdu, codedBytes };
}

function erasureValues(input: Color4ErasureInput | undefined): number[] {
  if (input === undefined) return [];
  return input instanceof Set ? [...input] : Array.from(input);
}

interface FecDecodeSummary {
  readonly erasures: number;
  readonly correctedErrors: number;
  readonly correctedBytes: number;
  readonly correctedShards: number;
}

interface FecDecodeSuccess extends FecDecodeSummary {
  readonly status: "corrected";
  readonly pdu: Uint8Array;
}

interface FecDecodeFailure extends FecDecodeSummary {
  readonly status: "uncorrectable";
}

type FecDecodeResult = FecDecodeSuccess | FecDecodeFailure;

function decodeFec(
  codedBytes: Uint8Array,
  profile: Color4Profile,
  paletteId: Color4PaletteId,
  erasureInput: Color4ErasureInput | undefined,
  observer: Color4UnwrapObserver | undefined,
  clock: (() => number) | undefined,
): FecDecodeResult {
  const observing = observer !== undefined;
  const startedAt = observing ? readClock(clock) : 0;
  const erasures = erasureValues(erasureInput);
  const validErasures = erasures.filter(
    (index) => Number.isInteger(index) && index >= 0 && index < profile.codedBytes,
  );
  const invalidErasures = erasures.length - validErasures.length;
  const uniqueErasures = [...new Set(validErasures)];
  const byShard = Array.from({ length: profile.shards }, () => new Set<number>());
  for (const index of uniqueErasures) {
    const mapped = shardPosition(index, profile.shards);
    byShard[mapped.shard]!.add(mapped.position);
  }

  if (invalidErasures > 0) {
    const timing = observing
      ? elapsedSince(clock, startedAt)
      : { endedAt: 0, durationMs: 0 };
    const shards = Object.freeze(
      byShard.map((positions, shard) => Object.freeze({
        shard,
        erasuresRequested: positions.size,
        durationMs: 0,
        status: "not-attempted" as const,
        reason: "invalid-global-erasure" as const,
        errors: 0,
        correctedBytes: 0,
      })),
    );
    notifyObserver(observer, {
      stage: "rs",
      durationMs: timing.durationMs,
      outcome: "rejected",
      profileId: profile.id,
      paletteId,
      requestedErasures: erasures.length,
      uniqueErasures: uniqueErasures.length,
      invalidErasures,
      correctedErrors: 0,
      correctedBytes: 0,
      correctedShards: 0,
      shards,
    });
    return {
      status: "uncorrectable",
      erasures: uniqueErasures.length,
      correctedErrors: 0,
      correctedBytes: 0,
      correctedShards: 0,
    };
  }

  const unwhitened = whiten(codedBytes, profile.id, paletteId);
  const codewords = deinterleaveCodewords(unwhitened, profile.shards, profile.rsN);
  const codec = new ReedSolomonCodec(profile.rsK, profile.rsN - profile.rsK);
  const pdu = new Uint8Array(profile.pduBytes);
  let correctedErrors = 0;
  let correctedBytes = 0;
  let correctedShards = 0;
  const shardObservations: Color4RsShardObservation[] = [];
  for (let shard = 0; shard < profile.shards; shard++) {
    const shardStartedAt = observing ? readClock(clock) : 0;
    const decoded = codec.decode(codewords[shard]!, byShard[shard]!);
    const shardTiming = observing
      ? elapsedSince(clock, shardStartedAt)
      : { endedAt: 0, durationMs: 0 };
    if (decoded.status === "uncorrectable") {
      shardObservations.push(Object.freeze({
        shard,
        erasuresRequested: byShard[shard]!.size,
        durationMs: shardTiming.durationMs,
        status: "uncorrectable",
        reason: decoded.reason,
        errors: 0,
        correctedBytes: 0,
      }));
      for (let remaining = shard + 1; remaining < profile.shards; remaining++) {
        shardObservations.push(Object.freeze({
          shard: remaining,
          erasuresRequested: byShard[remaining]!.size,
          durationMs: 0,
          status: "not-attempted",
          errors: 0,
          correctedBytes: 0,
        }));
      }
      const timing = observing
        ? elapsedSince(clock, startedAt)
        : { endedAt: 0, durationMs: 0 };
      notifyObserver(observer, {
        stage: "rs",
        durationMs: timing.durationMs,
        outcome: "rejected",
        profileId: profile.id,
        paletteId,
        requestedErasures: erasures.length,
        uniqueErasures: uniqueErasures.length,
        invalidErasures,
        correctedErrors,
        correctedBytes,
        correctedShards,
        shards: Object.freeze(shardObservations),
      });
      return {
        status: "uncorrectable",
        erasures: uniqueErasures.length,
        correctedErrors,
        correctedBytes,
        correctedShards,
      };
    }
    pdu.set(decoded.data, shard * profile.rsK);
    correctedErrors += decoded.errors;
    correctedBytes += decoded.correctedBytes;
    if (decoded.correctedBytes > 0) correctedShards++;
    shardObservations.push(Object.freeze({
      shard,
      erasuresRequested: byShard[shard]!.size,
      durationMs: shardTiming.durationMs,
      status: "corrected",
      errors: decoded.errors,
      correctedBytes: decoded.correctedBytes,
    }));
  }
  const timing = observing
    ? elapsedSince(clock, startedAt)
    : { endedAt: 0, durationMs: 0 };
  notifyObserver(observer, {
    stage: "rs",
    durationMs: timing.durationMs,
    outcome: "completed",
    profileId: profile.id,
    paletteId,
    requestedErasures: erasures.length,
    uniqueErasures: uniqueErasures.length,
    invalidErasures,
    correctedErrors,
    correctedBytes,
    correctedShards,
    shards: Object.freeze(shardObservations),
  });
  return {
    status: "corrected",
    pdu,
    erasures: uniqueErasures.length,
    correctedErrors,
    correctedBytes,
    correctedShards,
  };
}

function diagnostics(
  profileId: Color4ProfileId | undefined,
  paletteId: Color4PaletteId | undefined,
  attemptedProfiles: number,
  attemptedPalettes: number,
  fec?: FecDecodeSummary,
): Color4DecodeDiagnostics {
  return {
    profileId,
    paletteId,
    erasures: fec?.erasures ?? 0,
    correctedErrors: fec?.correctedErrors ?? 0,
    correctedBytes: fec?.correctedBytes ?? 0,
    correctedShards: fec?.correctedShards ?? 0,
    attemptedProfiles,
    attemptedPalettes,
  };
}

function reject(
  reason: RejectReason,
  diagnostic: Color4DecodeDiagnostics,
): Color4UnwrapResult {
  return { status: "rejected", reason, diagnostics: diagnostic };
}

function validateDecodedPdu(
  fec: FecDecodeSuccess,
  profile: Color4Profile,
  paletteId: Color4PaletteId,
  attemptedProfiles: number,
  attemptedPalettes: number,
  observer: Color4UnwrapObserver | undefined,
  clock: (() => number) | undefined,
): Color4UnwrapResult {
  const diagnostic = diagnostics(
    profile.id,
    paletteId,
    attemptedProfiles,
    attemptedPalettes,
    fec,
  );
  const observing = observer !== undefined;
  let wireDurationMs = 0;
  let wireStartedAt = observing ? readClock(clock) : 0;
  const header = parseColor4OuterHeader(fec.pdu);
  const outerHeaderValid =
    header !== null &&
    header.profileId === profile.id &&
    header.paletteId === paletteId;
  const headerLengthValid = header !== null && header.innerLength === profile.innerFrameBytes;
  let wireTiming = observing
    ? elapsedSince(clock, wireStartedAt)
    : { endedAt: 0, durationMs: 0 };
  wireDurationMs += wireTiming.durationMs;
  const notifyWire = (
    outcome: "completed" | "rejected",
    reason: RejectReason | undefined,
    lengthValid: boolean,
    innerFrameChecked: boolean,
    innerFrameValid: boolean,
    identityChecked: boolean,
    identityValid: boolean,
  ): void => notifyObserver(observer, {
    stage: "wire",
    durationMs: wireDurationMs,
    outcome,
    profileId: profile.id,
    paletteId,
    ...(reason === undefined ? {} : { reason }),
    outerHeaderValid,
    lengthValid,
    innerFrameChecked,
    innerFrameValid,
    identityChecked,
    identityValid,
  });
  if (header === null || !outerHeaderValid || !headerLengthValid) {
    notifyWire("rejected", "invalid-outer-header", headerLengthValid, false, false, false, false);
    return reject("invalid-outer-header", diagnostic);
  }

  const crcStartedAt = observing ? readClock(clock) : 0;
  const crcValid = hasValidCrc32c(fec.pdu);
  const crcTiming = observing
    ? elapsedSince(clock, crcStartedAt)
    : { endedAt: 0, durationMs: 0 };
  notifyObserver(observer, {
    stage: "crc",
    durationMs: crcTiming.durationMs,
    outcome: crcValid ? "completed" : "rejected",
    profileId: profile.id,
    paletteId,
    valid: crcValid,
  });
  if (!crcValid) {
    notifyWire("completed", undefined, true, false, false, false, false);
    return reject("crc-mismatch", diagnostic);
  }

  wireStartedAt = observing ? readClock(clock) : 0;
  const innerEnd = COLOR4_OUTER_HEADER_BYTES + header.innerLength;
  const pduLengthValid = innerEnd + 4 === fec.pdu.length;
  if (!pduLengthValid) {
    wireTiming = observing
      ? elapsedSince(clock, wireStartedAt)
      : { endedAt: 0, durationMs: 0 };
    wireDurationMs += wireTiming.durationMs;
    notifyWire("rejected", "invalid-outer-header", false, false, false, false, false);
    return reject("invalid-outer-header", diagnostic);
  }
  const innerFrame = fec.pdu.slice(COLOR4_OUTER_HEADER_BYTES, innerEnd);
  const parsed = validateInnerFrame(innerFrame, profile);
  if (parsed === null) {
    wireTiming = observing
      ? elapsedSince(clock, wireStartedAt)
      : { endedAt: 0, durationMs: 0 };
    wireDurationMs += wireTiming.durationMs;
    notifyWire("rejected", "invalid-inner-frame", true, true, false, false, false);
    return reject("invalid-inner-frame", diagnostic);
  }
  if (
    parsed.header.sessionId !== header.sessionId ||
    parsed.header.seq !== header.sequence
  ) {
    wireTiming = observing
      ? elapsedSince(clock, wireStartedAt)
      : { endedAt: 0, durationMs: 0 };
    wireDurationMs += wireTiming.durationMs;
    notifyWire("rejected", "identity-mismatch", true, true, true, true, false);
    return reject("identity-mismatch", diagnostic);
  }
  wireTiming = observing
    ? elapsedSince(clock, wireStartedAt)
    : { endedAt: 0, durationMs: 0 };
  wireDurationMs += wireTiming.durationMs;
  notifyWire("completed", undefined, true, true, true, true, true);
  return {
    status: "valid",
    innerFrame,
    header,
    profile,
    diagnostics: diagnostic,
  };
}

export function unwrapColor4Frame(
  codedBytes: Uint8Array,
  options: InstrumentedColor4UnwrapOptions = {},
): Color4UnwrapResult {
  const candidateProfiles = options.profileId === undefined
    ? COLOR4_PROFILES.filter((profile) => profile.codedBytes === codedBytes.length)
    : [getColor4Profile(options.profileId)].filter(
        (profile): profile is Color4Profile => profile !== undefined,
      );
  if (candidateProfiles.length === 0) {
    return reject("unsupported-profile", diagnostics(undefined, options.paletteId, 0, 0));
  }
  if (candidateProfiles.every((profile) => profile.codedBytes !== codedBytes.length)) {
    return reject(
      "invalid-length",
      diagnostics(options.profileId, options.paletteId, candidateProfiles.length, 0),
    );
  }
  const palettes = options.paletteId === undefined
    ? COLOR4_PALETTE_IDS
    : isPaletteId(options.paletteId)
      ? [options.paletteId]
      : [];
  if (palettes.length === 0) {
    return reject(
      "unsupported-palette",
      diagnostics(options.profileId, undefined, candidateProfiles.length, 0),
    );
  }

  let attemptedProfiles = 0;
  let attemptedPalettes = 0;
  let lastSemanticRejection: Color4UnwrapResult | undefined;
  let lastFecFailure: FecDecodeFailure | undefined;
  for (const profile of candidateProfiles) {
    if (profile.codedBytes !== codedBytes.length) continue;
    attemptedProfiles++;
    for (const paletteId of palettes) {
      attemptedPalettes++;
      const fec = decodeFec(
        codedBytes,
        profile,
        paletteId,
        options.erasures,
        options.observer,
        options.clock,
      );
      if (fec.status === "uncorrectable") {
        lastFecFailure = fec;
        continue;
      }
      const result = validateDecodedPdu(
        fec,
        profile,
        paletteId,
        attemptedProfiles,
        attemptedPalettes,
        options.observer,
        options.clock,
      );
      if (result.status === "valid") return result;
      lastSemanticRejection = result;
    }
  }
  return lastSemanticRejection ?? reject(
    "fec-uncorrectable",
    diagnostics(
      options.profileId ?? candidateProfiles[0]?.id,
      options.paletteId,
      attemptedProfiles,
      attemptedPalettes,
      lastFecFailure,
    ),
  );
}

/** Exported for deterministic vectors and tooling that operates below whitening. */
export function encodeColor4PduForTesting(pdu: Uint8Array, profile: Color4Profile): Uint8Array {
  return encodePdu(pdu, profile);
}
