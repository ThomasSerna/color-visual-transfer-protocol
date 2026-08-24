import assert from "node:assert/strict";
import test from "node:test";
import {
  COLOR4_FRAMING_QUORUM,
  COLOR4_FRAMING_WINDOW,
  Color4FramingAdviceTracker,
  color4FramingAdvice,
  color4FramingProblem,
  type Color4FramingSample,
} from "../receive/color4-framing-advice.ts";
import type { BrowserVisionDiagnostics } from "../shared/carrier.ts";

function vision(
  overrides: {
    pixelsPerModule?: number;
    contrast?: number;
    foundFiducials?: number;
    omitOptical?: boolean;
  } = {},
): BrowserVisionDiagnostics {
  const {
    pixelsPerModule = 8,
    contrast = 120,
    foundFiducials = 4,
    omitOptical = false,
  } = overrides;
  const ids = ["TL", "TR", "BR", "BL"] as const;
  return {
    fiducials: Object.fromEntries(
      ids.map((id, index) => [id, { found: index < foundFiducials, errors: 0 }]),
    ),
    ...(omitOptical ? {} : {
      optical: {
        apparentFrameWidthPx: pixelsPerModule * 172,
        apparentFrameHeightPx: pixelsPerModule * 172,
        pixelsPerModuleX: pixelsPerModule,
        pixelsPerModuleY: pixelsPerModule,
        minimumPixelsPerModule: pixelsPerModule,
        fiducialWidthPx: 30,
        fiducialHeightPx: 30,
        fiducialContrast: contrast,
        blurMetric: 30,
        clippedPixelFraction: 0,
      },
    }),
  } as BrowserVisionDiagnostics;
}

const stable = (v: BrowserVisionDiagnostics): Color4FramingSample => ({
  stability: "stable",
  vision: v,
});

test("resolution is diagnosed before contrast because it bounds everything after it", () => {
  // capture-000013: geometry perfect, 3.95 px/module, contrast 99.75. The frame
  // is bright and sharply located and still cannot be classified.
  assert.equal(
    color4FramingProblem(stable(vision({ pixelsPerModule: 3.95, contrast: 99.75 }))),
    "TOO_SMALL",
  );
  // Comfortable resolution but a washed-out screen is the other failure.
  assert.equal(
    color4FramingProblem(stable(vision({ pixelsPerModule: 8, contrast: 12 }))),
    "TOO_DIM",
  );
  // Both wrong at once still sends the user to the fix that gains the most.
  assert.equal(
    color4FramingProblem(stable(vision({ pixelsPerModule: 3, contrast: 12 }))),
    "TOO_SMALL",
  );
  // A healthy capture has nothing to say.
  assert.equal(color4FramingProblem(stable(vision())), undefined);
});

test("unusable captures yield no optical verdict to read", () => {
  assert.equal(
    color4FramingProblem({ stability: "unstable", vision: vision({ pixelsPerModule: 3 }) }),
    "UNSTABLE",
  );
  // Warmup and missing stability have not measured anything yet.
  assert.equal(color4FramingProblem({ stability: "warmup", vision: vision() }), undefined);
  assert.equal(color4FramingProblem({ stability: undefined, vision: vision() }), undefined);
  // Missing markers mean the optical numbers describe nothing in particular.
  assert.equal(color4FramingProblem(stable(vision({ foundFiducials: 3 }))), "NOT_FOUND");
  assert.equal(color4FramingProblem(stable(vision({ omitOptical: true }))), undefined);
});

test("advice stays silent until most of the window agrees", () => {
  const tracker = new Color4FramingAdviceTracker();
  const small = stable(vision({ pixelsPerModule: 3.95 }));

  for (let count = 1; count < COLOR4_FRAMING_QUORUM; count++) {
    tracker.observe(small);
    assert.equal(tracker.advice, undefined, `after ${count} captures`);
  }
  tracker.observe(small);
  assert.equal(tracker.advice?.problem, "TOO_SMALL");
});

test("a scattering of unrelated problems never reaches quorum", () => {
  const tracker = new Color4FramingAdviceTracker();
  const rotation: Color4FramingSample[] = [
    stable(vision({ pixelsPerModule: 3 })),
    { stability: "unstable", vision: vision() },
    stable(vision({ contrast: 5 })),
    stable(vision({ foundFiducials: 2 })),
  ];
  for (let index = 0; index < COLOR4_FRAMING_WINDOW; index++) {
    tracker.observe(rotation[index % rotation.length]!);
  }
  assert.equal(tracker.advice, undefined);
});

test("the window forgets a problem the user has fixed", () => {
  const tracker = new Color4FramingAdviceTracker();
  const small = stable(vision({ pixelsPerModule: 3.95 }));
  const healthy = stable(vision());

  for (let index = 0; index < COLOR4_FRAMING_WINDOW; index++) tracker.observe(small);
  assert.equal(tracker.advice?.problem, "TOO_SMALL");

  // Moving closer must retire the advice rather than latch it forever.
  for (let index = 0; index < COLOR4_FRAMING_WINDOW; index++) tracker.observe(healthy);
  assert.equal(tracker.advice, undefined);
});

test("a decoded frame clears accumulated evidence", () => {
  const tracker = new Color4FramingAdviceTracker();
  const small = stable(vision({ pixelsPerModule: 3.95 }));
  for (let index = 0; index < COLOR4_FRAMING_WINDOW; index++) tracker.observe(small);
  assert.equal(tracker.advice?.problem, "TOO_SMALL");

  tracker.reset();
  assert.equal(tracker.advice, undefined);
});

test("every problem carries a distinct actionable headline and tips", () => {
  const problems = ["TOO_SMALL", "TOO_DIM", "UNSTABLE", "NOT_FOUND"] as const;
  const headlines = new Set<string>();
  for (const problem of problems) {
    const advice = color4FramingAdvice(problem);
    assert.equal(advice.problem, problem);
    assert.ok(advice.headline.length > 0, problem);
    assert.ok(advice.tips.length > 0, problem);
    headlines.add(advice.headline);
  }
  assert.equal(headlines.size, problems.length);
});

test("the tracker rejects window and quorum settings it cannot honour", () => {
  assert.throws(() => new Color4FramingAdviceTracker(0), /positive integer/);
  assert.throws(() => new Color4FramingAdviceTracker(1.5), /positive integer/);
  assert.throws(() => new Color4FramingAdviceTracker(4, 5), /within the window/);
  assert.throws(() => new Color4FramingAdviceTracker(4, 0), /within the window/);
});
