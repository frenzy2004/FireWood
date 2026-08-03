import { z } from "zod";

import { boundedJson, SourceAdapterError } from "../sources/shared";
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
export const AGENT_MAX_CALLS_PER_ROUND = 9;
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
Use only values returned by the provided tools. Every condition or source assertion in a final briefing must cite a successful tool's server-issued evidenceRef exactly as [evidence:REF]. Never cite a failed call. Call satellite heat anomalies "detections", never confirmed fires unless an official incident tool confirms one. Name missing, stale, partial, missing-key, error, live, and fixture source states explicitly. Do not invent observations, alter deterministic scores, predict spread, or issue evacuation, dispatch, firefighting, or protection-of-life or property instructions. You may suggest low-risk questions for farm continuity planning. Follow local emergency officials and NWS alerts. Data may be delayed, incomplete, or inaccurate.`;

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
  persistenceStatus: "saved" | "error";
}

export interface RunAgentInput {
  prompt: string;
  assetId: string;
  repository: AgentRepository;
  snapshotService: SnapshotService;
  fetchImpl?: typeof fetch;
  ollamaBaseUrl?: string;
  mode?: "live" | "fixture";
  now?: () => Date;
  monotonicNow?: () => number;
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

function safeTraceIdentity(
  value: string | undefined,
  maximumLength = 160,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const opaqueIdentity = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
  const sensitiveLabel =
    /(?:api[_-]?key|map[_-]?key|authorization|password|secret|token)/i;
  if (
    trimmed.length === 0 ||
    trimmed.length > maximumLength ||
    !opaqueIdentity.test(trimmed) ||
    sensitiveLabel.test(trimmed)
  ) {
    return "[redacted-identity]";
  }
  return trimmed;
}

function numericClaims(value: string): number[] {
  return [...value.matchAll(/(?<![A-Za-z])\d+(?:\.\d+)?/g)]
    .map(([match]) => Number(match))
    .filter(Number.isFinite);
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

const TOOL_EVIDENCE_TERMS: Record<string, string[]> = {
  list_assets: ["asset", "saved", "available"],
  inspect_asset: [
    "asset",
    "saved",
    "available",
    "activity",
    "alert",
    "assessment",
    "context",
    "detection",
    "nearby",
  ],
  refresh_asset_data: [
    "asset",
    "refresh",
    "refreshed",
    "fresh",
    "activity",
    "detection",
  ],
  get_activity_groups: [
    "activity",
    "assessment",
    "context",
    "detection",
    "group",
    "satellite",
  ],
  get_weather_context: [
    "weather",
    "wind",
    "moving",
    "humidity",
    "nws",
    "context",
  ],
  get_air_quality: ["air", "quality", "aqi", "airnow"],
  get_official_incidents: [
    "official",
    "incident",
    "perimeter",
    "confirmed",
    "wildfire",
  ],
  get_timeline: ["activity", "detection", "recent", "satellite", "timeline"],
  explain_assessment: [
    "assessment",
    "context",
    "deterministic",
    "reason",
    "score",
  ],
};

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

function lexicalTokens(value: string): string[] {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return [...expanded.matchAll(/[a-z][a-z0-9]*/g)].map(([token]) =>
    normalizedToken(token),
  );
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
    /^(?:ask|consider|identify|prepare)\b.*\blow[- ]risk\b.*\bquestions?\b[.!?]?$/.test(
      normalized,
    ) ||
    /^data may be (?:delayed|incomplete|inaccurate)(?:,? (?:or|and) (?:delayed|incomplete|inaccurate))*[.!]?$/.test(
      normalized,
    )
  );
}

function isNegatedAt(sentence: string, index: number): boolean {
  const prefix = sentence.slice(Math.max(0, index - 120), index);
  const clause =
    prefix.split(/[.;!?]|\b(?:and|but|however|or)\b/i).at(-1) ?? prefix;
  const negations = [
    ...clause.matchAll(/\b(?:no|not|never|cannot|can't|does not|doesn't|do not|without)\b/gi),
  ];
  const lastNegation = negations.at(-1);
  if (!lastNegation || lastNegation.index === undefined) return false;
  return lexicalTokens(clause.slice(lastNegation.index)).length <= 10;
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
      return (
        !lowRiskQualifier &&
        !isNegatedAt(sentence, match.index) &&
        !negatedAfter
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
    /\b(?:wildfires?|fires?|detections?|activity|incidents?|perimeters?|smoke|flames?)\b/i.test(
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
  entries: AgentTraceEntry[],
): boolean {
  const evidenceTerms = new Set(
    entries.flatMap((entry) => [
      ...lexicalTokens(JSON.stringify(entry.resultSummary)),
      ...(TOOL_EVIDENCE_TERMS[entry.toolName] ?? []).map(normalizedToken),
    ]),
  );
  const claimTerms = [
    ...new Set(
      lexicalTokens(sentence.replace(CITATION_PATTERN, "")).filter(
        (token) => !CLAIM_FRAMING_TERMS.has(token),
      ),
    ),
  ];
  return (
    claimTerms.length > 0 &&
    claimTerms.every((token) => evidenceTerms.has(token))
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
    const evidenceNumbers = new Set(
      numericClaims(
        JSON.stringify(citedEntries.map(({ resultSummary }) => resultSummary)),
      ),
    );
    if (!numericClaims(claim).every((number) => evidenceNumbers.has(number))) {
      return false;
    }
    if (
      confirmation !== null &&
      !hasMatchingOfficialIncident(claim, citedEntries)
    ) {
      return false;
    }
    return hasLexicalEvidence(claim, citedEntries);
  });
}

const fallbackAnswers = {
  offline:
    "Local Gemma is offline. Deterministic monitoring remains available; review the source states and follow local emergency officials and NWS alerts.",
  timeout:
    "Local Gemma timed out. Deterministic monitoring remains available; review the source states and follow local emergency officials and NWS alerts.",
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

function createAgentDeadline(timeoutMs: number): AgentDeadline {
  const controller = new AbortController();
  let expired = false;
  let rejectExpiration!: (error: AgentDeadlineError) => void;
  const expiration = new Promise<never>((_resolve, reject) => {
    rejectExpiration = reject;
  });
  void expiration.catch(() => undefined);
  const timeout = setTimeout(() => {
    expired = true;
    controller.abort();
    rejectExpiration(new AgentDeadlineError());
  }, timeoutMs);

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
    },
  };
}

async function persistResult(
  input: RunAgentInput,
  result: Omit<AgentResult, "persistenceStatus">,
  deadline: AgentDeadline,
): Promise<AgentResult> {
  if (deadline.expired()) return { ...result, persistenceStatus: "error" };
  try {
    await deadline.run(() =>
      input.repository.saveAgentRun(
        {
          assetId: input.assetId,
          prompt: input.prompt,
          answer: result.answer,
          model: GEMMA_MODEL,
          trace: result.trace,
          durationMs: result.durationMs,
        },
        deadline.signal,
      ),
    );
    return { ...result, persistenceStatus: "saved" };
  } catch {
    return { ...result, persistenceStatus: "error" };
  }
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
  const deadline = createAgentDeadline(AGENT_TIMEOUT_MS);
  let totalToolCalls = 0;
  let refreshCalls = 0;
  const context: AgentToolContext = {
    activeAssetId: parsedRequest.assetId,
    repository: input.repository,
    snapshotService: input.snapshotService,
    snapshots: new Map(),
    signal: deadline.signal,
  };
  const messages: OllamaMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: parsedRequest.prompt },
  ];
  const finish = async (
    status: AgentRunStatus,
    answer: string,
    rounds: number,
  ) =>
    persistResult(
      input,
      {
        status,
        answer,
        model: GEMMA_MODEL,
        trace,
        rounds,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      },
      deadline,
    );

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
        const visibleToolName =
          safeTraceIdentity(toolName) ?? "[unknown-tool]";
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
          callId: safeTraceIdentity(call.id),
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
