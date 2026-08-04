import { z } from "zod";

import { boundedJson, SourceAdapterError } from "../sources/shared";
import { geocodeAddress, type GeocodePayload } from "../sources/census";
import {
  AGENT_TOOL_DEFINITIONS,
  AgentToolExecutionError,
  AgentToolValidationError,
  boundToolResult,
  executeAgentTool,
  isAgentToolName,
  sanitizeAgentValue,
  validateAgentToolArguments,
  type AgentRepository,
  type AgentToolContext,
  type SnapshotService,
} from "./tools";

export const GEMMA_MODEL = "gemma4:12b";
export const AGENT_TIMEOUT_MS = 45_000;
export const AGENT_MAX_ROUNDS = 6;
// Sized to the allowlist so the model can exercise every evidence tool in a
// single round. Raise this alongside AGENT_TOOL_NAMES.
export const AGENT_MAX_CALLS_PER_ROUND = 11;
export const AGENT_MAX_TOOL_CALLS = 18;
export const AGENT_MAX_REFRESH_CALLS = 1;

export const agentRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(12_000),
    assetId: z.string().trim().min(1).max(128),
    mode: z.enum(["live", "fixture"]).optional(),
  })
  .strict();

export const AGENT_SYSTEM_PROMPT = `You are EmberField's local agricultural evidence assistant.
Use only values returned by the provided tools. Every condition or source assertion in a final briefing must cite a successful tool's server-issued evidenceRef exactly as [evidence:REF]. Never cite a failed call. Call satellite heat anomalies "detections", never confirmed fires unless an official incident tool confirms one. Name missing, stale, partial, missing-key, error, live, and fixture source states explicitly. Do not invent observations, alter deterministic scores, predict spread, or issue evacuation, dispatch, firefighting, or protection-of-life or property instructions. You may suggest low-risk questions for farm continuity planning. Follow local emergency officials and NWS alerts. Data may be delayed, incomplete, or inaccurate.
When you state a number, name the quantity in the same sentence using the tool's own wording, so the claim can be checked against its evidence. Write "the distance is 103.6 km", not "103.6 km away"; write "arrives in 4.2 hours" or "transit time is 4.3 hours", not "4.2 hours out". Prefer short sentences that carry one fact each.`;

export type AgentRunStatus =
  | "ok"
  | "offline"
  | "timeout"
  | "round-limit"
  | "grounding-error"
  | "error";

export type AgentTraceStatus =
  | "ok"
  | "unknown-tool"
  | "validation-error"
  | "tool-error";

export interface AgentTraceEntry {
  evidenceRef: string | null;
  callId: string | null;
  functionIndex: number | null;
  toolName: string;
  validatedArguments: Record<string, unknown> | null;
  durationMs: number;
  status: AgentTraceStatus;
  sourceStatus: Record<string, unknown> | null;
  resultSummary: unknown;
}

export interface AgentResult {
  status: AgentRunStatus;
  answer: string;
  model: typeof GEMMA_MODEL;
  trace: AgentTraceEntry[];
  rounds: number;
  durationMs: number;
  persistenceStatus: "not-persisted";
}

export interface RunAgentInput {
  prompt: string;
  assetId: string;
  repository: AgentRepository;
  snapshotService: SnapshotService;
  fetchImpl?: typeof fetch;
  geocodeService?: (
    address: string,
    options: { signal: AbortSignal },
  ) => Promise<GeocodePayload>;
  ollamaBaseUrl?: string;
  mode?: "live" | "fixture";
  now?: () => Date;
  monotonicNow?: () => number;
  signal?: AbortSignal;
}

interface OllamaToolCall {
  id?: string;
  type?: string;
  function: {
    index?: number;
    name: string;
    arguments: unknown;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaResponse {
  message: {
    role: "assistant";
    content: string;
    tool_calls?: OllamaToolCall[];
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

function loopbackChatUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Ollama must use a loopback HTTP URL");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Ollama must use a loopback HTTP URL");
  }
  return new URL("/api/chat", url).toString();
}

function parseToolCall(value: unknown): OllamaToolCall | null {
  const record = asRecord(value);
  const functionRecord = asRecord(record?.function);
  if (typeof functionRecord?.name !== "string") return null;
  return {
    ...(typeof record?.id === "string" ? { id: record.id } : {}),
    ...(typeof record?.type === "string" ? { type: record.type } : {}),
    function: {
      ...(typeof functionRecord.index === "number"
        ? { index: functionRecord.index }
        : {}),
      name: functionRecord.name,
      arguments: functionRecord.arguments,
    },
  };
}

function parseOllamaResponse(payload: unknown): OllamaResponse {
  const message = asRecord(asRecord(payload)?.message);
  if (message === null || message.role !== "assistant") {
    throw new Error("Ollama returned an invalid assistant message");
  }
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawCalls.map(parseToolCall);
  if (toolCalls.some((call) => call === null)) {
    throw new Error("Ollama returned an invalid native tool call");
  }
  return {
    message: {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : "",
      ...(toolCalls.length > 0
        ? { tool_calls: toolCalls as OllamaToolCall[] }
        : {}),
    },
  };
}

function errorToolResult(toolName: string, error: string, message: string) {
  const value = sanitizeAgentValue({ ok: false, toolName, error, message });
  return {
    json: JSON.stringify(value),
    summary: value,
  };
}

interface NumericClaim {
  value: number;
  index: number;
}

function numericClaims(value: string): NumericClaim[] {
  return [...value.matchAll(/(?<![A-Za-z0-9])[-+]?\d+(?:\.\d+)?/g)]
    .flatMap((match) => {
      const number = Number(match[0]);
      return Number.isFinite(number) && match.index !== undefined
        ? [{ value: number, index: match.index }]
        : [];
    });
}

const CITATION_PATTERN = /\[evidence:([A-Za-z0-9_-]{1,64})\]/g;

const CLAIM_FRAMING_TERMS = new Set([
  "a",
  "active",
  "all",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "being",
  "brief",
  "but",
  "by",
  "can",
  "cannot",
  "clearly",
  "current",
  "currently",
  "data",
  "did",
  "do",
  "does",
  "evidence",
  "establish",
  "for",
  "from",
  "guidance",
  "had",
  "has",
  "have",
  "in",
  "is",
  "it",
  "label",
  "may",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "approach",
  "evacuation",
  "reach",
  "recent",
  "report",
  "request",
  "result",
  "return",
  "safe",
  "show",
  "so",
  "some",
  "source",
  "spread",
  "state",
  "system",
  "that",
  "the",
  "their",
  "these",
  "this",
  "those",
  "to",
  "use",
  "verified",
  "was",
  "were",
  "which",
  "with",
  "your",
]);

function normalizedToken(value: string): string {
  if (value === "firms" || value === "nws" || value === "aqi") return value;
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ing") && value.length > 5) return value.slice(0, -3);
  if (value.endsWith("ed") && value.length > 4) {
    const stem = value.slice(0, -2);
    return stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : stem;
  }
  if (value.endsWith("s") && !value.endsWith("ss") && value.length > 3) {
    return value.slice(0, -1);
  }
  return value;
}

const NORMALIZED_CLAIM_FRAMING_TERMS = new Set(
  [...CLAIM_FRAMING_TERMS].map(normalizedToken),
);

function lexicalTokens(value: string): string[] {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return [...expanded.matchAll(/[a-z][a-z0-9]*/g)].map(([token]) =>
    normalizedToken(token),
  );
}

const FIELD_LABEL_ALIASES: Record<string, string[]> = {
  lat: ["latitude"],
  lon: ["longitude"],
  radiusKm: ["radius", "radius kilometers"],
  distanceKm: ["distance", "distance kilometers"],
  ageHours: ["age", "age hours"],
  detectionCount: ["detection count", "detections"],
  activityGroupCount: ["activity group count", "activity groups"],
  relativeHumidityPct: [
    "relative humidity",
    "humidity",
    "humidity percent",
    "humidity percentage",
  ],
  windSpeedMps: ["wind speed", "speed", "moving"],
  windFromDeg: ["wind direction", "direction"],
  pm25UgM3: ["pm25", "pm 2 5"],
  frpMw: ["frp", "fire radiative power"],
  maxFrpMw: ["maximum frp", "maximum fire radiative power"],
  percentContained: ["percent contained", "containment", "contained"],
  scoreRange: ["score range", "range"],
  dataConfidence: ["data confidence"],
  distinctPasses24h: ["distinct passes", "passes"],
  bearingClusterToAsset: ["bearing", "bearing to asset"],
  // Smoke-advection fields. Without these the raw camelCase label is the only
  // way to ground a number, so natural phrasing such as "arrives in 4.2 hours"
  // could never match its own evidence and every briefing fell back.
  hoursUntilArrival: [
    "hours until arrival",
    "arrives in",
    "arrival in",
    "estimated arrival",
    "arrival",
    "lead time",
    "hours of warning",
    "warning",
  ],
  transitHours: ["transit", "transit time", "travel time", "corrected transit"],
  rawTransitHours: ["raw transit", "uncorrected transit"],
  transportBearingDeg: [
    "transport bearing",
    "transport direction",
    "heading toward",
    "toward",
  ],
  offAxisDeg: ["off axis", "off the transport bearing", "degrees off"],
  assetBearingDeg: ["asset bearing", "bearing to asset"],
};

const SOURCE_SELECTOR_ALIASES: Record<string, string[]> = {
  firms: ["firms", "nasa firms"],
  nws: ["nws", "national weather service"],
  airnow: ["airnow", "air now"],
  wfigs: ["wfigs"],
};

interface EvidenceNumericFact {
  value: number;
  labels: string[];
}

interface EvidenceStateFact {
  kind: "mode" | "status";
  value: string;
  path: string[];
}

interface EvidenceIndex {
  terms: Set<string>;
  numbers: EvidenceNumericFact[];
  states: EvidenceStateFact[];
  /** Ordered clock keys from evidence timestamps, e.g. "19:10:42" and "19:10". */
  clocks: Set<string>;
}

function fieldLabels(path: string[]): string[] {
  const field = path.at(-1);
  if (!field) return [];
  const rawLabel = lexicalTokens(field).join(" ");
  return [rawLabel, ...(FIELD_LABEL_ALIASES[field] ?? [])].filter(Boolean);
}

function addLexicalTerms(target: Set<string>, value: string): void {
  for (const token of lexicalTokens(value)) target.add(token);
}

function sourceSelector(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const terms = lexicalTokens(value);
  return (
    Object.entries(SOURCE_SELECTOR_ALIASES).find(([, aliases]) =>
      aliases.some((alias) => containsTokenSequence(terms, alias)),
    )?.[0] ?? null
  );
}

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/;

/** Clock times as a briefing would write them, e.g. "19:10:42" or "19:10". */
const CLOCK_CLAIM_PATTERN = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g;

/**
 * Calendar and clock components of an ISO timestamp.
 *
 * `numericClaims` cannot reach some of these: its lookbehind rejects the hour
 * in `T19`, and a fractional second indexes as `42.523` rather than `42`. A
 * briefing that quotes a time as "19:10:42 on November 8" was therefore
 * ungroundable against the very timestamp it came from, for every tool that
 * returns one.
 *
 * Strictly additive — only surfaces values already present in the evidence.
 */
function isoTimestampComponents(value: string): number[] {
  const parsed = parseIsoTimestamp(value);
  return parsed === null
    ? []
    : [parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second];
}

interface ParsedTimestamp {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

/**
 * Parse an ISO timestamp, rejecting shapes that are well-formed but impossible.
 *
 * Digit-width matching alone accepts `2018-02-31T25:61:61Z`. Round-tripping
 * through Date catches both invalid clock values and dates that do not exist in
 * the calendar, so nothing unreal ever reaches the evidence index.
 */
function parseIsoTimestamp(value: string): ParsedTimestamp | null {
  const match = ISO_TIMESTAMP_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number) as number[];
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(utc)) return null;
  const round = new Date(utc);
  if (
    round.getUTCFullYear() !== year ||
    round.getUTCMonth() !== month - 1 ||
    round.getUTCDate() !== day ||
    round.getUTCHours() !== hour ||
    round.getUTCMinutes() !== minute ||
    round.getUTCSeconds() !== second
  ) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

const clockKey = (hour: number, minute: number, second: number | null) =>
  second === null
    ? `${hour}:${minute}`
    : `${hour}:${minute}:${second}`;

/**
 * Clock times a sentence asserts, as ordered keys.
 *
 * Components are indexed individually so that a briefing quoting "19:10:42" can
 * ground against the timestamp it came from. That alone would also accept
 * "19:42:10", which recombines the same three numbers into a time that never
 * happened — so a clock claim is additionally checked as an ordered whole.
 */
function clockClaims(sentence: string): string[] {
  return [...sentence.matchAll(CLOCK_CLAIM_PATTERN)].map((match) =>
    clockKey(Number(match[1]), Number(match[2]), match[3] === undefined ? null : Number(match[3])),
  );
}

function addEvidenceValue(
  index: EvidenceIndex,
  value: unknown,
  path: string[],
): void {
  const field = path.at(-1);
  if (field) {
    addLexicalTerms(index.terms, field);
    for (const alias of FIELD_LABEL_ALIASES[field] ?? []) {
      addLexicalTerms(index.terms, alias);
    }
  }

  if (Array.isArray(value)) {
    if (field) {
      index.numbers.push({ value: value.length, labels: fieldLabels(path) });
    }
    if (value.length > 0 && field === "assets") {
      addLexicalTerms(index.terms, "saved available");
    }
    if (value.length > 0 && field === "activityGroups") {
      addLexicalTerms(index.terms, "nearby available");
    }
    for (const entry of value) addEvidenceValue(index, entry, path);
    return;
  }

  const record = asRecord(value);
  if (record) {
    const selector = sourceSelector(record.source);
    const childPath =
      selector && !path.includes(selector) ? [...path, selector] : path;
    for (const [key, entry] of Object.entries(record)) {
      addEvidenceValue(index, entry, [...childPath, key]);
    }
    return;
  }

  if (typeof value === "string") {
    addLexicalTerms(index.terms, value);
    for (const claim of numericClaims(value)) {
      index.numbers.push({ value: claim.value, labels: fieldLabels(path) });
    }
    for (const component of isoTimestampComponents(value)) {
      index.numbers.push({ value: component, labels: fieldLabels(path) });
    }
    const timestamp = parseIsoTimestamp(value);
    if (timestamp) {
      index.clocks.add(clockKey(timestamp.hour, timestamp.minute, timestamp.second));
      index.clocks.add(clockKey(timestamp.hour, timestamp.minute, null));
    }
    if ((field === "mode" || field === "status") && value.trim()) {
      index.states.push({
        kind: field,
        value: value.trim().toLowerCase().replaceAll("_", "-"),
        path,
      });
    }
    if (
      field === "type" &&
      value.toUpperCase() === "WF" &&
      path.includes("incidents")
    ) {
      addLexicalTerms(index.terms, "confirmed official wildfire incident");
    }
    return;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    index.numbers.push({ value, labels: fieldLabels(path) });
    return;
  }

  if (value === true && field === "refreshed") {
    addLexicalTerms(index.terms, "fresh refreshed");
  }
}

function evidenceIndex(entries: AgentTraceEntry[]): EvidenceIndex {
  const index: EvidenceIndex = {
    terms: new Set<string>(),
    numbers: [],
    states: [],
    clocks: new Set<string>(),
  };
  for (const entry of entries) {
    addEvidenceValue(index, entry.resultSummary, []);
  }
  return index;
}

function containsTokenSequence(haystack: string[], phrase: string): boolean {
  const needle = lexicalTokens(phrase);
  return (
    needle.length > 0 &&
    haystack.some((_token, start) =>
      needle.every((token, offset) => haystack[start + offset] === token),
    )
  );
}

function hasSupportedNumericClaims(
  sentence: string,
  index: EvidenceIndex,
): boolean {
  // A clock must match an evidence timestamp as an ordered whole. Checking the
  // components independently would accept "19:42:10" against a 19:10:42
  // timestamp — the same three numbers rearranged into a time that never was.
  for (const clock of clockClaims(sentence)) {
    if (!index.clocks.has(clock)) return false;
  }
  return numericClaims(sentence).every((claim) => {
    const nearbyTerms = lexicalTokens(
      sentence.slice(
        Math.max(0, claim.index - 96),
        Math.min(sentence.length, claim.index + 64),
      ),
    );
    return index.numbers.some(
      (fact) =>
        Object.is(fact.value, claim.value) &&
        fact.labels.some((label) => containsTokenSequence(nearbyTerms, label)),
    );
  });
}

function stateMentions(
  sentence: string,
): Array<{ kind: "mode" | "status"; value: string }> {
  const normalized = sentence.toLowerCase();
  const mentions: Array<{ kind: "mode" | "status"; value: string }> = [];
  for (const match of normalized.matchAll(/\b(?:live|fixture)\b/g)) {
    mentions.push({ kind: "mode", value: match[0] });
  }
  for (const match of normalized.matchAll(
    /\b(?:ok|partial|error|missing[- ]key|not[- ]requested)\b/g,
  )) {
    mentions.push({
      kind: "status",
      value: match[0].replace(" ", "-"),
    });
  }
  return mentions;
}

function hasSupportedStateClaims(
  sentence: string,
  index: EvidenceIndex,
): boolean {
  const sentenceTerms = lexicalTokens(sentence);
  const namedSources = Object.entries(SOURCE_SELECTOR_ALIASES).flatMap(
    ([source, aliases]) =>
      aliases.some((alias) => containsTokenSequence(sentenceTerms, alias))
        ? [source]
        : [],
  );
  return stateMentions(sentence).every((mention) => {
    const matching = index.states.filter(
      (fact) => fact.kind === mention.kind && fact.value === mention.value,
    );
    if (matching.length === 0) return false;
    if (namedSources.length > 0) {
      return matching.some((fact) =>
        namedSources.every((source) => fact.path.includes(source)),
      );
    }
    const unscoped = matching.some((fact) => {
      const parent = fact.path.at(-2);
      return parent === "data" || parent === undefined;
    });
    const allFacts = index.states.filter((fact) => fact.kind === mention.kind);
    if (sentenceTerms.includes(mention.kind) && unscoped) return true;
    return allFacts.every((fact) => fact.value === mention.value);
  });
}

function claimSentences(answer: string): string[] {
  const citationsAttached = answer.replace(
    /([.!?])\s*((?:\[evidence:[A-Za-z0-9_-]{1,64}\]\s*)+)/g,
    (_match, punctuation: string, citations: string) =>
      ` ${citations.trim()}${punctuation} `,
  );
  return citationsAttached
    .split(/(?<=[.!?])(?:\s+|$)|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isAllowedUncitedSentence(sentence: string): boolean {
  const normalized = sentence.toLowerCase();
  return (
    /^(?:current evidence|evidence summary|limitations|next questions|source states?):$/.test(
      normalized,
    ) ||
    /^follow (?:local )?emergency officials(?: and nws alerts)?[.!]?$/.test(
      normalized,
    ) ||
    normalized === "consider low-risk preparation questions." ||
    /^data may be (?:delayed|incomplete|inaccurate)(?:,? (?:or|and) (?:delayed|incomplete|inaccurate))*[.!]?$/.test(
      normalized,
    )
  );
}

function isNegatedAt(sentence: string, index: number): boolean {
  const prefix = sentence.slice(Math.max(0, index - 96), index);
  const clause =
    prefix
      .split(
        /[,.;!?]|\b(?:and|but|however|or|because|although|while|whereas|so)\b/i,
      )
      .at(-1) ?? prefix;
  const negations = [
    ...clause.matchAll(/\b(?:no|not|never|cannot|can't|does not|doesn't|do not|without)\b/gi),
  ];
  const lastNegation = negations.at(-1);
  if (!lastNegation || lastNegation.index === undefined) return false;
  return lexicalTokens(clause.slice(lastNegation.index)).length <= 3;
}

function hasUnsupportedSafetyAssertion(sentence: string): boolean {
  const hasAffirmativeMatch = (pattern: RegExp) =>
    [...sentence.matchAll(pattern)].some((match) => {
      if (match.index === undefined) return true;
      const prefix = sentence.slice(Math.max(0, match.index - 12), match.index);
      const lowRiskQualifier =
        /^risks?$/i.test(match[0]) && /\blow[-\s]*$/i.test(prefix);
      const suffix = sentence.slice(
        match.index + match[0].length,
        match.index + match[0].length + 40,
      );
      const negatedAfter =
        /^\W*(?:(?:is|are|was|were)\W+)?(?:no|not|never)\b/i.test(suffix);
      const deniedEvidenceConclusion =
        /\b(?:do|does|did|can|could|would)\s+not\s+(?:establish|show|confirm|mean)\b[^,.;!?]*$/i.test(
          sentence.slice(0, match.index),
        );
      return (
        !lowRiskQualifier &&
        !isNegatedAt(sentence, match.index) &&
        !negatedAfter &&
        !deniedEvidenceConclusion
      );
    });
  if (
    hasAffirmativeMatch(
      /\b(?:evacuat(?:e|ed|es|ing|ion|ions)|safe|danger(?:ous)?|risk(?:s|y)?)\b/gi,
    )
  ) {
    return true;
  }
  const fireContext =
    /\b(?:wildfires?|fires?|detections?|activity|clusters?|groups?|incidents?|perimeters?|smoke|flames?)\b/i.test(
      sentence,
    );
  const windOnly = /\bwinds?\b/i.test(sentence) && !fireContext;
  if (
    !windOnly &&
    hasAffirmativeMatch(
      /\b(?:approach(?:ed|es|ing)?|reach(?:ed|es|ing)?|spread(?:s|ing)?)\b/gi,
    )
  ) {
    return true;
  }
  return (
    fireContext &&
    (hasAffirmativeMatch(
      /\b(?:mov(?:e|ed|es|ing)|head(?:ed|ing|s)?|advanc(?:e|ed|es|ing)|travel(?:ed|led|ing|ling|s)?)\b/gi,
    ) ||
      hasAffirmativeMatch(
        /\b(?:(?:will|expected to|likely to)\W+)?(?:impact(?:ed|ing|s)?|threaten(?:ed|ing|s)?)\b/gi,
      ))
  );
}

function confirmedWildfireIndex(sentence: string): number | null {
  if (!/\b(?:wildfire|fire)\b/i.test(sentence)) return null;
  const confirmation = [
    ...sentence.matchAll(/\bconfirm(?:ed|s|ing)?\b/gi),
  ].find(
    (match) =>
      match.index !== undefined && !isNegatedAt(sentence, match.index),
  );
  return confirmation?.index ?? null;
}

function officialIncidentNames(entry: AgentTraceEntry): string[] {
  if (entry.toolName !== "get_official_incidents") return [];
  const result = asRecord(entry.resultSummary);
  const data = asRecord(result?.data);
  if (!Array.isArray(data?.incidents)) return [];
  return data.incidents.flatMap((candidate) => {
    const incident = asRecord(candidate);
    const type = typeof incident?.type === "string" ? incident.type : "";
    return typeof incident?.name === "string" &&
      (type.toUpperCase() === "WF" || /wildfire/i.test(type))
      ? [incident.name]
      : [];
  });
}

function hasMatchingOfficialIncident(
  sentence: string,
  entries: AgentTraceEntry[],
): boolean {
  const sentenceTokens = lexicalTokens(sentence);
  return entries
    .flatMap(officialIncidentNames)
    .some((name) => {
      const incidentName = lexicalTokens(name).filter(
        (token) => token !== "fixture",
      );
      return (
        incidentName.length > 0 &&
        sentenceTokens.some((_token, index) =>
          incidentName.every(
            (incidentToken, offset) =>
              sentenceTokens[index + offset] === incidentToken,
          ),
        )
      );
    });
}

function hasLexicalEvidence(
  sentence: string,
  index: EvidenceIndex,
): boolean {
  const claimTerms = [
    ...new Set(
      lexicalTokens(sentence.replace(CITATION_PATTERN, "")).filter(
        (token) => !NORMALIZED_CLAIM_FRAMING_TERMS.has(token),
      ),
    ),
  ];
  return (
    claimTerms.length > 0 &&
    claimTerms.every((token) => index.terms.has(token))
  );
}

export function isAnswerGrounded(
  answer: string,
  trace: AgentTraceEntry[],
): boolean {
  const successfulEvidence = new Map(
    trace.flatMap((entry) =>
      entry.status === "ok" && entry.evidenceRef
        ? [[entry.evidenceRef, entry] as const]
        : [],
    ),
  );
  const citations = [...answer.matchAll(CITATION_PATTERN)].map(
    (match) => match[1],
  );
  if (
    successfulEvidence.size === 0 ||
    citations.length === 0 ||
    citations.some((reference) => !successfulEvidence.has(reference))
  ) {
    return false;
  }
  return claimSentences(answer).every((sentence) => {
    const sentenceCitations = [...sentence.matchAll(CITATION_PATTERN)].map(
      (match) => match[1],
    );
    const claim = sentence.replace(CITATION_PATTERN, "").trim();
    if (!claim) return true;
    if (hasUnsupportedSafetyAssertion(claim)) return false;
    const confirmation = confirmedWildfireIndex(claim);
    if (sentenceCitations.length === 0) {
      return confirmation === null && isAllowedUncitedSentence(claim);
    }
    if (sentenceCitations.some((reference) => !successfulEvidence.has(reference))) {
      return false;
    }
    const citedEntries = [
      ...new Set(
        sentenceCitations.map((reference) => successfulEvidence.get(reference)!),
      ),
    ];
    const index = evidenceIndex(citedEntries);
    if (!hasSupportedNumericClaims(claim, index)) return false;
    if (!hasSupportedStateClaims(claim, index)) return false;
    if (
      confirmation !== null &&
      !hasMatchingOfficialIncident(claim, citedEntries)
    ) {
      return false;
    }
    return hasLexicalEvidence(claim, index);
  });
}

const fallbackAnswers = {
  offline:
    "Local Gemma is offline. Start Ollama and warm gemma4:12b, then retry. Deterministic monitoring remains available; review the source states and follow local emergency officials and NWS alerts.",
  timeout:
    "Local Gemma timed out. A cold model may need a warm-up; run ollama run gemma4:12b, then retry. Deterministic monitoring remains available; review the source states and follow local emergency officials and NWS alerts.",
  roundLimit:
    "The local agent reached its tool-round limit before producing a briefing. Review the visible evidence trace and source states, and follow local emergency officials and NWS alerts.",
  grounding:
    "I could not produce a fully source-grounded briefing from the visible tool evidence. Review the deterministic evidence and source states, and follow local emergency officials and NWS alerts.",
  error:
    "The local agent could not complete this briefing. Deterministic monitoring remains available; review source states and follow local emergency officials and NWS alerts.",
} as const;

class AgentDeadlineError extends Error {
  constructor() {
    super("The agent deadline was reached");
    this.name = "AgentDeadlineError";
  }
}

interface AgentDeadline {
  signal: AbortSignal;
  expired(): boolean;
  run<T>(operation: () => Promise<T>): Promise<T>;
  cancel(): void;
}

function createAgentDeadline(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): AgentDeadline {
  const controller = new AbortController();
  let expired = false;
  let rejectExpiration!: (error: AgentDeadlineError) => void;
  const expiration = new Promise<never>((_resolve, reject) => {
    rejectExpiration = reject;
  });
  void expiration.catch(() => undefined);
  const expire = () => {
    if (expired) return;
    expired = true;
    controller.abort();
    rejectExpiration(new AgentDeadlineError());
  };
  const timeout = setTimeout(expire, timeoutMs);
  const abortFromCaller = () => expire();
  if (externalSignal?.aborted) {
    expire();
  } else {
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  return {
    signal: controller.signal,
    expired: () => expired,
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (expired) return Promise.reject(new AgentDeadlineError());
      let work: Promise<T>;
      try {
        work = operation();
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.race([work, expiration]);
    },
    cancel() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const parsedRequest = agentRequestSchema.parse({
    prompt: input.prompt,
    assetId: input.assetId,
    mode: input.mode,
  });
  const fetchImplementation = input.fetchImpl ?? fetch;
  const chatUrl = loopbackChatUrl(
    input.ollamaBaseUrl ?? "http://127.0.0.1:11434",
  );
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const trace: AgentTraceEntry[] = [];
  const deadline = createAgentDeadline(AGENT_TIMEOUT_MS, input.signal);
  let totalToolCalls = 0;
  let refreshCalls = 0;
  const context: AgentToolContext = {
    activeAssetId: parsedRequest.assetId,
    repository: input.repository,
    snapshotService: input.snapshotService,
    snapshots: new Map(),
    geocodeService:
      input.geocodeService ??
      ((address, options) =>
        geocodeAddress(address, { signal: options.signal })),
    signal: deadline.signal,
  };
  const messages: OllamaMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: parsedRequest.prompt },
  ];
  const finish = (
    status: AgentRunStatus,
    answer: string,
    rounds: number,
  ): AgentResult => ({
    status,
    answer,
    model: GEMMA_MODEL,
    trace,
    rounds,
    durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
    persistenceStatus: "not-persisted",
  });

  try {
    for (let round = 1; round <= AGENT_MAX_ROUNDS; round += 1) {
      let payload: unknown;
      try {
        const response = await deadline.run(() =>
          fetchImplementation(chatUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: GEMMA_MODEL,
              messages,
              tools: AGENT_TOOL_DEFINITIONS,
              stream: false,
              think: false,
              options: {
                num_predict: 256,
                temperature: 0.1,
              },
            }),
            signal: deadline.signal,
          }),
        );
        payload = await deadline.run(() =>
          boundedJson("Ollama", response, 2_000_000),
        );
      } catch (error) {
        if (
          deadline.expired() ||
          error instanceof AgentDeadlineError ||
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof SourceAdapterError && error.code === "timeout")
        ) {
          return await finish("timeout", fallbackAnswers.timeout, round);
        }
        if (error instanceof TypeError) {
          return await finish("offline", fallbackAnswers.offline, round);
        }
        return await finish("error", fallbackAnswers.error, round);
      }

      let assistantResponse: OllamaResponse;
      try {
        assistantResponse = parseOllamaResponse(payload);
      } catch {
        return await finish("error", fallbackAnswers.error, round);
      }
      const assistantMessage: OllamaMessage = {
        role: "assistant",
        content: assistantResponse.message.content,
        ...(assistantResponse.message.tool_calls
          ? { tool_calls: assistantResponse.message.tool_calls }
          : {}),
      };
      messages.push(assistantMessage);
      const calls = assistantResponse.message.tool_calls ?? [];

      if (calls.length === 0) {
        const answer = assistantResponse.message.content.trim();
        if (!answer) return await finish("error", fallbackAnswers.error, round);
        if (!isAnswerGrounded(answer, trace)) {
          return await finish("grounding-error", fallbackAnswers.grounding, round);
        }
        return await finish("ok", answer, round);
      }
      if (
        calls.length > AGENT_MAX_CALLS_PER_ROUND ||
        totalToolCalls + calls.length > AGENT_MAX_TOOL_CALLS
      ) {
        return await finish("round-limit", fallbackAnswers.roundLimit, round);
      }
      totalToolCalls += calls.length;

      for (const call of calls) {
        const toolStartedAt = monotonicNow();
        const toolName = call.function.name;
        const visibleToolName = isAgentToolName(toolName)
          ? toolName
          : "[unknown-tool]";
        const candidateEvidenceRef = String(trace.length + 1);
        let evidenceRef: string | null = null;
        let validatedArguments: Record<string, unknown> | null = null;
        let status: AgentTraceStatus = "ok";
        let sourceStatus: Record<string, unknown> | null = null;
        let toolResult: { json: string; summary: unknown };

        if (!isAgentToolName(toolName)) {
          status = "unknown-tool";
          toolResult = errorToolResult(
            visibleToolName,
            "unknown-tool",
            "The requested tool is not allowlisted",
          );
        } else {
          try {
            validatedArguments = validateAgentToolArguments(
              toolName,
              call.function.arguments,
            );
            if (
              toolName === "refresh_asset_data" &&
              refreshCalls >= AGENT_MAX_REFRESH_CALLS
            ) {
              status = "tool-error";
              toolResult = errorToolResult(
                visibleToolName,
                "refresh-limit",
                "The evidence refresh limit was reached",
              );
            } else {
              if (toolName === "refresh_asset_data") refreshCalls += 1;
              const execution = await deadline.run(() =>
                executeAgentTool(
                  toolName,
                  validatedArguments as Record<string, unknown>,
                  context,
                ),
              );
              sourceStatus = sanitizeAgentValue(
                execution.sourceStatus,
              ) as Record<string, unknown> | null;
              evidenceRef = candidateEvidenceRef;
              toolResult = boundToolResult(
                visibleToolName,
                execution.data,
                6_000,
                evidenceRef,
              );
            }
          } catch (error) {
            if (deadline.expired() || error instanceof AgentDeadlineError) {
              return await finish("timeout", fallbackAnswers.timeout, round);
            }
            if (error instanceof AgentToolValidationError) {
              status = "validation-error";
              validatedArguments = null;
              toolResult = errorToolResult(
                visibleToolName,
                "validation-error",
                "Tool arguments failed validation",
              );
            } else {
              status = "tool-error";
              const code =
                error instanceof AgentToolExecutionError
                  ? error.code
                  : "tool-unavailable";
              toolResult = errorToolResult(
                visibleToolName,
                code,
                "The evidence tool could not complete",
              );
            }
          }
        }

        trace.push({
          evidenceRef,
          callId: `trace-${trace.length + 1}`,
          functionIndex: call.function.index ?? null,
          toolName: visibleToolName,
          validatedArguments:
            validatedArguments === null
              ? null
              : (sanitizeAgentValue(validatedArguments) as Record<string, unknown>),
          durationMs: Math.max(0, Math.round(monotonicNow() - toolStartedAt)),
          status,
          sourceStatus,
          resultSummary: toolResult.summary,
        });
        messages.push({
          role: "tool",
          tool_name: toolName,
          content: toolResult.json,
        });
      }
    }

    return await finish(
      "round-limit",
      fallbackAnswers.roundLimit,
      AGENT_MAX_ROUNDS,
    );
  } finally {
    deadline.cancel();
  }
}
