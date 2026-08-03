export interface Coordinate {
  lat: number;
  lon: number;
}

export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
  crossesAntimeridian: boolean;
}

export type DetectionConfidence = "low" | "nominal" | "high";

export interface Detection extends Coordinate {
  id?: string;
  source?: string;
  acquiredAt: string;
  satellite: string;
  confidence: DetectionConfidence;
  frpMw: number | null;
}

export interface ActivityCluster {
  id: string;
  centroid: Coordinate;
  detections: Detection[];
  memberFingerprints: string[];
  detectionCount: number;
  firstAcquiredAt: string;
  latestAcquiredAt: string;
  satellites: string[];
  maxConfidence: DetectionConfidence;
  maxFrpMw: number | null;
}

export interface Asset {
  id: string;
  name: string;
  location: Coordinate;
  radiusKm: number;
}

export type SourceQuality =
  | "direct-fresh"
  | "derived-or-stale"
  | "missing-or-expired";

export interface WeatherContext {
  windFromDeg: number | null;
  windSpeedMps: number | null;
  relativeHumidityPct: number | null;
  quality: SourceQuality;
  observedAt?: string;
}

export interface AirQualityContext {
  pm25UgM3: number | null;
  aqi: number | null;
  quality: SourceQuality;
  observedAt?: string;
}

export interface OfficialIncident {
  id: string;
  name: string;
  location: Coordinate;
  updatedAt: string;
  sourceUrl?: string;
}

export interface AssessmentInput {
  assetId: string;
  clusterId: string;
  distanceKm: number | null;
  ageHours: number | null;
  confidence: DetectionConfidence | null;
  frpMw: number | null;
  distinctPasses24h: number | null;
  bearingClusterToAsset: number | null;
  weather: WeatherContext | null;
  air: AirQualityContext | null;
  sourceQuality?: Partial<
    Record<
      | "distance"
      | "age"
      | "confidence"
      | "frp"
      | "distinct-passes"
      | "bearing",
      SourceQuality
    >
  >;
}

export type AssessmentBand =
  | "low-context"
  | "watch"
  | "elevated-context"
  | "high-context"
  | "unassessed";

export interface AssessmentContribution {
  code: string;
  label: string;
  weight: number;
  normalizedValue: number | null;
  quality: number;
  weightedValue: number;
  available: boolean;
}

export interface AssessmentReason {
  code: string;
  label: string;
  contribution: number;
}

export interface Assessment {
  assetId: string;
  clusterId: string;
  score: number | null;
  scoreRange: { low: number; high: number } | null;
  band: AssessmentBand;
  contributions: AssessmentContribution[];
  reasons: AssessmentReason[];
  missingInputs: string[];
  completeness: "complete" | "partial" | "insufficient";
  dataQuality: "good" | "adequate" | "limited";
  dataConfidence: number;
  canAutomateAlerts: boolean;
}

export type AlertType =
  | "new-cluster"
  | "new-satellite"
  | "activity-resumed"
  | "score-increase"
  | "official-incident";

export interface Alert {
  id: string;
  type: AlertType;
  assetId: string;
  clusterId: string;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  message: string;
}

export interface AlertEvaluation {
  assetId: string;
  clusterId: string;
  evaluatedAt: string;
  inRadius: boolean;
  satellites: string[];
  latestActivityAt: string;
  score: number | null;
  dataConfidence: number;
  matchedOfficialIncidentId: string | null;
  existingAlerts?: Alert[];
}
