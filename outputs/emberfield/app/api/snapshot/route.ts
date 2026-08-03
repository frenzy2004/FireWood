import { env } from "cloudflare:workers";

import { boundingBox } from "@/lib/domain/geometry";
import type { Asset } from "@/lib/domain/types";
import { DEMO_ASSET, DEMO_BBOX } from "@/lib/fixtures/demo";
import { buildSnapshot } from "@/lib/server/snapshot";

const finiteParameter = (value: string | null, fallback: number) => {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requestedMode = url.searchParams.get("mode");
  if (requestedMode !== null && requestedMode !== "live" && requestedMode !== "fixture") {
    return Response.json({ error: "Unsupported snapshot mode" }, { status: 400 });
  }
  const lat = finiteParameter(url.searchParams.get("lat"), DEMO_ASSET.location.lat);
  const lon = finiteParameter(url.searchParams.get("lon"), DEMO_ASSET.location.lon);
  const radiusKm = finiteParameter(url.searchParams.get("radiusKm"), DEMO_ASSET.radiusKm);
  if (
    lat === null ||
    lon === null ||
    radiusKm === null ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    radiusKm <= 0 ||
    radiusKm > 100
  ) {
    return Response.json({ error: "Invalid snapshot coordinates or radius" }, { status: 400 });
  }
  const asset: Asset = {
    id: "request-asset",
    name: url.searchParams.get("name")?.slice(0, 80) || DEMO_ASSET.name,
    location: { lat, lon },
    radiusKm,
  };
  const usesDemoBounds =
    lat === DEMO_ASSET.location.lat &&
    lon === DEMO_ASSET.location.lon &&
    radiusKm === DEMO_ASSET.radiusKm;

  try {
    const snapshot = await buildSnapshot({
      asset,
      bbox: usesDemoBounds ? DEMO_BBOX : boundingBox(asset.location, radiusKm),
      mode: requestedMode === "fixture" ? "fixture" : "live",
    }, { environment: env });
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { mode: requestedMode === "fixture" ? "fixture" : "live", error: "Snapshot could not be built" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
