import type { BoundingBox, Coordinate } from "./types";

const EARTH_RADIUS_KM = 6_371.0088;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

const clampLatitude = (latitude: number) =>
  Math.max(-90, Math.min(90, latitude));

const normalizeLongitude = (longitude: number) => {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
};

export function distanceKm(a: Coordinate, b: Coordinate): number {
  const latitudeA = toRadians(clampLatitude(a.lat));
  const latitudeB = toRadians(clampLatitude(b.lat));
  const latitudeDelta = latitudeB - latitudeA;
  const longitudeDelta = toRadians(normalizeLongitude(b.lon - a.lon));
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    EARTH_RADIUS_KM *
    Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))))
  );
}

export function bearingDegrees(a: Coordinate, b: Coordinate): number {
  const latitudeA = toRadians(clampLatitude(a.lat));
  const latitudeB = toRadians(clampLatitude(b.lat));
  const longitudeDelta = toRadians(normalizeLongitude(b.lon - a.lon));
  const y = Math.sin(longitudeDelta) * Math.cos(latitudeB);
  const x =
    Math.cos(latitudeA) * Math.sin(latitudeB) -
    Math.sin(latitudeA) * Math.cos(latitudeB) * Math.cos(longitudeDelta);

  return ((toDegrees(Math.atan2(y, x)) % 360) + 360) % 360;
}

export function angleDifference(a: number, b: number): number {
  const difference = Math.abs(normalizeLongitude(a - b));
  return Math.min(difference, 360 - difference);
}

export function boundingBox(
  center: Coordinate,
  radiusKm: number,
): BoundingBox {
  const radius = Math.max(0, radiusKm);
  const latitude = clampLatitude(center.lat);
  const longitude = normalizeLongitude(center.lon);
  const angularDistance = Math.min(Math.PI, radius / EARTH_RADIUS_KM);
  const latitudeDelta = toDegrees(angularDistance);
  const north = clampLatitude(latitude + latitudeDelta);
  const south = clampLatitude(latitude - latitudeDelta);
  const coversAllLongitudes = north === 90 || south === -90;
  const longitudeDelta = coversAllLongitudes
    ? 180
    : toDegrees(
        Math.asin(
          Math.max(
            -1,
            Math.min(
              1,
              Math.sin(angularDistance) /
                Math.cos(toRadians(latitude)),
            ),
          ),
        ),
      );
  const rawWest = longitude - longitudeDelta;
  const rawEast = longitude + longitudeDelta;
  const crossesAntimeridian =
    !coversAllLongitudes && (rawWest < -180 || rawEast > 180);

  return {
    north,
    south,
    west: coversAllLongitudes ? -180 : normalizeLongitude(rawWest),
    east: coversAllLongitudes ? 180 : normalizeLongitude(rawEast),
    crossesAntimeridian,
  };
}
