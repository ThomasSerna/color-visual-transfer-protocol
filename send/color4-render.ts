import {
  wrapColor4Frame,
  type Color4FrameContext,
  type Color4PaletteId,
  type RenderedFrame,
} from "../shared/color4";
import { rasterizeColor4 } from "../shared/color4/raster";

/** Pure worker-side encoder, exported separately for golden/context tests. */
export function renderColor4InnerFrame(
  innerFrame: Uint8Array,
  context: Color4FrameContext,
  moduleScale = 1,
): RenderedFrame {
  const wrapped = wrapColor4Frame(innerFrame, {
    profileId: context.profileId,
    paletteId: context.paletteId as Color4PaletteId,
  });
  if (
    wrapped.header.sessionId !== context.sessionId ||
    wrapped.header.sequence !== context.sequence
  ) {
    throw new Error("COLOR_4 context does not match the inner Decimen frame.");
  }
  const raster = rasterizeColor4(wrapped.codedBytes, {
    profile: wrapped.profile,
    paletteId: context.paletteId as Color4PaletteId,
    sequence: context.sequence,
    moduleScale,
  });
  return { width: raster.width, height: raster.height, rgba: raster.pixels };
}
