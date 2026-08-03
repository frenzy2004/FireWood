"use client";

import { CloudSun, Drop, Info, Thermometer, WarningCircle, Wind } from "@phosphor-icons/react";
import { formatUtc, type ConsoleAlert, type DashboardSnapshot } from "../hooks/use-dashboard";

const title = (value: string) => value.replaceAll("-", " ");

export function ActivityInspector({ snapshot, selectedGroupId, alerts = [] }: { snapshot?: DashboardSnapshot; selectedGroupId: string; alerts?: ConsoleAlert[] }) {
  const group = snapshot?.groups.find((candidate) => candidate.cluster.id === selectedGroupId) ?? snapshot?.groups[0];
  if (!snapshot || !group) return <aside className="inspector panel"><p className="eyebrow">Activity inspector</p><h2>No activity selected</h2><p>Select an activity group to inspect its available evidence.</p></aside>;
  const assessment = group.assessment;
  const score = assessment.score === null ? "Unassessed" : assessment.scoreRange && assessment.scoreRange.low !== assessment.scoreRange.high ? `${assessment.scoreRange.low} to ${assessment.scoreRange.high}` : String(assessment.score);
  return <aside className="inspector panel" aria-label="Activity inspector">
    <div className="panel-heading"><div><p className="eyebrow">Activity inspector</p><h2>{group.cluster.detectionCount} detected points</h2></div><span className={`band ${assessment.dataQuality === "limited" ? "limited" : ""}`}>{assessment.dataQuality === "limited" ? "Limited data" : title(assessment.band)}</span></div>
    <section className="score-block"><span>Context score</span><strong className="metric">{score}</strong><small>Evidence context only. Not an official danger rating.</small></section>
    <dl className="evidence-list">
      <div><dt><Thermometer size={16} /> Latest anomaly</dt><dd>{formatUtc(group.cluster.latestAcquiredAt)}</dd></div>
      <div><dt><CloudSun size={16} /> Satellites</dt><dd>{group.cluster.satellites.join(", ")}</dd></div>
      <div><dt><Info size={16} /> Confidence coverage</dt><dd>{assessment.dataConfidence}%</dd></div>
      <div><dt><Wind size={16} /> Wind</dt><dd>{group.weather?.windSpeedMps != null ? `${group.weather.windSpeedMps.toFixed(1)} m/s from ${group.weather.windFromDeg ?? "unknown"}°` : "Missing weather"}</dd></div>
      <div><dt><Drop size={16} /> Air quality</dt><dd>{snapshot.air?.pm25UgM3 != null ? `${snapshot.air.pm25UgM3} µg/m³ PM2.5` : snapshot.air?.aqi != null ? `AQI ${snapshot.air.aqi}` : "Missing air quality"}</dd></div>
    </dl>
    {assessment.missingInputs.length > 0 && <div className="missing-note"><WarningCircle size={18} /><span><strong>Limited data</strong><br />Missing: {assessment.missingInputs.join(", ")}</span></div>}
    {group.officialMatch && <div className="official-match"><p className="eyebrow">Official context</p><strong>{group.officialMatch.incident.name}</strong><span>{group.officialMatch.method} match, {group.officialMatch.distanceKm.toFixed(1)} km away</span></div>}
    <section className="contribution-section"><p className="eyebrow">Why this context score</p>{assessment.reasons.length ? assessment.reasons.map((reason) => <div className="reason-row" key={reason.code}><span>{reason.label}</span><b>{Math.round(reason.contribution * 100)}</b></div>) : <p className="quiet">No positive contribution details are available yet.</p>}</section>
    <section className="source-freshness"><p className="eyebrow">Source freshness</p>{Object.values(snapshot.sources).map((source) => <div key={source.source} className="source-row"><span>{source.source}</span><small>{source.status === "missing-key" ? "setup needed" : source.status === "error" ? "unavailable" : source.observedAt ? `observed ${formatUtc(source.observedAt)}` : "not observed"}</small></div>)}</section>
    <section className="alert-feed" aria-label="In-console alerts"><p className="eyebrow">In-console alerts</p>{alerts.length ? alerts.map((alert) => <article className="alert-row" key={alert.dedupeKey}><div><strong>{alert.title}</strong><p>{alert.reason}</p></div><small>{formatUtc(alert.acquiredAt)} · {alert.distanceKm.toFixed(1)} km · {alert.confidence}<br />{alert.source}</small></article>) : <p className="quiet">No new eligible activity alerts in this snapshot.</p>}</section>
  </aside>;
}
