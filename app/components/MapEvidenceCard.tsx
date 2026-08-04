"use client";

import { Crosshair, Fire, WarningCircle, X } from "@phosphor-icons/react";

import { formatUtc } from "../hooks/use-dashboard";
import type { MapEvidenceDetail } from "./map-evidence";

const formatDistance = (distanceKm: number) => `${distanceKm.toFixed(1)} km from asset`;

function EvidenceIcon({ kind }: { kind: MapEvidenceDetail["kind"] }) {
  if (kind === "incident") return <WarningCircle size={18} weight="fill" />;
  if (kind === "group") return <Crosshair size={18} weight="bold" />;
  return <Fire size={18} weight="fill" />;
}

export function MapEvidenceCard({
  detail,
  onClose,
}: {
  detail: MapEvidenceDetail;
  onClose: () => void;
}) {
  return (
    <aside className={`map-evidence-card ${detail.kind}`} role="region" aria-label="Selected map evidence">
      <div className="map-evidence-head">
        <span className="map-evidence-icon" aria-hidden="true"><EvidenceIcon kind={detail.kind} /></span>
        <div>
          <p className="eyebrow">Selected evidence</p>
          <h3>{detail.title}</h3>
        </div>
        <button className="map-evidence-close" type="button" onClick={onClose} aria-label="Close selected map evidence">
          <X size={16} />
        </button>
      </div>

      <p className="map-evidence-source">{detail.source} <span>·</span> {formatDistance(detail.distanceKm)}</p>

      {detail.kind === "incident" ? (
        <p className="map-evidence-summary">
          {detail.type ? `${detail.type} · ` : ""}
          {detail.acres === null ? "area not reported" : `${detail.acres.toLocaleString()} acres`}
          {detail.percentContained === null ? " · containment not reported" : ` · ${detail.percentContained}% contained`}
          {` · Updated ${formatUtc(detail.updatedAt)}`}
        </p>
      ) : null}

      {detail.kind === "detection" ? (
        <p className="map-evidence-summary">
          {detail.confidence} confidence
          {detail.frpMw === null ? "" : ` · ${detail.frpMw.toFixed(1)} MW FRP`}
          {` · Acquired ${formatUtc(detail.acquiredAt)}`}
        </p>
      ) : null}

      {detail.kind === "group" ? (
        <p className="map-evidence-summary">
          {detail.detectionCount} detection{detail.detectionCount === 1 ? "" : "s"}
          {detail.satellites.length > 0 ? ` · ${detail.satellites.join(", ")}` : ""}
          {detail.maxConfidence ? ` · ${detail.maxConfidence} max confidence` : ""}
          {detail.maxFrpMw === null ? "" : ` · ${detail.maxFrpMw.toFixed(1)} MW max FRP`}
          {` · Latest ${formatUtc(detail.latestAcquiredAt)}`}
        </p>
      ) : null}

      <p className="map-evidence-coordinates">
        {detail.location.lat.toFixed(4)}, {detail.location.lon.toFixed(4)}
      </p>
    </aside>
  );
}
