import type { Plugin } from "vite";

/**
 * Own the manifest link and the service-worker registration for every page.
 *
 * Two problems, one owner:
 *
 * 1. PATHS. vite-plugin-pwa resolves what it injects against `base`, which is
 *    "./" — so it resolves against the PAGE, while manifest.webmanifest and
 *    sw.js only exist at the site root. From /send/ and /receive/ they 404,
 *    which made the receiver — the page the README tells you to add to your
 *    home screen — the one page that never registered a worker at all.
 *    base "./" is what lets one build work under any subpath, so it stays and
 *    the references get a "../" per directory of depth instead.
 *
 * 2. UPDATES. The generated worker only calls skipWaiting() on a SKIP_WAITING
 *    message, and `registerType: "autoUpdate"` leaves sending it to workbox-
 *    window's registration script. A bare register() never does, so every
 *    rebuilt worker installs, parks in "waiting", and the old one goes on
 *    serving its precache indefinitely. The script below does the handshake,
 *    but holds both activation and reload while any same-origin tab has an
 *    optical transfer in progress.
 *
 * Doing both here means `injectRegister: false`, so no generated string is
 * left to depend on.
 */
export function rootPwaHead(): Plugin {
  const registration = (prefix: string) =>
    `
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    let hasControlledPage = !!navigator.serviceWorker.controller;
    const leasePrefix = "decimen-transfer-active:";
    const tabId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    const leaseKey = leasePrefix + tabId;
    const leaseMs = 15000;
    let leaseTimer;
    let waitingWorker;
    let reloadWhenIdle = false;
    let reloading = false;

    const currentTabActive = () => document.body.classList.contains("transfer-active");
    const removeLease = () => {
      try { localStorage.removeItem(leaseKey); } catch {}
    };
    const writeLease = () => {
      try { localStorage.setItem(leaseKey, String(Date.now() + leaseMs)); } catch {}
    };
    const syncLease = () => {
      if (currentTabActive()) {
        writeLease();
        if (!leaseTimer) leaseTimer = setInterval(writeLease, leaseMs / 3);
      } else {
        if (leaseTimer) clearInterval(leaseTimer);
        leaseTimer = undefined;
        removeLease();
      }
    };
    const anyTabActive = () => {
      if (currentTabActive()) return true;
      const now = Date.now();
      try {
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const key = localStorage.key(index);
          if (!key || !key.startsWith(leasePrefix)) continue;
          const expires = Number(localStorage.getItem(key));
          if (Number.isFinite(expires) && expires > now) return true;
          localStorage.removeItem(key);
        }
      } catch {}
      return false;
    };
    const proceedWhenIdle = () => {
      syncLease();
      if (anyTabActive()) return;
      if (reloadWhenIdle && !reloading) {
        reloading = true;
        location.reload();
        return;
      }
      if (waitingWorker) {
        const worker = waitingWorker;
        waitingWorker = undefined;
        worker.postMessage({ type: "SKIP_WAITING" });
      }
    };

    new MutationObserver(proceedWhenIdle).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("storage", (event) => {
      if (event.key && event.key.startsWith(leasePrefix)) proceedWhenIdle();
    });
    window.addEventListener("pagehide", () => {
      if (leaseTimer) clearInterval(leaseTimer);
      removeLease();
    });
    syncLease();

    // Another idle tab may activate a worker while this one is transferring.
    // Keep running the old page and reload only after its transfer finishes.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // The first install may claim a page that started uncontrolled; that is
      // not an update and does not need a reload. Remember it so every later
      // controller change in this long-lived tab is handled normally.
      if (!hasControlledPage) {
        hasControlledPage = true;
        return;
      }
      reloadWhenIdle = true;
      proceedWhenIdle();
    });
    navigator.serviceWorker.register("${prefix}sw.js", { scope: "${prefix}" }).then((reg) => {
      const queuePromotion = (worker) => {
        if (!worker) return;
        waitingWorker = worker;
        proceedWhenIdle();
      };
      queuePromotion(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          if (next.state === "installed") queuePromotion(reg.waiting || next);
        });
      });
    });
  });
}`.trim();

  // Matched loosely: the exact attribute order and self-closing style are
  // vite-plugin-pwa's business, only the href is ours.
  // vite-plugin-pwa injects the manifest link during generateBundle, after
  // transformIndexHtml has already run — so the rewrite has to happen there
  // too, which is also where the registration script gets appended.
  const MANIFEST_LINK = /<link[^>]*rel="manifest"[^>]*>/;
  return {
    name: "root-pwa-head",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== "asset" || !fileName.endsWith(".html")) continue;
        const depth = fileName.split("/").length - 1;
        const prefix = depth === 0 ? "./" : "../".repeat(depth);
        const html =
          typeof asset.source === "string"
            ? asset.source
            : new TextDecoder().decode(asset.source);

        if (!MANIFEST_LINK.test(html)) {
          throw new Error(`${fileName}: no manifest link to re-point — root-pwa-head is stale`);
        }
        if (!html.includes("</body>")) {
          throw new Error(`${fileName}: no </body> to append the registration to`);
        }

        const next = html
          .replace(MANIFEST_LINK, `<link rel="manifest" href="${prefix}manifest.webmanifest">`)
          .replace("</body>", `<script>${registration(prefix)}</script></body>`);

        // Resolve what we just wrote the way a browser would, from a page served
        // under a project subpath. Anything not landing on the site root is the
        // bug this plugin exists to prevent.
        const page = new URL(fileName, "https://example.test/repo/");
        const root = "https://example.test/repo/";
        const manifest = /<link rel="manifest" href="([^"]+)"/.exec(next)?.[1];
        const sw = /register\("([^"]+)", \{ scope: "([^"]+)" \}\)/.exec(next);
        const checks: [string, string | undefined, string][] = [
          ["manifest", manifest, `${root}manifest.webmanifest`],
          ["service worker", sw?.[1], `${root}sw.js`],
          ["service worker scope", sw?.[2], root],
        ];
        for (const [what, value, expected] of checks) {
          if (value === undefined) throw new Error(`${fileName}: no ${what} reference found`);
          const actual = new URL(value, page).href;
          if (actual !== expected) {
            throw new Error(`${fileName}: ${what} resolves to ${actual}, expected ${expected}`);
          }
        }
        asset.source = next;
      }
    },
  };
}
