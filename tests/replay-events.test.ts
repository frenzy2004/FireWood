import { describe, expect, it } from "vitest";

import {
  FULL_REPLAY_STATE,
  nextReplayEvent,
  replayEventTimes,
  replayPosition,
  type ReplayState,
} from "../app/components/replay-events";
import type { DashboardSnapshot } from "../app/hooks/use-dashboard";

const snapshot = {
  generatedAt: "2018-11-08T15:00:00.000Z",
  detections: [
    { acquiredAt: "2018-11-08T14:42:00.000Z" },
    { acquiredAt: "2018-11-08T14:48:00.000Z" },
    { acquiredAt: "2018-11-08T14:54:00.000Z" },
  ],
  groups: [],
  assetWeather: { observedAt: "2018-11-08T15:00:00.000Z" },
  air: { observedAt: "2018-11-08T14:48:00.000Z" },
  alerts: [{ createdAt: "2018-11-08T14:54:00.000Z", updatedAt: "2018-11-08T14:54:00.000Z" }],
  sources: {
    firms: { observedAt: "2018-11-08T14:54:00.000Z" },
    nws: { observedAt: "2018-11-08T15:00:00.000Z" },
    airnow: { observedAt: "2018-11-08T14:48:00.000Z" },
  },
} as unknown as DashboardSnapshot;

const restarted: ReplayState = {
  cutoff: "2018-11-07T15:00:00.000Z",
  sources: FULL_REPLAY_STATE.sources,
};

describe("event-driven replay", () => {
  it("deduplicates and orders exact enabled source timestamps", () => {
    expect(replayEventTimes(snapshot, FULL_REPLAY_STATE.sources)).toEqual([
      "2018-11-08T14:42:00.000Z",
      "2018-11-08T14:48:00.000Z",
      "2018-11-08T14:54:00.000Z",
      "2018-11-08T15:00:00.000Z",
    ]);
    expect(replayEventTimes(snapshot, { firms: true, nws: false, airnow: false })).toEqual([
      "2018-11-08T14:42:00.000Z",
      "2018-11-08T14:48:00.000Z",
      "2018-11-08T14:54:00.000Z",
    ]);
  });

  it("jumps from restart to the first real event", () => {
    expect(nextReplayEvent(snapshot, restarted)?.cutoff).toBe("2018-11-08T14:42:00.000Z");
  });

  it("advances through evidence and ends at now after the final event", () => {
    const afterFirst = nextReplayEvent(snapshot, restarted);
    const afterSecond = nextReplayEvent(snapshot, afterFirst!);
    const afterThird = nextReplayEvent(snapshot, afterSecond!);
    const afterFourth = nextReplayEvent(snapshot, afterThird!);
    const finished = nextReplayEvent(snapshot, afterFourth!);

    expect(afterSecond?.cutoff).toBe("2018-11-08T14:48:00.000Z");
    expect(afterThird?.cutoff).toBe("2018-11-08T14:54:00.000Z");
    expect(afterFourth?.cutoff).toBe("2018-11-08T15:00:00.000Z");
    expect(finished).toEqual(FULL_REPLAY_STATE);
    expect(nextReplayEvent(snapshot, finished!)).toBeNull();
  });

  it("returns no next step when enabled sources have no events", () => {
    const emptySnapshot = { ...snapshot, detections: [], assetWeather: null, air: null, alerts: [], sources: {} } as unknown as DashboardSnapshot;
    expect(replayEventTimes(emptySnapshot, FULL_REPLAY_STATE.sources)).toEqual([]);
    expect(nextReplayEvent(emptySnapshot, restarted)).toBeNull();
  });

  it("converts exact event cutoffs back to the 24 hour slider position", () => {
    expect(replayPosition(snapshot, restarted)).toBe(0);
    expect(replayPosition(snapshot, { ...restarted, cutoff: "2018-11-08T14:42:00.000Z" })).toBeCloseTo(23.7, 5);
    expect(replayPosition(snapshot, FULL_REPLAY_STATE)).toBe(24);
  });
});
