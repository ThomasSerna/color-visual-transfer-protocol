# Canonical COLOR_4 replay fixtures

These fixtures start at the canonical-raster boundary. They exercise bootstrap,
timing, phase, calibration, colour classification and Reed-Solomon handling,
but they do not replay camera acquisition, contour detection, fiducial search or
homography estimation. Do not use them as evidence that the OpenCV path or a
physical transfer works end to end.

Only the privacy-reviewed warped artifact is stored in this canonical fixture.
After a separate privacy review, the corresponding full camera frame was
retained under `../physical/capture-000017/`, where it follows the physical
acquisition evidence contract.

## `capture-000017`

`capture-000017-warped.png` is the lossless 1032 x 1032 RGBA canonical frame
(172 modules at scale 6) recovered from a Debug Vision bundle.
`bootstrap-luma.json` is the corresponding textual 3 x 24 bootstrap matrix,
derived with the classifier's center-inset median RGB sampling and BT.709
luminance coefficients. It pins the photometric oracle without duplicating or
re-encoding the PNG.

- PNG SHA-256: `3af7b4dd41ef15447fc54f7ef99e2d150a3f8a754b5c6a8a900003ae8e864bcc`
- decoded RGBA SHA-256: `86ebacb71a5bb9268848c3c478cdc51452ad4671d30bd38dc0d20e03a1402554`
- expected classifier result: PHY 1, ROBUST, KCMY, phase 3
- expected timing result: 0 errors across 314 modules
- expected classification result: 219 uncertain cells and 195 candidate erased
  bytes, distributed `[26, 35, 29, 34, 34, 37]` across the six shards; score
  distribution `count=195`, `min=1.0014599635981696`,
  `p50=1.6220608388842113`, `p95=12.534467124400843`,
  `max=62.854022931804224`
- coded-byte SHA-256: `fd777331c87b26bbdc019c2b78eccd4713e62bb942df2bcca62e9128b75536df`
- expected ranked-policy selection: `classifier-budgeted`, 100% budget (32 per
  shard), one attempt, with 183 selected erasures distributed
  `[26, 32, 29, 32, 32, 32]`
- expected unwrap result: valid session 31926, sequence 23 (phase 3), with 0
  corrected errors, 47 corrected bytes and all six shards corrected
- inner-frame SHA-256: `a5dcecd1058c25b13c5076e9f7d7e2617af3c830823c33831180d6a4f9976a84`

This is a `crc-derived-regression` oracle: the recovered bytes are pinned only
after Reed-Solomon, CRC32C and wire validation. The original transmitter bytes
are unavailable, so this fixture is not independent transmitter ground truth
and does not by itself prove a successful physical end-to-end transfer.
