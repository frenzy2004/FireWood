import type { DashboardSnapshot } from "../hooks/use-dashboard";

export type ReplaySources = { firms: boolean; nws: boolean; airnow: boolean };
export type ReplayState = { cutoff: string | null; sources: ReplaySources };

export const FULL_REPLAY_STATE: ReplayState = {
  cutoff: null,
  sources: { firms: true, nws: true, airnow: true },
};

const DAY_MS = 24 * 60 * 60 * 1_000;

function validEventTime(value: string | null | undefined, startMs: number, endMs: number) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < startMs || parsed > endMs) return null;
  return new Date(parsed).toISOString();
}

/**
 * Exact evidence timestamps inside the snapshot's 24-hour window. Alerts are
 * FIRMS-derived, so they follow the FIRMS visibility switch instead of acting
 * like a fourth source the operator cannot control.
 */
export function replayEventTimes(
  snapshot: DashboardSnapshot | undefined,
  sources: ReplaySources,
): string[] {
  if (!snapshot) return [];
  const endMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(endMs)) return [];
  const startMs = endMs - DAY_MS;
  const candidates: Array<string | null | undefined> = [];

  if (sources.firms) {
    candidates.push(...snapshot.detections.map((detection) => detection.acquiredAt));
    candidates.push(...(snapshot.alerts ?? []).flatMap((alert) => [alert.createdAt, alert.updatedAt]));
  }

  if (sources.nws) {
    candidates.push(snapshot.sources.nws?.observedAt, snapshot.assetWeather?.observedAt);
    candidates.push(...snapshot.groups.map((group) => group.weather?.observedAt));
  }

  if (sources.airnow) {
    candidates.push(snapshot.sources.airnow?.observedAt, snapshot.air?.observedAt);
  }

  return [...new Set(
    candidates
      .map((value) => validEventTime(value, startMs, endMs))
      .filter((value): value is string => value !== null),
  )].sort((left, right) => Date.parse(left) - Date.parse(right));
}

/**
 * Advance to the next real observation. A null cutoff means the replay is at
 * "now", so it is terminal until the caller explicitly restarts it.
 */
export function nextReplayEvent(
  snapshot: DashboardSnapshot | undefined,
  replay: ReplayState,
): ReplayState | null {
  const events = replayEventTimes(snapshot, replay.sources);
  if (!snapshot || events.length === 0 || replay.cutoff === null) return null;
  const cutoffMs = Date.parse(replay.cutoff);
  const generatedMs = Date.parse(snapshot.generatedAt);
  const currentMs = Number.isFinite(cutoffMs) ? cutoffMs : generatedMs - DAY_MS;
  const next = events.find((event) => Date.parse(event) > currentMs);
  return next
    ? { cutoff: next, sources: replay.sources }
    : { cutoff: null, sources: replay.sources };
}

export function replayPosition(
  snapshot: DashboardSnapshot | undefined,
  replay: ReplayState,
): number {
  if (!snapshot || replay.cutoff === null) return 24;
  const generatedMs = Date.parse(snapshot.generatedAt);
  const cutoffMs = Date.parse(replay.cutoff);
  if (!Number.isFinite(generatedMs) || !Number.isFinite(cutoffMs)) return 24;
  const startMs = generatedMs - DAY_MS;
  return Math.max(0, Math.min(24, (cutoffMs - startMs) / (60 * 60 * 1_000)));
}
