"use client";

import { CaretDown, CircleNotch, PaperPlaneTilt, Sparkle } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";

import type { DashboardSnapshot, IntegrationStatus } from "../hooks/use-dashboard";

// One-click prompts, chosen by measurement rather than by what reads well.
// A question that maps to a single tool's answer grounds reliably; a compound
// or summarising one makes the model write prose the validator cannot tie back
// to a tool result. The previous set — "Brief me on this ranch", "Summarize
// activity change in 24 hours" — were all of the second kind, so every button
// in the panel returned a fallback.
const starters = ["When would smoke reach here?", "Which of my sites is in trouble?", "What evidence is missing?"];
type Trace = { toolName?: string; function?: string; arguments?: unknown; validatedArguments?: unknown; durationMs?: number; sourceStatus?: unknown; resultSummary?: unknown; status?: string };
type AgentRunStatus = "ok" | "offline" | "timeout" | "round-limit" | "grounding-error" | "evidence-answer" | "error";
const runStatusLabels: Record<AgentRunStatus, string> = {
  ok: "Grounded",
  // The answer came from the tool results, not the model's prose. Labelled
  // distinctly so the reader is never told the model wrote something it did not.
  "evidence-answer": "From evidence",
  offline: "Offline",
  timeout: "Timed out",
  "round-limit": "Round limit",
  "grounding-error": "Grounding error",
  error: "Unavailable",
};
const traceText = (value: unknown) => { if (value === null || value === undefined) return "not returned"; try { return JSON.stringify(value).slice(0, 360); } catch { return "not available"; } };
const asRecord = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
const isAgentRunStatus = (value: unknown): value is AgentRunStatus => typeof value === "string" && value in runStatusLabels;

type AgentPanelProps = {
  snapshot?: DashboardSnapshot;
  selectedAssetId?: string;
  ollamaStatus?: IntegrationStatus;
};

export function AgentPanel(props: AgentPanelProps) {
  const identity = `${props.selectedAssetId ?? props.snapshot?.asset.id ?? "no-asset"}:${props.snapshot?.mode ?? "no-mode"}:${props.snapshot?.generatedAt ?? "no-generation"}`;
  return <AgentPanelContent key={identity} {...props} />;
}

function AgentPanelContent({
  snapshot,
  selectedAssetId,
  ollamaStatus,
}: AgentPanelProps) {
  const promptId = useId();
  const traceId = useId();
  const [answer, setAnswer] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [trace, setTrace] = useState<Trace[]>([]);
  const [showTrace, setShowTrace] = useState(false);
  const [runStatus, setRunStatus] = useState<AgentRunStatus | null>(null);
  const requestRef = useRef<{ sequence: number; controller: AbortController } | null>(null);
  const sequenceRef = useRef(0);
  const assetId = selectedAssetId ?? snapshot?.asset.id;
  const mode = snapshot?.mode;

  useEffect(() => () => {
    sequenceRef.current += 1;
    requestRef.current?.controller.abort();
  }, []);

  const ask = async (nextPrompt: string) => {
    const cleaned = nextPrompt.trim();
    if (!cleaned) return;
    if (!assetId || !mode) {
      setAnswer("Select an asset with a completed evidence snapshot before asking Gemma.");
      setRunStatus("error");
      return;
    }
    requestRef.current?.controller.abort();
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    requestRef.current = { sequence, controller };
    setPrompt(cleaned);
    setPending(true);
    setAnswer("");
    setTrace([]);
    setShowTrace(false);
    setRunStatus(null);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: cleaned, assetId, mode }),
        signal: controller.signal,
      });
      const payload = asRecord(await response.json().catch(() => null));
      if (!response.ok) {
        const message = typeof payload?.error === "string" ? payload.error : "Gemma is unavailable. Deterministic evidence remains available.";
        throw new Error(message);
      }
      if (!payload) {
        throw new Error("Gemma returned an invalid response. Deterministic evidence remains available.");
      }
      if (sequenceRef.current !== sequence) return;
      const nextStatus = isAgentRunStatus(payload?.status) ? payload.status : "ok";
      setRunStatus(nextStatus);
      setAnswer(typeof payload?.answer === "string"
        ? payload.answer
        : asRecord(payload?.message) && typeof asRecord(payload?.message)?.content === "string"
          ? String(asRecord(payload?.message)?.content)
          : "Gemma returned no prose response. Review the deterministic evidence panels and try again.");
      setTrace(Array.isArray(payload?.trace) ? payload.trace as Trace[] : []);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (sequenceRef.current !== sequence) return;
      setTrace([]);
      setRunStatus(ollamaStatus === "offline" ? "offline" : "error");
      setAnswer(cause instanceof Error ? cause.message : "Gemma is unavailable. Deterministic evidence remains available.");
    } finally {
      if (sequenceRef.current === sequence) setPending(false);
    }
  };

  const displayedStatus = pending
    ? "Reviewing"
    : runStatus
      ? runStatusLabels[runStatus]
      : ollamaStatus === "offline"
        ? "Offline"
        : ollamaStatus === "error"
          ? "Unavailable"
          : ollamaStatus === "ready"
            ? "Ready"
            : "Checking";

  return <section className="agent-panel panel" aria-label="Gemma local evidence assistant">
    <div className="panel-heading"><div><p className="eyebrow">Evidence assistant</p><h2><Sparkle size={18} /> Gemma 4 12B · local</h2></div><span className={`agent-run-status status-${runStatus ?? ollamaStatus ?? "checking"}`}>{displayedStatus}</span></div>
    <div className="starter-row">{starters.map((starter) => <button key={starter} onClick={() => void ask(starter)} disabled={pending || !snapshot}>{starter}</button>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); void ask(prompt); }}><label className="sr-only" htmlFor={promptId}>Ask Gemma about this asset</label><div className="agent-input"><input id={promptId} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask for a grounded briefing" disabled={!snapshot} /><button type="submit" aria-label="Send prompt" title="Send prompt" disabled={pending || !snapshot}><PaperPlaneTilt size={19} /></button></div></form>
    {pending ? <div className="agent-pending"><CircleNotch size={18} className="spin" /> Gemma is reviewing local evidence and source freshness.</div> : null}
    {answer ? <p className="agent-answer">{answer}</p> : null}
    <button className="trace-toggle" onClick={() => setShowTrace((value) => !value)} aria-expanded={showTrace} aria-controls={traceId}>Visible tool trace <CaretDown size={16} className={showTrace ? "turned" : ""} /></button>
    {showTrace ? <div className="trace-list" id={traceId}>{trace.length ? trace.map((item, index) => <div className="trace-entry" key={`${item.toolName ?? item.function ?? "tool"}-${index}`}><div><strong>{item.toolName ?? item.function ?? "local tool"}</strong><span>{item.durationMs != null ? `${item.durationMs} ms` : "completed"} · {item.status ?? "completed"}</span></div><small>Safe arguments: {traceText(item.validatedArguments ?? item.arguments)}</small><small>Sources: {traceText(item.sourceStatus)}</small><small>Result: {traceText(item.resultSummary)}</small></div>) : <p className="quiet">No tool calls have been returned for this response.</p>}</div> : null}
  </section>;
}
