/// <reference types="vite/client" />

/** Replaced by Vite. Standalone builds pin this false and exclude COLOR_4. */
declare const __COLOR4_ENABLED__: boolean;

/**
 * Emitted by the `inline-zxing-wasm` plugin in build/inline-zxing-wasm.ts:
 * the decoder wasm as a data: URI. Only standalone builds import it — served
 * builds resolve receive/wasm-url.ts instead and never touch this module.
 */
declare module "virtual:zxing-wasm-data-url" {
  const dataUrl: string;
  export default dataUrl;
}
