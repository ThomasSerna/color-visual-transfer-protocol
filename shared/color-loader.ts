/**
 * This is the sole route into the optional COLOR_4 implementation. Keeping
 * both imports dynamic lets QR start immediately without parsing OpenCV.
 */
export const COLOR4_AVAILABLE = __COLOR4_ENABLED__;

export async function loadColor4Sender() {
  if (!__COLOR4_ENABLED__) throw new Error("COLOR_4 is unavailable in the QR standalone build.");
  return import("../send/color4-carrier");
}

export async function loadColor4Receiver() {
  if (!__COLOR4_ENABLED__) throw new Error("COLOR_4 is unavailable in the QR standalone build.");
  return import("../receive/color4-carrier");
}

