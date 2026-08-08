import type { Plugin } from "vite";

function requiredSingleMatch(html: string, pattern: RegExp, label: string): RegExpMatchArray {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...html.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`standalone ${label} rewrite expected one target, found ${matches.length}`);
  }
  return matches[0]!;
}

/**
 * A standalone file has no siblings, so navigation is collapsed to inert
 * labels and external icon references are removed. Brand detection relies on
 * the stable `data-brand` contract in the source HTML: the plugin preserves
 * whatever SVG and wordmark the product uses instead of carrying a second,
 * inevitably stale copy of that markup.
 */
export function rewriteStandaloneLinks(page: "send" | "receive"): Plugin {
  return {
    name: "rewrite-standalone-links",
    transformIndexHtml(source) {
      let html = source;

      const navigation = requiredSingleMatch(
        html,
        /<nav\b[^>]*\bclass=(['"])[^'"]*\bmode-nav\b[^'"]*\1[^>]*>[\s\S]*?<\/nav>/i,
        "mode navigation",
      )[0];
      html = html.replace(
        navigation,
        `<span class="mode-badge">${page === "send" ? "Transmit" : "Capture"}</span>`,
      );

      const brandAnchor = requiredSingleMatch(
        html,
        /<a\b[^>]*\bdata-brand(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=[\s>])[^>]*>[\s\S]*?<\/a>/i,
        "data-brand",
      )[0];
      const brandParts = brandAnchor.match(/^<a\b([^>]*)>([\s\S]*)<\/a>$/i);
      if (!brandParts) throw new Error("standalone data-brand target is not an anchor");
      const rawAttributes = brandParts.at(1);
      const brandContent = brandParts.at(2);
      if (rawAttributes === undefined || brandContent === undefined) {
        throw new Error("standalone data-brand target is malformed");
      }
      const inertAttributes = rawAttributes.replace(
        /\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
        "",
      );
      html = html.replace(brandAnchor, `<span${inertAttributes}>${brandContent}</span>`);

      const favicon = requiredSingleMatch(
        html,
        /<link\b(?=[^>]*\brel=(['"])icon\1)[^>]*>/i,
        "favicon",
      )[0];
      html = html.replace(favicon, "");

      const appleIcon = requiredSingleMatch(
        html,
        /<link\b(?=[^>]*\brel=(['"])apple-touch-icon\1)[^>]*>/i,
        "apple touch icon",
      )[0];
      html = html.replace(appleIcon, "");

      html = html.replaceAll(
        "Open Capture on the other device.",
        "Open the standalone receiver on the other device.",
      );
      // Compatibility with source copy from releases before the public rename.
      html = html.replaceAll(
        "Open Receive on the other device.",
        "Open the standalone receiver on the other device.",
      );

      // COLOR_4 is intentionally absent from standalone artifacts, including
      // controls that would otherwise be hidden only after JavaScript runs.
      const colorOption = /<label id="carrier-color-option">[\s\S]*?<\/label>/g;
      const colorSettings = /<label data-color-setting hidden>[\s\S]*?<\/label>/g;
      if (!colorOption.test(html)) {
        throw new Error("standalone COLOR carrier rewrite missed its target");
      }
      html = html.replace(colorOption, "");
      if (!colorSettings.test(html)) {
        throw new Error("standalone COLOR settings rewrite missed its target");
      }
      html = html.replace(colorSettings, "");
      return html;
    },
  };
}
