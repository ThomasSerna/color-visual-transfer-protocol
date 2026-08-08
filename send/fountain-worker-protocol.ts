import type { FountainSessionMetadata } from "./fountain-frame";

export type FountainWorkerRequest =
  | {
      readonly kind: "init";
      readonly payload: ArrayBuffer;
      readonly blockLen: number;
      readonly sessionId: number;
    }
  | { readonly kind: "frame"; readonly id: number; readonly sequence: number };

export type FountainWorkerResponse =
  | { readonly kind: "ready"; readonly metadata: FountainSessionMetadata }
  | { readonly kind: "frame"; readonly id: number; readonly innerFrame: ArrayBuffer }
  | { readonly kind: "error"; readonly id?: number; readonly reason: string };
