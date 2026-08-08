import type { Plugin } from "vite";

/**
 * Prepends the copyright banner to every built artifact. The repository's
 * LICENSE covers source; this also keeps attribution attached to deployable
 * bundles and self-contained standalone pages.
 *
 * JS and CSS get a `/*!` legal comment (minifiers preserve those); HTML gets
 * a comment immediately after the doctype. Binary assets are left untouched.
 */
export function licenseBanner(version: string): Plugin {
  const text =
    `Color Visual Transfer Protocol v${version} — ` +
    `https://github.com/ThomasSerna/color-visual-transfer-protocol — ` +
    `incorporates Decimen Optical Transfer (c) 2026 Evan Crawley — ` +
    `SPDX-License-Identifier: MIT — see NOTICE.md`;
  const comment = `/*! ${text} */\n`;
  const htmlComment = `<!-- ${text} -->`;
  return {
    name: "license-banner",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") {
          if (!output.code.startsWith(comment)) output.code = comment + output.code;
          continue;
        }
        if (typeof output.source !== "string") continue;
        if (fileName.endsWith(".js") || fileName.endsWith(".css")) {
          if (!output.source.startsWith(comment)) output.source = comment + output.source;
        } else if (fileName.endsWith(".html")) {
          if (output.source.includes(htmlComment)) continue;
          if (!/^<!doctype html>/i.test(output.source)) {
            throw new Error(`${fileName}: no leading doctype to banner after`);
          }
          output.source = output.source.replace(/^<!doctype html>/i, (doctype) =>
            `${doctype}\n${htmlComment}`,
          );
        }
      }
    },
  };
}
