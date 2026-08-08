/** Standalone alias: importantly, this file contains no COLOR_4 import. */
export const COLOR4_AVAILABLE = false;

export async function loadColor4Sender(): Promise<never> {
  throw new Error("This optional carrier is unavailable in the standalone build.");
}

export async function loadColor4Receiver(): Promise<never> {
  throw new Error("This optional carrier is unavailable in the standalone build.");
}
