import type { DashboardSnapshot } from "../hooks/use-dashboard";
import { detectionSelectionId, type MapSelection } from "./map-evidence";

export type MapFocusMode = "asset" | "evidence" | "threat";
export type MapBounds = [[number, number], [number, number]];
export type MapCoordinate = { lat: number; lon: number };
export type MapFocusPlan = {
  mode: MapFocusMode;
  bounds: MapBounds;
  target: MapCoordinate;
};
export type MapFocusRequest = {
  id: number;
  mode: MapFocusMode;
  groupId?: string;
};

const MINIMUM_BOUND_DELTA = 0.01;

function finiteCoordinate(location: MapCoordinate): MapCoordinate | null {
  return Number.isFinite(location.lat) && Number.isFinite(location.lon)
    ? location
    : null;
}

function perimeterCoordinates(value: unknown, points: MapCoordinate[]) {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2
    && typeof value[0] === "number"
    && Number.isFinite(value[0])
    && typeof value[1] === "number"
    && Number.isFinite(value[1])
  ) {
    points.push({ lon: value[0], lat: value[1] });
    return;
  }
  value.forEach((child) => perimeterCoordinates(child, points));
}

function expandAxis(minimum: number, maximum: number): [number, number] {
  if (maximum - minimum >= MINIMUM_BOUND_DELTA * 2) return [minimum, maximum];
  const midpoint = (minimum + maximum) / 2;
  return [midpoint - MINIMUM_BOUND_DELTA, midpoint + MINIMUM_BOUND_DELTA];
}

function boundsFor(points: MapCoordinate[]): MapBounds {
  const finite = points.flatMap((point) => {
    const coordinate = finiteCoordinate(point);
    return coordinate ? [coordinate] : [];
  });
  const longitudes = finite.map((point) => point.lon);
  const latitudes = finite.map((point) => point.lat);
  const [west, east] = expandAxis(Math.min(...longitudes), Math.max(...longitudes));
  const [south, north] = expandAxis(Math.min(...latitudes), Math.max(...latitudes));
  return [[west, south], [east, north]];
}

function assetRadiusCoordinates(snapshot: DashboardSnapshot): MapCoordinate[] {
  const { lat, lon } = snapshot.asset.location;
  const radiusKm = Number.isFinite(snapshot.asset.radiusKm)
    ? Math.max(0, snapshot.asset.radiusKm)
    : 0;
  const latitudeDelta = radiusKm / 111.32;
  const longitudeDelta = radiusKm / (
    111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180))
  );
  return [
    { lat: lat - latitudeDelta, lon: lon - longitudeDelta },
    { lat: lat + latitudeDelta, lon: lon + longitudeDelta },
  ];
}

function allEvidenceCoordinates(snapshot: DashboardSnapshot): MapCoordinate[] {
  const points: MapCoordinate[] = [snapshot.asset.location];
  snapshot.detections.forEach((detection) => {
    points.push({ lat: detection.lat, lon: detection.lon });
  });
  snapshot.incidents.forEach((incident) => points.push(incident.location));
  snapshot.perimeters.forEach((perimeter) => {
    const geometry = perimeter.geometry as { coordinates?: unknown } | null;
    perimeterCoordinates(geometry?.coordinates, points);
  });
  return points;
}

export function buildMapFocusPlan(
  snapshot: DashboardSnapshot,
  mode: MapFocusMode,
  selectedGroupId = "",
): MapFocusPlan {
  const group = snapshot.groups.find((entry) => entry.cluster.id === selectedGroupId)
    ?? snapshot.groups[0];
  const resolvedMode: MapFocusMode = mode === "threat" && !group ? "asset" : mode;
  const points = resolvedMode === "asset"
    ? assetRadiusCoordinates(snapshot)
    : resolvedMode === "threat"
      ? [snapshot.asset.location, group!.cluster.centroid]
      : allEvidenceCoordinates(snapshot);
  return {
    mode: resolvedMode,
    bounds: boundsFor(points),
    target: resolvedMode === "threat" ? group!.cluster.centroid : snapshot.asset.location,
  };
}

export function selectionLocation(
  snapshot: DashboardSnapshot,
  selection: MapSelection,
): MapCoordinate | null {
  if (!selection) return null;
  if (selection.kind === "group") {
    return snapshot.groups.find((entry) => entry.cluster.id === selection.id)?.cluster.centroid ?? null;
  }
  if (selection.kind === "incident") {
    return snapshot.incidents.find((entry) => entry.id === selection.id)?.location ?? null;
  }
  const entry = snapshot.detections.find((detection, index) => (
    detectionSelectionId(detection, index) === selection.id
  ));
  return entry ? { lat: entry.lat, lon: entry.lon } : null;
}

export function groupForDetection(
  snapshot: DashboardSnapshot,
  detectionId: string,
): DashboardSnapshot["groups"][number] | undefined {
  return snapshot.groups.find((group) => group.cluster.detections.some((detection, index) => (
    detectionSelectionId(detection, index) === detectionId
    || detection.id === detectionId
    || detection.fingerprint === detectionId
  )));
}
