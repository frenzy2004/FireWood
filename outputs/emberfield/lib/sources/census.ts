import type { Coordinate } from "../domain/types";
import {
  asRecord,
  boundedJson,
  fetchWithTimeout,
  finiteNumber,
  SourceAdapterError,
  utcNow,
  type AdapterDependencies,
} from "./shared";

const CENSUS_ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export interface CensusBenchmark {
  id: string;
  name: string;
}

export interface CensusMatch {
  matchedAddress: string;
  location: Coordinate;
  tigerLineId: string | null;
  side: string | null;
  addressComponents: Record<string, unknown>;
}

export type CensusResult =
  | {
      status: "ok";
      benchmark: CensusBenchmark;
      match: CensusMatch;
    }
  | {
      status: "no-match";
      benchmark: CensusBenchmark;
      match: null;
    };

export type GeocodePayload = CensusResult & {
  mode: "live";
  source: "US Census Geocoder";
  fetchedAt: string;
};

export function parseCensusResponse(payload: unknown): CensusResult {
  const result = asRecord(asRecord(payload)?.result);
  const input = asRecord(result?.input);
  const benchmarkRecord = asRecord(input?.benchmark);
  const benchmark: CensusBenchmark = {
    id: String(benchmarkRecord?.id ?? ""),
    name: String(benchmarkRecord?.benchmarkName ?? benchmarkRecord?.name ?? ""),
  };
  const matches = Array.isArray(result?.addressMatches)
    ? result.addressMatches
    : null;
  if (matches === null) {
    throw new SourceAdapterError("Census", "invalid-response", "Census returned an invalid response");
  }
  if (matches.length === 0) return { status: "no-match", benchmark, match: null };

  const match = asRecord(matches[0]);
  const coordinates = asRecord(match?.coordinates);
  const lon = finiteNumber(coordinates?.x);
  const lat = finiteNumber(coordinates?.y);
  if (match === null || lat === null || lon === null) {
    throw new SourceAdapterError("Census", "invalid-response", "Census returned invalid coordinates");
  }
  const tigerLine = asRecord(match.tigerLine);
  return {
    status: "ok",
    benchmark,
    match: {
      matchedAddress: String(match.matchedAddress ?? ""),
      location: { lat, lon },
      tigerLineId:
        tigerLine?.tigerLineId === undefined
          ? null
          : String(tigerLine.tigerLineId),
      side: tigerLine?.side === undefined ? null : String(tigerLine.side),
      addressComponents: asRecord(match.addressComponents) ?? {},
    },
  };
}

export async function geocodeAddress(
  address: string,
  dependencies: AdapterDependencies = {},
): Promise<GeocodePayload> {
  const normalizedAddress = address.trim();
  if (normalizedAddress.length === 0 || normalizedAddress.length > 100) {
    throw new SourceAdapterError("Census", "invalid-address", "Address must contain 1 to 100 characters");
  }
  const url = new URL(CENSUS_ENDPOINT);
  url.searchParams.set("address", normalizedAddress);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const response = await fetchWithTimeout(
    "Census",
    url.toString(),
    { headers: { Accept: "application/json" } },
    dependencies.fetchImplementation ?? fetch,
    12_000,
  );
  const parsed = parseCensusResponse(await boundedJson("Census", response, 1_000_000));
  return {
    ...parsed,
    mode: "live",
    source: "US Census Geocoder",
    fetchedAt: utcNow(dependencies.now),
  };
}
