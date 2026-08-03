"use client";

import { useState } from "react";
import { ActivityInspector } from "./components/ActivityInspector";
import { AgentPanel } from "./components/AgentPanel";
import { AssetRail } from "./components/AssetRail";
import { MapCanvas } from "./components/MapCanvas";
import { SetupPanel } from "./components/SetupPanel";
import { TimelineDock } from "./components/TimelineDock";
import { TopBar } from "./components/TopBar";
import { type DashboardSnapshot, type SavedAsset, useDashboard } from "./hooks/use-dashboard";

const tabs = ["Assets", "Activity", "Timeline", "Gemma"] as const;
type Tab = (typeof tabs)[number];

export function Dashboard({ initialSnapshot }: { initialSnapshot?: DashboardSnapshot }) {
  const dashboard = useDashboard(initialSnapshot);
  const [activeTab, setActiveTab] = useState<Tab>("Activity");
  const [setupOpen, setSetupOpen] = useState(false);
  const saveAsset = (asset: SavedAsset) => { dashboard.setAssets((assets) => [asset, ...assets.filter((item) => item.id !== asset.id)]); dashboard.selectAsset(asset); setSetupOpen(false); };
  const snapshot = dashboard.snapshot;
  const limited = snapshot?.groups.some((group) => group.assessment.dataQuality === "limited" || group.assessment.completeness !== "complete");
  return <main className="console-shell">
    <TopBar mode={dashboard.mode} loading={dashboard.loading} onModeChange={dashboard.changeMode} onRefresh={() => void dashboard.refresh()} />
    {dashboard.error && <div className="console-error" role="alert"><strong>Live evidence needs attention.</strong> {dashboard.error} Fixture data remains available as a clearly labeled local demo.</div>}
    <div className="workspace">
      <AssetRail assets={dashboard.assets} selectedId={dashboard.selectedAsset.id} onSelect={dashboard.selectAsset} onAdd={() => setSetupOpen(true)} storageMessage={dashboard.assetStorageError} />
      <div className="map-column"><MapCanvas snapshot={snapshot} selectedGroupId={dashboard.selectedGroupId} onSelect={dashboard.setSelectedGroupId} /><TimelineDock snapshot={snapshot} onSelect={dashboard.setSelectedGroupId} /></div>
      <ActivityInspector snapshot={snapshot} selectedGroupId={dashboard.selectedGroupId} alerts={dashboard.alerts} />
    </div>
    <div className="agent-dock"><AgentPanel snapshot={snapshot} /></div>
    <div className="mobile-tabs" role="tablist" aria-label="Console sections">{tabs.map((tab) => <button key={tab} role="tab" aria-selected={activeTab === tab} aria-controls={`panel-${tab.toLowerCase()}`} id={`tab-${tab.toLowerCase()}`} onClick={() => setActiveTab(tab)}>{tab}</button>)}</div>
    <div className="mobile-panel" role="tabpanel" aria-label={activeTab} id={`panel-${activeTab.toLowerCase()}`} aria-labelledby={`tab-${activeTab.toLowerCase()}`}>
      {activeTab === "Assets" && <AssetRail assets={dashboard.assets} selectedId={dashboard.selectedAsset.id} onSelect={dashboard.selectAsset} onAdd={() => setSetupOpen(true)} storageMessage={dashboard.assetStorageError} />}
      {activeTab === "Activity" && <ActivityInspector snapshot={snapshot} selectedGroupId={dashboard.selectedGroupId} alerts={dashboard.alerts} />}
      {activeTab === "Timeline" && <TimelineDock snapshot={snapshot} onSelect={dashboard.setSelectedGroupId} />}
      {activeTab === "Gemma" && <AgentPanel snapshot={snapshot} />}
    </div>
    <footer className="safety-footer"><strong>Evidence limits</strong><span>A FIRMS point is a satellite-detected heat anomaly, not a confirmed wildfire. It is the center of an approximately 375-meter VIIRS pixel. Change in detected activity is not confirmed fire spread. Absence of detections does not mean absence of fire. This is informational context, not an evacuation or emergency-warning tool. Follow official local guidance.</span></footer>
    {limited && <span className="sr-only">Limited data is present in this evidence view.</span>}
    {setupOpen && <SetupPanel onClose={() => setSetupOpen(false)} onSaved={saveAsset} />}
  </main>;
}

export default function Home() { return <Dashboard />; }
