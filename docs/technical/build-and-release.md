# Build & release

## Prerequisite

Use **Node.js 22**. The repository pins the major in `.nvmrc` and declares it
in `package.json`.

## Scripts

```powershell
npm ci                    # exact dependency graph from package-lock.json
npm run dev               # HTTPS dev server with HMR and a self-signed certificate
npm run demo              # dev server with VITE_DEMO=1
npm test                  # golden vectors and unit/property tests
npm run typecheck         # app, build, unit-test and Playwright TypeScript
npm run build             # hosted site → dist/
npm run build:standalone  # cvtp-sender.html + cvtp-receiver.html → dist-standalone/
npm run build:all         # hosted and standalone builds
npm run preview           # preview an existing production build
npm run test:e2e:install  # install Chromium/WebKit once per machine
npm run test:e2e          # hosted/PWA/standalone flows in Chromium + WebKit
npm run test:stress       # opt-in 64 MiB pipeline test; approximately 700 MiB RAM
npm run icons             # regenerate SVG-derived PWA icons and social card
```

`npm run icons` uses the pinned `@resvg/resvg-js@2.6.2` renderer, so asset
generation is local and reproducible and does not require librsvg or an
external image service. The CVTP mark is the single vector source for the app
icons, maskable icon and 1200×630 social card.

`VITE_SITE_URL` overrides the published URL baked into social metadata and the
standalone sender's receiver fallback (default
`https://thomasserna.github.io/color-visual-transfer-protocol/`, trailing slash
required). Hosted pages derive share URLs from their current origin and
project subpath.

## PWA / service worker

`vite-plugin-pwa` (Workbox) precaches the app shell, ZXing WASM and lazy OpenCV
bundle. `build/root-pwa-head.ts` rewrites manifest/service-worker references so
they resolve from every page depth and validates those paths during the build.
Its skip-waiting handshake activates an update only after all same-origin
transfer tabs are idle. A Workbox range-request route serves received media
from the Cache API; see [Platform quirks](platform-quirks.md).

## Standalone contract

`cvtp-sender.html` and `cvtp-receiver.html` are self-contained and QR-only.
They must contain neither COLOR_4/OpenCV code nor external runtime requests.
The standalone rewrite locates the product wordmark through its stable brand
attribute rather than duplicating the SVG inside the build plugin.

## CI (`.github/workflows`)

- **`ci.yml`** runs tests and builds for pushes and pull requests, executes the
  Chromium/WebKit PWA and standalone matrix, enforces the receive-chunk budget
  and verifies manifest/service-worker references. Its test step sets
  `CVTP_REQUIRE_PHYSICAL_FIXTURES=1`, so at least one real-camera replay must be
  present and pass.
- **`pages.yml`** deploys the hosted build to GitHub Pages from `main`.
- **`release.yml`** runs on `v*` tags and attaches
  `cvtp-<tag>-site.zip`, `cvtp-<tag>-sender.html`,
  `cvtp-<tag>-receiver.html` and `SHA256SUMS.txt`. Its test step sets
  `CVTP_REQUIRE_INDEPENDENT_PHYSICAL_FIXTURE=1`, which blocks publication until
  at least one passing, unaltered full-camera fixture pins transmitter bytes
  captured before the optical transfer
  (`oracle.basis.kind=independent-tx-ground-truth`) and distinguishes the ranked
  fix by rejecting under both legacy erasure selection and hard decision. A
  CRC-derived regression fixture alone cannot satisfy the release gate.

The hosted site builds with `base: "./"`, so it works below a project subpath.

## Release pattern

1. Create `release/vX.Y.Z`, bump with
   `npm version X.Y.Z --no-git-tag-version`, and open the release PR.
2. Run the complete validation matrix documented in the root README.
3. Tag `vX.Y.Z` after merge; the release workflow builds and attaches the
   CVTP-named artifacts.

The footer stamps `v<version> · build <short-hash>` (`-dirty` for uncommitted
sources), so every artifact identifies its exact build.
