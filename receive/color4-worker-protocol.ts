import type {
  BrowserCarrierDiagnostics,
  BrowserColor4UnwrapAttemptDiagnostics,
} from "../shared/carrier";
import type {
  CanonicalRasterObservation,
  Color4PaletteId,
  Color4ProfileId,
  Color4UnwrapObservation,
  RejectReason,
} from "../shared/color4";
import type {
  VisionCanonicalScale,
  VisionDebugArtifacts,
  VisionDebugView,
  VisionDetectionLimit,
} from "./color4-vision-types";
import type {
  Color4ErasureBudgetFraction,
  Color4ErasurePolicy,
} from "./color4-erasure-policy";

export interface Color4WorkerDebugOptions {
  readonly enabled: boolean;
  readonly view: VisionDebugView;
  readonly generation: number;
  readonly canonicalScale: VisionCanonicalScale;
  readonly maxDetectionDimension: VisionDetectionLimit;
  readonly emitPlane: boolean;
  readonly snapshot: boolean;
}

export interface Color4WorkerInitRequest {
  readonly kind: "init";
  readonly id: number;
}

export interface Color4WorkerDecodeRequest {
  readonly kind: "decode";
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: ArrayBuffer;
  readonly paletteId: Color4PaletteId;
  readonly capturedAt: number;
  readonly captureMs: number;
  readonly debug: Color4WorkerDebugOptions;
}

export type Color4WorkerRequest = Color4WorkerInitRequest | Color4WorkerDecodeRequest;

export interface Color4WorkerUnwrapAttemptDiagnostics
  extends BrowserColor4UnwrapAttemptDiagnostics {
  readonly policy: Color4ErasurePolicy;
  readonly budgetFraction: Color4ErasureBudgetFraction;
  readonly maxErasuresPerShard: number;
  readonly erasures: number;
  readonly erasuresByShard: readonly number[];
  readonly phaseMatched?: boolean;
  readonly durationMs: number;
  readonly status: "valid" | "rejected";
  readonly reason?: RejectReason;
}

export interface Color4WorkerDiagnostics extends BrowserCarrierDiagnostics {
  readonly candidates: number;
  readonly uncertainCells: number;
  readonly erasureBytes: number;
  readonly rsCorrectedSymbols: number;
  readonly rsFailures: number;
  readonly crcFailures: number;
  readonly decodeMs: number;
  /** Erasure count used by the selected unwrap attempt, or zero before unwrap. */
  readonly erasures: number;
  readonly correctedErrors: number;
  readonly correctedBytes: number;
  readonly correctedShards: number;
  /** Policy and counts for the selected, protocol-validating unwrap attempt. */
  readonly erasurePolicy?: Color4ErasurePolicy;
  /** Budget rung used by the selected attempt. Absent before unwrap and in legacy snapshots. */
  readonly selectedBudgetFraction?: Color4ErasureBudgetFraction;
  /** Per-shard erasure cap used by the selected attempt. */
  readonly selectedMaxErasuresPerShard?: number;
  /** Aggregate selected erasure counts by shard; never erased-byte positions. */
  readonly selectedErasuresByShard?: readonly number[];
  /** Classifier erasure hints before the per-shard FEC budget is applied. */
  readonly suggestedErasuresByShard?: readonly number[];
  /** Shards whose original hints exceeded their Reed-Solomon parity budget. */
  readonly saturatedErasureShards?: readonly number[];
  /**
   * Bounded unwrap history in deterministic attempt order. Stage timings sum
   * every attempt, while rsFailures/crcFailures describe only the selected
   * final outcome so a rescued frame is not reported as failed.
   */
  readonly unwrapAttempts?: readonly Color4WorkerUnwrapAttemptDiagnostics[];
}

export interface Color4WorkerDebugFrame {
  readonly frameId: number;
  readonly capturedAt: number;
  readonly generation: number;
  readonly view: VisionDebugView;
  readonly maxDetectionDimension: VisionDetectionLimit;
  readonly paletteId: Color4PaletteId;
  readonly planeRequested: boolean;
  readonly snapshot: boolean;
  readonly profileId?: Color4ProfileId;
  readonly artifacts: VisionDebugArtifacts;
  readonly classifier: readonly CanonicalRasterObservation[];
  readonly unwrap: readonly Color4UnwrapObservation[];
}

export interface Color4WorkerReadyResponse {
  readonly kind: "ready";
  readonly id: number;
  readonly opencvInitMs: number;
}

interface Color4WorkerResultBase {
  readonly kind: "result";
  readonly id: number;
  readonly diagnostics: Color4WorkerDiagnostics;
  readonly debug?: Color4WorkerDebugFrame;
}

export interface Color4WorkerValidResponse extends Color4WorkerResultBase {
  readonly status: "valid";
  readonly innerFrame: ArrayBuffer;
}

export interface Color4WorkerRejectedResponse extends Color4WorkerResultBase {
  readonly status: "rejected";
  readonly reason: RejectReason;
}

export type Color4WorkerResponse =
  | Color4WorkerReadyResponse
  | Color4WorkerValidResponse
  | Color4WorkerRejectedResponse;
