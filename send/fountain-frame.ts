import { LTEncoder } from "../shared/fountain";
import { fnv1a, packFrame, type FrameHeader } from "../shared/protocol";

export interface FountainSessionMetadata {
  readonly sessionId: number;
  readonly k: number;
  readonly blockLen: number;
  readonly totalLen: number;
  readonly payloadFnv: number;
}

/**
 * The wire-format part of a sender session. Browser code instantiates this
 * only inside fountain-worker.ts; keeping it independent from Worker globals
 * also lets golden-vector tests exercise the exact worker implementation.
 */
export class FountainFrameGenerator {
  readonly metadata: FountainSessionMetadata;
  private readonly encoder: LTEncoder;
  private readonly header: FrameHeader;

  constructor(payload: Uint8Array, blockLen: number, sessionId: number) {
    this.encoder = new LTEncoder(payload, blockLen, sessionId);
    this.header = {
      sessionId,
      seq: 0,
      k: this.encoder.k,
      blockLen,
      totalLen: payload.length,
      payloadFnv: fnv1a(payload),
    };
    this.metadata = {
      sessionId,
      k: this.encoder.k,
      blockLen,
      totalLen: payload.length,
      payloadFnv: this.header.payloadFnv,
    };
  }

  encode(sequence: number): Uint8Array<ArrayBuffer> {
    return packFrame(
      { ...this.header, seq: sequence },
      this.encoder.encode(sequence),
    ) as Uint8Array<ArrayBuffer>;
  }
}
