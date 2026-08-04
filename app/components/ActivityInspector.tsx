"use client";

import { CloudSun, Drop, Gauge, Info, Thermometer, Timer, WarningCircle, Wind } from "@phosphor-icons/react";

import { angleDifference, bearingDegrees } from "@/lib/domain/geometry";
import { estimateSmokeArrival } from "@/lib/domain/smoke";

import {
  distanceBetweenKm,
  formatUtc,
  type ConsoleAlert,
  type DashboardSnapshot,
} from "../hooks/use-dashboard";

const title = (value: string) => value.replaceAll("-", " ");
const finite = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value);

function SourceFreshness({ snapshot }: { snapshot: DashboardSnapshot }) {
  return <section className="source-freshness" aria-label="Source results">
    <p className="eyebrow">Source results</p>
    {Object.values(snapshot.sources).map((source) => <div
      key={source.source}
      className={`source-row source-${source.status}`}
      aria-label={`${source.source} ${source.mode} ${title(source.status)}`}
    >
      <span><strong>{source.source}</strong><small>{source.mode} · {title(source.status)}{source.replayState ? ` · replay ${title(source.replayState)}` : ""}</small></span>
      <small>fetched {formatUtc(source.fetchedAt)}<br />observed {formatUtc(source.observedAt)}{source.error ? <><br />{source.error.code}: {source.error.message}</> : null}</small>
    </div>)}
  </section>;
}

function EmptyActivityInspector({
  snapshot,
  replayCutoff,
}: {
  snapshot: DashboardSnapshot;
  replayCutoff?: string | null;
}) {
  const weather = snapshot.assetWeather;
  const incidentCount = snapshot.incidents.length;
  const isLive = snapshot.mode === "live";
  const firmsSucceeded = snapshot.sources.firms.status === "ok";
  const airQuality = finite(snapshot.air?.pm25UgM3)
    ? `${snapshot.air?.pm25UgM3} µg/m³ PM2.5`
    : finite(snapshot.air?.aqi)
      ? `AQI ${snapshot.air?.aqi}`
      : snapshot.sources.airnow.status === "ok"
        ? "No nearby AirNow observation returned"
        : `AirNow ${title(snapshot.sources.airnow.status)}`;

  return <aside className="inspector panel empty-inspector" aria-label="Activity inspector">
    <div className="panel-heading"><div><p className="eyebrow">Activity inspector</p><h2>{isLive ? "No recent FIRMS detections" : "No detections at this replay time"}</h2></div><span className={`band ${firmsSucceeded ? "" : "limited"}`}>{firmsSucceeded ? "Valid result" : title(snapshot.sources.firms.status)}</span></div>
    <p className="empty-evidence-explanation">
      {isLive && firmsSucceeded
        ? "NASA FIRMS returned a successful empty result for this asset radius. A successful empty result does not establish that no fire exists."
        : "No satellite detections are included at this replay position. Absence of detections does not establish that no fire exists."}
    </p>
    {replayCutoff ? <p className="replay-note"><strong>Replay cutoff {formatUtc(replayCutoff)}</strong><br />Only observations at or before this exact source timestamp are visible.</p> : null}
    <div className="independent-evidence-grid">
      <section className="independent-evidence-card" aria-label="Asset weather">
        <p className="eyebrow"><CloudSun size={14} /> Asset weather</p>
        {weather
          ? <><strong>{finite(weather.windSpeedMps) ? `${weather.windSpeedMps?.toFixed(1)} m/s from ${weather.windFromDeg ?? "unknown"}°` : "Wind unavailable"}</strong><span>{finite(weather.relativeHumidityPct) ? `${weather.relativeHumidityPct?.toFixed(0)}% humidity` : "Humidity unavailable"}</span><small>Observed {formatUtc(weather.observedAt)}</small></>
          : <><strong>Weather unavailable</strong><span>NWS {title(snapshot.sources.nws.status)}</span></>}
      </section>
      <section className="independent-evidence-card" aria-label="Air quality context">
        <p className="eyebrow"><Drop size={14} /> Air quality</p>
        <strong>{airQuality}</strong>
        <small>Observed {formatUtc(snapshot.air?.observedAt ?? snapshot.sources.airnow.observedAt)}</small>
      </section>
    </div>
    <section className="nearby-incidents" aria-label="Nearby official incidents">
      <div className="panel-heading"><div><p className="eyebrow">WFIGS official context</p><h3>{incidentCount} nearby official incident{incidentCount === 1 ? "" : "s"}</h3></div><WarningCircle size={22} /></div>
      {incidentCount > 0
        ? <ul>{snapshot.incidents.slice(0, 8).map((incident) => <li key={incident.id}><strong>{incident.name}</strong><span>{incident.location.lat.toFixed(3)}, {incident.location.lon.toFixed(3)}</span></li>)}</ul>
        : <p className="quiet">No official WFIGS incidents were returned inside this asset radius.</p>}
    </section>
    <SourceFreshness snapshot={snapshot} />
  </aside>;
}

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
  if (!snapshot) return <aside className="inspector panel" aria-label="Activity inspector"><p className="eyebrow">Activity inspector</p><h2>Waiting for evidence</h2><p>Select an asset or refresh its evidence snapshot.</p></aside>;
  if (!group) return <EmptyActivityInspector snapshot={snapshot} replayCutoff={replayCutoff} />;
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
  // Derived here rather than stored on the snapshot, so a replay cutoff cannot
  // leave a stale arrival behind. Anchored to when the evidence was gathered.
  const arrival = estimateSmokeArrival({
    asset: snapshot.asset.location,
    source: group.cluster.centroid,
    detectedAt: group.cluster.latestAcquiredAt,
    windFromDeg: group.weather?.windFromDeg ?? null,
    windSpeedMps: group.weather?.windSpeedMps ?? null,
    now: new Date(snapshot.generatedAt),
  });
  const arrivalHeadline = arrival.status === "inbound"
    ? `${arrival.hoursUntilArrival?.toFixed(1)} h`
    : arrival.status === "likely-arrived"
      ? "Arrived"
      : arrival.status === "off-plume"
        ? "Not upwind"
        : arrival.status === "calm-wind"
          ? "Calm wind"
          : arrival.status === "beyond-range"
            ? "Out of range"
            : "Unassessable";
  const arrivalDetail = arrival.status === "inbound"
    ? `Estimated arrival ${formatUtc(arrival.estimatedArrivalAt)} · transit time ${arrival.transitHours?.toFixed(1)} h`
    : arrival.status === "likely-arrived"
      ? `Estimated arrival ${formatUtc(arrival.estimatedArrivalAt)} has already passed`
      : arrival.missingData.length > 0
        ? `Missing: ${arrival.missingData.join(", ")}`
        : arrival.status === "calm-wind"
          // Calm wind has no missingData and no off-axis angle, because without a
          // usable wind there is no transport bearing to be off.
          ? "Wind is below the speed where a transport direction is meaningful"
          : arrival.offAxisDeg !== null
            ? `${arrival.offAxisDeg}° off the transport bearing`
            : "No transport direction available";

  return <aside className="inspector panel" aria-label="Activity inspector">
    <div className="panel-heading"><div><p className="eyebrow">Activity inspector</p><h2>{pointLabel}</h2></div><div className="assessment-badges"><span className={`band ${limited ? "limited" : ""}`}>{limited ? "Limited data" : title(assessment.band)}</span><span className="completeness">{title(assessment.completeness)}</span></div></div>
    {replayCutoff ? <p className="replay-note"><strong>Replay cutoff {formatUtc(replayCutoff)}</strong><br />Raw detections and observations are filtered to this time. Scores and contributions are hidden because they were not recalculated for this replay cutoff.</p> : null}
    <section className="score-block"><span>Context score</span><strong className="metric">{score}</strong><small>Evidence context only. Not an official danger rating.</small></section>
    <section className={`arrival-block ${arrival.status}`} aria-label="Smoke arrival estimate">
      <div className="arrival-head"><span className="eyebrow"><Timer size={14} /> Smoke arrival</span><span className={`arrival-confidence confidence-${arrival.confidence}`}>{title(arrival.confidence)} confidence</span></div>
      <strong className="metric">{arrivalHeadline}</strong>
      <span className="arrival-detail">{arrivalDetail}</span>
      <small>Smoke-transport estimate from measured wind. It does not predict where the fire itself will go.</small>
    </section>
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
    <SourceFreshness snapshot={snapshot} />
    <section className="alert-feed" aria-label="In-console alerts"><p className="eyebrow">In-console alerts</p>{alerts.length ? alerts.map((alert) => <article className="alert-row" key={alert.dedupeKey}><div><strong>{alert.title}</strong><p>{alert.reason}</p></div><small>{formatUtc(alert.acquiredAt)} · {alert.distanceKm.toFixed(1)} km · {alert.confidence}<br />{alert.source}</small></article>) : <p className="quiet">No new eligible activity alerts for this asset and evidence mode.</p>}</section>
  </aside>;
}
