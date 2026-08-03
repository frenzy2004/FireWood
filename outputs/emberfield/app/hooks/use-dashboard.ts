"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type DataMode = "fixture" | "live";

export type SourceState = {
  mode: DataMode;
  status: "ok" | "partial" | "missing-key" | "error" | "not-requested";
  source: string;
  sourceUrl: string | null;
  fetchedAt: string;
  observedAt: string | null;
  error?: { code: string; message: string };
};

export type DashboardSnapshot = {
  mode: DataMode;
  generatedAt: string;
  asset: { id: string; name: string; location: { lat: number; lon: number }; radiusKm: number };
  detections: Array<{ id?: string; lat: number; lon: number; acquiredAt: string; satellite: string; confidence: string; frpMw: number | null }>;
  groups: Array<{
    cluster: { id: string; centroid: { lat: number; lon: number }; detectionCount: number; latestAcquiredAt: string; satellites: string[]; maxConfidence?: string; maxFrpMw: number | null };
    weather: { windSpeedMps: number | null; windFromDeg: number | null; relativeHumidityPct: number | null } | null;
    assessment: { score: number | null; scoreRange: { low: number; high: number } | null; band: string; contributions: Array<{ code: string; label: string; weightedValue: number; available: boolean }>; reasons: Array<{ code: string; label: string; contribution: number }>; missingInputs: string[]; completeness: string; dataQuality: string; dataConfidence: number; canAutomateAlerts?: boolean };
    officialMatch: { incident: { name: string; percentContained: number | null; updatedAt: string | null }; method: string; distanceKm: number } | null;
  }>;
  incidents: Array<{ id: string; name: string; location: { lat: number; lon: number } }>;
  perimeters: Array<{ id: string; geometry: unknown }>;
  air: { aqi: number | null; pm25UgM3: number | null } | null;
  sources: Record<string, SourceState>;
};

export type SavedAsset = {
  id: string;
  name: string;
  category?: string;
  location: { lat: number; lon: number };
  radiusKm: number;
  notes?: string | null;
};

export type ConsoleAlert = {
  dedupeKey: string;
  type: "new-cluster" | "new-satellite" | "score-increase";
  title: string;
  acquiredAt: string;
  distanceKm: number;
  confidence: string;
  source: string;
  reason: string;
};

const distanceKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const latitudeA = radians(a.lat);
  const latitudeB = radians(b.lat);
  const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLon / 2) ** 2;
  return 2 * 6_371.0088 * Math.asin(Math.min(1, Math.sqrt(haversine)));
};

export function deriveConsoleAlerts(previous: DashboardSnapshot | undefined, current: DashboardSnapshot | undefined): ConsoleAlert[] {
  if (!current) return [];
  const previousGroups = new Map(previous?.groups.map((group) => [group.cluster.id, group]) ?? []);
  const alerts = current.groups.flatMap((group) => {
    if (group.assessment.canAutomateAlerts === false) return [];
    const prior = previousGroups.get(group.cluster.id);
    const shared = {
      acquiredAt: group.cluster.latestAcquiredAt,
      distanceKm: distanceKm(current.asset.location, group.cluster.centroid),
      confidence: group.cluster.maxConfidence ?? "not reported",
      source: `${current.sources.firms?.source ?? "NASA FIRMS"}: ${group.cluster.satellites.join(", ")}`,
    };
    if (!prior) return [{ dedupeKey: `${current.asset.id}:${group.cluster.id}:new-cluster`, type: "new-cluster" as const, title: "New activity group", reason: "New detected activity group inside the asset radius.", ...shared }];
    const previousSatellites = new Set(prior.cluster.satellites);
    if (group.cluster.satellites.some((satellite) => !previousSatellites.has(satellite))) return [{ dedupeKey: `${current.asset.id}:${group.cluster.id}:new-satellite`, type: "new-satellite" as const, title: "New satellite confirmation", reason: "A new satellite contributed detected activity to this group.", ...shared }];
    if (prior.assessment.score !== null && group.assessment.score !== null && group.assessment.score - prior.assessment.score >= 10) return [{ dedupeKey: `${current.asset.id}:${group.cluster.id}:score-increase`, type: "score-increase" as const, title: "Context score increased", reason: "The deterministic context score increased by at least 10 points.", ...shared }];
    return [];
  });
  return [...new Map(alerts.map((alert) => [alert.dedupeKey, alert])).values()];
}

const defaultAsset: SavedAsset = {
  id: "demo-antelope-ranch",
  name: "Antelope Creek Ranch",
  category: "other",
  location: { lat: 41.049033, lon: -116.543867 },
  radiusKm: 45,
};

function snapshotUrl(asset: SavedAsset, mode: DataMode) {
  const query = new URLSearchParams({
    lat: String(asset.location.lat),
    lon: String(asset.location.lon),
    radiusKm: String(asset.radiusKm),
    name: asset.name,
    mode,
  });
  return `/api/snapshot?${query}`;
}

export function useDashboard(initialSnapshot?: DashboardSnapshot) {
  const requestedInitialSnapshot = useRef(false);
  const previousSnapshot = useRef<DashboardSnapshot | undefined>(initialSnapshot);
  const [mode, setMode] = useState<DataMode>(initialSnapshot?.mode ?? "fixture");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | undefined>(initialSnapshot);
  const [assets, setAssets] = useState<SavedAsset[]>([initialSnapshot?.asset ?? defaultAsset]);
  const [selectedAssetId, setSelectedAssetId] = useState(initialSnapshot?.asset.id ?? defaultAsset.id);
  const [selectedGroupId, setSelectedGroupId] = useState(initialSnapshot?.groups[0]?.cluster.id ?? "");
  const [loading, setLoading] = useState(!initialSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [assetStorageError, setAssetStorageError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<ConsoleAlert[]>(() => deriveConsoleAlerts(undefined, initialSnapshot));
  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? assets[0] ?? defaultAsset,
    [assets, selectedAssetId],
  );

  const loadSnapshot = useCallback(async (asset: SavedAsset, nextMode: DataMode) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(snapshotUrl(asset, nextMode));
      const payload = await response.json().catch(() => null) as DashboardSnapshot | { error?: string } | null;
      if (!response.ok || !payload || !("asset" in payload)) {
        throw new Error((payload && "error" in payload && payload.error) || "Snapshot data is unavailable right now.");
      }
      setSnapshot(payload);
      setAlerts(deriveConsoleAlerts(previousSnapshot.current, payload));
      previousSnapshot.current = payload;
      setSelectedGroupId(payload.groups[0]?.cluster.id ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Snapshot data is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback((nextMode = mode) => loadSnapshot(selectedAsset, nextMode), [loadSnapshot, mode, selectedAsset]);

  useEffect(() => {
    void fetch("/api/assets")
      .then((response) => {
        if (!response.ok) throw new Error("Saved asset storage is unavailable.");
        return response.json();
      })
      .then((payload: { assets?: SavedAsset[] } | null) => {
        if (payload?.assets?.length) setAssets([initialSnapshot?.asset ?? defaultAsset, ...payload.assets]);
      })
      .catch(() => setAssetStorageError("Saved asset storage is unavailable. You can keep exploring the fixture ranch and retry setup after local storage is initialized."));
  }, [initialSnapshot?.asset]);

  useEffect(() => {
    if (initialSnapshot || requestedInitialSnapshot.current) return;
    requestedInitialSnapshot.current = true;
    const timer = window.setTimeout(() => { void refresh("fixture"); }, 0);
    return () => window.clearTimeout(timer);
  }, [initialSnapshot, refresh]);

  const selectAsset = (asset: SavedAsset) => {
    setSelectedAssetId(asset.id);
    setSelectedGroupId("");
    void loadSnapshot(asset, mode);
  };

  const changeMode = (nextMode: DataMode) => {
    setMode(nextMode);
    void refresh(nextMode);
  };

  return { mode, snapshot, assets, setAssets, selectedAsset, selectAsset, selectedGroupId, setSelectedGroupId, loading, error, assetStorageError, alerts, refresh, changeMode };
}

export const formatUtc = (value: string | null | undefined) => {
  if (!value) return "not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not available";
  return `${date.toISOString().slice(11, 16)} UTC`;
};
