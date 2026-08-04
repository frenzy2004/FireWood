"use client";

import { MapPin, Plus, Tractor } from "@phosphor-icons/react";

import { formatUtc, type AssetSummary, type SavedAsset } from "../hooks/use-dashboard";

const summaryText = (summary: AssetSummary | undefined) => {
  if (!summary) return "Not refreshed · completeness unknown";
  const score = summary.score === null ? "Unassessed" : `Score ${summary.score}`;
  const trend = summary.trend === "new" ? "new snapshot" : `${summary.trend} trend`;
  return `${score} · ${trend} · ${summary.completeness} · ${summary.mode} · refreshed ${formatUtc(summary.generatedAt)}`;
};

export function AssetRail({
  assets,
  selectedId,
  summaries,
  onSelect,
  onAdd,
  storageMessage,
}: {
  assets: SavedAsset[];
  selectedId: string;
  summaries?: Record<string, AssetSummary>;
  onSelect: (asset: SavedAsset) => void;
  onAdd: () => void;
  storageMessage?: string | null;
}) {
  return <aside className="asset-rail panel" aria-label="Saved agriculture assets">
    <div className="panel-heading"><div><p className="eyebrow">Farm assets</p><h2>Monitored places</h2></div><button className="icon-button" onClick={onAdd} aria-label="Add an asset" title="Add an asset"><Plus size={18} /></button></div>
    <div className="asset-list">
      {/* Without an explicit name the button announces its whole body — name,
          radius, score, trend, mode, ISO timestamp and coordinates — as one
          run-on string. The visible detail stays; the name stays actionable. */}
      {assets.map((asset) => <button key={asset.id} className={`asset-row ${asset.id === selectedId ? "selected" : ""}`} aria-pressed={asset.id === selectedId} aria-label={`Select ${asset.name}`} onClick={() => onSelect(asset)}>
        <span className="asset-icon"><Tractor size={17} /></span><span className="asset-copy"><strong>{asset.name}</strong><small>{asset.category ?? "saved location"} · {asset.radiusKm.toFixed(1)} km</small><small className="asset-summary">{summaryText(summaries?.[asset.id])}</small><small><MapPin size={12} /> {asset.location.lat.toFixed(3)}, {asset.location.lon.toFixed(3)}</small></span>
      </button>)}
    </div>
    <p className="rail-note">Save fields, orchards, barns, livestock areas, and workforce locations for local monitoring.</p>
    {storageMessage ? <p className="storage-warning" role="status">{storageMessage}</p> : null}
  </aside>;
}
