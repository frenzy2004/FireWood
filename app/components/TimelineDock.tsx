"use client";

import { Pause, Play, SkipBack } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  formatShortUtc,
  formatUtc,
  type DashboardDetection,
  type DashboardSnapshot,
  type SourceState,
} from "../hooks/use-dashboard";
import {
  nextReplayEvent,
  replayEventTimes,
  replayPosition,
  type ReplaySources,
  type ReplayState,
} from "./replay-events";

export { FULL_REPLAY_STATE } from "./replay-events";
export type { ReplaySources, ReplayState } from "./replay-events";

const confidenceRank: Record<string, number> = { low: 0, nominal: 1, high: 2 };

function latestConfidence(rows: DashboardDetection[]) {
  return rows.reduce<string | undefined>((highest, row) => (
    highest === undefined || (confidenceRank[row.confidence] ?? -1) > (confidenceRank[highest] ?? -1)
      ? row.confidence
      : highest
  ), undefined);
}

function atOrBefore(value: string | null | undefined, cutoffMs: number) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= cutoffMs;
}

function latestAtOrBefore(values: Array<string | null | undefined>, cutoffMs: number) {
  return values
    .filter((value): value is string => atOrBefore(value, cutoffMs))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1) ?? null;
}

function replaySourceState(
  state: SourceState,
  enabled: boolean,
  observedAt: string | null,
  cutoffMs: number,
  isTemporalReplay: boolean,
): SourceState {
  if (!enabled) {
    return { ...state, fetchedAt: null, observedAt: null, replayState: "excluded" };
  }
  if (!isTemporalReplay) return { ...state, replayState: "included" };
  const fetchedAt = atOrBefore(state.fetchedAt, cutoffMs) ? state.fetchedAt : null;
  const filtered = fetchedAt !== state.fetchedAt || observedAt !== state.observedAt;
  return {
    ...state,
    fetchedAt,
    observedAt,
    replayState: filtered ? "cutoff-filtered" : "included",
  };
}

export function applyReplayState(
  snapshot: DashboardSnapshot | undefined,
  replay: ReplayState,
): DashboardSnapshot | undefined {
  if (!snapshot) return undefined;
  const requestedCutoffMs = replay.cutoff ? Date.parse(replay.cutoff) : Date.parse(snapshot.generatedAt);
  const cutoffMs = Number.isFinite(requestedCutoffMs) ? requestedCutoffMs : Date.parse(snapshot.generatedAt);
  const cutoff = new Date(cutoffMs).toISOString();
  const isTemporalReplay = replay.cutoff !== null;
  const startMs = Date.parse(snapshot.generatedAt) - 24 * 60 * 60 * 1_000;
  const officialContextVisible = !isTemporalReplay || atOrBefore(snapshot.sources.wfigs?.observedAt, cutoffMs);
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
        weather: replay.sources.nws && (!isTemporalReplay || atOrBefore(weatherObservedAt, cutoffMs)) ? group.weather : null,
        officialMatch: officialContextVisible ? group.officialMatch : null,
        assessment: isTemporalReplay || !replay.sources.firms || !replay.sources.nws || !replay.sources.airnow
          ? {
              ...group.assessment,
              score: null,
              scoreRange: null,
              band: "replay-unassessed",
              contributions: [],
              reasons: [],
              missingInputs: [...new Set([...group.assessment.missingInputs, "replay-assessment"])],
              completeness: "insufficient",
              dataQuality: "limited",
              dataConfidence: 0,
              canAutomateAlerts: false,
            }
          : group.assessment,
      }];
    })
    : [];
  const airObservedAt = snapshot.air?.observedAt ?? snapshot.sources.airnow?.observedAt;
  const air = replay.sources.airnow && (!isTemporalReplay || atOrBefore(airObservedAt, cutoffMs)) ? snapshot.air : null;
  const firmsObservedAt = latestAtOrBefore(detections.map((row) => row.acquiredAt), cutoffMs);
  const nwsObservedAt = latestAtOrBefore([
    snapshot.sources.nws?.observedAt,
    ...groups.map((group) => group.weather?.observedAt),
  ], cutoffMs);
  const visibleAirObservedAt = air
    ? latestAtOrBefore([air.observedAt, snapshot.sources.airnow?.observedAt], cutoffMs)
    : null;
  const sources = Object.fromEntries(
    Object.entries(snapshot.sources).map(([key, state]) => {
      const enabled = key === "firms"
        ? replay.sources.firms
        : key === "nws"
          ? replay.sources.nws
          : key === "airnow"
            ? replay.sources.airnow
            : true;
      const observedAt = key === "firms"
        ? firmsObservedAt
        : key === "nws"
          ? nwsObservedAt
          : key === "airnow"
            ? visibleAirObservedAt
            : latestAtOrBefore([state.observedAt], cutoffMs);
      return [
        key,
        replaySourceState(
          state,
          enabled,
          observedAt,
          cutoffMs,
          isTemporalReplay,
        ),
      ];
    }),
  );
  return {
    ...snapshot,
    generatedAt: isTemporalReplay ? cutoff : snapshot.generatedAt,
    detections,
    groups,
    incidents: officialContextVisible ? snapshot.incidents : [],
    perimeters: officialContextVisible ? snapshot.perimeters : [],
    air,
    sources,
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
  replay: ReplayState;
  onReplayChange: (state: ReplayState) => void;
};

export function TimelineDock(props: TimelineDockProps) {
  const snapshotIdentity = props.snapshot
    ? `${props.snapshot.asset.id}:${props.snapshot.mode}:${props.snapshot.generatedAt}`
    : "no-snapshot";
  return <TimelineDockContent key={snapshotIdentity} {...props} />;
}

function TimelineDockContent({
  snapshot,
  onSelect,
  replay,
  onReplayChange,
}: TimelineDockProps) {
  const [playing, setPlaying] = useState(false);
  const generatedMs = snapshot ? Date.parse(snapshot.generatedAt) : 0;
  const startMs = generatedMs - 24 * 60 * 60 * 1_000;
  const position = replayPosition(snapshot, replay);

  const replayAtPosition = useCallback((nextPosition: number): ReplayState => ({
    cutoff: nextPosition >= 24 || !snapshot
      ? null
      : new Date(startMs + nextPosition * 60 * 60 * 1_000).toISOString(),
    sources: replay.sources,
  }), [replay.sources, snapshot, startMs]);

  useEffect(() => {
    if (!playing || !snapshot) return;
    const timer = window.setTimeout(() => {
      const next = nextReplayEvent(snapshot, replay);
      if (next === null) {
        setPlaying(false);
        return;
      }
      onReplayChange(next);
      if (next.cutoff === null) setPlaying(false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [onReplayChange, playing, replay, snapshot]);

  const marks = useMemo(() => timelineMarks(snapshot), [snapshot]);
  const events = useMemo(() => replayEventTimes(snapshot, replay.sources), [replay.sources, snapshot]);
  const eventIndex = replay.cutoff === null
    ? -1
    : events.findIndex((event) => Date.parse(event) === Date.parse(replay.cutoff ?? ""));
  const cursorLabel = events.length === 0
    ? "No replay events for enabled sources"
    : replay.cutoff === null
      ? `Now · ${events.length} event${events.length === 1 ? "" : "s"}`
      : eventIndex >= 0
        ? `Event ${eventIndex + 1} of ${events.length}`
        : `Before first event · ${events.length} event${events.length === 1 ? "" : "s"}`;
  const toggleSource = (source: keyof ReplaySources) => {
    onReplayChange({
      ...replay,
      sources: { ...replay.sources, [source]: !replay.sources[source] },
    });
  };
  const startPlayback = () => {
    if (!snapshot || events.length === 0) return;
    if (position >= 24) onReplayChange(replayAtPosition(0));
    setPlaying(true);
  };

  return <section className="timeline panel" aria-label="24 hour activity timeline">
    <div className="timeline-header">
      <div><p className="eyebrow">24 hour replay</p><h2>Change in detected activity</h2></div>
      <div className="timeline-controls">
        <button className="icon-button" aria-label="Restart timeline" title={events.length === 0 ? "No replay events for enabled sources" : "Restart timeline"} disabled={events.length === 0} onClick={() => { setPlaying(false); onReplayChange(replayAtPosition(0)); }}><SkipBack size={18} /></button>
        <button className="icon-button" aria-label={playing ? "Pause timeline" : "Play timeline"} title={events.length === 0 ? "No replay events for enabled sources" : playing ? "Pause timeline" : "Play timeline"} disabled={events.length === 0} onClick={() => playing ? setPlaying(false) : startPlayback()}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
        {(["firms", "nws", "airnow"] as const).map((source) => <label className="source-toggle" key={source}>
          <input type="checkbox" checked={replay.sources[source]} onChange={() => toggleSource(source)} /> {source === "firms" ? "FIRMS" : source === "nws" ? "NWS" : "AirNow"}
        </label>)}
      </div>
    </div>
    <div className="timeline-track">
      <input aria-label="Timeline position" type="range" min="0" max="24" step="0.25" value={position} onChange={(event) => { setPlaying(false); onReplayChange(replayAtPosition(Number(event.target.value))); }} />
      {marks.filter((mark) => replay.sources[mark.source]).map((mark) => {
        const acquiredMs = Date.parse(mark.acquiredAt);
        const left = Math.max(0, Math.min(100, ((acquiredMs - startMs) / (24 * 60 * 60 * 1_000)) * 100));
        const label = `${mark.label} at ${formatUtc(mark.acquiredAt)}`;
        return mark.groupId
          ? <button key={mark.id} className={`timeline-mark ${mark.source}`} onClick={() => onSelect(mark.groupId ?? "")} style={{ left: `${left}%` }} aria-label={`Select ${label}`} title={label} />
          : <span key={mark.id} className={`timeline-mark static ${mark.source}`} style={{ left: `${left}%` }} aria-label={label} title={label} />;
      })}
    </div>
    <div className="timeline-labels"><span>24h ago</span><span className="timeline-event-status" aria-live="polite">{cursorLabel}</span><span>{replay.cutoff ? `Cutoff ${formatUtc(replay.cutoff)}` : snapshot ? `Latest ${formatShortUtc(snapshot.detections.at(-1)?.acquiredAt)}` : "Waiting for evidence"}</span></div>
  </section>;
}
