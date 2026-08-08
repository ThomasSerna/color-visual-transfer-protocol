# Contributing to CVTP

Color Visual Transfer Protocol is an experimental optical transport. Bug
reports and focused pull requests are welcome, especially when they include a
reproducible camera, display, or browser setup.

For receiver issues, include the browser and OS versions, device model,
negotiated capture resolution/FPS, selected carrier/profile/palette, and an
exported experiment summary when possible. Never attach the recovered payload
unless it is safe to share.

Protocol changes must keep the existing DCF2, fountain, QR legacy, and COLOR_4
golden vectors passing. Run `npm test`, `npm run typecheck`, and the relevant
Playwright scenario before opening a pull request.

This project incorporates MIT-licensed work from Decimen Optical Transfer. See
[`NOTICE.md`](NOTICE.md) for the pinned upstream commit and attribution.
