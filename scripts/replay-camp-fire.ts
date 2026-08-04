/**
 * Camp Fire replay — offline demonstration.
 *
 *   npm run replay
 *
 * Requires no API keys, no Ollama, and no network. Every value below is either
 * computed by EmberField's deterministic engine or read from the replay fixture,
 * whose provenance is documented in lib/fixtures/camp-fire.ts.
 *
 * The point of the demonstration: 30 minutes after the Camp Fire started, the
 * air at a farm 104 km downwind was still clean. EmberField already knew when
 * the smoke would arrive.
 */

import { estimateSmokeArrival } from "../lib/domain/smoke";
import {
  CAMP_FIRE_ASSET,
  CAMP_FIRE_BBOX,
  CAMP_FIRE_IGNITION,
  CAMP_FIRE_OBSERVED_ARRIVAL_HOURS,
  CAMP_FIRE_REFERENCE_INSTANT,
} from "../lib/fixtures/camp-fire";
import { buildSnapshot } from "../lib/server/snapshot";

const BOLD = "[1m";
const DIM = "[2m";
const RESET = "[0m";
const CYAN = "[36m";
const YELLOW = "[33m";
const GREEN = "[32m";

const rule = (char = "─") => DIM + char.repeat(70) + RESET;
const clock = (iso: string) =>
  iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
const row = (label: string, value: string) =>
  `  ${label.padEnd(16)}${value}`;

async function main(): Promise<void> {
  const snapshot = await buildSnapshot({
    asset: CAMP_FIRE_ASSET,
    bbox: CAMP_FIRE_BBOX,
    mode: "fixture",
  });

  const group = snapshot.groups[0];
  if (!group) throw new Error("Replay produced no activity group");

  const arrival = estimateSmokeArrival({
    asset: CAMP_FIRE_ASSET.location,
    source: group.cluster.centroid,
    detectedAt: group.cluster.latestAcquiredAt,
    windFromDeg: group.weather?.windFromDeg ?? null,
    windSpeedMps: group.weather?.windSpeedMps ?? null,
    now: new Date(CAMP_FIRE_REFERENCE_INSTANT),
  });

  const ignitionMs = Date.parse(CAMP_FIRE_IGNITION.at);
  const predictedFromIgnition =
    (Date.parse(arrival.estimatedArrivalAt as string) - ignitionMs) / 3_600_000;
  const error = predictedFromIgnition - CAMP_FIRE_OBSERVED_ARRIVAL_HOURS;

  console.log("");
  console.log(`${BOLD}  EmberField — Camp Fire replay${RESET}`);
  console.log(`${DIM}  8 November 2018 · offline · no keys · no model required${RESET}`);
  console.log(rule("━"));

  console.log(`${BOLD}  SITUATION${RESET}`);
  console.log(row("time now", clock(snapshot.generatedAt)));
  console.log(row("asset", CAMP_FIRE_ASSET.name));
  console.log(
    row(
      "air at asset",
      `${GREEN}AQI ${snapshot.air?.aqi} — clean${RESET}  ${DIM}nothing is wrong yet${RESET}`,
    ),
  );
  console.log(rule());

  console.log(`${BOLD}  EVIDENCE${RESET}`);
  console.log(
    row(
      "detections",
      `${snapshot.detections.length} in ${snapshot.groups.length} group · ${group.cluster.satellites.join(" + ")}`,
    ),
  );
  console.log(row("first seen", clock(group.cluster.firstAcquiredAt)));
  console.log(row("latest", clock(group.cluster.latestAcquiredAt)));
  console.log(
    row(
      "wind",
      `${group.weather?.windSpeedMps} m/s from ${group.weather?.windFromDeg}° ${DIM}(NASA POWER, 50 m)${RESET}`,
    ),
  );
  console.log(rule());

  console.log(`${BOLD}  SMOKE ADVECTION${RESET}`);
  console.log(row("distance", `${arrival.distanceKm} km`));
  console.log(
    row(
      "transport",
      `toward ${arrival.transportBearingDeg}° · asset ${arrival.offAxisDeg}° off axis`,
    ),
  );
  console.log(
    row(
      "transit",
      `${arrival.rawTransitHours} h raw → ${arrival.transitHours} h corrected`,
    ),
  );
  console.log(row("confidence", arrival.confidence));
  console.log("");
  console.log(
    `  ${YELLOW}${BOLD}▶ SMOKE ARRIVES ${clock(arrival.estimatedArrivalAt as string)}${RESET}`,
  );
  console.log(
    `  ${YELLOW}${BOLD}▶ ${arrival.hoursUntilArrival} HOURS OF WARNING${RESET}`,
  );
  console.log(rule());

  console.log(`${BOLD}  DID IT ACTUALLY HAPPEN?${RESET}`);
  console.log(row("predicted", `${predictedFromIgnition.toFixed(1)} h after ignition`));
  console.log(
    row(
      "observed",
      `${CAMP_FIRE_OBSERVED_ARRIVAL_HOURS} h after ignition  ${DIM}(EPA monitor, same coordinates)${RESET}`,
    ),
  );
  console.log(
    row(
      "error",
      `${CYAN}${error >= 0 ? "+" : ""}${error.toFixed(1)} h${RESET} ${DIM}(${error < 0 ? "early — the safe direction" : "late"})${RESET}`,
    ),
  );
  console.log(rule("━"));

  console.log(`${DIM}  ${arrival.basis}${RESET}`);
  console.log("");
  console.log(
    `${DIM}  Informational context, not an evacuation tool. A satellite heat`,
  );
  console.log(
    `  anomaly is not a confirmed wildfire. Follow local officials.${RESET}`,
  );
  console.log("");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
