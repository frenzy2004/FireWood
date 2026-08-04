import {
  distanceBetweenKm,
  type DashboardDetection,
  type DashboardSnapshot,
} from "../hooks/use-dashboard";

export type MapSelection =
  | { kind: "detection"; id: string }
  | { kind: "group"; id: string }
  | { kind: "incident"; id: string }
  | null;

export type DetectionEvidenceDetail = {
  kind: "detection";
  id: string;
  title: string;
  source: string;
  location: { lat: number; lon: number };
  distanceKm: number;
  acquiredAt: string;
  confidence: string;
  frpMw: number | null;
};

export type GroupEvidenceDetail = {
  kind: "group";
  id: string;
  title: "Activity group";
  source: "NASA FIRMS";
  location: { lat: number; lon: number };
  distanceKm: number;
  detectionCount: number;
  latestAcquiredAt: string;
  satellites: string[];
  maxConfidence: string | null;
  maxFrpMw: number | null;
};

export type IncidentEvidenceDetail = {
  kind: "incident";
  id: string;
  title: string;
  source: "WFIGS";
  location: { lat: number; lon: number };
  distanceKm: number;
  type: string | null;
  acres: number | null;
  percentContained: number | null;
  discoveredAt: string | null;
  updatedAt: string | null;
};

export type MapEvidenceDetail =
  | DetectionEvidenceDetail
  | GroupEvidenceDetail
  | IncidentEvidenceDetail;

export function detectionSelectionId(
  detection: DashboardDetection,
  index: number,
): string {
  return detection.id
    ?? detection.fingerprint
    ?? [
      detection.source ?? "NASA FIRMS",
      detection.satellite,
      detection.acquiredAt,
      detection.lat,
      detection.lon,
      index,
    ].join("|");
}

export function describeMapSelection(
  snapshot: DashboardSnapshot,
  selection: MapSelection,
): MapEvidenceDetail | null {
  if (selection === null) return null;

  if (selection.kind === "detection") {
    const entry = snapshot.detections
      .map((detection, index) => ({
        detection,
        id: detectionSelectionId(detection, index),
      }))
      .find(({ id }) => id === selection.id);
    if (!entry) return null;
    const { detection } = entry;
    const location = { lat: detection.lat, lon: detection.lon };
    return {
      kind: "detection",
      id: entry.id,
      title: `${detection.satellite} detection`,
      source: detection.source ?? snapshot.sources.firms.source,
      location,
      distanceKm: distanceBetweenKm(snapshot.asset.location, location),
      acquiredAt: detection.acquiredAt,
      confidence: detection.confidence,
      frpMw: detection.frpMw,
    };
  }

  if (selection.kind === "group") {
    const group = snapshot.groups.find(({ cluster }) => cluster.id === selection.id);
    if (!group) return null;
    return {
      kind: "group",
      id: group.cluster.id,
      title: "Activity group",
      source: "NASA FIRMS",
      location: group.cluster.centroid,
      distanceKm: distanceBetweenKm(snapshot.asset.location, group.cluster.centroid),
      detectionCount: group.cluster.detectionCount,
      latestAcquiredAt: group.cluster.latestAcquiredAt,
      satellites: group.cluster.satellites,
      maxConfidence: group.cluster.maxConfidence ?? null,
      maxFrpMw: group.cluster.maxFrpMw,
    };
  }

  const incident = snapshot.incidents.find(({ id }) => id === selection.id);
  if (!incident) return null;
  return {
    kind: "incident",
    id: incident.id,
    title: incident.name,
    source: "WFIGS",
    location: incident.location,
    distanceKm: distanceBetweenKm(snapshot.asset.location, incident.location),
    type: incident.type ?? null,
    acres: incident.acres ?? null,
    percentContained: incident.percentContained ?? null,
    discoveredAt: incident.discoveredAt ?? null,
    updatedAt: incident.updatedAt ?? null,
  };
}
