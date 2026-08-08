import type { Color4Profile } from "./profiles";
import {
  CALIBRATION_SWATCHES,
  FIDUCIALS,
  PHY_VERSION,
  QUIET_MODULES,
  TOTAL_MODULES,
  createPhysicalLayout,
  encodeBootstrap,
  encodePhasePilot,
  fiducialModule,
  getColor4Palette,
  type ModuleRect,
  type PaletteId,
  type PhysicalLayout,
  type Rgb,
} from "./physical";

const WHITE: Rgb = [0xff, 0xff, 0xff];
const BLACK: Rgb = [0x00, 0x00, 0x00];

export interface Color4RasterOptions {
  readonly profile: Color4Profile;
  readonly paletteId: PaletteId;
  readonly sequence: number;
  /** Pixels per logical module. Must be an integer; defaults to one. */
  readonly moduleScale?: number;
}

export interface Color4Raster {
  readonly width: number;
  readonly height: number;
  readonly moduleScale: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly layout: PhysicalLayout;
  readonly profileId: number;
  readonly paletteId: PaletteId;
  readonly sequencePhase: 0 | 1 | 2 | 3;
}

interface Painter {
  readonly scale: number;
  readonly size: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

function paintModule(painter: Painter, moduleX: number, moduleY: number, color: Rgb): void {
  const startX = (moduleX + QUIET_MODULES) * painter.scale;
  const startY = (moduleY + QUIET_MODULES) * painter.scale;
  for (let offsetY = 0; offsetY < painter.scale; offsetY++) {
    let pixel = ((startY + offsetY) * painter.size + startX) * 4;
    for (let offsetX = 0; offsetX < painter.scale; offsetX++) {
      painter.pixels[pixel] = color[0];
      painter.pixels[pixel + 1] = color[1];
      painter.pixels[pixel + 2] = color[2];
      painter.pixels[pixel + 3] = 0xff;
      pixel += 4;
    }
  }
}

function paintRect(painter: Painter, rect: ModuleRect, color: Rgb): void {
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      paintModule(painter, rect.x + x, rect.y + y, color);
    }
  }
}

function paintFiducials(painter: Painter): void {
  for (const marker of FIDUCIALS) {
    for (let y = 0; y < marker.height; y++) {
      for (let x = 0; x < marker.width; x++) {
        paintModule(
          painter,
          marker.x + x,
          marker.y + y,
          fiducialModule(marker.id, x, y) === 1 ? BLACK : WHITE,
        );
      }
    }
  }
}

function paintTiming(painter: Painter, layout: PhysicalLayout): void {
  for (let x = 0; x < layout.data.width; x++) {
    const alternating = (x & 1) === 0;
    paintModule(
      painter,
      layout.timing.top.x + x,
      layout.timing.top.y,
      alternating ? BLACK : WHITE,
    );
    paintModule(
      painter,
      layout.timing.bottom.x + x,
      layout.timing.bottom.y,
      alternating ? WHITE : BLACK,
    );
  }
  for (let y = 0; y < layout.data.height; y++) {
    const alternating = (y & 1) === 0;
    paintModule(
      painter,
      layout.timing.left.x,
      layout.timing.left.y + y,
      alternating ? BLACK : WHITE,
    );
    paintModule(
      painter,
      layout.timing.right.x,
      layout.timing.right.y + y,
      alternating ? WHITE : BLACK,
    );
  }
}

function paintBootstrap(
  painter: Painter,
  layout: PhysicalLayout,
  profile: Color4Profile,
  paletteId: PaletteId,
  sequencePhase: 0 | 1 | 2 | 3,
): void {
  const modules = encodeBootstrap({
    version: PHY_VERSION,
    profileId: profile.id,
    paletteId,
    sequencePhase,
  });
  for (let y = 0; y < layout.bootstrap.height; y++) {
    for (let x = 0; x < layout.bootstrap.width; x++) {
      const dark = modules[y * layout.bootstrap.width + x] === 1;
      paintModule(
        painter,
        layout.bootstrap.x + x,
        layout.bootstrap.y + y,
        dark ? BLACK : WHITE,
      );
    }
  }
}

function paintPhasePilots(
  painter: Painter,
  layout: PhysicalLayout,
  sequencePhase: 0 | 1 | 2 | 3,
): void {
  const pilot = encodePhasePilot(sequencePhase);
  for (let x = 0; x < pilot.length; x++) {
    const color = pilot[x] === 1 ? BLACK : WHITE;
    paintModule(painter, layout.phasePilots.top.x + x, layout.phasePilots.top.y, color);
    paintModule(painter, layout.phasePilots.bottom.x + x, layout.phasePilots.bottom.y, color);
  }
}

function paintCalibration(painter: Painter, layout: PhysicalLayout): void {
  for (const bank of [layout.calibration.left, layout.calibration.right]) {
    for (const placement of bank) {
      const expected = CALIBRATION_SWATCHES.find((swatch) => swatch.name === placement.name);
      // Layout construction and this fixture share the same exhaustive name set.
      if (expected === undefined) throw new Error("Unknown COLOR_4 calibration swatch.");
      paintRect(painter, placement, expected.color);
    }
  }
}

/**
 * Paint a whitened/interleaved/FEC-coded stream into the normative COLOR_4
 * physical frame. `codedBytes` is deliberately opaque here; envelope/FEC live
 * in the codec layer and this function only maps its dibits to cells.
 */
export function rasterizeColor4(
  codedBytes: Uint8Array,
  options: Color4RasterOptions,
): Color4Raster {
  const { profile, paletteId, sequence } = options;
  const palette = getColor4Palette(paletteId);
  if (palette === undefined) throw new RangeError(`Unsupported COLOR_4 palette ${paletteId}.`);
  if (codedBytes.length !== profile.codedBytes) {
    throw new RangeError(
      `COLOR_4 profile ${profile.id} needs ${profile.codedBytes} coded bytes; got ${codedBytes.length}.`,
    );
  }
  if (profile.columns * profile.rows !== codedBytes.length * 4) {
    throw new RangeError("COLOR_4 profile grid does not contain exactly four cells per byte.");
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new RangeError("COLOR_4 sequence must be an unsigned 32-bit integer.");
  }
  const scale = options.moduleScale ?? 1;
  if (!Number.isInteger(scale) || scale < 1 || scale > 32) {
    throw new RangeError("COLOR_4 module scale must be an integer from 1 through 32.");
  }

  const size = TOTAL_MODULES * scale;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let pixel = 0; pixel < pixels.length; pixel += 4) {
    pixels[pixel] = WHITE[0];
    pixels[pixel + 1] = WHITE[1];
    pixels[pixel + 2] = WHITE[2];
    pixels[pixel + 3] = 0xff;
  }
  const painter: Painter = { scale, size, pixels };
  const layout = createPhysicalLayout(profile);
  const sequencePhase = (sequence & 0x03) as 0 | 1 | 2 | 3;

  paintFiducials(painter);
  paintTiming(painter, layout);
  paintBootstrap(painter, layout, profile, paletteId, sequencePhase);
  paintPhasePilots(painter, layout, sequencePhase);
  paintCalibration(painter, layout);

  let cell = 0;
  for (let byteIndex = 0; byteIndex < codedBytes.length; byteIndex++) {
    const byte = codedBytes[byteIndex]!;
    for (let shift = 6; shift >= 0; shift -= 2) {
      const dibit = (byte >>> shift) & 0x03;
      const x = layout.data.x + (cell % profile.columns);
      const y = layout.data.y + Math.floor(cell / profile.columns);
      paintModule(painter, x, y, palette.colors[dibit]!);
      cell++;
    }
  }

  return Object.freeze({
    width: size,
    height: size,
    moduleScale: scale,
    pixels,
    layout,
    profileId: profile.id,
    paletteId,
    sequencePhase,
  });
}
