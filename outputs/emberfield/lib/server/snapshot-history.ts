import { deriveAlerts } from "../domain/alerts";
import { distanceKm } from "../domain/geometry";
import type { Alert, AlertEvaluation } from "../domain/types";
import type { DataMode } from "../sources/shared";
import type { Snapshot, SnapshotGroup } from "./snapshot";

const MAXIMUM_HISTORY_RUNS = 48;
const MAXIMUM_HISTORY_DETECTIONS = 2_000;
const MAXIMUM_HISTORY_ALERTS = 200;

export interface StoredSnapshotRun {
  id: string;
  assetId: string;
  mode: DataMode;
  generatedAt: string;
  snapshot: Snapshot;
  alerts: Alert[];
  byteSize: number;
  createdAt: string;
}

export interface CompactSnapshotHistory {
  since: string;
  runs: Array<{
    id: string;
    generatedAt: string;
    detectionCount: number;
    groupCount: number;
  }>;
  detections: Snapshot["detections"];
  alerts: Alert[];
}

const fingerprintSet = (group: SnapshotGroup): Set<string> =>
  new Set(group.cluster.memberFingerprints);

const overlapCount = (left: Set<string>, right: Set<string>): number => {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
};

function evaluationFor(
  snapshot: Snapshot,
  group: SnapshotGroup,
  existingAlerts: Alert[] = [],
): AlertEvaluation {
  return {
    assetId: snapshot.asset.id,
    clusterId: group.cluster.id,
    dedupeScope: snapshot.mode,
    evaluatedAt: snapshot.generatedAt,
    inRadius:
      distanceKm(snapshot.asset.location, group.cluster.centroid) <=
      snapshot.asset.radiusKm,
    satellites: group.cluster.satellites,
    latestActivityAt: group.cluster.latestAcquiredAt,
    score: group.assessment.score,
    dataConfidence: group.assessment.canAutomateAlerts
      ? group.assessment.dataConfidence
      : Math.min(59, group.assessment.dataConfidence),
    matchedOfficialIncidentId: group.officialMatch?.incident.id ?? null,
    existingAlerts,
  };
}

/**
 * Reuses a prior server-issued group identity when a refreshed cluster shares
 * a detection fingerprint, with a small centroid fallback for sources whose
 * upstream row identity changed. Histories are supplied by asset and mode, so
 * matching can never cross those boundaries.
 */
export function stabilizeSnapshot(
  current: Snapshot,
  previous: Snapshot | null,
  existingAlerts: Alert[] = [],
): { snapshot: Snapshot; alerts: Alert[] } {
  const unusedPrevious = new Set(previous?.groups.map((_, index) => index) ?? []);
  const matchedPrevious = new Map<string, SnapshotGroup>();
  const groups = current.groups.map((group) => {
    const fingerprints = fingerprintSet(group);
    const candidates = [...unusedPrevious]
      .map((index) => ({
        index,
        group: previous?.groups[index] as SnapshotGroup,
      }))
      .map((candidate) => ({
        ...candidate,
        overlap: overlapCount(fingerprints, fingerprintSet(candidate.group)),
        distance: distanceKm(
          group.cluster.centroid,
          candidate.group.cluster.centroid,
        ),
      }))
      .filter(({ overlap, distance }) => overlap > 0 || distance <= 1.5)
      .sort(
        (left, right) =>
          right.overlap - left.overlap ||
          left.distance - right.distance ||
          left.group.cluster.id.localeCompare(right.group.cluster.id),
      );
    const matched = candidates[0];
    if (!matched) return group;
    unusedPrevious.delete(matched.index);
    matchedPrevious.set(matched.group.cluster.id, matched.group);
    return {
      ...group,
      cluster: { ...group.cluster, id: matched.group.cluster.id },
      assessment: {
        ...group.assessment,
        clusterId: matched.group.cluster.id,
      },
    };
  });
  const snapshot = { ...current, groups };
  const alerts = groups.flatMap((group) => {
    const previousGroup = matchedPrevious.get(group.cluster.id) ?? null;
    return deriveAlerts(
      previous && previousGroup
        ? evaluationFor(previous, previousGroup, existingAlerts)
        : null,
      evaluationFor(snapshot, group, existingAlerts),
    );
  });
  return { snapshot, alerts };
}

const detectionIdentity = (detection: Snapshot["detections"][number]): string => {
  const fingerprint = (detection as typeof detection & { fingerprint?: string })
    .fingerprint;
  return fingerprint ?? detection.id ?? [
    detection.source,
    detection.satellite,
    detection.acquiredAt,
    detection.lat,
    detection.lon,
  ].join("|");
};

export function compactSnapshotHistory(
  allRuns: StoredSnapshotRun[],
  since: string,
): CompactSnapshotHistory {
  const runs = [...allRuns]
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
    .slice(0, MAXIMUM_HISTORY_RUNS);
  const detectionMap = new Map<string, Snapshot["detections"][number]>();
  for (const run of runs) {
    for (const detection of run.snapshot.detections) {
      const identity = detectionIdentity(detection);
      if (!detectionMap.has(identity)) detectionMap.set(identity, detection);
      if (detectionMap.size >= MAXIMUM_HISTORY_DETECTIONS) break;
    }
    if (detectionMap.size >= MAXIMUM_HISTORY_DETECTIONS) break;
  }
  const alertMap = new Map<string, Alert>();
  for (const alert of runs.flatMap(({ alerts }) => alerts)) {
    const existing = alertMap.get(alert.dedupeKey);
    if (!existing || alert.updatedAt > existing.updatedAt) {
      alertMap.set(alert.dedupeKey, alert);
    }
  }

  return {
    since,
    runs: runs.map((run) => ({
      id: run.id,
      generatedAt: run.generatedAt,
      detectionCount: run.snapshot.detections.length,
      groupCount: run.snapshot.groups.length,
    })),
    detections: [...detectionMap.values()]
      .sort((left, right) => right.acquiredAt.localeCompare(left.acquiredAt))
      .slice(0, MAXIMUM_HISTORY_DETECTIONS),
    alerts: [...alertMap.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAXIMUM_HISTORY_ALERTS),
  };
}
