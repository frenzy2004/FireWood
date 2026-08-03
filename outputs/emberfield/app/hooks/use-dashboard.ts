"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deriveAlerts } from "@/lib/domain/alerts";
import type { Alert, AlertEvaluation, AlertType } from "@/lib/domain/types";

export type DataMode = "fixture" | "live";

export type SourceState = {
  mode: DataMode;
  status: "ok" | "partial" | "missing-key" | "error" | "not-requested";
  source: string;
  sourceUrl: string | null;
  sourceUrls?: string[];
  coverage?: { succeeded: number; failed: number; total: number };
  fetchedAt: string | null;
  observedAt: string | null;
  replayState?: "included" | "excluded" | "cutoff-filtered";
  error?: { code: string; message: string };
};

export type DashboardDetection = {
  id?: string;
  fingerprint?: string;
  source?: string;
  lat: number;
  lon: number;
  acquiredAt: string;
  satellite: string;
  confidence: string;
  frpMw: number | null;
};

export type PersistedDashboardAlert = Alert & {
  acquiredAt: string;
  distanceKm: number;
  confidence: string;
  source: string;
};

export type DashboardSnapshot = {
  mode: DataMode;
  generatedAt: string;
  asset: { id: string; name: string; location: { lat: number; lon: number }; radiusKm: number };
  detections: DashboardDetection[];
  groups: Array<{
    cluster: {
      id: string;
      centroid: { lat: number; lon: number };
      detections: DashboardDetection[];
      memberFingerprints: string[];
      detectionCount: number;
      firstAcquiredAt: string;
      latestAcquiredAt: string;
      satellites: string[];
      maxConfidence?: string;
      maxFrpMw: number | null;
    };
    weather: {
      windSpeedMps: number | null;
      windFromDeg: number | null;
      relativeHumidityPct: number | null;
      quality?: string;
      observedAt?: string;
    } | null;
    assessment: {
      score: number | null;
      scoreRange: { low: number; high: number } | null;
      band: string;
      contributions: Array<{
        code: string;
        label: string;
        weight: number;
        normalizedValue: number | null;
        quality: number;
        weightedValue: number;
        available: boolean;
      }>;
      reasons: Array<{ code: string; label: string; contribution: number }>;
      missingInputs: string[];
      completeness: "complete" | "partial" | "insufficient" | string;
      dataQuality: "good" | "adequate" | "limited" | string;
      dataConfidence: number;
      canAutomateAlerts?: boolean;
    };
    officialMatch: {
      incident: {
        id?: string;
        name: string;
        percentContained: number | null;
        updatedAt: string | null;
      };
      method: string;
      distanceKm: number;
    } | null;
  }>;
  incidents: Array<{ id: string; name: string; location: { lat: number; lon: number } }>;
  perimeters: Array<{ id: string; geometry: unknown }>;
  air: {
    aqi: number | null;
    pm25UgM3: number | null;
    quality?: string;
    observedAt?: string;
  } | null;
  sources: Record<string, SourceState>;
  snapshotId?: string | null;
  persisted?: boolean;
  alerts?: Alert[];
  history24h?: {
    since: string;
    runs: Array<{
      id: string;
      generatedAt: string;
      detectionCount: number;
      groupCount: number;
    }>;
    detections: DashboardDetection[];
    alerts: PersistedDashboardAlert[];
  };
};

export type SavedAsset = {
  id: string;
  name: string;
  category?: string;
  location: { lat: number; lon: number };
  radiusKm: number;
  notes?: string | null;
};

export type IntegrationStatus = "ready" | "missing-key" | "offline" | "error";

export type HealthPayload = {
  status: "ok" | "degraded";
  integrations: Record<"firms" | "airnow" | "ollama", { configured: boolean; status: IntegrationStatus }>;
};

export type ConsoleAlert = {
  dedupeKey: string;
  type: AlertType;
  title: string;
  acquiredAt: string;
  distanceKm: number;
  confidence: string;
  source: string;
  reason: string;
};

export type AssetSummary = {
  score: number | null;
  trend: "up" | "down" | "steady" | "new" | "unknown";
  completeness: "complete" | "partial" | "insufficient" | "no-activity" | string;
  mode: DataMode;
  generatedAt: string;
};

export type DashboardErrorNotice = {
  attemptedMode: DataMode;
  message: string;
  status: number | null;
  retryAfterSeconds: number | null;
  retainedMode: DataMode | null;
  retainedAssetName: string | null;
};

const EARTH_RADIUS_KM = 6_371.0088;

export const distanceBetweenKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const latitudeA = radians(a.lat);
  const latitudeB = radians(b.lat);
  const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine)));
};

const alertTitle: Record<AlertType, string> = {
  "new-cluster": "New activity group",
  "new-satellite": "New satellite joined",
  "activity-resumed": "Detected activity resumed",
  "score-increase": "Context score increased",
  "official-incident": "Official incident associated",
};

const alertReason: Record<AlertType, string> = {
  "new-cluster": "A new detected activity group appeared inside the selected asset radius.",
  "new-satellite": "A new satellite contributed a detection to this activity group.",
  "activity-resumed": "The group received a new detection after at least six quiet hours.",
  "score-increase": "The deterministic context score increased by at least 10 points.",
  "official-incident": "An official incident became associated by perimeter or bounded proximity.",
};

function evaluationFor(
  snapshot: DashboardSnapshot,
  group: DashboardSnapshot["groups"][number],
): AlertEvaluation {
  const distanceKm = distanceBetweenKm(snapshot.asset.location, group.cluster.centroid);
  return {
    assetId: snapshot.asset.id,
    clusterId: group.cluster.id,
    dedupeScope: snapshot.mode,
    evaluatedAt: snapshot.generatedAt,
    inRadius: distanceKm <= snapshot.asset.radiusKm,
    satellites: group.cluster.satellites,
    latestActivityAt: group.cluster.latestAcquiredAt,
    score: group.assessment.score,
    dataConfidence: group.assessment.canAutomateAlerts === false
      ? Math.min(59, group.assessment.dataConfidence)
      : group.assessment.dataConfidence,
    matchedOfficialIncidentId: group.officialMatch?.incident.id ?? null,
  };
}

export function deriveConsoleAlerts(
  previous: DashboardSnapshot | undefined,
  current: DashboardSnapshot | undefined,
): ConsoleAlert[] {
  if (!current) return [];
  const comparablePrevious = previous?.asset.id === current.asset.id && previous.mode === current.mode
    ? previous
    : undefined;
  const previousGroups = new Map(comparablePrevious?.groups.map((group) => [group.cluster.id, group]) ?? []);
  const alerts: ConsoleAlert[] = [];

  for (const group of current.groups) {
    const distanceKm = distanceBetweenKm(current.asset.location, group.cluster.centroid);
    if (distanceKm > current.asset.radiusKm) continue;
    const prior = previousGroups.get(group.cluster.id);
    const domainAlerts = deriveAlerts(
      prior && comparablePrevious ? evaluationFor(comparablePrevious, prior) : null,
      evaluationFor(current, group),
    );
    const source = `${current.sources.firms?.source ?? "NASA FIRMS"}: ${group.cluster.satellites.join(", ") || "satellite not reported"}`;
    for (const alert of domainAlerts) {
      alerts.push({
        dedupeKey: alert.dedupeKey,
        type: alert.type,
        title: alertTitle[alert.type],
        acquiredAt: group.cluster.latestAcquiredAt,
        distanceKm,
        confidence: group.cluster.maxConfidence ?? "not reported",
        source,
        reason: alertReason[alert.type],
      });
    }
  }

  return [...new Map(alerts.map((alert) => [alert.dedupeKey, alert])).values()];
}

const defaultAsset: SavedAsset = {
  id: "demo-antelope-ranch",
  name: "Antelope Creek Ranch",
  category: "other",
  location: { lat: 41.049033, lon: -116.543867 },
  radiusKm: 45,
};

const DEMO_ASSET_ID = defaultAsset.id;

class SnapshotRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
  }
}

const detectionIdentity = (detection: DashboardDetection) => detection.fingerprint
  ?? detection.id
  ?? [
    detection.source,
    detection.satellite,
    detection.acquiredAt,
    detection.lat,
    detection.lon,
  ].join("|");

export function hydrateSnapshotHistory(snapshot: DashboardSnapshot): DashboardSnapshot {
  const evidence = new Map<string, DashboardDetection>();
  for (const detection of [
    ...snapshot.detections,
    ...(snapshot.history24h?.detections ?? []),
  ]) {
    const identity = detectionIdentity(detection);
    if (!evidence.has(identity)) evidence.set(identity, detection);
  }
  return {
    ...snapshot,
    detections: [...evidence.values()].sort(
      (left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt),
    ),
  };
}

function persistedConsoleAlerts(snapshot: DashboardSnapshot): ConsoleAlert[] {
  const domainAlerts = new Map<string, Alert | PersistedDashboardAlert>();
  for (const alert of [
    ...(snapshot.history24h?.alerts ?? []),
    ...(snapshot.alerts ?? []),
  ]) {
    const prior = domainAlerts.get(alert.dedupeKey);
    if (!prior || alert.updatedAt > prior.updatedAt) domainAlerts.set(alert.dedupeKey, alert);
  }

  return [...domainAlerts.values()].flatMap((alert) => {
    if (
      "acquiredAt" in alert
      && typeof alert.acquiredAt === "string"
      && "distanceKm" in alert
      && typeof alert.distanceKm === "number"
      && Number.isFinite(alert.distanceKm)
      && "confidence" in alert
      && typeof alert.confidence === "string"
      && "source" in alert
      && typeof alert.source === "string"
    ) {
      return [{
        dedupeKey: alert.dedupeKey,
        type: alert.type,
        title: alertTitle[alert.type],
        acquiredAt: alert.acquiredAt,
        distanceKm: alert.distanceKm,
        confidence: alert.confidence,
        source: alert.source,
        reason: alert.message,
      }];
    }
    const group = snapshot.groups.find((candidate) => candidate.cluster.id === alert.clusterId);
    if (!group) return [];
    const evaluatedAt = Date.parse(alert.updatedAt);
    const detection = [...group.cluster.detections]
      .filter((candidate) => Date.parse(candidate.acquiredAt) <= evaluatedAt)
      .sort((left, right) => Date.parse(right.acquiredAt) - Date.parse(left.acquiredAt))[0];
    if (!detection) return [];
    const distanceKm = distanceBetweenKm(snapshot.asset.location, group.cluster.centroid);
    return [{
      dedupeKey: alert.dedupeKey,
      type: alert.type,
      title: alertTitle[alert.type],
      acquiredAt: detection.acquiredAt,
      distanceKm,
      confidence: detection.confidence,
      source: `${detection.source ?? snapshot.sources.firms?.source ?? "NASA FIRMS"}: ${detection.satellite}`,
      reason: alert.message,
    }];
  });
}

function initialConsoleAlerts(snapshot: DashboardSnapshot | undefined): ConsoleAlert[] {
  if (!snapshot) return [];
  const combined = [
    ...deriveConsoleAlerts(undefined, snapshot),
    ...persistedConsoleAlerts(snapshot),
  ];
  return [...new Map(combined.map((alert) => [alert.dedupeKey, alert])).values()];
}

const requestedModeForAsset = (asset: SavedAsset, mode: DataMode): DataMode =>
  asset.id === DEMO_ASSET_ID ? mode : "live";

const snapshotKey = (assetId: string, mode: DataMode) => `${assetId}:${mode}`;

function summarizeSnapshot(snapshot: DashboardSnapshot, previous?: AssetSummary): AssetSummary {
  const scores = snapshot.groups
    .map((group) => group.assessment.score)
    .filter((score): score is number => score !== null);
  const score = scores.length > 0 ? Math.max(...scores) : null;
  const completenessOrder = { complete: 0, partial: 1, insufficient: 2 } as const;
  const completeness = snapshot.groups.length === 0
    ? "no-activity"
    : snapshot.groups.reduce<string>((worst, group) => {
      const candidate = group.assessment.completeness;
      const worstRank = completenessOrder[worst as keyof typeof completenessOrder] ?? 0;
      const candidateRank = completenessOrder[candidate as keyof typeof completenessOrder] ?? 0;
      return candidateRank > worstRank ? candidate : worst;
    }, "complete");
  const trend = previous?.score === undefined || previous.score === null || score === null
    ? (previous ? "unknown" : "new")
    : score > previous.score
      ? "up"
      : score < previous.score
        ? "down"
        : "steady";
  return { score, trend, completeness, mode: snapshot.mode, generatedAt: snapshot.generatedAt };
}

function isHealthPayload(value: unknown): value is HealthPayload {
  if (!value || typeof value !== "object") return false;
  const integrations = (value as { integrations?: unknown }).integrations;
  if (!integrations || typeof integrations !== "object") return false;
  return ["firms", "airnow", "ollama"].every((key) => {
    const integration = (integrations as Record<string, unknown>)[key];
    return Boolean(integration && typeof integration === "object" && typeof (integration as { status?: unknown }).status === "string");
  });
}

export function useDashboard(initialSnapshot?: DashboardSnapshot) {
  const hydratedInitialSnapshot = useMemo(
    () => initialSnapshot ? hydrateSnapshotHistory(initialSnapshot) : undefined,
    [initialSnapshot],
  );
  const requestedInitialSnapshot = useRef(false);
  const snapshotRequest = useRef<{ sequence: number; controller: AbortController } | null>(null);
  const healthRequest = useRef<AbortController | null>(null);
  const snapshotRef = useRef<DashboardSnapshot | undefined>(hydratedInitialSnapshot);
  const initialKey = hydratedInitialSnapshot ? snapshotKey(hydratedInitialSnapshot.asset.id, hydratedInitialSnapshot.mode) : null;
  const initialAlerts = initialConsoleAlerts(hydratedInitialSnapshot);
  const previousSnapshots = useRef(new Map<string, DashboardSnapshot>(hydratedInitialSnapshot && initialKey ? [[initialKey, hydratedInitialSnapshot]] : []));
  const alertHistories = useRef(new Map<string, Map<string, ConsoleAlert>>(initialKey ? [[initialKey, new Map(initialAlerts.map((alert) => [alert.dedupeKey, alert]))]] : []));

  const [mode, setMode] = useState<DataMode>(hydratedInitialSnapshot?.mode ?? "fixture");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | undefined>(hydratedInitialSnapshot);
  const [assets, setAssets] = useState<SavedAsset[]>([hydratedInitialSnapshot?.asset ?? defaultAsset]);
  const [selectedAssetId, setSelectedAssetId] = useState(hydratedInitialSnapshot?.asset.id ?? defaultAsset.id);
  const [selectedGroupId, setSelectedGroupId] = useState(hydratedInitialSnapshot?.groups[0]?.cluster.id ?? "");
  const [loading, setLoading] = useState(!hydratedInitialSnapshot);
  const [error, setError] = useState<DashboardErrorNotice | null>(null);
  const [assetStorageError, setAssetStorageError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthPayload | undefined>();
  const [healthError, setHealthError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState(hydratedInitialSnapshot?.generatedAt ?? null);
  const [summaries, setSummaries] = useState<Record<string, AssetSummary>>(() => hydratedInitialSnapshot
    ? { [hydratedInitialSnapshot.asset.id]: summarizeSnapshot(hydratedInitialSnapshot) }
    : {});
  const [alerts, setAlerts] = useState<ConsoleAlert[]>(initialAlerts);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? assets[0] ?? defaultAsset,
    [assets, selectedAssetId],
  );

  const loadHealth = useCallback(async () => {
    healthRequest.current?.abort();
    const controller = new AbortController();
    healthRequest.current = controller;
    try {
      const response = await fetch("/api/health", { signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isHealthPayload(payload)) throw new Error("Integration health is unavailable.");
      setHealth(payload);
      setHealthError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setHealth((current) => ({
        status: "degraded",
        integrations: {
          firms: { configured: current?.integrations.firms.configured ?? false, status: "error" },
          airnow: { configured: current?.integrations.airnow.configured ?? false, status: "error" },
          ollama: { configured: current?.integrations.ollama.configured ?? false, status: "error" },
        },
      }));
      setHealthError("Integration health is unavailable.");
    }
  }, []);

  const loadSnapshot = useCallback(async (asset: SavedAsset, nextMode: DataMode) => {
    snapshotRequest.current?.controller.abort();
    const controller = new AbortController();
    const sequence = (snapshotRequest.current?.sequence ?? 0) + 1;
    snapshotRequest.current = { sequence, controller };
    setLoading(true);
    setError(null);
    const requestedMode = requestedModeForAsset(asset, nextMode);
    try {
      const response = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: asset.id, mode: requestedMode, refresh: true }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object" || !("asset" in payload)) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Snapshot data is unavailable right now.";
        const retryAfter = Number(response.headers.get("Retry-After"));
        throw new SnapshotRequestError(
          message,
          response.status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        );
      }
      if (snapshotRequest.current.sequence !== sequence) return;
      const responseSnapshot = payload as DashboardSnapshot;
      if (responseSnapshot.asset.id !== asset.id || responseSnapshot.mode !== requestedMode) {
        throw new SnapshotRequestError("Snapshot identity did not match the requested saved asset and evidence mode.", 502, null);
      }
      const normalized = hydrateSnapshotHistory(responseSnapshot);
      const key = snapshotKey(normalized.asset.id, normalized.mode);
      const prior = previousSnapshots.current.get(key);
      const events = deriveConsoleAlerts(prior, normalized);
      const history = alertHistories.current.get(key) ?? new Map<string, ConsoleAlert>();
      for (const event of events) history.set(event.dedupeKey, event);
      for (const event of persistedConsoleAlerts(normalized)) history.set(event.dedupeKey, event);
      alertHistories.current.set(key, history);
      previousSnapshots.current.set(key, normalized);
      snapshotRef.current = normalized;
      setSnapshot(normalized);
      setMode(normalized.mode);
      setSelectedAssetId(normalized.asset.id);
      setAlerts([...history.values()].sort((left, right) => Date.parse(right.acquiredAt) - Date.parse(left.acquiredAt)));
      setSelectedGroupId(normalized.groups[0]?.cluster.id ?? "");
      setLastRefreshAt(normalized.generatedAt);
      setSummaries((current) => ({
        ...current,
        [normalized.asset.id]: summarizeSnapshot(
          normalized,
          prior ? summarizeSnapshot(prior) : undefined,
        ),
      }));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (snapshotRequest.current?.sequence !== sequence) return;
      const retained = snapshotRef.current;
      setError({
        attemptedMode: requestedMode,
        message: cause instanceof Error ? cause.message : "Snapshot data is unavailable right now.",
        status: cause instanceof SnapshotRequestError ? cause.status : null,
        retryAfterSeconds: cause instanceof SnapshotRequestError ? cause.retryAfterSeconds : null,
        retainedMode: retained?.mode ?? null,
        retainedAssetName: retained?.asset.name ?? null,
      });
    } finally {
      if (snapshotRequest.current?.sequence === sequence) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async (nextMode = mode) => {
    await Promise.all([loadSnapshot(selectedAsset, nextMode), loadHealth()]);
  }, [loadHealth, loadSnapshot, mode, selectedAsset]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/assets", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Saved asset storage is unavailable.");
        return response.json();
      })
      .then((payload: { assets?: SavedAsset[] } | null) => {
        if (!payload?.assets?.length) return;
        const first = initialSnapshot?.asset ?? defaultAsset;
        setAssets([first, ...payload.assets.filter((asset) => asset.id !== first.id)]);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setAssetStorageError("Saved asset storage is unavailable. You can keep exploring the fixture ranch and retry setup after local storage is initialized.");
      });
    return () => controller.abort();
  }, [initialSnapshot?.asset]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadHealth(); }, 0);
    return () => {
      window.clearTimeout(timer);
      healthRequest.current?.abort();
    };
  }, [loadHealth]);

  useEffect(() => {
    if (initialSnapshot || requestedInitialSnapshot.current) return;
    requestedInitialSnapshot.current = true;
    const timer = window.setTimeout(() => { void refresh("fixture"); }, 0);
    return () => window.clearTimeout(timer);
  }, [initialSnapshot, refresh]);

  useEffect(() => () => snapshotRequest.current?.controller.abort(), []);

  const selectAsset = (asset: SavedAsset) => {
    setSelectedAssetId(asset.id);
    setSelectedGroupId("");
    if (snapshotRef.current?.asset.id !== asset.id) {
      snapshotRef.current = undefined;
      setSnapshot(undefined);
    }
    const requestedMode = requestedModeForAsset(asset, mode);
    const key = snapshotKey(asset.id, requestedMode);
    setAlerts([...(alertHistories.current.get(key)?.values() ?? [])]);
    void loadSnapshot(asset, requestedMode);
  };

  const changeMode = (nextMode: DataMode) => {
    const requestedMode = requestedModeForAsset(selectedAsset, nextMode);
    if (requestedMode === mode && snapshotRef.current?.mode === requestedMode) return;
    void Promise.all([loadSnapshot(selectedAsset, requestedMode), loadHealth()]);
  };

  return {
    mode,
    snapshot,
    assets,
    setAssets,
    selectedAsset,
    selectAsset,
    selectedGroupId,
    setSelectedGroupId,
    loading,
    error,
    assetStorageError,
    alerts,
    health,
    healthError,
    lastRefreshAt,
    summaries,
    refresh,
    changeMode,
    fixtureAvailable: selectedAsset.id === DEMO_ASSET_ID,
  };
}

export const formatUtc = (value: string | null | undefined) => {
  if (!value) return "not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not available";
  return date.toISOString().replace(".000Z", "Z");
};

export const formatShortUtc = (value: string | null | undefined) => {
  if (!value) return "not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not available";
  return `${date.toISOString().slice(11, 16)} UTC`;
};
