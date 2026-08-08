# Transmitting a signal

Open `/send/`, choose **File** or **Text snippet**, then choose the optical
carrier before starting:

- **QR compatible** is the Decimen v0.3.0 carrier. Use it for interoperability
  with the upstream app and the standalone HTML builds.
- **COLOR_4** carries the same legacy inner frame in a four-colour physical frame.
  It is an optical MVP to measure, not a promise of higher throughput.

The receiver must select the same carrier. For COLOR_4 it must also select the
same palette; the receiver reads the profile from each valid bootstrap.

- **File** — tap **Select File** (any file up to 64 MiB). Streaming starts
  immediately; the button becomes **Stop transfer**. Gzip is used only when it
  actually shrinks the optical payload.
- **Text snippet** — paste or type up to 4 MiB, then tap **Start text stream**.

While streaming, *Share receiver link* opens a dialog containing a QR for the
receiver page, a copyable URL and the operating-system share sheet. That QR is
only a web link; it does not change the selected transfer carrier.

Tap the transmitted frame to make it fullscreen. Tap again, or press Esc, to
leave fullscreen. Use maximum screen brightness and avoid display colour modes
that strongly alter KCMY. The stream is self-contained and continues forever; it
has no start or end frame, so a receiver may join after transmission begins.

## Common transfer settings

Changing carrier, profile, palette or any transfer setting starts a new
fountain session. The stream-details grid reports the actual rate, carrier,
frame payload, compression and source-block count K.

| Setting | Default | Notes |
|---|---:|---|
| display size | 900 px | capped by the screen; fullscreen uses the available integer scale |
| QR tx fps | 60 | on a 60 Hz sender, try 24–30 if decoding stalls |
| COLOR_4 ROBUST tx fps | 5 | holds every frame for at least six real display cycles |
| COLOR_4 EXPERIMENTAL tx fps | 30 | Labs only; holds every frame for at least two cycles |

The scheduler follows real display refreshes and does not emit catch-up bursts.
Requested fps can therefore be higher than the rate physically shown.

## QR settings

| Setting | Default | Notes |
|---|---:|---|
| bytes / frame | 2953 (QR v40) | use 1465 (v27) for monitors, distance or weak cameras |
| error correction | L | the fountain layer handles discarded QR frames |

If QR crawls, try bytes/frame 1465 and then tx fps 24.

## COLOR_4 settings

| Setting | Choice | Notes |
|---|---|---|
| profile | ROBUST | stable target, `72×85`, 1,318-byte inner frame, 1,298-byte LT block |
| profile | EXPERIMENTAL | Labs, `120×119`, 3,326-byte frame, 3,306-byte LT block; not a stable mode |
| palette | KCMY | stable K/C/M/Y mapping; use this for acceptance runs |
| palette | KRGB | Labs comparison palette; both devices must opt into it |

Start with ROBUST, KCMY and 5 fps. Compare COLOR_4 and QR with the same file,
displayed area, camera and lighting; see the [benchmark protocol](../technical/benchmarking.md).
