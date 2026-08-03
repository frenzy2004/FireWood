import type { Coordinate, WeatherContext } from "../domain/types";
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

const NWS_USER_AGENT = "EmberField/0.1 (local wildfire context prototype)";

interface NwsValue {
  validTime: string;
  value: number | null;
}

interface NwsSeries {
  uom: string;
  values: NwsValue[];
}

export interface ParsedNwsGrid extends WeatherContext {
  humidityPercent: number | null;
  selectedValidTimes: {
    windSpeed: string | null;
    windDirection: string | null;
    relativeHumidity: string | null;
  };
}

export interface FetchWeatherInput {
  location: Coordinate;
  at: Date;
}

export interface WeatherPayload {
  mode: "live";
  status: "ok";
  source: "NWS";
  sourceUrl: string;
  fetchedAt: string;
  observedAt: string | null;
  weather: ParsedNwsGrid;
}

interface SelectedNwsValue {
  value: number;
  validTime: string;
  start: number;
}

function durationMilliseconds(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return 0;
  return (
    Number(match[1] ?? 0) * 86_400_000 +
    Number(match[2] ?? 0) * 3_600_000 +
    Number(match[3] ?? 0) * 60_000 +
    Number(match[4] ?? 0) * 1_000
  );
}

function parseInterval(validTime: string): { start: number; end: number } | null {
  const [startText, durationText = ""] = validTime.split("/");
  const start = Date.parse(startText);
  if (!Number.isFinite(start)) return null;
  return { start, end: start + durationMilliseconds(durationText) };
}

function parseSeries(value: unknown): NwsSeries {
  const record = asRecord(value);
  const values = Array.isArray(record?.values) ? record.values : [];
  return {
    uom: String(record?.uom ?? ""),
    values: values.flatMap((item) => {
      const row = asRecord(item);
      if (typeof row?.validTime !== "string") return [];
      return [{ validTime: row.validTime, value: finiteNumber(row.value) }];
    }),
  };
}

function closestValue(series: NwsSeries, target: number): SelectedNwsValue | null {
  let selected: (SelectedNwsValue & { distance: number }) | null = null;
  for (const row of series.values) {
    if (row.value === null) continue;
    const interval = parseInterval(row.validTime);
    if (interval === null) continue;
    const distance =
      target < interval.start
        ? interval.start - target
        : target > interval.end
          ? target - interval.end
          : 0;
    if (
      selected === null ||
      distance < selected.distance ||
      (distance === selected.distance && interval.start < selected.start)
    ) {
      selected = {
        value: row.value,
        validTime: row.validTime,
        distance,
        start: interval.start,
      };
    }
  }
  return selected;
}

function windSpeedMps(value: number | null, unit: string): number | null {
  if (value === null) return null;
  const factors: Record<string, number> = {
    "wmoUnit:km_h-1": 1 / 3.6,
    "wmoUnit:kt": 0.514444444,
    "wmoUnit:mile_h-1": 0.44704,
    "wmoUnit:m_s-1": 1,
  };
  const factor = factors[unit];
  if (factor === undefined) {
    throw new SourceAdapterError("NWS", "unsupported-unit", "NWS returned an unsupported wind-speed unit");
  }
  return value * factor;
}

export function parseNwsGrid(payload: unknown, instant: Date): ParsedNwsGrid {
  const properties = asRecord(asRecord(payload)?.properties);
  if (properties === null) {
    throw new SourceAdapterError("NWS", "invalid-response", "NWS returned an invalid grid response");
  }
  const target = instant.getTime();
  const speedSeries = parseSeries(properties.windSpeed);
  const directionSeries = parseSeries(properties.windDirection);
  const humiditySeries = parseSeries(properties.relativeHumidity);
  const speed = closestValue(speedSeries, target);
  const direction = closestValue(directionSeries, target);
  const humidity = closestValue(humiditySeries, target);
  const selectedStarts = [speed, direction, humidity].flatMap((selection) =>
    selection ? [selection.start] : [],
  );
  // Series are selected independently. Use the latest actual selected interval
  // start as the single snapshot timestamp, while retaining every raw interval.
  const observedAt =
    selectedStarts.length > 0
      ? new Date(Math.max(...selectedStarts)).toISOString()
      : undefined;
  return {
    windSpeedMps: windSpeedMps(speed?.value ?? null, speedSeries.uom),
    windFromDeg: direction?.value ?? null,
    humidityPercent: humidity?.value ?? null,
    relativeHumidityPct: humidity?.value ?? null,
    quality: "direct-fresh",
    ...(observedAt ? { observedAt } : {}),
    selectedValidTimes: {
      windSpeed: speed?.validTime ?? null,
      windDirection: direction?.validTime ?? null,
      relativeHumidity: humidity?.validTime ?? null,
    },
  };
}

export async function fetchWeatherContext(
  input: FetchWeatherInput,
  dependencies: AdapterDependencies = {},
): Promise<WeatherPayload> {
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const headers = { Accept: "application/geo+json", "User-Agent": NWS_USER_AGENT };
  const pointUrl = `https://api.weather.gov/points/${input.location.lat},${input.location.lon}`;
  const loadGridUrl = async () => {
    const pointResponse = await fetchWithTimeout("NWS", pointUrl, { headers }, fetchImplementation, 12_000);
    const pointPayload = asRecord(await boundedJson("NWS", pointResponse, 1_000_000));
    const gridUrl = asRecord(pointPayload?.properties)?.forecastGridData;
    if (typeof gridUrl !== "string" || !gridUrl.startsWith("https://api.weather.gov/")) {
      throw new SourceAdapterError("NWS", "invalid-response", "NWS point response omitted forecast grid data");
    }
    return gridUrl;
  };
  const gridUrl = dependencies.cache
    ? (
        await dependencies.cache.getOrLoad(
          `nws:point:${input.location.lat},${input.location.lon}`,
          CACHE_TTLS.nwsPointMapping,
          loadGridUrl,
        )
      ).value
    : await loadGridUrl();
  if (typeof gridUrl !== "string" || !gridUrl.startsWith("https://api.weather.gov/")) {
    throw new SourceAdapterError("NWS", "invalid-response", "NWS point response omitted forecast grid data");
  }
  const loadGrid = async () => {
    const gridResponse = await fetchWithTimeout("NWS", gridUrl, { headers }, fetchImplementation, 12_000);
    return boundedJson("NWS", gridResponse, 5_000_000);
  };
  const gridPayload = dependencies.cache
    ? (
        await dependencies.cache.getOrLoad(
          `nws:grid:${gridUrl}`,
          CACHE_TTLS.nwsObservations,
          loadGrid,
        )
      ).value
    : await loadGrid();
  const weather = parseNwsGrid(gridPayload, input.at);
  return {
    mode: "live",
    status: "ok",
    source: "NWS",
    sourceUrl: gridUrl,
    fetchedAt: utcNow(dependencies.now),
    observedAt: weather.observedAt ?? null,
    weather,
  };
}
