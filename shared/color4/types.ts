import type { Color4Profile, Color4ProfileId } from "./profiles";

export type CarrierId = "QR_LEGACY" | "COLOR_4";
export type Color4PaletteId = 0 | 1;

export interface FrameContext {
  readonly sessionId: number;
  readonly sequence: number;
}

/** Carrier-specific fields needed only by the COLOR_4 outer envelope. */
export interface Color4FrameContext extends FrameContext {
  readonly profileId: Color4ProfileId;
  readonly paletteId: Color4PaletteId;
}

/** A renderer-neutral visual frame. Raster adapters may add carrier-specific metadata. */
export interface RenderedFrame {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** A camera-neutral captured frame. Vision adapters may use either representation. */
export interface CapturedFrame {
  readonly source: ImageBitmap | ImageData;
  readonly timestamp: number;
}

export interface VisualEncoder<TContext extends FrameContext = FrameContext> {
  readonly carrier: CarrierId;
  encode(innerFrame: Uint8Array, context: TContext): Promise<RenderedFrame>;
}

export interface FrameDiagnostics {
  readonly profileId?: Color4ProfileId;
  readonly paletteId?: Color4PaletteId;
  readonly erasures: number;
  readonly correctedErrors: number;
  readonly correctedBytes: number;
  readonly correctedShards: number;
}

export type RejectReason =
  | "invalid-length"
  | "unsupported-profile"
  | "unsupported-palette"
  | "fec-uncorrectable"
  | "invalid-outer-header"
  | "crc-mismatch"
  | "invalid-inner-frame"
  | "identity-mismatch"
  | "no-symbol";

export type DecodeResult =
  | {
      readonly status: "valid";
      readonly innerFrame: Uint8Array;
      readonly diagnostics: FrameDiagnostics;
    }
  | {
      readonly status: "rejected";
      readonly reason: RejectReason;
      readonly diagnostics: FrameDiagnostics;
    };

export interface VisualDecoder {
  readonly carrier: CarrierId;
  decode(frame: CapturedFrame): Promise<DecodeResult>;
  dispose(): void;
}

export interface Color4OuterHeader {
  readonly phyVersion: 1;
  readonly profileId: Color4ProfileId;
  readonly paletteId: Color4PaletteId;
  readonly flags: 3;
  readonly headerLength: 16;
  readonly innerLength: number;
  readonly sessionId: number;
  readonly sequence: number;
}

export interface Color4EncodedFrame {
  readonly profile: Color4Profile;
  readonly header: Color4OuterHeader;
  /** Header, original Decimen frame, then its little-endian CRC32C. */
  readonly pdu: Uint8Array;
  /** RS-coded, position-major interleaved, whitened visual byte plane. */
  readonly codedBytes: Uint8Array;
}

export type Color4ErasureInput = ArrayLike<number> | ReadonlySet<number>;

export interface Color4UnwrapOptions {
  readonly profileId?: Color4ProfileId;
  readonly paletteId?: Color4PaletteId;
  /** Byte indices in the whitened/interleaved coded plane. */
  readonly erasures?: Color4ErasureInput;
}

export interface Color4DecodeDiagnostics extends FrameDiagnostics {
  readonly attemptedProfiles: number;
  readonly attemptedPalettes: number;
}

export type Color4UnwrapResult =
  | {
      readonly status: "valid";
      readonly innerFrame: Uint8Array;
      readonly header: Color4OuterHeader;
      readonly profile: Color4Profile;
      readonly diagnostics: Color4DecodeDiagnostics;
    }
  | {
      readonly status: "rejected";
      readonly reason: RejectReason;
      readonly diagnostics: Color4DecodeDiagnostics;
    };
