import assert from "node:assert/strict";
import test from "node:test";
import {
  TemporalFrameScheduler,
  effectiveHoldMs,
  minimumHoldMs,
} from "../shared/frame-timing";

test("COLOR_4 hold policy converts profile cycles into real time", () => {
  assert.equal(minimumHoldMs(6), 100);
  assert.equal(effectiveHoldMs(5, 6), 200);
  assert.equal(effectiveHoldMs(30, 2), 1000 / 30);
  assert.equal(effectiveHoldMs(120, 2), 1000 / 30);
});

for (const refreshHz of [30, 60, 120]) {
  test(`temporal scheduler respects a six-cycle hold at ${refreshHz} Hz rAF`, () => {
    const scheduler = new TemporalFrameScheduler(30, 6);
    const presentedAt: number[] = [];
    let frame = 0;
    const take = (now: number) => {
      const presented = scheduler.take(now, () => frame++);
      if (presented !== undefined) presentedAt.push(now);
    };

    // The caller can present an already-available first frame synchronously.
    take(0);
    for (let tick = 1; tick <= refreshHz; tick++) take((tick * 1000) / refreshHz);

    assert.equal(presentedAt[0], 0);
    assert.equal(presentedAt.length, 11);
    for (let index = 1; index < presentedAt.length; index++) {
      assert.ok(presentedAt[index]! - presentedAt[index - 1]! >= 100 - 1e-6);
    }
  });
}

test("empty queues preserve the displayed frame and do not advance the hold", () => {
  const scheduler = new TemporalFrameScheduler(10, 2);
  assert.equal(scheduler.take(0, () => "first"), "first");
  assert.equal(scheduler.take(100, () => undefined), undefined);
  assert.equal(scheduler.take(101, () => "second"), "second");
});

test("a long animation pause cannot create a catch-up burst", () => {
  const scheduler = new TemporalFrameScheduler(10, 2);
  const frames = ["first", "second", "third"];
  const dequeue = () => frames.shift();
  assert.equal(scheduler.take(0, dequeue), "first");
  assert.equal(scheduler.take(5_000, dequeue), "second");
  assert.equal(scheduler.take(5_001, dequeue), undefined);
  assert.equal(scheduler.take(5_100, dequeue), "third");
});
