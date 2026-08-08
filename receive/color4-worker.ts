import {
  TOTAL_MODULES,
  decodeCanonicalColor4Raster,
  unwrapColor4Frame,
  type CanonicalRasterResult,
  type Color4PaletteId,
} from "../shared/color4";
import { normalizeColor4WithOpenCv, type OpenCvRuntime } from "./color4-vision";
import { color4SequencePhaseMatches } from "./color4-binding";

interface DecodeRequest {
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  paletteId: Color4PaletteId;
}

interface WorkerDiagnostics {
  profile?: string;
  stage: "geometry" | "bootstrap" | "calibration" | "classification" | "rs" | "crc" | "wire";
  candidates: number;
  uncertainCells: number;
  erasureBytes: number;
  rsCorrectedSymbols: number;
  rsFailures: number;
  crcFailures: number;
  decodeMs: number;
  rejectReason?: string;
  erasures: number;
  correctedErrors: number;
  correctedBytes: number;
  correctedShards: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let openCvPromise: Promise<OpenCvRuntime> | undefined;

async function loadOpenCv(): Promise<OpenCvRuntime> {
  openCvPromise ??= (async () => {
    const imported = (await import("@techstark/opencv-js")) as unknown as Record<string, unknown>;
    const candidate = (imported.default ?? imported) as
      | Record<string, unknown>
      | Promise<Record<string, unknown>>;
    const runtime: Record<string, unknown> = await Promise.resolve(candidate);
    if (runtime.Mat === undefined) {
      await new Promise<void>((resolve) => {
        runtime.onRuntimeInitialized = resolve;
      });
    }
    return runtime as unknown as OpenCvRuntime;
  })();
  return openCvPromise;
}

function classifierStage(reason: string): WorkerDiagnostics["stage"] {
  if (reason === "invalid_geometry" || reason === "invalid_dimensions") return "geometry";
  if (reason === "calibration_failed") return "calibration";
  if (
    reason === "invalid_bootstrap" ||
    reason === "unsupported_version" ||
    reason === "unsupported_profile" ||
    reason === "unsupported_palette" ||
    reason === "phase_mismatch"
  ) return "bootstrap";
  return "classification";
}

function baseDiagnostics(
  raster: CanonicalRasterResult | undefined,
  candidates: number,
  elapsed: number,
): WorkerDiagnostics {
  return {
    profile: raster?.status === "valid" ? raster.profile.name : undefined,
    stage: raster?.status === "rejected" ? classifierStage(raster.reason) : "wire",
    candidates,
    uncertainCells: raster?.diagnostics.uncertainCells ?? 0,
    erasureBytes: raster?.diagnostics.erasureBytes ?? 0,
    rsCorrectedSymbols: 0,
    rsFailures: 0,
    crcFailures: 0,
    decodeMs: elapsed,
    erasures: raster?.diagnostics.erasureBytes ?? 0,
    correctedErrors: 0,
    correctedBytes: 0,
    correctedShards: 0,
  };
}

scope.onmessage = async (event) => {
  const started = performance.now();
  const { id, width, height, rgba, paletteId } = event.data;
  const pixels = new Uint8ClampedArray(rgba);
  let candidates = 0;
  let raster: CanonicalRasterResult | undefined;
  try {
    // Deterministic fast path used by fixtures and by already-normalized input.
    if (width === height && width % TOTAL_MODULES === 0) {
      raster = decodeCanonicalColor4Raster({ width, height, pixels });
    }
    if (raster?.status !== "valid") {
      const cv = await loadOpenCv();
      const normalized = normalizeColor4WithOpenCv(cv, width, height, pixels);
      candidates = normalized.candidates;
      if (normalized.status === "rejected") {
        const diagnostics = baseDiagnostics(undefined, candidates, performance.now() - started);
        diagnostics.stage = "geometry";
        diagnostics.rejectReason = normalized.reason;
        scope.postMessage({ id, status: "rejected", reason: "invalid-inner-frame", diagnostics });
        return;
      }
      raster = decodeCanonicalColor4Raster(normalized.image);
    }
    if (raster.status === "rejected") {
      const diagnostics = baseDiagnostics(raster, candidates, performance.now() - started);
      diagnostics.rejectReason = raster.reason;
      scope.postMessage({ id, status: "rejected", reason: "invalid-inner-frame", diagnostics });
      return;
    }
    if (raster.paletteId !== paletteId) {
      const diagnostics = baseDiagnostics(raster, candidates, performance.now() - started);
      diagnostics.stage = "bootstrap";
      diagnostics.rejectReason = "palette-selection-mismatch";
      scope.postMessage({ id, status: "rejected", reason: "unsupported-palette", diagnostics });
      return;
    }
    const unwrapped = unwrapColor4Frame(raster.codedBytes, {
      profileId: raster.profile.id,
      paletteId,
      erasures: raster.byteErasures,
    });
    const diagnostics = baseDiagnostics(raster, candidates, performance.now() - started);
    diagnostics.erasures = unwrapped.diagnostics.erasures;
    diagnostics.erasureBytes = unwrapped.diagnostics.erasures;
    diagnostics.correctedErrors = unwrapped.diagnostics.correctedErrors;
    diagnostics.correctedBytes = unwrapped.diagnostics.correctedBytes;
    diagnostics.correctedShards = unwrapped.diagnostics.correctedShards;
    diagnostics.rsCorrectedSymbols = unwrapped.diagnostics.correctedBytes;
    diagnostics.profile = raster.profile.name;
    if (unwrapped.status === "rejected") {
      diagnostics.rejectReason = unwrapped.reason;
      if (unwrapped.reason === "fec-uncorrectable") {
        diagnostics.stage = "rs";
        diagnostics.rsFailures = 1;
      } else if (unwrapped.reason === "crc-mismatch") {
        diagnostics.stage = "crc";
        diagnostics.crcFailures = 1;
      } else diagnostics.stage = "wire";
      scope.postMessage({ id, status: "rejected", reason: unwrapped.reason, diagnostics });
      return;
    }
    if (!color4SequencePhaseMatches(unwrapped.header.sequence, raster.sequencePhase)) {
      diagnostics.stage = "bootstrap";
      diagnostics.rejectReason = "sequence-phase-mismatch";
      scope.postMessage({
        id,
        status: "rejected",
        reason: "identity-mismatch",
        diagnostics,
      });
      return;
    }
    const innerFrame = Uint8Array.from(unwrapped.innerFrame);
    scope.postMessage(
      { id, status: "valid", innerFrame: innerFrame.buffer, diagnostics },
      [innerFrame.buffer],
    );
  } catch (error) {
    const diagnostics = baseDiagnostics(raster, candidates, performance.now() - started);
    diagnostics.stage = "wire";
    diagnostics.rejectReason = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id, status: "rejected", reason: "invalid-inner-frame", diagnostics });
  }
};
