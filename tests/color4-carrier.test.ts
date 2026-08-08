import assert from "node:assert/strict";
import test from "node:test";
import { packFrame } from "../shared/protocol.ts";
import { ROBUST_PROFILE } from "../shared/color4/profiles.ts";
import { renderColor4InnerFrame } from "../send/color4-render.ts";

function innerFrame(sequence: number): Uint8Array {
  return packFrame(
    {
      sessionId: 7,
      seq: sequence,
      k: 1,
      blockLen: ROBUST_PROFILE.blockBytes,
      totalLen: 1,
      payloadFnv: 0,
    },
    new Uint8Array(ROBUST_PROFILE.blockBytes),
  );
}

test("COLOR_4 renderer rejects context that disagrees with the inner frame", () => {
  assert.throws(
    () =>
      renderColor4InnerFrame(innerFrame(2), {
        sessionId: 7,
        sequence: 3,
        profileId: ROBUST_PROFILE.id,
        paletteId: 0,
      }),
    /context does not match/,
  );
});

test("COLOR_4 renderer preserves the canonical frame dimensions", () => {
  const rendered = renderColor4InnerFrame(innerFrame(2), {
    sessionId: 7,
    sequence: 2,
    profileId: ROBUST_PROFILE.id,
    paletteId: 0,
  });
  assert.equal(rendered.width, 172);
  assert.equal(rendered.height, 172);
});

