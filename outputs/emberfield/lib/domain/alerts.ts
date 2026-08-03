import type { Alert, AlertEvaluation, AlertType } from "./types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

const stableHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const messageFor = (
  type: AlertType,
  previous: AlertEvaluation | null,
  current: AlertEvaluation,
) => {
  switch (type) {
    case "new-cluster":
      return "New satellite activity detected inside the asset radius.";
    case "new-satellite": {
      const known = new Set(previous?.satellites ?? []);
      const added = current.satellites.filter((satellite) => !known.has(satellite));
      return `New satellite confirmation: ${added.join(", ")}.`;
    }
    case "activity-resumed":
      return "Satellite activity resumed after at least six quiet hours.";
    case "score-increase":
      return `Context score increased from ${previous?.score ?? 0} to ${current.score}.`;
    case "official-incident":
      return `Matched official incident ${current.matchedOfficialIncidentId}.`;
  }
};

export function deriveAlerts(
  previous: AlertEvaluation | null,
  current: AlertEvaluation,
): Alert[] {
  if (!current.inRadius || current.dataConfidence < 60) return [];

  const types: AlertType[] = [];
  if (previous === null || !previous.inRadius) {
    types.push("new-cluster");
  } else {
    const previousSatellites = new Set(previous.satellites);
    if (current.satellites.some((satellite) => !previousSatellites.has(satellite))) {
      types.push("new-satellite");
    }

    const previousActivity = Date.parse(previous.latestActivityAt);
    const currentActivity = Date.parse(current.latestActivityAt);
    if (
      currentActivity > previousActivity &&
      currentActivity - previousActivity >= SIX_HOURS_MS
    ) {
      types.push("activity-resumed");
    }

    if (
      previous.score !== null &&
      current.score !== null &&
      current.score - previous.score >= 10
    ) {
      types.push("score-increase");
    }

    if (
      current.matchedOfficialIncidentId !== null &&
      current.matchedOfficialIncidentId !== previous.matchedOfficialIncidentId
    ) {
      types.push("official-incident");
    }
  }

  const existingAlerts = [
    ...(current.existingAlerts ?? []),
    ...(previous?.existingAlerts ?? []),
  ];

  return types.map((type) => {
    const dedupeKey = `${current.assetId}:${current.clusterId}:${type}`;
    const existing = existingAlerts.find((alert) => alert.dedupeKey === dedupeKey);

    return {
      id: existing?.id ?? `alert-${stableHash(dedupeKey)}`,
      type,
      assetId: current.assetId,
      clusterId: current.clusterId,
      dedupeKey,
      createdAt: existing?.createdAt ?? current.evaluatedAt,
      updatedAt: current.evaluatedAt,
      message: messageFor(type, previous, current),
    };
  });
}
