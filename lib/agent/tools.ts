import { z } from "zod";

import { distanceKm } from "../domain/geometry";
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
