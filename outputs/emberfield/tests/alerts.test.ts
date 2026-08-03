import { describe, expect, it } from "vitest";

import { deriveAlerts } from "../lib/domain/alerts";
import type { AlertEvaluation } from "../lib/domain/types";

const previous: AlertEvaluation = {
  assetId: "asset-1",
  clusterId: "cluster-1",
  evaluatedAt: "2026-08-03T06:00:00.000Z",
  inRadius: true,
  satellites: ["NOAA-20"],
  latestActivityAt: "2026-08-03T05:00:00.000Z",
  score: 50,
  dataConfidence: 100,
  matchedOfficialIncidentId: null,
  existingAlerts: [],
};

const current: AlertEvaluation = {
  ...previous,
  evaluatedAt: "2026-08-03T10:00:00.000Z",
  satellites: ["NOAA-20", "NOAA-21"],
  latestActivityAt: "2026-08-03T10:00:00.000Z",
  score: 60,
};

describe("deriveAlerts", () => {
  it("emits one stable dedupe family per new satellite and score trigger", () => {
    const alerts = deriveAlerts(previous, current);

    expect(alerts.map(({ type }) => type)).toEqual([
      "new-satellite",
      "score-increase",
    ]);
    expect(new Set(alerts.map(({ dedupeKey }) => dedupeKey)).size).toBe(2);
    expect(alerts[0].dedupeKey).toBe(
      "asset-1:cluster-1:new-satellite",
    );
  });

  it("does not describe a brand-new in-radius cluster as a new satellite confirmation", () => {
    const firstEvaluation = {
      ...current,
      matchedOfficialIncidentId: "incident-7",
    };

    expect(deriveAlerts(null, firstEvaluation).map(({ type }) => type)).toEqual([
      "new-cluster",
      "official-incident",
    ]);
  });

  it("detects resumed activity and a newly matched official incident", () => {
    const next = {
      ...previous,
      evaluatedAt: "2026-08-03T13:00:00.000Z",
      latestActivityAt: "2026-08-03T12:00:00.000Z",
      matchedOfficialIncidentId: "incident-7",
    };

    expect(deriveAlerts(previous, next).map(({ type }) => type)).toEqual([
      "activity-resumed",
      "official-incident",
    ]);
  });

  it("updates an existing alert timestamp without changing its identity", () => {
    const existing = {
      id: "alert-existing",
      type: "score-increase" as const,
      assetId: previous.assetId,
      clusterId: previous.clusterId,
      dedupeKey: "asset-1:cluster-1:score-increase",
      createdAt: "2026-08-03T01:00:00.000Z",
      updatedAt: "2026-08-03T01:00:00.000Z",
      message: "Older score message",
    };
    const alerts = deriveAlerts(
      { ...previous, existingAlerts: [existing] },
      current,
    );
    const scoreAlert = alerts.find(({ type }) => type === "score-increase");

    expect(scoreAlert?.id).toBe("alert-existing");
    expect(scoreAlert?.createdAt).toBe(existing.createdAt);
    expect(scoreAlert?.updatedAt).toBe(current.evaluatedAt);
  });

  it("suppresses all automated alerts below 60 data confidence", () => {
    expect(
      deriveAlerts(previous, { ...current, dataConfidence: 59 }),
    ).toEqual([]);
  });
});
