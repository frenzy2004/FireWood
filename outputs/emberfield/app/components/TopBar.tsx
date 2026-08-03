"use client";

import { ArrowsClockwise, CloudArrowDown, Leaf, Radio, WarningCircle } from "@phosphor-icons/react";

import { formatUtc, type DashboardSnapshot, type DataMode, type HealthPayload } from "../hooks/use-dashboard";

const statusLabel = (value: string) => value.replaceAll("-", " ");

export function TopBar({
  mode,
  snapshotMode,
  health,
  healthError,
  lastRefreshAt,
  snapshot,
  fixtureAvailable,
  loading,
  onModeChange,
  onRefresh,
}: {
  mode: DataMode;
  snapshotMode?: DataMode;
  health?: HealthPayload;
  healthError?: string | null;
  lastRefreshAt?: string | null;
  snapshot?: DashboardSnapshot;
  fixtureAvailable: boolean;
  loading: boolean;
  onModeChange: (mode: DataMode) => void;
  onRefresh: () => void;
}) {
  const integrations = [
    ["FIRMS", health?.integrations.firms.status],
    ["AirNow", health?.integrations.airnow.status],
    ["Ollama", health?.integrations.ollama.status],
  ] as const;
  const history = snapshot?.history24h;
  const historyAlertCount = new Set(history?.alerts.map((alert) => alert.dedupeKey) ?? []).size;
  const persistenceLabel = snapshot?.persisted === true
    ? `Saved locally · ${history?.runs.length ?? 0}/48 runs · ${snapshot.detections.length.toLocaleString("en-US")}/2,000 detections · ${historyAlertCount}/200 alerts`
    : snapshot?.persisted === false
      ? snapshot.asset.id === "demo-antelope-ranch"
        ? "Virtual demo · not persisted"
        : "Local snapshot · not persisted"
      : "Persistence not checked";
  return <header className="topbar">
    <div className="brand"><span className="brand-mark"><Leaf size={18} weight="bold" /></span><span>EmberField</span><small>operations console</small></div>
    <div className="topbar-actions">
      <div className="connection-health" aria-label="Integration health" aria-live="polite">
        {integrations.map(([label, status]) => <span key={label} className={`health-status status-${status ?? "checking"}`}><Radio size={12} weight="fill" />{label} {status ? statusLabel(status) : healthError ? "unavailable" : "checking"}</span>)}
      </div>
      <span className={`snapshot-badge ${snapshotMode ?? mode}`}>Showing {snapshotMode ?? mode} snapshot</span>
      <span className={`history-badge ${snapshot?.persisted === true ? "persisted" : "not-persisted"}`} title="Bounded local history: 48 refreshes, 2,000 detections, and 200 alerts over the latest 24 hours.">{persistenceLabel}</span>
      <div className="mode-switch" aria-label="Evidence mode">
        <button aria-pressed={mode === "fixture"} className={mode === "fixture" ? "is-active" : ""} onClick={() => onModeChange("fixture")} disabled={!fixtureAvailable} title={fixtureAvailable ? "Use the bounded virtual demo" : "Fixture mode is available only for the virtual demo asset"}>Fixture data</button>
        <button aria-pressed={mode === "live"} className={mode === "live" ? "is-active" : ""} onClick={() => onModeChange("live")}>Live data</button>
      </div>
      <button className="control-button refresh-button" aria-label="Refresh evidence" title="Refresh evidence" onClick={onRefresh} disabled={loading}>
        {loading ? <CloudArrowDown size={18} /> : <ArrowsClockwise size={18} />}<span>{loading ? "Loading" : "Refresh"}</span>
      </button>
      <span className="refresh-time">Last refresh {formatUtc(lastRefreshAt)}</span>
      <span className="safety-status" title="Informational context only"><WarningCircle size={17} /> Context only</span>
    </div>
  </header>;
}
