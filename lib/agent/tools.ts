import { z } from "zod";

import { distanceKm } from "../domain/geometry";
import { estimateSmokeArrival, type SmokeArrival } from "../domain/smoke";
import type { GeocodePayload } from "../sources/census";
import type { StoredAlert, StoredAgentRun } from "../server/repository";
import type {
  SaveAgentRunInput,
  SavedAsset,
} from "../server/repository";
import type { Snapshot, SnapshotGroup } from "../server/snapshot";

export const AGENT_TOOL_NAMES = [
  "list_assets",
  "inspect_asset",
  "refresh_asset_data",
  "get_activity_groups",
  "get_weather_context",
  "get_air_quality",
  "get_official_incidents",
  "get_smoke_arrival",
  "get_timeline",
  "explain_assessment",
  "geocode_location",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentRepository {
  listAssets(signal?: AbortSignal): Promise<SavedAsset[]>;
  listAlerts(assetId: string, signal?: AbortSignal): Promise<StoredAlert[]>;
  saveAgentRun(
    input: SaveAgentRunInput,
    signal?: AbortSignal,
  ): Promise<StoredAgentRun>;
}

export type SnapshotService = (
  asset: SavedAsset,
  options: { refresh: boolean; signal?: AbortSignal },
) => Promise<Snapshot>;

export interface AgentToolDefinition {
  type: "function";
  function: {
    name: AgentToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const assetIdProperty = {
  type: "string",
  description: "Saved EmberField asset id. Omit to use the active asset.",
  minLength: 1,
  maxLength: 128,
};

const clusterIdProperty = {
  type: "string",
  description: "Activity group id returned by get_activity_groups.",
  minLength: 1,
  maxLength: 160,
};

const objectParameters = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_assets",
      description: "List saved agricultural assets with coordinates and alert radii.",
      parameters: objectParameters({}),
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_asset",
      description: "Inspect one asset and its current deterministic evidence snapshot.",
      parameters: objectParameters({ assetId: assetIdProperty }),
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_asset_data",
      description: "Refresh current evidence for one saved asset.",
      parameters: objectParameters({ assetId: assetIdProperty }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_activity_groups",
      description: "Get clustered satellite detections and deterministic assessments.",
      parameters: objectParameters({ assetId: assetIdProperty }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather_context",
      description: "Get source-timestamped NWS context for an activity group or valid coordinate.",
      parameters: objectParameters({
        assetId: assetIdProperty,
        clusterId: clusterIdProperty,
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_air_quality",
      description: "Get AirNow AQI evidence and explicit missing-key or missing-data state.",
      parameters: objectParameters({ assetId: assetIdProperty }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_official_incidents",
      description: "Get optional WFIGS official incidents and perimeter associations.",
      parameters: objectParameters({ assetId: assetIdProperty }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_smoke_arrival",
      description:
        "Estimate when smoke from each detection group reaches the asset, using straight-line advection from the measured wind. Omit clusterId to get every group at once, ranked with the soonest arrival first. Returns transit hours, estimated arrival time, and how far the asset sits off the plume corridor. This is a smoke-transport estimate, not a fire-spread prediction.",
      parameters: objectParameters({
        assetId: assetIdProperty,
        clusterId: clusterIdProperty,
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_timeline",
      description: "Get recent satellite detections for a bounded evidence timeline.",
      parameters: objectParameters({
        assetId: assetIdProperty,
        hours: { type: "integer", minimum: 1, maximum: 168, default: 24 },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "explain_assessment",
      description: "Explain deterministic assessment contributions without altering the score.",
      parameters: objectParameters({
        assetId: assetIdProperty,
        clusterId: clusterIdProperty,
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "geocode_location",
      description:
        "Geocode one US street address with the live US Census Geocoder. This does not save an asset.",
      parameters: objectParameters(
        {
          address: {
            type: "string",
            description: "US street address to match with the Census Geocoder.",
            minLength: 1,
            maxLength: 100,
          },
        },
        ["address"],
      ),
    },
  },
];

/**
 * Most arrival rows returned in one result.
 *
 * boundToolResult caps a tool result at 6 KB. Each arrival row carries a
 * summary sentence, so a live snapshot with 28 groups overflowed that budget
 * and was replaced by a truncated string preview — structured evidence the
 * grounding validator could no longer read. Rows are ranked before this cut,
 * so what survives is what an operator would look at first.
 */
const SMOKE_ARRIVAL_REPORT_LIMIT = 3;

const idSchema = z.string().trim().min(1).max(128);
const clusterIdSchema = z.string().trim().min(1).max(160);
const assetArgumentsSchema = z.object({ assetId: idSchema.optional() }).strict();

const toolSchemas = {
  list_assets: z.object({}).strict(),
  inspect_asset: assetArgumentsSchema,
  refresh_asset_data: assetArgumentsSchema,
  get_activity_groups: assetArgumentsSchema,
  get_weather_context: z
    .object({
      assetId: idSchema.optional(),
      clusterId: clusterIdSchema.optional(),
      latitude: z.number().finite().min(-90).max(90).optional(),
      longitude: z.number().finite().min(-180).max(180).optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.latitude === undefined) === (value.longitude === undefined),
      { message: "Latitude and longitude must be supplied together" },
    ),
  get_air_quality: assetArgumentsSchema,
  get_official_incidents: assetArgumentsSchema,
  get_smoke_arrival: z
    .object({
      assetId: idSchema.optional(),
      clusterId: clusterIdSchema.optional(),
    })
    .strict(),
  get_timeline: z
    .object({
      assetId: idSchema.optional(),
      hours: z.number().int().min(1).max(168).default(24),
    })
    .strict(),
  explain_assessment: z
    .object({
      assetId: idSchema.optional(),
      clusterId: clusterIdSchema.optional(),
    })
    .strict(),
  geocode_location: z
    .object({ address: z.string().trim().min(1).max(100) })
    .strict(),
} satisfies Record<AgentToolName, z.ZodType>;

export class AgentToolValidationError extends Error {
  readonly code = "validation-error";
}

export class AgentToolExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentToolExecutionError";
  }
}

export interface AgentToolContext {
  activeAssetId: string;
  repository: AgentRepository;
  snapshotService: SnapshotService;
  snapshots: Map<string, Snapshot>;
  geocodeService: (
    address: string,
    options: { signal: AbortSignal },
  ) => Promise<GeocodePayload>;
  signal: AbortSignal;
}

export interface AgentToolExecution {
  data: unknown;
  sourceStatus: Record<string, unknown> | null;
}

const sourceEvidence = (snapshot: Snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot.sources).map(([key, state]) => [
      key,
      {
        source: state.source,
        mode: state.mode,
        status: state.status,
        observedAt: state.observedAt,
        fetchedAt: state.fetchedAt,
        sourceUrl: state.sourceUrl,
        coverage: state.coverage ?? null,
      },
    ]),
  );

function ensureActive(context: AgentToolContext): void {
  if (context.signal.aborted) {
    throw new AgentToolExecutionError(
      "deadline-reached",
      "The agent deadline was reached",
    );
  }
}

const assetEvidence = (savedAsset: SavedAsset) => ({
  id: savedAsset.id,
  name: savedAsset.name,
  category: savedAsset.category,
  location: savedAsset.location,
  radiusKm: savedAsset.radiusKm,
  updatedAt: savedAsset.updatedAt,
});

const groupEvidence = (group: SnapshotGroup) => ({
  clusterId: group.cluster.id,
  centroid: group.cluster.centroid,
  detectionCount: group.cluster.detectionCount,
  firstAcquiredAt: group.cluster.firstAcquiredAt,
  latestAcquiredAt: group.cluster.latestAcquiredAt,
  satellites: group.cluster.satellites,
  maxConfidence: group.cluster.maxConfidence,
  maxFrpMw: group.cluster.maxFrpMw,
  weather: group.weather,
  assessment: {
    score: group.assessment.score,
    scoreRange: group.assessment.scoreRange,
    band: group.assessment.band,
    reasons: group.assessment.reasons,
    missingInputs: group.assessment.missingInputs,
    completeness: group.assessment.completeness,
    dataQuality: group.assessment.dataQuality,
    dataConfidence: group.assessment.dataConfidence,
  },
  officialMatch: group.officialMatch
    ? {
        method: group.officialMatch.method,
        distanceKm: group.officialMatch.distanceKm,
        incident: {
          id: group.officialMatch.incident.id,
          name: group.officialMatch.incident.name,
          updatedAt: group.officialMatch.incident.updatedAt,
        },
      }
    : null,
});

/**
 * A sentence the model can quote instead of inventing its own wording.
 *
 * Grounding checks a claim against the vocabulary the evidence actually
 * contains. A briefing that says "detection group" cannot be verified, because
 * the payload has `detectionCount` and no word for "group" anywhere — so a true
 * statement was being rejected for using an ordinary synonym. Emitting the
 * sentence as evidence puts that vocabulary in the payload and gives the model
 * a phrasing that is checkable by construction.
 *
 * This adds words, never numbers the estimator did not produce, so a false
 * figure remains as unverifiable as before.
 */
function smokeArrivalSummary(arrival: SmokeArrival): string {
  const where = `The distance to this detection group is ${arrival.distanceKm} km.`;
  switch (arrival.status) {
    case "inbound":
      return `Smoke from this detection group is inbound and arrives in ${arrival.hoursUntilArrival} hours. ${where} The transit time is ${arrival.transitHours} hours and the estimated arrival is ${arrival.estimatedArrivalAt}.`;
    case "likely-arrived":
      return `Smoke from this detection group has likely arrived; the estimated arrival of ${arrival.estimatedArrivalAt} has passed. ${where}`;
    case "beyond-range":
      return `This detection group lies beyond the validated range. ${where} The transit time is ${arrival.transitHours} hours.`;
    case "off-plume":
      return `This detection group is not upwind of the asset; it sits ${arrival.offAxisDeg} degrees off the transport bearing. ${where}`;
    case "calm-wind":
      return `The wind is too calm to give this detection group a transport direction. ${where}`;
    default:
      return `Smoke arrival for this detection group is not assessable. Missing: ${arrival.missingData.join(", ") || "transport inputs"}.`;
  }
}

async function resolveAsset(
  context: AgentToolContext,
  requestedAssetId: unknown,
): Promise<SavedAsset> {
  ensureActive(context);
  const assetId =
    typeof requestedAssetId === "string"
      ? requestedAssetId
      : context.activeAssetId;
  const assets = await context.repository.listAssets(context.signal);
  ensureActive(context);
  const savedAsset = assets.find(
    (candidate) => candidate.id === assetId,
  );
  if (!savedAsset) {
    throw new AgentToolExecutionError(
      "asset-not-found",
      "The requested saved asset was not found",
    );
  }
  return savedAsset;
}

async function snapshotFor(
  context: AgentToolContext,
  savedAsset: SavedAsset,
  refresh = false,
): Promise<Snapshot> {
  ensureActive(context);
  if (!refresh) {
    const existing = context.snapshots.get(savedAsset.id);
    if (existing) return existing;
  }
  const snapshot = await context.snapshotService(savedAsset, {
    refresh,
    signal: context.signal,
  });
  ensureActive(context);
  context.snapshots.set(savedAsset.id, snapshot);
  return snapshot;
}

function findGroup(snapshot: Snapshot, clusterId: unknown): SnapshotGroup {
  const group =
    typeof clusterId === "string"
      ? snapshot.groups.find(({ cluster }) => cluster.id === clusterId)
      : snapshot.groups[0];
  if (!group) {
    throw new AgentToolExecutionError(
      "activity-group-not-found",
      "No matching activity group is available",
    );
  }
  return group;
}

type ParsedArguments = Record<string, unknown>;

export function validateAgentToolArguments(
  toolName: AgentToolName,
  argumentsValue: unknown,
): ParsedArguments {
  const parsed = toolSchemas[toolName].safeParse(argumentsValue);
  if (!parsed.success) {
    throw new AgentToolValidationError("Tool arguments failed validation");
  }
  return parsed.data as ParsedArguments;
}

export function isAgentToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

export async function executeAgentTool(
  toolName: AgentToolName,
  argumentsValue: ParsedArguments,
  context: AgentToolContext,
): Promise<AgentToolExecution> {
  ensureActive(context);
  if (toolName === "list_assets") {
    const assets = await context.repository.listAssets(context.signal);
    ensureActive(context);
    return {
      data: {
        assets: assets.map(assetEvidence),
        missingData: [],
      },
      sourceStatus: null,
    };
  }

  if (toolName === "geocode_location") {
    const result = await context.geocodeService(
      argumentsValue.address as string,
      { signal: context.signal },
    );
    ensureActive(context);
    const censusStatus = {
      source: result.source,
      mode: result.mode,
      status: result.status,
      observedAt: null,
      fetchedAt: result.fetchedAt,
    };
    return {
      data: {
        ...result,
        missingData: result.status === "ok" ? [] : ["address-match"],
      },
      sourceStatus: { census: censusStatus },
    };
  }

  const savedAsset = await resolveAsset(context, argumentsValue.assetId);
  if (toolName === "refresh_asset_data") {
    const snapshot = await snapshotFor(context, savedAsset, true);
    const sources = sourceEvidence(snapshot);
    return {
      data: {
        refreshed: true,
        asset: assetEvidence(savedAsset),
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        detectionCount: snapshot.detections.length,
        activityGroupCount: snapshot.groups.length,
        sources,
      },
      sourceStatus: sources,
    };
  }

  const snapshot = await snapshotFor(context, savedAsset);
  const sources = sourceEvidence(snapshot);

  if (toolName === "inspect_asset") {
    return {
      data: {
        asset: assetEvidence(savedAsset),
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        sources,
        activityGroups: snapshot.groups.map(groupEvidence),
        missingData: Object.entries(snapshot.sources)
          .filter(([, state]) => state.status !== "ok")
          .map(([name, state]) => `${name}:${state.status}`),
      },
      sourceStatus: sources,
    };
  }

  if (toolName === "get_activity_groups") {
    return {
      data: {
        assetId: savedAsset.id,
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        sources,
        activityGroups: snapshot.groups.map(groupEvidence),
        emptyMeaning:
          snapshot.groups.length === 0
            ? "No recent satellite detections were returned; this does not establish that no fire exists."
            : null,
      },
      sourceStatus: sources,
    };
  }

  if (toolName === "get_smoke_arrival") {
    const groups =
      typeof argumentsValue.clusterId === "string"
        ? [findGroup(snapshot, argumentsValue.clusterId)]
        : snapshot.groups;
    // Estimates are anchored to the moment the evidence was gathered, not to
    // wall-clock time, so a replayed snapshot reproduces the same arrival.
    const referenceInstant = new Date(snapshot.generatedAt);
    const arrivals = groups.map((group) => {
      const arrival = estimateSmokeArrival({
        asset: savedAsset.location,
        source: group.cluster.centroid,
        detectedAt: group.cluster.latestAcquiredAt,
        windFromDeg: group.weather?.windFromDeg ?? null,
        windSpeedMps: group.weather?.windSpeedMps ?? null,
        now: referenceInstant,
      });
      return {
        clusterId: group.cluster.id,
        centroid: group.cluster.centroid,
        detectionCount: group.cluster.detectionCount,
        latestAcquiredAt: group.cluster.latestAcquiredAt,
        weatherQuality: group.weather?.quality ?? null,
        arrival,
        summary: smokeArrivalSummary(arrival),
      };
    });
    const downwind = arrivals.filter((row) =>
      row.arrival.status === "inbound" ||
      row.arrival.status === "likely-arrived" ||
      row.arrival.status === "beyond-range",
    );
    // Rank before truncating, so the rows that survive are the ones an operator
    // needs: soonest arrival first, then the rest of the corridor, then groups
    // the wind is carrying elsewhere.
    const statusRank: Record<string, number> = {
      inbound: 0, "likely-arrived": 1, "beyond-range": 2,
      "off-plume": 3, "calm-wind": 4, "insufficient-data": 5,
    };
    const ranked = [...arrivals].sort((left, right) => {
      const byStatus = (statusRank[left.arrival.status] ?? 9) - (statusRank[right.arrival.status] ?? 9);
      if (byStatus !== 0) return byStatus;
      return (left.arrival.hoursUntilArrival ?? Infinity) - (right.arrival.hoursUntilArrival ?? Infinity);
    });
    const inbound = arrivals
      .filter((row) => row.arrival.status === "inbound")
      .sort(
        (left, right) =>
          (left.arrival.hoursUntilArrival ?? Infinity) -
          (right.arrival.hoursUntilArrival ?? Infinity),
      );
    return {
      data: {
        assetId: savedAsset.id,
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        sources,
        referenceInstant: snapshot.generatedAt,
        method:
          "Straight-line advection from the detection centroid using measured wind, corrected for observed lateness. Not a fire-spread prediction.",
        // Capped so the payload stays inside the tool byte budget. A live
        // snapshot can hold dozens of groups; returning all of them pushed the
        // result past the limit, and a truncated result reaches the model as a
        // clipped string rather than structured evidence — which silently
        // removed the model's ability to ground any claim about it.
        arrivals: ranked.slice(0, SMOKE_ARRIVAL_REPORT_LIMIT),
        reportedArrivals: Math.min(ranked.length, SMOKE_ARRIVAL_REPORT_LIMIT),
        totalArrivals: ranked.length,
        omittedArrivals: Math.max(0, ranked.length - SMOKE_ARRIVAL_REPORT_LIMIT),
        soonestInbound: inbound[0] ?? null,
        missingData: arrivals
          .flatMap((row) => row.arrival.missingData)
          .filter((value, index, all) => all.indexOf(value) === index),
        // A group can sit squarely in the corridor and still be absent from
        // `inbound` — "likely-arrived" and "beyond-range" are both downwind.
        // Reporting those as "nothing upwind" would understate the hazard.
        emptyMeaning:
          snapshot.groups.length === 0
            ? "No recent satellite detections were returned; no smoke source is known, which does not establish that none exists."
            : downwind.length === 0
              ? "No detection group sits in the downwind plume corridor of this asset. Wind shifts invalidate this immediately."
              : inbound.length === 0
                ? "Every downwind group has either already passed its estimated arrival or lies beyond the validated range. Smoke may be present now."
                : null,
      },
      sourceStatus: sources,
    };
  }

  if (toolName === "get_weather_context") {
    let groups = snapshot.groups;
    if (typeof argumentsValue.clusterId === "string") {
      groups = [findGroup(snapshot, argumentsValue.clusterId)];
    } else if (
      typeof argumentsValue.latitude === "number" &&
      typeof argumentsValue.longitude === "number"
    ) {
      const requested = {
        lat: argumentsValue.latitude,
        lon: argumentsValue.longitude,
      };
      groups = [...snapshot.groups]
        .sort(
          (left, right) =>
            distanceKm(requested, left.cluster.centroid) -
            distanceKm(requested, right.cluster.centroid),
        )
        .slice(0, 1);
    }
    return {
      data: {
        assetId: savedAsset.id,
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        source: snapshot.sources.nws,
        contexts: groups.map((group) => ({
          clusterId: group.cluster.id,
          centroid: group.cluster.centroid,
          weather: group.weather,
          missingData: group.weather ? [] : ["weather"],
        })),
      },
      sourceStatus: { nws: sources.nws },
    };
  }

  if (toolName === "get_air_quality") {
    return {
      data: {
        assetId: savedAsset.id,
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        source: snapshot.sources.airnow,
        airQuality: snapshot.air,
        missingData: snapshot.air ? [] : ["air-quality"],
      },
      sourceStatus: { airnow: sources.airnow },
    };
  }

  if (toolName === "get_official_incidents") {
    return {
      data: {
        assetId: savedAsset.id,
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        source: snapshot.sources.wfigs,
        incidents: snapshot.incidents,
        perimeters: snapshot.perimeters.map((perimeter) => ({
          id: perimeter.id,
          irwinId: perimeter.irwinId,
          name: perimeter.name,
          acres: perimeter.acres,
          percentContained: perimeter.percentContained,
          updatedAt: perimeter.updatedAt,
        })),
        missingData: snapshot.incidents.length > 0 ? [] : ["official-incidents"],
      },
      sourceStatus: { wfigs: sources.wfigs },
    };
  }

  if (toolName === "get_timeline") {
    const hours = argumentsValue.hours as number;
    const cutoff = Date.parse(snapshot.generatedAt) - hours * 3_600_000;
    const detections = snapshot.detections
      .filter(({ acquiredAt }) => Date.parse(acquiredAt) >= cutoff)
      .sort((left, right) => Date.parse(left.acquiredAt) - Date.parse(right.acquiredAt))
      .map((detection) => ({
        id: detection.id,
        source: detection.source,
        acquiredAt: detection.acquiredAt,
        satellite: detection.satellite,
        location: { lat: detection.lat, lon: detection.lon },
        confidence: detection.confidence,
        frpMw: detection.frpMw,
      }));
    return {
      data: {
        assetId: savedAsset.id,
        generatedAt: snapshot.generatedAt,
        mode: snapshot.mode,
        hours,
        source: snapshot.sources.firms,
        detections,
        emptyMeaning:
          detections.length === 0
            ? "No recent satellite detections were returned; this does not establish that no fire exists."
            : null,
      },
      sourceStatus: { firms: sources.firms },
    };
  }

  const group = findGroup(snapshot, argumentsValue.clusterId);
  return {
    data: {
      assetId: savedAsset.id,
      generatedAt: snapshot.generatedAt,
      mode: snapshot.mode,
      sources,
      clusterId: group.cluster.id,
      assessment: group.assessment,
      invariant:
        "This deterministic assessment cannot be changed by the language model.",
    },
    sourceStatus: sources,
  };
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|map[_-]?key|authorization|password|secret|token)/i;

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return "[redacted-url]";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_PATTERN.test(key)) url.searchParams.set(key, "[redacted]");
    }
    if (url.hostname.endsWith("firms.modaps.eosdis.nasa.gov")) {
      url.pathname = url.pathname.replace(
        /(\/api\/area\/csv\/)[^/]+/,
        "$1[redacted]",
      );
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}

export function sanitizeAgentValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limited]";
  if (typeof value === "string") {
    const urlCandidate = value.trimStart();
    const sanitized = /^https?:\/\//i.test(urlCandidate)
      ? sanitizeUrl(urlCandidate)
      : value;
    return sanitized.length > 2_000 ? `${sanitized.slice(0, 2_000)}…` : sanitized;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry) => sanitizeAgentValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          SECRET_KEY_PATTERN.test(key)
            ? "[redacted]"
            : sanitizeAgentValue(entry, depth + 1),
        ]),
    );
  }
  return String(value);
}

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;

function serializedPreview(
  base: Record<string, unknown>,
  source: string,
  maximumBytes: number,
): { value: unknown; json: string } {
  const limit = Math.max(1, Math.floor(maximumBytes));
  const minimalJson = JSON.stringify(base);
  if (utf8Length(minimalJson) > limit) {
    return { value: 0, json: "0" };
  }
  const characters = Array.from(source);
  let low = 0;
  let high = characters.length;
  let bestValue: unknown = base;
  let bestJson = minimalJson;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const value = {
      ...base,
      preview: `${characters.slice(0, middle).join("")}…`,
    };
    const json = JSON.stringify(value);
    if (utf8Length(json) <= limit) {
      low = middle;
      bestValue = value;
      bestJson = json;
    } else {
      high = middle - 1;
    }
  }
  return { value: bestValue, json: bestJson };
}

export interface BoundedToolResult {
  value: unknown;
  json: string;
  summary: unknown;
}

export function boundToolResult(
  toolName: string,
  result: unknown,
  maximumBytes = 6_000,
  evidenceRef?: string,
): BoundedToolResult {
  const sanitized = sanitizeAgentValue({
    ok: true,
    toolName,
    ...(evidenceRef ? { evidenceRef } : {}),
    data: result,
  });
  const json = JSON.stringify(sanitized);
  if (utf8Length(json) <= maximumBytes) {
    return {
      value: sanitized,
      json,
      summary:
        utf8Length(json) <= 4_000
          ? sanitized
          : serializedPreview({ truncated: true }, json, 4_000).value,
    };
  }
  const bounded = serializedPreview({
    ok: true,
    toolName,
    ...(evidenceRef ? { evidenceRef } : {}),
    truncated: true,
  }, json, maximumBytes);
  return {
    value: bounded.value,
    json: bounded.json,
    summary: bounded.value,
  };
}
