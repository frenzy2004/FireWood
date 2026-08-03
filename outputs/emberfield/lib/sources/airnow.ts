import type { AirQualityContext, Coordinate } from "../domain/types";
import { CACHE_TTLS } from "../server/cache";
import {
  asRecord,
  boundedJson,
  fetchWithTimeout,
  finiteNumber,
  SourceAdapterError,
  utcNow,
  type AdapterDependencies,
} from "./shared";

const AIRNOW_ENDPOINT = "https://www.airnowapi.org/aq/observation/latLong/current/";

export interface AirNowObservation {
  dateObserved: string;
  hourObserved: number;
  localTimeZone: string;
  reportingArea: string;
  stateCode: string;
  location: Coordinate | null;
  parameter: string;
  aqi: number | null;
  category: { number: number | null; name: string };
  observedAt: string | null;
}

export interface FetchAirQualityInput {
  apiKey: string;
  location: Coordinate;
}

export interface AirQualityPayload {
  mode: "live";
  status: "ok" | "missing-key";
  source: "AirNow";
  fetchedAt: string;
  observedAt: string | null;
  observations: AirNowObservation[];
  air: AirQualityContext | null;
}

const timezoneOffsets: Record<string, string> = {
  UTC: "+00:00",
  GMT: "+00:00",
  EST: "-05:00",
  EDT: "-04:00",
  CST: "-06:00",
  CDT: "-05:00",
  MST: "-07:00",
  MDT: "-06:00",
  PST: "-08:00",
  PDT: "-07:00",
  AKST: "-09:00",
  AKDT: "-08:00",
  HST: "-10:00",
};

function observedAt(date: string, hour: number, zone: string): string | null {
  const offset = timezoneOffsets[zone];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || offset === undefined || hour < 0 || hour > 23) {
    return null;
  }
  const parsed = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00${offset}`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function parseAirNow(payload: unknown): AirNowObservation[] {
  const record = asRecord(payload);
  if (Array.isArray(record?.WebServiceError)) {
    throw new SourceAdapterError("AirNow", "service-error", "AirNow reported a service error");
  }
  if (!Array.isArray(payload)) {
    throw new SourceAdapterError("AirNow", "invalid-response", "AirNow returned an invalid response");
  }
  return payload.map((item) => {
    const row = asRecord(item);
    if (row === null) {
      throw new SourceAdapterError("AirNow", "invalid-response", "AirNow returned an invalid observation");
    }
    const dateObserved = String(row.DateObserved ?? "");
    const hourObserved = finiteNumber(row.HourObserved);
    const localTimeZone = String(row.LocalTimeZone ?? "");
    const latitude = finiteNumber(row.Latitude);
    const longitude = finiteNumber(row.Longitude);
    const category = asRecord(row.Category);
    if (hourObserved === null) {
      throw new SourceAdapterError("AirNow", "invalid-response", "AirNow returned an invalid observation hour");
    }
    return {
      dateObserved,
      hourObserved,
      localTimeZone,
      reportingArea: String(row.ReportingArea ?? ""),
      stateCode: String(row.StateCode ?? ""),
      location:
        latitude === null || longitude === null
          ? null
          : { lat: latitude, lon: longitude },
      parameter: String(row.ParameterName ?? ""),
      aqi: finiteNumber(row.AQI),
      category: {
        number: finiteNumber(category?.Number),
        name: String(category?.Name ?? ""),
      },
      observedAt: observedAt(dateObserved, hourObserved, localTimeZone),
    };
  });
}

export async function fetchAirQuality(
  input: FetchAirQualityInput,
  dependencies: AdapterDependencies = {},
): Promise<AirQualityPayload> {
  dependencies.signal?.throwIfAborted();
  const fetchedAt = utcNow(dependencies.now);
  if (!input.apiKey) {
    return {
      mode: "live",
      status: "missing-key",
      source: "AirNow",
      fetchedAt,
      observedAt: null,
      observations: [],
      air: null,
    };
  }
  const load = async (): Promise<AirQualityPayload> => {
    const url = new URL(AIRNOW_ENDPOINT);
    url.searchParams.set("format", "application/json");
    url.searchParams.set("latitude", String(input.location.lat));
    url.searchParams.set("longitude", String(input.location.lon));
    url.searchParams.set("distance", "25");
    url.searchParams.set("API_KEY", input.apiKey);
    const response = await fetchWithTimeout(
      "AirNow",
      url.toString(),
      { headers: { Accept: "application/json" } },
      dependencies.fetchImplementation ?? fetch,
      12_000,
      dependencies.signal,
    );
    const observations = parseAirNow(await boundedJson("AirNow", response, 1_000_000));
    const selected = observations.find(({ parameter }) => parameter === "PM2.5") ?? null;
    const air: AirQualityContext | null = selected
      ? {
          pm25UgM3: null,
          aqi: selected.aqi,
          quality: "direct-fresh",
          ...(selected.observedAt ? { observedAt: selected.observedAt } : {}),
        }
      : null;
    return {
      mode: "live",
      status: "ok",
      source: "AirNow",
      fetchedAt: utcNow(dependencies.now),
      observedAt: selected?.observedAt ?? null,
      observations,
      air,
    };
  };
  const cacheKey = `airnow:${input.location.lat},${input.location.lon}`;
  return dependencies.cache
    ? (
        await dependencies.cache.getOrLoad(cacheKey, CACHE_TTLS.airnow, load, {
          signal: dependencies.signal,
          refresh: dependencies.refresh,
        })
      ).value
    : load();
}
