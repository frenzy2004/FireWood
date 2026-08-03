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
  const sanitized = sanitizeAgentValue(value);
  return typeof sanitized === "string"
    ? sanitized.slice(0, maximumLength)
    : "[redacted-identity]";
}

function numericClaims(value: string): number[] {
  return [...value.matchAll(/(?<![A-Za-z])\d+(?:\.\d+)?/g)]
    .map(([match]) => Number(match))
    .filter(Number.isFinite);
}

function isAnswerGrounded(answer: string, trace: AgentTraceEntry[]): boolean {
  const citationPattern = /\[evidence:([A-Za-z0-9_-]{1,64})\]/g;
  const successfulEvidence = new Map(
    trace.flatMap((entry) =>
      entry.status === "ok" && entry.evidenceRef
        ? [[entry.evidenceRef, entry] as const]
        : [],
    ),
  );
  const citations = [...answer.matchAll(citationPattern)].map(
    (match) => match[1],
  );
  if (
    successfulEvidence.size === 0 ||
    citations.length === 0 ||
    citations.some((reference) => !successfulEvidence.has(reference))
  ) {
    return false;
  }
  const claims = numericClaims(answer.replace(citationPattern, ""));
  if (claims.length === 0) return true;
  const citedEntries = [
    ...new Set(citations.map((reference) => successfulEvidence.get(reference)!)),
  ];
  const evidenceNumbers = new Set(
    numericClaims(JSON.stringify(citedEntries.map(({ resultSummary }) => resultSummary))),
  );
  return claims.every((claim) => evidenceNumbers.has(claim));
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
      input.repository.saveAgentRun({
        assetId: input.assetId,
        prompt: input.prompt,
        answer: result.answer,
        model: GEMMA_MODEL,
        trace: result.trace,
        durationMs: result.durationMs,
      }),
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
