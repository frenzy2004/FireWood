import type { AgentResult, AgentTraceEntry } from "./ollama";

export type AgentProgressEvent =
  | { type: "round-start"; round: number }
  | { type: "tool-complete"; entry: AgentTraceEntry }
  | { type: "complete"; result: AgentResult };
