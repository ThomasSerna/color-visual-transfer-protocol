import type { Plugin } from "vite";
import { resolve } from "node:path";

/**
 * Standalone builds need the worker and the wasm embedded rather than fetched.
 * Doing that with a runtime branch does not work: both inline forms have
 * module-scope side effects, so Rollup keeps them even when the branch is dead.
 * Swapping the module at resolve time means the other variant is never parsed.
 *
 * `rootDir` is the repo root — passed in from vite.config.ts so the swap
 * targets stay anchored there no matter where this file lives.
 */
export function useInlineVariants(rootDir: string): Plugin {
  const swaps = new Map([
    ["./worker-factory", "receive/worker-factory.inline.ts"],
    ["./qr-worker-factory", "send/qr-worker-factory.inline.ts"],
    ["./fountain-worker-factory", "send/fountain-worker-factory.inline.ts"],
    ["./wasm-url", "receive/wasm-url.inline.ts"],
    // The self-contained artifacts deliberately remain byte-compatible QR
    // tools. Pointing their loader at a module with no dynamic imports keeps
    // the COLOR_4/OpenCV graph out of Rollup entirely.
    ["../shared/color-loader", "shared/color-loader.disabled.ts"],
  ]);
  return {
    name: "use-inline-variants",
    enforce: "pre",
    resolveId(source) {
      const target = swaps.get(source);
      return target ? resolve(rootDir, target) : null;
    },
  };
}
