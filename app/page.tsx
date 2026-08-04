"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";

import { ActivityInspector } from "./components/ActivityInspector";
import { AgentPanel } from "./components/AgentPanel";
import { AssetRail } from "./components/AssetRail";
import { SetupPanel } from "./components/SetupPanel";
import { type MapFocusRequest } from "./components/map-navigation";
import { applyReplayState, FULL_REPLAY_STATE, type ReplayFocusEvent, type ReplayState, TimelineDock } from "./components/TimelineDock";
import { TopBar } from "./components/TopBar";
import { type DashboardSnapshot, type SavedAsset, useDashboard } from "./hooks/use-dashboard";

const MapCanvas = dynamic(
  () => import("./components/MapCanvas").then((module) => module.MapCanvas),
  { ssr: false, loading: () => <section className="map-canvas panel map-loading" aria-label="Evidence map"><div className="map-grid" /><p>Preparing local evidence map</p></section> },
);

const tabs = ["Assets", "Activity", "Timeline", "Gemma"] as const;
type Tab = (typeof tabs)[number];

export function Dashboard({ initialSnapshot }: { initialSnapshot?: DashboardSnapshot }) {
  const dashboard = useDashboard(initialSnapshot);
  const [activeTab, setActiveTab] = useState<Tab>("Activity");
  const [setupOpen, setSetupOpen] = useState(false);
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest>();
  const [replaySession, setReplaySession] = useState<{ snapshotIdentity: string; state: ReplayState }>({
    snapshotIdentity: "no-snapshot",
    state: FULL_REPLAY_STATE,
  });
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const saveAsset = (asset: SavedAsset) => {
    dashboard.setAssets((assets) => [asset, ...assets.filter((item) => item.id !== asset.id)]);
    dashboard.selectAsset(asset);
    setSetupOpen(false);
  };
  const snapshot = dashboard.snapshot;
  const snapshotIdentity = snapshot
    ? `${snapshot.asset.id}:${snapshot.mode}:${snapshot.generatedAt}`
    : "no-snapshot";
  const replay = replaySession.snapshotIdentity === snapshotIdentity
    ? replaySession.state
    : FULL_REPLAY_STATE;
  const replaySnapshot = useMemo(() => applyReplayState(snapshot, replay), [replay, snapshot]);
  const replayAlerts = useMemo(() => {
    if (replay.cutoff === null) return dashboard.alerts;
    const cutoffMs = Date.parse(replay.cutoff);
    if (!Number.isFinite(cutoffMs)) return [];
    return dashboard.alerts.filter((alert) => Date.parse(alert.acquiredAt) <= cutoffMs);
  }, [dashboard.alerts, replay.cutoff]);
  const limited = snapshot?.groups.some((group) => group.assessment.dataQuality === "limited" || group.assessment.completeness !== "complete");
  const updateReplay = useCallback((state: ReplayState) => {
    setReplaySession({ snapshotIdentity, state });
  }, [snapshotIdentity]);
  const handleReplayFocus = useCallback((event: ReplayFocusEvent) => {
    setReplaySession({
      snapshotIdentity,
      state: { cutoff: event.acquiredAt, sources: replay.sources },
    });
    dashboard.setSelectedGroupId(event.groupId);
    setMapFocusRequest((current) => ({
      id: (current?.id ?? 0) + 1,
      mode: "threat",
      groupId: event.groupId,
    }));
  }, [dashboard.setSelectedGroupId, replay.sources, snapshotIdentity]);
  const activateTab = (index: number, focus = false) => {
    const normalized = (index + tabs.length) % tabs.length;
    setActiveTab(tabs[normalized]);
    if (focus) tabRefs.current[normalized]?.focus();
  };
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") { event.preventDefault(); activateTab(index + 1, true); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); activateTab(index - 1, true); }
    else if (event.key === "Home") { event.preventDefault(); activateTab(0, true); }
    else if (event.key === "End") { event.preventDefault(); activateTab(tabs.length - 1, true); }
  };
  const assetRail = <AssetRail assets={dashboard.assets} selectedId={dashboard.selectedAsset.id} summaries={dashboard.summaries} onSelect={dashboard.selectAsset} onAdd={() => setSetupOpen(true)} storageMessage={dashboard.assetStorageError} triage={dashboard.triage} triagePending={dashboard.triagePending} onTriage={() => { void dashboard.runTriage(); }} />;
  const inspector = <ActivityInspector snapshot={replaySnapshot} selectedGroupId={dashboard.selectedGroupId} alerts={replayAlerts} replayCutoff={replay.cutoff} />;
  const timeline = <TimelineDock snapshot={snapshot} replay={replay} onFocusEvent={handleReplayFocus} onReplayChange={updateReplay} />;
  const agent = <AgentPanel snapshot={snapshot} selectedAssetId={dashboard.selectedAsset.id} ollamaStatus={dashboard.health?.integrations.ollama.status} />;
  const errorHeading = dashboard.error?.status === 429
    ? "Refresh limited."
    : dashboard.error?.status === 503
      ? "Local snapshot unavailable."
      : dashboard.error?.attemptedMode === "live"
        ? "Live evidence needs attention."
        : "Fixture evidence needs attention.";

  return <main className="console-shell">
    <TopBar mode={dashboard.mode} snapshotMode={snapshot?.mode} snapshot={snapshot} fixtureAvailable={dashboard.fixtureAvailable} health={dashboard.health} healthError={dashboard.healthError} lastRefreshAt={dashboard.lastRefreshAt} loading={dashboard.loading} onModeChange={dashboard.changeMode} onRefresh={() => void dashboard.refresh()} />
    {dashboard.error ? <div className="console-error" role="alert"><strong>{errorHeading}</strong> {dashboard.error.message} {dashboard.error.retryAfterSeconds ? `Retry after ${dashboard.error.retryAfterSeconds} second${dashboard.error.retryAfterSeconds === 1 ? "" : "s"}. ` : ""}{dashboard.error.retainedMode ? `Showing the previous ${dashboard.error.retainedMode} snapshot${dashboard.error.retainedAssetName ? ` for ${dashboard.error.retainedAssetName}` : ""}.` : "No prior snapshot is being shown."}</div> : null}
    {/* Gemma sits in the workspace, not below it. Measured before the change:
        the agent panel began at 931px in a 950px viewport, so the product's
        headline feature was off-screen on load and the detail inspector — which
        a user consults second, not first — held the prime column. */}
    <div className="workspace">
      {assetRail}
      <div className="map-column"><MapCanvas snapshot={replaySnapshot} selectedGroupId={dashboard.selectedGroupId} onSelect={dashboard.setSelectedGroupId} focusRequest={mapFocusRequest} />{activeTab === "Timeline" ? null : timeline}</div>
      {agent}
    </div>
    <div className="inspector-dock">{inspector}</div>
    <div className="mobile-tabs" role="tablist" aria-label="Console sections">{tabs.map((tab, index) => <button ref={(element) => { tabRefs.current[index] = element; }} key={tab} role="tab" aria-selected={activeTab === tab} aria-controls={`panel-${tab.toLowerCase()}`} id={`tab-${tab.toLowerCase()}`} tabIndex={activeTab === tab ? 0 : -1} onKeyDown={(event) => handleTabKeyDown(event, index)} onClick={() => activateTab(index)}>{tab}</button>)}</div>
    {tabs.map((tab) => <div className="mobile-panel" role="tabpanel" key={tab} hidden={activeTab !== tab} aria-label={tab} id={`panel-${tab.toLowerCase()}`} aria-labelledby={`tab-${tab.toLowerCase()}`}>
      {activeTab === tab && tab === "Assets" ? assetRail : null}
      {activeTab === tab && tab === "Activity" ? inspector : null}
      {activeTab === tab && tab === "Timeline" ? timeline : null}
      {activeTab === tab && tab === "Gemma" ? agent : null}
    </div>)}
    <footer className="safety-footer"><strong>Evidence limits</strong><span>Informational planning view only. Not for evacuation, dispatch, firefighting, or protection-of-life or property decisions. Data may be delayed, incomplete, or inaccurate. Follow local emergency officials and NWS alerts. A FIRMS point is a satellite-detected heat anomaly, not a confirmed wildfire. It is the center of an approximately 375-meter VIIRS pixel. Points do not measure burning acreage. AirNow readings are preliminary. Change in detected activity is not confirmed fire spread. Absence of detections does not mean absence of fire. This is not an evacuation or emergency-warning tool.</span></footer>
    {limited ? <span className="sr-only">Limited data is present in this evidence view.</span> : null}
    {setupOpen ? <SetupPanel onClose={() => setSetupOpen(false)} onSaved={saveAsset} /> : null}
  </main>;
}

export default function Home() { return <Dashboard />; }
