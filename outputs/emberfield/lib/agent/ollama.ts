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

export const agentRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(12_000),
    assetId: z.string().trim().min(1).max(128),
    mode: z.enum(["live", "fixture"]).optional(),
  })
  .strict();

export const AGENT_SYSTEM_PROMPT = `You are EmberField's local agricultural evidence assistant.
Use only values returned by the provided tools. Call satellite heat anomalies "detections", never confirmed fires unless an official incident tool confirms one. Name missing, stale, partial, missing-key, error, live, and fixture source states explicitly. Do not invent observations, alter deterministic scores, predict spread, or issue evacuation, dispatch, firefighting, or protection-of-life or property instructions. You may suggest low-risk questions for farm continuity planning. Follow local emergency officials and NWS alerts. Data may be delayed, incomplete, or inaccurate.`;

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

function numericClaims(value: string): number[] {
  return [...value.matchAll(/(?<![A-Za-z])\d+(?:\.\d+)?/g)]
    .map(([match]) => Number(match))
    .filter(Number.isFinite);
}

function isAnswerGrounded(answer: string, trace: AgentTraceEntry[]): boolean {
  const claims = numericClaims(answer);
  if (claims.length === 0) return true;
  const evidenceNumbers = new Set(
    numericClaims(JSON.stringify(trace.map(({ resultSummary }) => resultSummary))),
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

async function persistResult(
  input: RunAgentInput,
  result: Omit<AgentResult, "persistenceStatus">,
): Promise<AgentResult> {
  try {
    await input.repository.saveAgentRun({
      assetId: input.assetId,
      prompt: input.prompt,
      answer: result.answer,
      model: GEMMA_MODEL,
      trace: result.trace,
      durationMs: result.durationMs,
    });
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
  const context: AgentToolContext = {
    activeAssetId: parsedRequest.assetId,
    repository: input.repository,
    snapshotService: input.snapshotService,
    snapshots: new Map(),
  };
  const messages: OllamaMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: parsedRequest.prompt },
  ];
  const controller = new AbortController();
  let deadlineReached = false;
  const deadline = setTimeout(() => {
    deadlineReached = true;
    controller.abort();
  }, AGENT_TIMEOUT_MS);

  const finish = async (
    status: AgentRunStatus,
    answer: string,
    rounds: number,
  ) =>
    persistResult(input, {
      status,
      answer,
      model: GEMMA_MODEL,
      trace,
      rounds,
      durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
    });

  try {
    for (let round = 1; round <= AGENT_MAX_ROUNDS; round += 1) {
      let payload: unknown;
      try {
        const response = await fetchImplementation(chatUrl, {
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
          signal: controller.signal,
        });
        payload = await boundedJson("Ollama", response, 2_000_000);
      } catch (error) {
        if (
          deadlineReached ||
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof SourceAdapterError && error.code === "timeout")
        ) {
          return finish("timeout", fallbackAnswers.timeout, round);
        }
        if (error instanceof TypeError) {
          return finish("offline", fallbackAnswers.offline, round);
        }
        return finish("error", fallbackAnswers.error, round);
      }

      let assistantResponse: OllamaResponse;
      try {
        assistantResponse = parseOllamaResponse(payload);
      } catch {
        return finish("error", fallbackAnswers.error, round);
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
        if (!answer) return finish("error", fallbackAnswers.error, round);
        if (!isAnswerGrounded(answer, trace)) {
          return finish("grounding-error", fallbackAnswers.grounding, round);
        }
        return finish("ok", answer, round);
      }

      for (const call of calls) {
        const toolStartedAt = monotonicNow();
        const toolName = call.function.name.slice(0, 160);
        let validatedArguments: Record<string, unknown> | null = null;
        let status: AgentTraceStatus = "ok";
        let sourceStatus: Record<string, unknown> | null = null;
        let toolResult: { json: string; summary: unknown };

        if (!isAgentToolName(toolName)) {
          status = "unknown-tool";
          toolResult = errorToolResult(
            toolName,
            "unknown-tool",
            "The requested tool is not allowlisted",
          );
        } else {
          try {
            validatedArguments = validateAgentToolArguments(
              toolName,
              call.function.arguments,
            );
            const execution = await executeAgentTool(
              toolName,
              validatedArguments,
              context,
            );
            sourceStatus = sanitizeAgentValue(
              execution.sourceStatus,
            ) as Record<string, unknown> | null;
            toolResult = boundToolResult(toolName, execution.data);
          } catch (error) {
            if (error instanceof AgentToolValidationError) {
              status = "validation-error";
              validatedArguments = null;
              toolResult = errorToolResult(
                toolName,
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
                toolName,
                code,
                "The evidence tool could not complete",
              );
            }
          }
        }

        trace.push({
          callId: call.id ?? null,
          functionIndex: call.function.index ?? null,
          toolName,
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

    return finish("round-limit", fallbackAnswers.roundLimit, AGENT_MAX_ROUNDS);
  } finally {
    clearTimeout(deadline);
  }
}
