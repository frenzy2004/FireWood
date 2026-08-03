"use client";

import { Pause, Play, SkipBack } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import {
  formatShortUtc,
  formatUtc,
  type DashboardDetection,
  type DashboardSnapshot,
} from "../hooks/use-dashboard";

export type ReplaySources = { firms: boolean; nws: boolean; airnow: boolean };
export type ReplayState = { cutoff: string | null; sources: ReplaySources };

export const FULL_REPLAY_STATE: ReplayState = {
  cutoff: null,
  sources: { firms: true, nws: true, airnow: true },
};

const confidenceRank: Record<string, number> = { low: 0, nominal: 1, high: 2 };

function latestConfidence(rows: DashboardDetection[]) {
  return rows.reduce<string | undefined>((highest, row) => (
    highest === undefined || (confidenceRank[row.confidence] ?? -1) > (confidenceRank[highest] ?? -1)
      ? row.confidence
      : highest
  ), undefined);
}

function atOrBefore(value: string | null | undefined, cutoffMs: number) {
  if (!value) return true;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= cutoffMs;
}

export function applyReplayState(
  snapshot: DashboardSnapshot | undefined,
  replay: ReplayState,
): DashboardSnapshot | undefined {
  if (!snapshot) return undefined;
  const cutoffMs = replay.cutoff ? Date.parse(replay.cutoff) : Date.parse(snapshot.generatedAt);
  const startMs = Date.parse(snapshot.generatedAt) - 24 * 60 * 60 * 1_000;
  const detections = replay.sources.firms
    ? snapshot.detections.filter((row) => {
      const acquired = Date.parse(row.acquiredAt);
      return acquired >= startMs && acquired <= cutoffMs;
    })
    : [];
  const visibleIds = new Set(detections.map((row) => row.id).filter(Boolean));
  const groups = replay.sources.firms
    ? snapshot.groups.flatMap((group) => {
      const clusterRows = (group.cluster.detections ?? snapshot.detections).filter((row) => (
        row.id ? visibleIds.has(row.id) : detections.some((candidate) => (
          candidate.acquiredAt === row.acquiredAt && candidate.lat === row.lat && candidate.lon === row.lon
        ))
      ));
      if (clusterRows.length === 0) return [];
      const ordered = [...clusterRows].sort((left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt));
      const maxFrpMw = ordered.reduce<number | null>((maximum, row) => (
        row.frpMw === null ? maximum : maximum === null ? row.frpMw : Math.max(maximum, row.frpMw)
      ), null);
      const weatherObservedAt = group.weather?.observedAt ?? snapshot.sources.nws?.observedAt;
      return [{
        ...group,
        cluster: {
          ...group.cluster,
          detections: ordered,
          memberFingerprints: ordered.map((row) => row.id).filter((id): id is string => Boolean(id)),
          detectionCount: ordered.length,
          firstAcquiredAt: ordered[0]?.acquiredAt ?? group.cluster.firstAcquiredAt,
          latestAcquiredAt: ordered.at(-1)?.acquiredAt ?? group.cluster.latestAcquiredAt,
          satellites: [...new Set(ordered.map((row) => row.satellite))],
          maxConfidence: latestConfidence(ordered),
          maxFrpMw,
        },
        weather: replay.sources.nws && atOrBefore(weatherObservedAt, cutoffMs) ? group.weather : null,
      }];
    })
    : [];
  const airObservedAt = snapshot.air?.observedAt ?? snapshot.sources.airnow?.observedAt;
  return {
    ...snapshot,
    detections,
    groups,
    air: replay.sources.airnow && atOrBefore(airObservedAt, cutoffMs) ? snapshot.air : null,
  };
}

type TimelineMark = {
  id: string;
  source: keyof ReplaySources;
  acquiredAt: string;
  groupId?: string;
  label: string;
};

function sameDetection(left: DashboardDetection, right: DashboardDetection) {
  return left.id && right.id
    ? left.id === right.id
    : left.acquiredAt === right.acquiredAt && left.lat === right.lat && left.lon === right.lon;
}

function timelineMarks(snapshot: DashboardSnapshot | undefined): TimelineMark[] {
  if (!snapshot) return [];
  const firms = snapshot.detections.map((detection, index) => ({
    id: `firms-${detection.id ?? index}`,
    source: "firms" as const,
    acquiredAt: detection.acquiredAt,
    groupId: snapshot.groups.find((group) => group.cluster.detections?.some((row) => sameDetection(row, detection)))?.cluster.id,
    label: `${detection.satellite} detection`,
  }));
  const nwsObservedAt = snapshot.sources.nws?.observedAt;
  const airObservedAt = snapshot.sources.airnow?.observedAt;
  return [
    ...firms,
    ...(nwsObservedAt ? [{ id: "nws-observation", source: "nws" as const, acquiredAt: nwsObservedAt, label: "NWS observation" }] : []),
    ...(airObservedAt ? [{ id: "airnow-observation", source: "airnow" as const, acquiredAt: airObservedAt, label: "AirNow observation" }] : []),
  ];
}

type TimelineDockProps = {
  snapshot?: DashboardSnapshot;
  onSelect: (id: string) => void;
  onReplayChange?: (state: ReplayState) => void;
};

export function TimelineDock(props: TimelineDockProps) {
  return <TimelineDockContent key={props.snapshot?.generatedAt ?? "no-snapshot"} {...props} />;
}

function TimelineDockContent({
  snapshot,
  onSelect,
  onReplayChange,
}: TimelineDockProps) {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(24);
  const [sources, setSources] = useState<ReplaySources>(FULL_REPLAY_STATE.sources);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setPosition((value) => {
        const next = Math.min(24, value + 0.5);
        if (next === 24) setPlaying(false);
        return next;
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [playing]);

  const cutoff = useMemo(() => {
    if (!snapshot || position === 24) return null;
    const start = Date.parse(snapshot.generatedAt) - 24 * 60 * 60 * 1_000;
    return new Date(start + position * 60 * 60 * 1_000).toISOString();
  }, [position, snapshot]);

  useEffect(() => {
    onReplayChange?.({ cutoff, sources });
  }, [cutoff, onReplayChange, sources]);

  const marks = useMemo(() => timelineMarks(snapshot), [snapshot]);
  const generatedMs = snapshot ? Date.parse(snapshot.generatedAt) : 0;
  const startMs = generatedMs - 24 * 60 * 60 * 1_000;
  const toggleSource = (source: keyof ReplaySources) => {
    setSources((current) => ({ ...current, [source]: !current[source] }));
  };
  const startPlayback = () => {
    if (position >= 24) setPosition(0);
    setPlaying(true);
  };

  return <section className="timeline panel" aria-label="24 hour activity timeline">
    <div className="timeline-header">
      <div><p className="eyebrow">24 hour replay</p><h2>Change in detected activity</h2></div>
      <div className="timeline-controls">
        <button className="icon-button" aria-label="Restart timeline" title="Restart timeline" onClick={() => { setPlaying(false); setPosition(0); }}><SkipBack size={18} /></button>
        <button className="icon-button" aria-label={playing ? "Pause timeline" : "Play timeline"} title={playing ? "Pause timeline" : "Play timeline"} onClick={() => playing ? setPlaying(false) : startPlayback()}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
        {(["firms", "nws", "airnow"] as const).map((source) => <label className="source-toggle" key={source}>
          <input type="checkbox" checked={sources[source]} onChange={() => toggleSource(source)} /> {source === "firms" ? "FIRMS" : source === "nws" ? "NWS" : "AirNow"}
        </label>)}
      </div>
    </div>
    <div className="timeline-track">
      <input aria-label="Timeline position" type="range" min="0" max="24" step="0.25" value={position} onChange={(event) => { setPlaying(false); setPosition(Number(event.target.value)); }} />
      {marks.filter((mark) => sources[mark.source]).map((mark) => {
        const acquiredMs = Date.parse(mark.acquiredAt);
        const left = Math.max(0, Math.min(100, ((acquiredMs - startMs) / (24 * 60 * 60 * 1_000)) * 100));
        const label = `${mark.label} at ${formatUtc(mark.acquiredAt)}`;
        return mark.groupId
          ? <button key={mark.id} className={`timeline-mark ${mark.source}`} onClick={() => onSelect(mark.groupId ?? "")} style={{ left: `${left}%` }} aria-label={`Select ${label}`} title={label} />
          : <span key={mark.id} className={`timeline-mark static ${mark.source}`} style={{ left: `${left}%` }} aria-label={label} title={label} />;
      })}
    </div>
    <div className="timeline-labels"><span>24h ago</span><span>{cutoff ? `Cutoff ${formatUtc(cutoff)}` : "Now"}</span><span>{snapshot ? `Latest ${formatShortUtc(snapshot.detections.at(-1)?.acquiredAt)}` : "Waiting for evidence"}</span></div>
  </section>;
}
