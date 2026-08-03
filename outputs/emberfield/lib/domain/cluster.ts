import { distanceKm } from "./geometry";
import type {
  ActivityCluster,
  Coordinate,
  Detection,
  DetectionConfidence,
} from "./types";

export interface ClusterOptions {
  maxDistanceKm: number;
  maxGapHours: number;
}

const confidenceRank: Record<DetectionConfidence, number> = {
  low: 0,
  nominal: 1,
  high: 2,
};

const stableHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const normalizedTime = (value: string) => new Date(value).toISOString();

const detectionFingerprint = (detection: Detection) =>
  stableHash(
    JSON.stringify([
      detection.source ?? "",
      detection.id ?? "",
      detection.satellite,
      normalizedTime(detection.acquiredAt),
      detection.lat,
      detection.lon,
      detection.confidence,
      detection.frpMw,
    ]),
  );

const centroidOf = (detections: Detection[]): Coordinate => {
  const vector = detections.reduce(
    (sum, detection) => {
      const latitude = (detection.lat * Math.PI) / 180;
      const longitude = (detection.lon * Math.PI) / 180;
      sum.x += Math.cos(latitude) * Math.cos(longitude);
      sum.y += Math.cos(latitude) * Math.sin(longitude);
      sum.z += Math.sin(latitude);
      return sum;
    },
    { x: 0, y: 0, z: 0 },
  );
  const longitude = Math.atan2(vector.y, vector.x);
  const hypotenuse = Math.hypot(vector.x, vector.y);
  const latitude = Math.atan2(vector.z, hypotenuse);

  return {
    lat: (latitude * 180) / Math.PI,
    lon: (longitude * 180) / Math.PI,
  };
};

export function clusterDetections(
  rows: Detection[],
  options: ClusterOptions,
): ActivityCluster[] {
  const sorted = rows
    .map((detection) => ({
      detection: {
        ...detection,
        acquiredAt: normalizedTime(detection.acquiredAt),
      },
      fingerprint: detectionFingerprint(detection),
    }))
    .sort(
      (a, b) =>
        Date.parse(a.detection.acquiredAt) -
          Date.parse(b.detection.acquiredAt) ||
        a.fingerprint.localeCompare(b.fingerprint),
    );
  const parents = sorted.map((_, index) => index);

  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parents[rootB] = rootA;
  };
  const maximumGapMs = Math.max(0, options.maxGapHours) * 60 * 60 * 1_000;

  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      const timeDifference =
        Date.parse(sorted[right].detection.acquiredAt) -
        Date.parse(sorted[left].detection.acquiredAt);
      if (timeDifference > maximumGapMs) break;
      if (
        distanceKm(sorted[left].detection, sorted[right].detection) <=
        Math.max(0, options.maxDistanceKm)
      ) {
        union(left, right);
      }
    }
  }

  const components = new Map<number, typeof sorted>();
  sorted.forEach((entry, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(entry);
    components.set(root, component);
  });

  return [...components.values()].map((members) => {
    const detections = members.map(({ detection }) => detection);
    const memberFingerprints = members
      .map(({ fingerprint }) => fingerprint)
      .sort();
    const maxConfidence = detections.reduce<DetectionConfidence>(
      (maximum, detection) =>
        confidenceRank[detection.confidence] > confidenceRank[maximum]
          ? detection.confidence
          : maximum,
      "low",
    );
    const finiteFrp = detections
      .map(({ frpMw }) => frpMw)
      .filter((value): value is number => value !== null && Number.isFinite(value));

    return {
      id: `cluster-${members[0].fingerprint}`,
      centroid: centroidOf(detections),
      detections,
      memberFingerprints,
      detectionCount: detections.length,
      firstAcquiredAt: detections[0].acquiredAt,
      latestAcquiredAt: detections[detections.length - 1].acquiredAt,
      satellites: [...new Set(detections.map(({ satellite }) => satellite))].sort(),
      maxConfidence,
      maxFrpMw: finiteFrp.length > 0 ? Math.max(...finiteFrp) : null,
    };
  });
}
