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

interface FecDecodeSuccess {
  readonly pdu: Uint8Array;
  readonly erasures: number;
  readonly correctedErrors: number;
  readonly correctedBytes: number;
  readonly correctedShards: number;
}

function decodeFec(
  codedBytes: Uint8Array,
  profile: Color4Profile,
  paletteId: Color4PaletteId,
  erasureInput: Color4ErasureInput | undefined,
): FecDecodeSuccess | null {
  const erasures = erasureValues(erasureInput);
  if (
    erasures.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= profile.codedBytes,
    )
  ) {
    return null;
  }
  const uniqueErasures = [...new Set(erasures)];
  const byShard = Array.from({ length: profile.shards }, () => new Set<number>());
  for (const index of uniqueErasures) {
    const mapped = shardPosition(index, profile.shards);
    byShard[mapped.shard]!.add(mapped.position);
  }

  const unwhitened = whiten(codedBytes, profile.id, paletteId);
  const codewords = deinterleaveCodewords(unwhitened, profile.shards, profile.rsN);
  const codec = new ReedSolomonCodec(profile.rsK, profile.rsN - profile.rsK);
  const pdu = new Uint8Array(profile.pduBytes);
  let correctedErrors = 0;
  let correctedBytes = 0;
  let correctedShards = 0;
  for (let shard = 0; shard < profile.shards; shard++) {
    const decoded = codec.decode(codewords[shard]!, byShard[shard]!);
    if (decoded.status === "uncorrectable") return null;
    pdu.set(decoded.data, shard * profile.rsK);
    correctedErrors += decoded.errors;
    correctedBytes += decoded.correctedBytes;
    if (decoded.correctedBytes > 0) correctedShards++;
  }
  return {
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
  fec?: FecDecodeSuccess,
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
): Color4UnwrapResult {
  const diagnostic = diagnostics(
    profile.id,
    paletteId,
    attemptedProfiles,
    attemptedPalettes,
    fec,
  );
  const header = parseColor4OuterHeader(fec.pdu);
  if (
    header === null ||
    header.profileId !== profile.id ||
    header.paletteId !== paletteId ||
    header.innerLength !== profile.innerFrameBytes
  ) {
    return reject("invalid-outer-header", diagnostic);
  }
  if (!hasValidCrc32c(fec.pdu)) return reject("crc-mismatch", diagnostic);
  const innerEnd = COLOR4_OUTER_HEADER_BYTES + header.innerLength;
  if (innerEnd + 4 !== fec.pdu.length) return reject("invalid-outer-header", diagnostic);
  const innerFrame = fec.pdu.slice(COLOR4_OUTER_HEADER_BYTES, innerEnd);
  const parsed = validateInnerFrame(innerFrame, profile);
  if (parsed === null) return reject("invalid-inner-frame", diagnostic);
  if (
    parsed.header.sessionId !== header.sessionId ||
    parsed.header.seq !== header.sequence
  ) {
    return reject("identity-mismatch", diagnostic);
  }
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
  options: Color4UnwrapOptions = {},
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
  for (const profile of candidateProfiles) {
    if (profile.codedBytes !== codedBytes.length) continue;
    attemptedProfiles++;
    for (const paletteId of palettes) {
      attemptedPalettes++;
      const fec = decodeFec(codedBytes, profile, paletteId, options.erasures);
      if (fec === null) continue;
      const result = validateDecodedPdu(
        fec,
        profile,
        paletteId,
        attemptedProfiles,
        attemptedPalettes,
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
    ),
  );
}

/** Exported for deterministic vectors and tooling that operates below whitening. */
export function encodeColor4PduForTesting(pdu: Uint8Array, profile: Color4Profile): Uint8Array {
  return encodePdu(pdu, profile);
}
