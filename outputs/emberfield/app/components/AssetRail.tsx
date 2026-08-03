"use client";

import { MapPin, Plus, Tractor } from "@phosphor-icons/react";
import type { SavedAsset } from "../hooks/use-dashboard";

export function AssetRail({ assets, selectedId, onSelect, onAdd, storageMessage }: { assets: SavedAsset[]; selectedId: string; onSelect: (asset: SavedAsset) => void; onAdd: () => void; storageMessage?: string | null }) {
  return <aside className="asset-rail panel" aria-label="Saved agriculture assets">
    <div className="panel-heading"><div><p className="eyebrow">Farm assets</p><h2>Monitored places</h2></div><button className="icon-button" onClick={onAdd} aria-label="Add an asset" title="Add an asset"><Plus size={18} /></button></div>
    <div className="asset-list">
      {assets.map((asset) => <button key={asset.id} className={`asset-row ${asset.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(asset)}>
        <span className="asset-icon"><Tractor size={17} /></span><span className="asset-copy"><strong>{asset.name}</strong><small>{asset.category ?? "saved location"} · {asset.radiusKm.toFixed(1)} km</small><small><MapPin size={12} /> {asset.location.lat.toFixed(3)}, {asset.location.lon.toFixed(3)}</small></span>
      </button>)}
    </div>
    <p className="rail-note">Save fields, orchards, barns, livestock areas, and workforce locations for local monitoring.</p>
    {storageMessage && <p className="storage-warning" role="status">{storageMessage}</p>}
  </aside>;
}
