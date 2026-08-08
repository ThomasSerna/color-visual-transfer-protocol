# Color Visual Transfer Protocol notices

## Decimen Optical Transfer

This project incorporates Decimen Optical Transfer from
<https://github.com/bashalarmistalt/decimen-optical-transfer> at commit
`f0c49e92d50366c6867759800dd962b70d840a1a` (version 0.3.0).

Copyright (c) 2026 Evan Crawley (Bash Alarmist)

The incorporated work is distributed under the MIT License. Its license text
is preserved in [`LICENSE`](LICENSE). The original protocol, QR carrier,
application pages, tests and documentation remain attributed to their author.

## COLOR_4 extension

The `COLOR_4/1` carrier is an extension maintained in this repository. It
wraps, but does not alter, Decimen's DCF2 container, fountain code or 20-byte
frame format. No endorsement by the upstream author is implied.

## Pinned optical runtimes

- `zxing-wasm` 2.2.4, reader WASM source SHA-256
  `85d46f55d7c86a4d09bb04273367408b19c324f582d040d018aecb25a9a82942`.
- `@techstark/opencv-js` 5.0.0-release.1, built from the official OpenCV 5.0.0
  JavaScript distribution, source SHA-256
  `b873c8211421da7b9bf41ae157a923f05a46a0b8d3e5904c44c6f3ad6d39a1bd`.

Both are resolved through the locked npm dependency graph and served from the
application origin. They are never loaded from a CDN at runtime. OpenCV is
Apache-2.0 licensed; zxing-wasm/ZXing-C++ retains its upstream license notices.
