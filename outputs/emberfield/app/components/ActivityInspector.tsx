"use client";

import { CloudSun, Drop, Gauge, Info, Thermometer, WarningCircle, Wind } from "@phosphor-icons/react";

import { angleDifference, bearingDegrees } from "@/lib/domain/geometry";

import {
  distanceBetweenKm,
  formatUtc,
  type ConsoleAlert,
  type DashboardSnapshot,
} from "../hooks/use-dashboard";

const title = (value: string) => value.replaceAll("-", " ");
const finite = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value);

export function ActivityInspector({
  snapshot,
  selectedGroupId,
  alerts = [],
  replayCutoff,
}: {
  snapshot?: DashboardSnapshot;
  selectedGroupId: string;
  alerts?: ConsoleAlert[];
  replayCutoff?: string | null;
}) {
  const group = snapshot?.groups.find((candidate) => candidate.cluster.id === selectedGroupId) ?? snapshot?.groups[0];
  if (!snapshot || !group) return <aside className="inspector panel" aria-label="Activity inspector"><p className="eyebrow">Activity inspector</p><h2>No recent satellite detections</h2><p>No recent satellite detections were returned for this replay position. Absence of detections does not mean absence of fire.</p></aside>;
  const assessment = group.assessment;
  const score = assessment.score === null
    ? "Unassessed"
    : assessment.scoreRange && assessment.scoreRange.low !== assessment.scoreRange.high
      ? `${assessment.scoreRange.low} to ${assessment.scoreRange.high}`
      : String(assessment.score);
  const distanceKm = distanceBetweenKm(snapshot.asset.location, group.cluster.centroid);
  const ageHours = Math.max(0, (Date.parse(snapshot.generatedAt) - Date.parse(group.cluster.latestAcquiredAt)) / 3_600_000);
  const windDirection = group.weather?.windFromDeg == null ? null : (group.weather.windFromDeg + 180) % 360;
  const bearingToAsset = bearingDegrees(group.cluster.centroid, snapshot.asset.location);
  const windOffset = windDirection === null ? null : angleDifference(windDirection, bearingToAsset);
  const windAlignment = windOffset === null ? "Missing wind direction" : windOffset <= 30 ? `Toward asset, ${Math.round(windOffset)}° offset` : windOffset >= 150 ? `Away from asset, ${Math.round(windOffset)}° offset` : `Crosswind, ${Math.round(windOffset)}° offset`;
  const pointLabel = `${group.cluster.detectionCount} detected point${group.cluster.detectionCount === 1 ? "" : "s"}`;
  const limited = assessment.dataQuality === "limited" || assessment.completeness !== "complete";

  return <aside className="inspector panel" aria-label="Activity inspector">
    <div className="panel-heading"><div><p className="eyebrow">Activity inspector</p><h2>{pointLabel}</h2></div><div className="assessment-badges"><span className={`band ${limited ? "limited" : ""}`}>{limited ? "Limited data" : title(assessment.band)}</span><span className="completeness">{title(assessment.completeness)}</span></div></div>
    {replayCutoff ? <p className="replay-note"><strong>Replay cutoff {formatUtc(replayCutoff)}</strong><br />Raw detections and observations are filtered to this time. Scores and contributions are hidden because they were not recalculated for this replay cutoff.</p> : null}
    <section className="score-block"><span>Context score</span><strong className="metric">{score}</strong><small>Evidence context only. Not an official danger rating.</small></section>
    <dl className="evidence-list">
      <div><dt><Info size={16} /> Distance</dt><dd>{distanceKm.toFixed(1)} km</dd></div>
      <div><dt><Thermometer size={16} /> Latest anomaly</dt><dd>{formatUtc(group.cluster.latestAcquiredAt)}</dd></div>
      <div><dt><Info size={16} /> Detection age</dt><dd>{ageHours.toFixed(1)} hours</dd></div>
      <div><dt><CloudSun size={16} /> Satellites</dt><dd>{group.cluster.satellites.join(", ") || "Not reported"}</dd></div>
      <div><dt><Gauge size={16} /> Detection confidence</dt><dd>{group.cluster.maxConfidence ? title(group.cluster.maxConfidence) : "Not reported"}</dd></div>
      <div><dt><Thermometer size={16} /> Maximum FRP</dt><dd>{finite(group.cluster.maxFrpMw) ? `${group.cluster.maxFrpMw?.toFixed(1)} MW` : "Unavailable"}</dd></div>
      <div><dt><Info size={16} /> Assessment confidence</dt><dd>{assessment.dataConfidence}%</dd></div>
      <div><dt><Wind size={16} /> Wind</dt><dd>{finite(group.weather?.windSpeedMps) ? `${group.weather?.windSpeedMps?.toFixed(1)} m/s from ${group.weather?.windFromDeg ?? "unknown"}°` : "Missing weather"}</dd></div>
      <div><dt><Drop size={16} /> Humidity</dt><dd>{finite(group.weather?.relativeHumidityPct) ? `${group.weather?.relativeHumidityPct?.toFixed(0)}%` : "Missing humidity"}</dd></div>
      <div><dt><Wind size={16} /> Wind alignment</dt><dd>{windAlignment}</dd></div>
      <div><dt><Drop size={16} /> Air quality</dt><dd>{finite(snapshot.air?.pm25UgM3) ? `${snapshot.air?.pm25UgM3} µg/m³ PM2.5` : finite(snapshot.air?.aqi) ? `AQI ${snapshot.air?.aqi}` : "Missing air quality"}</dd></div>
    </dl>
    {assessment.missingInputs.length > 0 ? <div className="missing-note"><WarningCircle size={18} /><span><strong>Limited data</strong><br />Missing: {assessment.missingInputs.join(", ")}</span></div> : null}
    {group.officialMatch ? <div className="official-match"><p className="eyebrow">Official context</p><strong>{group.officialMatch.incident.name}</strong><span>{group.officialMatch.method} match, {group.officialMatch.distanceKm.toFixed(1)} km away</span><span>Updated {formatUtc(group.officialMatch.incident.updatedAt)} · {group.officialMatch.incident.percentContained === null ? "containment not reported" : `${group.officialMatch.incident.percentContained}% contained`}</span></div> : null}
    <section className="contribution-section"><p className="eyebrow">Context score contributions</p>{assessment.contributions.length ? assessment.contributions.map((contribution) => <div className={`reason-row ${contribution.available ? "" : "unavailable"}`} key={contribution.code}><span><strong>{contribution.label}</strong><small>{Math.round(contribution.weight * 100)}% weight · quality {Math.round(contribution.quality * 100)}%</small></span><b>{contribution.available ? `+${Math.round(contribution.weightedValue * 100)}` : "Unavailable"}</b></div>) : <p className="quiet">No contribution details are available.</p>}</section>
    <section className="source-freshness"><p className="eyebrow">Source freshness</p>{Object.values(snapshot.sources).map((source) => <div key={source.source} className={`source-row source-${source.status}`}><span><strong>{source.source}</strong><small>{source.mode} · {title(source.status)}{source.replayState ? ` · replay ${title(source.replayState)}` : ""}</small></span><small>fetched {formatUtc(source.fetchedAt)}<br />observed {formatUtc(source.observedAt)}{source.error ? <><br />{source.error.code}: {source.error.message}</> : null}</small></div>)}</section>
    <section className="alert-feed" aria-label="In-console alerts"><p className="eyebrow">In-console alerts</p>{alerts.length ? alerts.map((alert) => <article className="alert-row" key={alert.dedupeKey}><div><strong>{alert.title}</strong><p>{alert.reason}</p></div><small>{formatUtc(alert.acquiredAt)} · {alert.distanceKm.toFixed(1)} km · {alert.confidence}<br />{alert.source}</small></article>) : <p className="quiet">No new eligible activity alerts for this asset and evidence mode.</p>}</section>
  </aside>;
}
