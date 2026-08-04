import Papa from "papaparse";

import type {
  BoundingBox,
  Detection,
  DetectionConfidence,
} from "../domain/types";
import { CACHE_TTLS } from "../server/cache";
import {
  boundedText,
  fetchWithTimeout,
  finiteNumber,
  SourceAdapterError,
  utcNow,
  type AdapterDependencies,
} from "./shared";

export const FIRMS_SOURCES = [
  "VIIRS_SNPP_NRT",
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA21_NRT",
] as const;

export type FirmsSource = (typeof FIRMS_SOURCES)[number];

export interface FirmsDetection extends Detection {
  id: string;
  source: FirmsSource;
  fingerprint: string;
  frp: number | null;
  brightnessTi4: number | null;
  brightnessTi5: number | null;
  dayNight: string | null;
}

export interface FetchFirmsInput {
  mapKey: string;
  bbox: BoundingBox;
}

export interface FirmsPayload {
  mode: "live";
  status: "ok" | "missing-key";
  source: "NASA FIRMS";
  fetchedAt: string;
  observedAt: string | null;
  detections: FirmsDetection[];
}

const FIRMS_ENDPOINT = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

/**
 * Days requested from FIRMS, before the rolling-window filter below.
 *
 * FIRMS day ranges are calendar days in UTC, not a rolling window. VIIRS is on
 * a polar orbiter, so a given longitude is only overflown a couple of times a
 * day — the US West sees its passes around 20:00-21:00 UTC. Asking for one day
 * therefore returns nothing at all for most of the UTC day: measured live at
 * 06:50 UTC against an actively burning fire, `/1` returned 0 detections across
 * all three satellites while `/2` returned 1,537.
 *
 * An operator opening the console in the morning would have seen an empty map
 * with a fire burning 40 km away. Two days guarantees at least one overpass is
 * in range regardless of the hour.
 */
export const FIRMS_QUERY_DAYS = 2;

/**
 * How far back a detection may be and still count as current.
 *
 * Applied after fetching so the console shows a true rolling 24 hours rather
 * than "however much of today has happened so far". Without this, widening the
 * query above would silently start surfacing detections up to 48 hours old.
 */
export const FIRMS_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const FIRMS_TIMEOUT_MS = 12_000;
const FIRMS_MAXIMUM_BYTES = 2_000_000;

const satelliteNames: Record<string, string> = {
  N: "SNPP",
  N20: "NOAA-20",
  N21: "NOAA-21",
};

const confidenceNames: Record<string, DetectionConfidence> = {
  l: "low",
  n: "nominal",
  h: "high",
};

type FirmsCsvRow = Record<string, string | undefined>;

function normalizedTime(date: string, rawTime: string): {
  hhmm: string;
  acquiredAt: string;
} {
  const hhmm = rawTime.trim().padStart(4, "0");
  if (!/^\d{4}$/.test(hhmm)) {
    throw new SourceAdapterError("FIRMS", "invalid-response", "FIRMS returned an invalid acquisition time");
  }
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2));
  if (hours > 23 || minutes > 59 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new SourceAdapterError("FIRMS", "invalid-response", "FIRMS returned an invalid acquisition time");
  }
  const acquiredAt = new Date(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
  if (!Number.isFinite(acquiredAt.getTime())) {
    throw new SourceAdapterError("FIRMS", "invalid-response", "FIRMS returned an invalid acquisition time");
  }
  return { hhmm, acquiredAt: acquiredAt.toISOString() };
}

export function parseFirmsCsv(
  csv: string,
  source: FirmsSource = "VIIRS_NOAA20_NRT",
): FirmsDetection[] {
  const parsed = Papa.parse<FirmsCsvRow>(csv, {
    header: true,
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length > 0) {
    throw new SourceAdapterError("FIRMS", "invalid-response", "FIRMS returned invalid CSV");
  }
  if (parsed.data.length === 0) return [];

  const fields = new Set(parsed.meta.fields ?? []);
  for (const required of [
    "latitude",
    "longitude",
    "acq_date",
    "acq_time",
    "satellite",
    "confidence",
  ]) {
    if (!fields.has(required)) {
      throw new SourceAdapterError("FIRMS", "invalid-response", "FIRMS response omitted required fields");
    }
  }

  return parsed.data.map((row) => {
    const rawLatitude = row.latitude?.trim() ?? "";
    const rawLongitude = row.longitude?.trim() ?? "";
    const lat = finiteNumber(rawLatitude);
    const lon = finiteNumber(rawLongitude);
    const date = row.acq_date?.trim() ?? "";
    const satelliteCode = row.satellite?.trim() ?? "";
    const satellite = satelliteNames[satelliteCode] ?? satelliteCode;
    const { hhmm, acquiredAt } = normalizedTime(date, row.acq_time ?? "");
    const confidence = confidenceNames[(row.confidence ?? "").trim().toLowerCase()];
    if (lat === null || lon === null || !satellite || confidence === undefined) {
      throw new SourceAdapterError("FIRMS", "invalid-response", "FIRMS returned an invalid detection row");
    }
    const fingerprint = [
      source,
      satellite,
      date,
      hhmm,
      rawLatitude,
      rawLongitude,
    ].join("|");
    const frp = finiteNumber(row.frp);

    return {
      id: fingerprint,
      fingerprint,
      source,
      lat,
      lon,
      acquiredAt,
      satellite,
      confidence,
      frp,
      frpMw: frp,
      brightnessTi4: finiteNumber(row.bright_ti4),
      brightnessTi5: finiteNumber(row.bright_ti5),
      dayNight: row.daynight?.trim() || null,
    };
  });
}

export async function fetchFirmsDetections(
  input: FetchFirmsInput,
  dependencies: AdapterDependencies = {},
): Promise<FirmsPayload> {
  dependencies.signal?.throwIfAborted();
  const fetchedAt = utcNow(dependencies.now);
  if (!input.mapKey) {
    return {
      mode: "live",
      status: "missing-key",
      source: "NASA FIRMS",
      fetchedAt,
      observedAt: null,
      detections: [],
    };
  }
  if (input.bbox.crossesAntimeridian) {
    throw new SourceAdapterError("FIRMS", "invalid-bbox", "FIRMS requests cannot cross the antimeridian");
  }

  const envelope = [
    input.bbox.west,
    input.bbox.south,
    input.bbox.east,
    input.bbox.north,
  ].join(",");
  const load = async (): Promise<FirmsPayload> => {
    const fetchImplementation = dependencies.fetchImplementation ?? fetch;
    const requestedAtMs = Date.parse(utcNow(dependencies.now));
    const detections = (
      await Promise.all(
        FIRMS_SOURCES.map(async (source) => {
          const url = `${FIRMS_ENDPOINT}/${encodeURIComponent(input.mapKey)}/${source}/${envelope}/${FIRMS_QUERY_DAYS}`;
          const response = await fetchWithTimeout(
            "FIRMS",
            url,
            { headers: { Accept: "text/csv" } },
            fetchImplementation,
            FIRMS_TIMEOUT_MS,
            dependencies.signal,
          );
          const csv = await boundedText("FIRMS", response, FIRMS_MAXIMUM_BYTES);
          return parseFirmsCsv(csv, source);
        }),
      )
    )
      .flat()
      .filter((detection) => {
        // Rolling window, not a calendar day. Detections with an unparseable
        // acquisition time are kept rather than silently dropped — a bad
        // timestamp is a data-quality signal, not grounds for deletion.
        const acquiredAtMs = Date.parse(detection.acquiredAt);
        if (!Number.isFinite(acquiredAtMs)) return true;
        return requestedAtMs - acquiredAtMs <= FIRMS_MAX_AGE_MS;
      });

    return {
      mode: "live",
      status: "ok",
      source: "NASA FIRMS",
      fetchedAt: utcNow(dependencies.now),
      observedAt:
        detections.length === 0
          ? null
          : detections.reduce((latest, detection) =>
              detection.acquiredAt > latest ? detection.acquiredAt : latest,
            detections[0].acquiredAt),
      detections,
    };
  };
  return dependencies.cache
    ? (
        await dependencies.cache.getOrLoad(
          `firms:${envelope}`,
          CACHE_TTLS.firms,
          load,
          { signal: dependencies.signal, refresh: dependencies.refresh },
        )
      ).value
    : load();
}
