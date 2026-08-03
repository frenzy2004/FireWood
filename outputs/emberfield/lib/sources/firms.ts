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
    const detections = (
      await Promise.all(
        FIRMS_SOURCES.map(async (source) => {
          const url = `${FIRMS_ENDPOINT}/${encodeURIComponent(input.mapKey)}/${source}/${envelope}/1`;
          const response = await fetchWithTimeout(
            "FIRMS",
            url,
            { headers: { Accept: "text/csv" } },
            fetchImplementation,
            FIRMS_TIMEOUT_MS,
          );
          const csv = await boundedText("FIRMS", response, FIRMS_MAXIMUM_BYTES);
          return parseFirmsCsv(csv, source);
        }),
      )
    ).flat();

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
    ? (await dependencies.cache.getOrLoad(`firms:${envelope}`, CACHE_TTLS.firms, load)).value
    : load();
}
