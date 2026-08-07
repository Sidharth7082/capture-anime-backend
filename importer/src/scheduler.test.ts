/**
 * Unit tests for the scheduler: overlap guard, next-run tracking and the
 * onRunStart / onRunFinished callbacks (node:test, no timers mocked — short
 * intervals so tests stay fast).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "./scheduler.js";

test("start schedules a run and tracks the next run time", async () => {
  let runs = 0;
  const s = createScheduler(async () => {
    runs += 1;
  }, { intervalMs: 50, runOnStart: false });
  assert.equal(s.getNextRunAt(), null);
  s.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(runs >= 1, "interval ticks should have run the job");
  const nextAt = s.getNextRunAt();
  assert.ok(nextAt !== null && nextAt > Date.now() - 1000, "next run is scheduled");
  await s.stop();
});

test("callbacks fire around each run; runs never overlap", async () => {
  let started = 0;
  let finished = 0;
  const s = createScheduler(
    async () => {
      await new Promise((r) => setTimeout(r, 40));
    },
    {
      intervalMs: 30, // fires faster than the 40ms run -> ticks must be skipped
      runOnStart: true,
      onRunStart: () => {
        started += 1;
      },
      onRunFinished: () => {
        finished += 1;
      },
    },
  );
  s.start();
  await new Promise((r) => setTimeout(r, 200));
  await s.stop();
  assert.ok(started >= 1, `at least one run (started=${started})`);
  assert.equal(started, finished, "every started run finishes");
  // 200ms / 40ms = 5 sequential runs max; overlap would inflate this.
  assert.ok(started <= 6, `overlap guard must serialize runs (started=${started})`);
  assert.ok(s.getNextRunAt() !== null);
});
