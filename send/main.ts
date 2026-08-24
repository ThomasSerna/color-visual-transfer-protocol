// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition; 24 fps on a 60 Hz screen is comfortable.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.

import { fitQrDisplaySize } from "../shared/display";
import { TemporalFrameScheduler } from "../shared/frame-timing";
import { formatBytes } from "../shared/format";
import {
  MAX_SOURCE_BLOCKS,
  blockLength,
  fitsInOneStream,
  minimumFrameBytes,
  smallestSufficientFrameSize,
  sourceBlockCount,
} from "../shared/frame-capacity";
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_LABEL, packSnippet } from "../shared/snippet";
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  packFile,
  type PackedOpticalFile,
} from "../shared/protocol";
import { statusLine } from "../shared/status-line";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock";
import { wireShareDialog } from "../shared/share-dialog";
import { loadColor4Sender } from "../shared/color-loader";
import { loadPreference, savePreference } from "../shared/experiments";
import type { CarrierChoice } from "../shared/carrier";
import { createFountainFrameProducer } from "./fountain-producer";
import { createQrLegacyEncoder } from "./qr-carrier";

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 3;

// `npm run demo` (vite --mode demo). Locks the sender to the two bundled
// payloads so the app can be left running in front of strangers without
// handing them a file picker into the host machine.
const DEMO = import.meta.env.VITE_DEMO === "1";

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const specs = document.getElementById("specs")!;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const filePickerLabel = document.getElementById("file-picker-label")!;
const filePickerButton = document.getElementById("file-picker-button")!;
const toolTitle = document.getElementById("tool-title")!;
const snippetText = document.getElementById("snippet-text") as HTMLTextAreaElement;
const snippetLabel = document.getElementById("snippet-label")!;
const sendSnippetBtn = document.getElementById("send-snippet") as HTMLButtonElement;
const paneFile = document.getElementById("pane-file")!;
const paneSnippet = document.getElementById("pane-snippet")!;
const paneDemo = document.getElementById("pane-demo")!;
const modePicker = document.getElementById("mode-picker")!;
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="send-mode"]')];
const streamSpecs = document.getElementById("stream-specs")!;
const footerHint = document.getElementById("footer-hint")!;
const spec = (id: string) => document.getElementById(id)!;

/** Panels that only mean something while a stream is up: the spec grid at the
 *  bottom of Transfer settings, and the receiver hint under the status line. */
function showStreamPanels(visible: boolean): void {
  streamSpecs.hidden = !visible;
  footerHint.hidden = !visible;
}

const openShareDialog = wireShareDialog();
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;
const carrierPicker = document.getElementById("carrier-picker")!;
const carrierColorOption = __COLOR4_ENABLED__
  ? document.getElementById("carrier-color-option")
  : null;
const carrierInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="carrier"]'),
];
const cfgColorProfile = __COLOR4_ENABLED__
  ? document.getElementById("cfg-color-profile") as HTMLSelectElement | null
  : null;
const cfgColorPalette = __COLOR4_ENABLED__
  ? document.getElementById("cfg-color-palette") as HTMLSelectElement | null
  : null;
const qrSettings = [...document.querySelectorAll<HTMLElement>("[data-qr-setting]")];
const colorSettings = __COLOR4_ENABLED__
  ? [...document.querySelectorAll<HTMLElement>("[data-color-setting]")]
  : [];

let selectedFile: {
  name: string;
  size: number;
  payload: Uint8Array;
  compression: "none" | "gzip";
  transmittedSize: number;
} | null = null;
let generation = 0; // bumped on every restart; stale loops see it and die
let resizeDisplay: (() => void) | null = null;
let colorSenderModule: Awaited<ReturnType<typeof loadColor4Sender>> | null = null;
let activeVisualEncoder: { dispose(): void } | null = null;

const specsLine = statusLine(specs);
const setStatus = specsLine.setStatus;

/**
 * Errors also hide the stage — a stale QR stream pulsing away under a
 * rejection message reads as "still working".
 *
 * Callers decide whether the pick survives. A file rejected on size is gone;
 * a stream that can't start at the current bytes/frame is not, because turning
 * that setting back up is the fix.
 */
function showError(message: string): void {
  activeVisualEncoder?.dispose();
  activeVisualEncoder = null;
  void releaseScreenWakeLock();
  document.body.classList.remove("transfer-active");
  setStageFullscreen(false);
  stage.hidden = true;
  showStreamPanels(false);
  specsLine.showError(message);
}

function currentMode(): "file" | "snippet" {
  return modeInputs.find((input) => input.checked)?.value === "snippet" ? "snippet" : "file";
}

function currentCarrier(): CarrierChoice {
  if (!__COLOR4_ENABLED__) return "qr";
  return carrierInputs.find((input) => input.checked)?.value === "color4" ? "color4" : "qr";
}

async function ensureColorSender() {
  colorSenderModule ??= await loadColor4Sender();
  if (!cfgColorProfile) throw new Error("The COLOR_4 profile control is missing.");
  if (cfgColorProfile.options.length === 1 && cfgColorProfile.value === "") {
    cfgColorProfile.replaceChildren(
      ...colorSenderModule.COLOR4_PROFILES.map((profile) => {
        const option = document.createElement("option");
        option.value = String(profile.id);
        option.textContent =
          `${profile.name} · ${profile.columns}×${profile.rows} · ` +
          `${profile.innerFrameBytes} bytes/frame`;
        return option;
      }),
    );
    const preferred = await loadPreference("send.color4Profile", 1);
    if (colorSenderModule.COLOR4_PROFILES.some((profile) => profile.id === preferred)) {
      cfgColorProfile.value = String(preferred);
    }
  }
  return colorSenderModule;
}

async function applyCarrier(restart = true): Promise<void> {
  if (restart) {
    generation++;
    activeVisualEncoder?.dispose();
    activeVisualEncoder = null;
    void releaseScreenWakeLock();
    document.body.classList.remove("transfer-active");
    stage.hidden = true;
    showStreamPanels(false);
  }
  const applyGeneration = generation;
  const carrier = currentCarrier();
  qrSettings.forEach((element) => { element.hidden = carrier !== "qr"; });
  if (__COLOR4_ENABLED__) {
    colorSettings.forEach((element) => { element.hidden = carrier !== "color4"; });
  }
  void savePreference("send.carrier", carrier);
  if (__COLOR4_ENABLED__ && carrier === "color4") {
    setStatus("Loading the COLOR_4 encoder…");
    try {
      await ensureColorSender();
    } catch (error) {
      if (applyGeneration !== generation) return;
      showError(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  if (applyGeneration !== generation) return;
  const profileId = __COLOR4_ENABLED__ ? Number(cfgColorProfile?.value) || 1 : 1;
  const fallbackFps = carrier === "qr" ? 60 : profileId === 1 ? 5 : 30;
  cfgFps.value = String(await loadPreference(`send.fps.${carrier}`, fallbackFps));
  if (restart && selectedFile) await startStream();
  else if (!selectedFile) {
    setStatus(currentMode() === "snippet" ? "Paste or type some text to begin" : "Choose a file to begin");
  }
}

/** The picker reads as state — which file is armed — and the button offers
 *  the next action: pick when idle, stop when streaming. A rejected pick
 *  keeps the idle wording: the status line already names what went wrong,
 *  and nothing is streaming. */
function updateFilePicker(): void {
  const armed = currentMode() === "file" && selectedFile !== null;
  paneFile.classList.toggle("has-file", armed);
  filePickerButton.textContent = armed ? "Stop transfer" : "Select File";
  filePickerLabel.textContent =
    armed && selectedFile ? `Selected file: ${selectedFile.name}` : `Any file · up to ${MAX_FILE_LABEL}`;
}

/** Tear the stream down and disarm the picker. The input is cleared so the
 *  same file can be picked again (change would not fire otherwise) and so a
 *  mode switch does not silently resurrect the stopped stream. */
function stopTransfer(): void {
  generation++;
  activeVisualEncoder?.dispose();
  activeVisualEncoder = null;
  void releaseScreenWakeLock();
  document.body.classList.remove("transfer-active");
  selectedFile = null;
  setStageFullscreen(false);
  stage.hidden = true;
  showStreamPanels(false);
  cfgFile.value = "";
  updateFilePicker();
  setStatus("Choose a file to begin");
}

/** Tap the code to fill the screen with it — a bigger physical code lets the
 *  receiver sit farther back or decode denser frames.
 *
 *  Fullscreen is a page STATE (body.qr-full — see style.css), never a fixed
 *  overlay and never a separate element: Safari 26 latches its chrome tint
 *  onto fixed layers, and an overlay element that merely loses a class is
 *  still there for the heuristic to track. A flow layout that reflows on
 *  exit leaves nothing behind. Tap again (or Esc) to shrink back. */
let scrollBeforeFullscreen = 0;
function setStageFullscreen(on: boolean): void {
  if (on === document.body.classList.contains("qr-full")) return;
  if (on) scrollBeforeFullscreen = window.scrollY;
  document.body.classList.toggle("qr-full", on);
  resizeDisplay?.();
  // Entering: the stage IS the page now, start at its top. Leaving: put the
  // user back on the exact spot they expanded from.
  window.scrollTo(0, on ? 0 : scrollBeforeFullscreen);
}

stage.addEventListener("click", () => {
  setStageFullscreen(!document.body.classList.contains("qr-full"));
});
// Tapping the frame stays the fast path, but it is undiscoverable, and a
// windowed sender is the most common reason a receiver never locks on: it
// leaves the camera too few pixels per module to classify colour at all.
document.getElementById("go-fullscreen")?.addEventListener("click", (event) => {
  // The stage's own handler would immediately toggle it back.
  event.stopPropagation();
  setStageFullscreen(true);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setStageFullscreen(false);
});

/** Switching what we're sending kills any stream in flight and clears the stage. */
function applyMode(): void {
  generation++;
  activeVisualEncoder?.dispose();
  activeVisualEncoder = null;
  void releaseScreenWakeLock();
  document.body.classList.remove("transfer-active");
  selectedFile = null;
  setStageFullscreen(false);
  stage.hidden = true;
  showStreamPanels(false);

  if (DEMO) {
    modePicker.hidden = true;
    paneFile.hidden = true;
    paneSnippet.hidden = true;
    paneDemo.hidden = false;
    setStatus("Choose a demo payload to begin");
    return;
  }

  const mode = currentMode();
  paneDemo.hidden = true;
  paneFile.hidden = mode !== "file";
  paneSnippet.hidden = mode !== "snippet";
  // The heading used to say "Send a file" even with Text snippet selected.
  toolTitle.textContent = mode === "snippet" ? "Transmit text" : "Transmit a file";
  setStatus(mode === "snippet" ? "Paste or type some text to begin" : "Choose a file to begin");
  updateFilePicker();
  // A file left in the picker survives the switch, so re-arm it rather than
  // leaving a filename on screen next to "choose a file to begin".
  if (mode === "file" && cfgFile.files?.[0]) void selectFile();
}

/**
 * The one path from "user picked something" to a running stream.
 *
 * Kills any stream in flight, then packs the payload; a selection that lands
 * mid-pack (the generation guard) or fails to pack (throw → showError) leaves
 * the page idle rather than streaming something stale. Every way of choosing a
 * payload goes through here so the guard can't be subtly wrong in one copy.
 */
async function startSelection(
  status: string,
  prepare: () => Promise<{ name: string; size: number; packed: PackedOpticalFile }>,
): Promise<void> {
  const selectionGeneration = ++generation;
  selectedFile = null;
  stage.hidden = true;
  setStatus(status);
  try {
    const { name, size, packed } = await prepare();
    if (selectionGeneration !== generation) return;
    selectedFile = {
      name,
      size,
      payload: packed.container,
      compression: packed.compression,
      transmittedSize: packed.transmittedSize,
    };
    await startStream(true);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

/** Demo payloads ship in public/, so they sit at the site root beside /send/. */
async function selectDemo(fileName: string): Promise<void> {
  await startSelection(`loading ${fileName}…`, async () => {
    const response = await fetch(`../${fileName}`);
    if (!response.ok) throw new Error(`could not load ${fileName} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { name: fileName, size: bytes.length, packed: await packFile(fileName, "image/png", bytes) };
  });
}

async function selectFile(): Promise<void> {
  const file = cfgFile.files?.[0];
  if (!file) return;
  await startSelection(`preparing ${file.name}…`, async () => {
    // Checked here, off File.size, rather than after reading the bytes: a file
    // well past the limit should be refused instantly instead of after the
    // browser has spent time and memory materialising it. Name the actual size —
    // "too large" without a number leaves you guessing by how much.
    if (file.size === 0) {
      throw new Error(`${file.name} is empty — there is nothing to send.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`${file.name} is ${formatBytes(file.size)}, over the ${MAX_FILE_LABEL} limit.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { name: file.name, size: file.size, packed: await packFile(file.name, file.type, bytes) };
  });
  updateFilePicker();
}

async function selectSnippet(): Promise<void> {
  await startSelection("preparing text snippet…", async () => {
    const packed = await packSnippet(snippetText.value);
    return { name: "Text snippet", size: packed.originalSize, packed };
  });
}

async function main() {
  // Both bounds come from MAX_SNIPPET_BYTES so they can't drift apart. maxLength
  // counts UTF-16 units and the real check counts UTF-8 bytes, which are never
  // fewer — so this is a loose guard and packSnippet() remains authoritative.
  snippetText.maxLength = MAX_SNIPPET_BYTES;
  snippetLabel.textContent = `Text to send · up to ${MAX_SNIPPET_LABEL}`;

  document.querySelector('.mode-nav a[href="../send/"]')?.setAttribute("aria-current", "page");
  if (!__COLOR4_ENABLED__) {
    if (carrierColorOption) carrierColorOption.hidden = true;
    carrierPicker.hidden = true;
  } else {
    const preferredCarrier = await loadPreference<CarrierChoice>("send.carrier", "qr");
    const preferredInput = carrierInputs.find((input) => input.value === preferredCarrier);
    if (preferredInput) preferredInput.checked = true;
    for (const input of carrierInputs) {
      input.addEventListener("change", () => { void applyCarrier(); });
    }
    cfgColorProfile!.addEventListener("change", () => {
      void savePreference("send.color4Profile", Number(cfgColorProfile!.value));
      void applyCarrier();
    });
    const preferredPalette = await loadPreference("send.color4Palette", 0);
    cfgColorPalette!.value = preferredPalette === 1 ? "1" : "0";
    cfgColorPalette!.addEventListener("change", () => {
      void savePreference("send.color4Palette", Number(cfgColorPalette!.value));
      activeVisualEncoder?.dispose();
      activeVisualEncoder = null;
      void releaseScreenWakeLock();
      void startStream();
    });
  }
  if (DEMO) {
    const current = document.querySelector('.mode-nav a[href="../send/"]');
    if (current) current.textContent = "Demo";
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-demo]")) {
      button.addEventListener("click", () => void selectDemo(button.dataset.demo!));
    }
  } else {
    cfgFile.addEventListener("change", () => void selectFile());
    // While a file is armed the picker label must NOT open the file dialog:
    // preventDefault cancels the label→input forwarding, and only the button
    // (or a keyboard activation of the hidden input, whose click bubbles up
    // through the label) stops the stream.
    paneFile.addEventListener("click", (event) => {
      if (!paneFile.classList.contains("has-file")) return;
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      if (target && (target.closest(".file-picker-button") || target === cfgFile)) stopTransfer();
    });
    sendSnippetBtn.addEventListener("click", () => void selectSnippet());
    for (const input of modeInputs) input.addEventListener("change", applyMode);
  }
  applyMode();
  await applyCarrier(false);
  window.addEventListener("resize", () => resizeDisplay?.());
  for (const el of [cfgFps, cfgBytes, cfgEcc, cfgSize]) {
    el.addEventListener("change", () => void startStream());
  }
  cfgFps.addEventListener("change", () => {
    void savePreference(`send.fps.${currentCarrier()}`, Number(cfgFps.value));
  });
}

/** Only on a fresh pick — a settings change restarts the stream too, and
 *  yanking the page down every time you nudge tx fps is worse than useless. */
function scrollStageIntoView() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    stage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  });
}

async function startStream(revealStage = false) {
  const gen = ++generation;
  document.body.classList.remove("transfer-active");
  void releaseScreenWakeLock();
  resizeDisplay = null;
  // Stale until this stream's first frame locks its version and refills them.
  showStreamPanels(false);
  if (!selectedFile) {
    setStatus(
      currentMode() === "snippet" ? "Paste or type some text to begin" : "Choose a file to begin",
    );
    return;
  }
  const { name, size: fileSize, payload, compression, transmittedSize } = selectedFile;
  if (gen !== generation) return; // superseded while fetching
  if (__COLOR4_ENABLED__ && currentCarrier() === "color4") {
    await startColorStream({
      gen,
      revealStage,
      name,
      fileSize,
      payload,
      compression,
      transmittedSize,
    });
    return;
  }
  activeVisualEncoder?.dispose();
  activeVisualEncoder = null;
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = blockLength(frameBytes);
  // Keep selectedFile on this path — raising bytes/frame back up is the fix,
  // and dropping the pick would hide that.
  if (!fitsInOneStream(payload.length, frameBytes)) {
    // Name a setting that is actually in the dropdown, not the bare minimum.
    const offered = [...cfgBytes.options].map((option) => Number(option.value));
    const suggestion =
      smallestSufficientFrameSize(payload.length, offered) ?? minimumFrameBytes(payload.length);
    showError(
      `${formatBytes(payload.length)} needs ` +
        `${sourceBlockCount(payload.length, frameBytes).toLocaleString()} blocks at ` +
        `${frameBytes} bytes per frame, and a frame can only number ` +
        `${MAX_SOURCE_BLOCKS.toLocaleString()} of them. ` +
        `Raise bytes / frame to ${suggestion} or more.`,
    );
    return;
  }
  const fountain = createFountainFrameProducer(payload, blockLen, sessionId);
  const visual = createQrLegacyEncoder(ecc, MARGIN);
  activeVisualEncoder = {
    dispose(): void {
      fountain.dispose();
      visual.dispose();
    },
  };
  let version = 0; // reported by the worker's first frame, then locked there
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    let cssBudget: number;
    if (document.body.classList.contains("qr-full")) {
      // Tap-to-fullscreen: the whole short viewport edge. The display-size
      // slider and page chrome are deliberately ignored — the point of the
      // mode is "as big as this device goes".
      cssBudget = Math.min(window.innerWidth, window.innerHeight);
    } else {
      // The workbench bay has its own padding and border. Measure the visible
      // optical slot itself so an integer-scaled frame can never be clipped —
      // clipping even part of the quiet zone makes the carrier invalid.
      const containerWidth = stage.getBoundingClientRect().width || window.innerWidth;
      const stageStyle = getComputedStyle(stage);
      const horizontalChrome =
        Number.parseFloat(stageStyle.paddingLeft) +
        Number.parseFloat(stageStyle.paddingRight) +
        Number.parseFloat(stageStyle.borderLeftWidth) +
        Number.parseFloat(stageStyle.borderRightWidth);
      cssBudget = fitQrDisplaySize(
        window.innerWidth,
        window.innerHeight,
        containerWidth,
        displayPx,
        horizontalChrome,
      );
    }
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };

  const makeFrame = async (): Promise<ImageData> => {
    const sequence = nextSeq++;
    const bytes = await fountain.encode(sequence);
    const rendered = await visual.encode(bytes, { sessionId, sequence });
    if (version === 0) {
      version = rendered.version;
      modules = rendered.moduleCount;
    } else if (rendered.version !== version || rendered.moduleCount !== modules) {
      throw new Error("QR encoder changed geometry inside one fountain session.");
    }
    return new ImageData(rendered.rgba, rendered.width, rendered.height);
  };

  let fountainSession;
  try {
    fountainSession = await fountain.ready;
    queue.push(await makeFrame());
  } catch (error) {
    if (gen !== generation) return;
    showError(error instanceof Error ? error.message : String(error));
    return;
  }
  if (gen !== generation) return;

  stage.hidden = false;
  document.body.classList.add("transfer-active");
  void requestScreenWakeLock();
  sizeCanvas();
  resizeDisplay = sizeCanvas;
  if (revealStage) scrollStageIntoView();
  spec("spec-fps").textContent = `${txFps} fps`;
  spec("spec-frame").textContent = `${frameBytes} bytes`;
  spec("spec-carrier-kind").textContent = "qr";
  spec("spec-qr").textContent = `V${version} · ECC ${ecc}`;
  spec("spec-payload").textContent = `${name} · ${formatBytes(fileSize)}`;
  spec("spec-compression").textContent =
    compression === "gzip" ? `gzip → ${formatBytes(transmittedSize)}` : "none";
  spec("spec-k").textContent = `K = ${fountainSession.k}`;
  showStreamPanels(true);
  setStatus(`Streaming ${name} — `);
  const share = document.createElement("button");
  share.type = "button";
  share.className = "text-button";
  share.textContent = "Share receiver link";
  share.addEventListener("click", openShareDialog);
  specs.append(share);

  let pumping = false;
  let generatorFailed = false;
  const pump = async (max = LOOKAHEAD) => {
    if (pumping || generatorFailed || gen !== generation) return;
    pumping = true;
    try {
      for (let n = 0; n < max && queue.length < LOOKAHEAD; n++) {
        queue.push(await makeFrame());
      }
    } catch (error) {
      if (gen !== generation) return;
      generatorFailed = true;
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      pumping = false;
    }
  };
  void pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    // generatorFailed means no frame will ever be produced again, so stop the
    // rAF loop rather than spinning on an empty queue until a settings change.
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    void pump(1);
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval; // fell behind — don't burst
  };
  requestAnimationFrame(tick);
}

interface ColorStreamInput {
  gen: number;
  revealStage: boolean;
  name: string;
  fileSize: number;
  payload: Uint8Array;
  compression: "none" | "gzip";
  transmittedSize: number;
}

async function startColorStream(input: ColorStreamInput): Promise<void> {
  const module = await ensureColorSender();
  if (input.gen !== generation) return;
  const profileId = Number(cfgColorProfile!.value);
  const profile = module.COLOR4_PROFILES.find((candidate) => candidate.id === profileId);
  if (!profile) {
    showError("Choose a supported COLOR_4 profile.");
    return;
  }
  const frameBytes = profile.innerFrameBytes;
  if (!fitsInOneStream(input.payload.length, frameBytes)) {
    const alternative = module.COLOR4_PROFILES.find((candidate) =>
      fitsInOneStream(input.payload.length, candidate.innerFrameBytes),
    );
    showError(
      alternative
        ? `${formatBytes(input.payload.length)} exceeds ${profile.name}; use ${alternative.name}.`
        : `${formatBytes(input.payload.length)} does not fit a COLOR_4 stream with K as u16.`,
    );
    return;
  }

  const txFps = Number(cfgFps.value);
  const displayPx = Number(cfgSize.value);
  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const paletteId = Number(cfgColorPalette!.value) === 1 ? 1 : 0;
  activeVisualEncoder?.dispose();
  const fountain = createFountainFrameProducer(input.payload, profile.blockBytes, sessionId);
  const visual = module.createColor4Encoder(profile.id, paletteId);
  activeVisualEncoder = {
    dispose(): void {
      fountain.dispose();
      visual.dispose();
    },
  };
  let nextSeq = 0;
  const queue: ImageData[] = [];
  const staging = document.createElement("canvas");
  const total = module.COLOR4_CANONICAL_MODULES;
  let scale = 1;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    let cssBudget: number;
    if (document.body.classList.contains("qr-full")) {
      cssBudget = Math.min(window.innerWidth, window.innerHeight);
    } else {
      // Measure the content slot, not the padded workbench bay; COLOR_4 must
      // keep every fiducial and quiet-zone cell inside the visible stage.
      const containerWidth = stage.getBoundingClientRect().width || window.innerWidth;
      const stageStyle = getComputedStyle(stage);
      const horizontalChrome =
        Number.parseFloat(stageStyle.paddingLeft) +
        Number.parseFloat(stageStyle.paddingRight) +
        Number.parseFloat(stageStyle.borderLeftWidth) +
        Number.parseFloat(stageStyle.borderRightWidth);
      cssBudget = fitQrDisplaySize(
        window.innerWidth,
        window.innerHeight,
        containerWidth,
        displayPx,
        horizontalChrome,
      );
    }
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };

  const makeFrame = async (): Promise<ImageData> => {
    const sequence = nextSeq++;
    const innerFrame = await fountain.encode(sequence);
    const rendered = await visual.encode(innerFrame, {
      sessionId,
      sequence,
      profileId: profile.id,
      paletteId,
    });
    if (rendered.width !== total || rendered.height !== total) {
      throw new Error("COLOR_4 renderer returned a non-canonical frame.");
    }
    return new ImageData(
      new Uint8ClampedArray(rendered.rgba),
      rendered.width,
      rendered.height,
    );
  };

  const scheduler = new TemporalFrameScheduler(txFps, profile.minHoldCycles);
  const presentAvailableFrame = (now: number): boolean => {
    const image = scheduler.take(now, () => queue.shift());
    if (!image) return false;
    staging.getContext("2d")!.putImageData(image, 0, 0);
    const context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    context.drawImage(staging, 0, 0, canvas.width, canvas.height);
    return true;
  };

  let fountainSession;
  try {
    fountainSession = await fountain.ready;
    queue.push(await makeFrame());
  } catch (error) {
    if (input.gen !== generation) return;
    showError(error instanceof Error ? error.message : String(error));
    return;
  }
  if (input.gen !== generation) return;

  stage.hidden = false;
  document.body.classList.add("transfer-active");
  void requestScreenWakeLock();
  sizeCanvas();
  resizeDisplay = sizeCanvas;
  // The first encoded frame is already available: paint it synchronously so
  // starting a stream never adds an arbitrary display-refresh delay.
  presentAvailableFrame(performance.now());
  if (input.revealStage) scrollStageIntoView();
  spec("spec-fps").textContent =
    `${txFps} fps · ≥${Math.ceil(scheduler.effectiveHoldMs)} ms/frame`;
  spec("spec-frame").textContent = `${frameBytes} bytes`;
  spec("spec-carrier-kind").textContent = "carrier";
  spec("spec-qr").textContent =
    `COLOR_4 ${profile.name} · ${profile.columns}×${profile.rows} · ` +
    (paletteId === 0 ? "KCMY" : "KRGB Labs");
  spec("spec-payload").textContent = `${input.name} · ${formatBytes(input.fileSize)}`;
  spec("spec-compression").textContent =
    input.compression === "gzip" ? `gzip → ${formatBytes(input.transmittedSize)}` : "none";
  spec("spec-k").textContent = `K = ${fountainSession.k}`;
  showStreamPanels(true);
  setStatus(`Streaming ${input.name} over COLOR_4 — `);
  const share = document.createElement("button");
  share.type = "button";
  share.className = "text-button";
  share.textContent = "Share receiver link";
  share.addEventListener("click", openShareDialog);
  specs.append(share);

  let pumping = false;
  let generatorFailed = false;
  const pump = async (max = LOOKAHEAD) => {
    if (pumping || generatorFailed || input.gen !== generation) return;
    pumping = true;
    try {
      for (let count = 0; count < max && queue.length < LOOKAHEAD; count++) {
        queue.push(await makeFrame());
      }
    } catch (error) {
      if (input.gen !== generation) return;
      generatorFailed = true;
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      pumping = false;
    }
  };
  void pump();
  const tick = (now: number) => {
    if (input.gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    if (presentAvailableFrame(now)) void pump(1);
  };
  requestAnimationFrame(tick);
}

void main();
