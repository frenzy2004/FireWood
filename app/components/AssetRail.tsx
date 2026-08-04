"use client";

import { MapPin, Plus, Timer, Tractor } from "@phosphor-icons/react";

import {
  formatUtc,
  type AssetSummary,
  type PortfolioTriage,
  type SavedAsset,
  type TriageStatus,
} from "../hooks/use-dashboard";

const summaryText = (summary: AssetSummary | undefined) => {
  if (!summary) return "Not refreshed · completeness unknown";
  const score = summary.score === null ? "Unassessed" : `Score ${summary.score}`;
  const trend = summary.trend === "new" ? "new snapshot" : `${summary.trend} trend`;
  return `${score} · ${trend} · ${summary.completeness} · ${summary.mode} · refreshed ${formatUtc(summary.generatedAt)}`;
};

/**
 * Short badge copy per triage status.
 *
 * Only `smoke-inbound` carries a number, because it is the only status where a
 * number means something an operator can act on. The rest stay deliberately
 * flat so the rail cannot read as five competing alarms.
 */
const triageLabel = (row: { status: TriageStatus; hoursUntilArrival: number | null }) => {
  switch (row.status) {
    case "smoke-inbound":
      return `Smoke in ${row.hoursUntilArrival} h`;
    case "smoke-likely-present":
      return "Smoke likely present";
    case "activity-nearby":
      return "Activity nearby";
    case "not-assessable":
      return "Not assessable";
    default:
      return "No detections";
  }
};

export function AssetRail({
  assets,
  selectedId,
  summaries,
  onSelect,
  onAdd,
  storageMessage,
  triage,
  triagePending = false,
  onTriage,
}: {
  assets: SavedAsset[];
  selectedId: string;
  summaries?: Record<string, AssetSummary>;
  onSelect: (asset: SavedAsset) => void;
  onAdd: () => void;
  storageMessage?: string | null;
  triage?: PortfolioTriage | null;
  triagePending?: boolean;
  onTriage?: () => void;
}) {
  const triageByAsset = new Map(
    (triage?.assets ?? []).map((row) => [row.assetId, row] as const),
  );
  // Ranked order when a scan exists, saved order otherwise. The rail must not
  // silently reorder itself when there is no ranking to justify it.
  const ordered = triage
    ? [...assets].sort((left, right) => {
        const l = triage.assets.findIndex((row) => row.assetId === left.id);
        const r = triage.assets.findIndex((row) => row.assetId === right.id);
        return (l === -1 ? Infinity : l) - (r === -1 ? Infinity : r);
      })
    : assets;
  return <aside className="asset-rail panel" aria-label="Saved agriculture assets">
    <div className="panel-heading"><div><p className="eyebrow">Farm assets</p><h2>Monitored places</h2></div><button className="icon-button" onClick={onAdd} aria-label="Add an asset" title="Add an asset"><Plus size={18} /></button></div>
    <div className="asset-list">
      {/* Without an explicit name the button announces its whole body — name,
          radius, score, trend, mode, ISO timestamp and coordinates — as one
          run-on string. The visible detail stays; the name stays actionable. */}
      {ordered.map((asset) => <button key={asset.id} className={`asset-row ${asset.id === selectedId ? "selected" : ""}`} aria-pressed={asset.id === selectedId} aria-label={`Select ${asset.name}`} onClick={() => onSelect(asset)}>
        <span className="asset-icon"><Tractor size={17} /></span><span className="asset-copy"><strong>{asset.name}</strong>{(() => { const row = triageByAsset.get(asset.id); return row ? <small className={`triage-badge triage-${row.status}`}>{row.status === "smoke-inbound" ? <Timer size={11} /> : null} {triageLabel(row)}</small> : null; })()}<small>{asset.category ?? "saved location"} · {asset.radiusKm.toFixed(1)} km</small><small className="asset-summary">{summaryText(summaries?.[asset.id])}</small><small><MapPin size={12} /> {asset.location.lat.toFixed(3)}, {asset.location.lon.toFixed(3)}</small></span>
      </button>)}
    </div>
    <section className="triage-block">
      <div className="triage-head"><p className="eyebrow">Portfolio</p>{onTriage ? <button className="triage-button" onClick={onTriage} disabled={triagePending}>{triagePending ? "Scanning…" : triage ? "Rescan" : "Rank by risk"}</button> : null}</div>
      {triage ? <p className="triage-summary">{triage.summary}</p> : <p className="quiet">Scan every saved place and rank them by how soon smoke could reach each one.</p>}
      {triage && (triage.assetsOmitted ?? 0) > 0 ? <p className="quiet">{triage.assetsOmitted} further {triage.assetsOmitted === 1 ? "asset was" : "assets were"} not scanned in this pass.</p> : null}
      {triage?.failures?.length ? <p className="quiet">Could not scan: {triage.failures.map((f) => f.assetName).join(", ")}.</p> : null}
    </section>
    <p className="rail-note">Save fields, orchards, barns, livestock areas, and workforce locations for local monitoring.</p>
    {storageMessage ? <p className="storage-warning" role="status">{storageMessage}</p> : null}
  </aside>;
}
