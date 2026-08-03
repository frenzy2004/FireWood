"use client";

import { CaretDown, CircleNotch, PaperPlaneTilt, Sparkle } from "@phosphor-icons/react";
import { useState } from "react";
import type { DashboardSnapshot } from "../hooks/use-dashboard";

const starters = ["Brief me on this ranch", "What evidence is missing?", "Summarize activity change in 24 hours"];
type Trace = { toolName?: string; function?: string; arguments?: unknown; validatedArguments?: unknown; durationMs?: number; sourceStatus?: unknown; resultSummary?: unknown; status?: string };
const traceText = (value: unknown) => { if (value === null || value === undefined) return "not returned"; try { return JSON.stringify(value).slice(0, 360); } catch { return "not available"; } };

export function AgentPanel({ snapshot }: { snapshot?: DashboardSnapshot }) {
  const [answer, setAnswer] = useState(""); const [prompt, setPrompt] = useState(""); const [pending, setPending] = useState(false); const [trace, setTrace] = useState<Trace[]>([]); const [showTrace, setShowTrace] = useState(false);
  const ask = async (nextPrompt: string) => {
    const cleaned = nextPrompt.trim(); if (!cleaned) return; setPrompt(cleaned); setPending(true); setAnswer("");
    try {
      const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: cleaned, assetId: snapshot?.asset.id, mode: snapshot?.mode }) });
      const payload = await response.json().catch(() => ({})) as { answer?: unknown; trace?: unknown; error?: unknown; message?: { content?: unknown } };
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Gemma is unavailable. Deterministic evidence remains available.");
      setAnswer(typeof payload.answer === "string" ? payload.answer : typeof payload.message?.content === "string" ? payload.message.content : "Gemma returned no prose response. Review the evidence panels and try again.");
      setTrace(Array.isArray(payload.trace) ? payload.trace as Trace[] : []);
    } catch (error) { setAnswer(error instanceof Error ? error.message : "Gemma is unavailable. Deterministic evidence remains available."); } finally { setPending(false); }
  };
  return <section className="agent-panel panel" aria-label="Gemma local evidence assistant"><div className="panel-heading"><div><p className="eyebrow">Evidence assistant</p><h2><Sparkle size={18} /> Gemma 4 12B · local</h2></div><span className="local-status">Local only</span></div>
    <div className="starter-row">{starters.map((starter) => <button key={starter} onClick={() => void ask(starter)} disabled={pending}>{starter}</button>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); void ask(prompt); }}><label className="sr-only" htmlFor="gemma-prompt">Ask Gemma about this asset</label><div className="agent-input"><input id="gemma-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask for a grounded briefing" /><button type="submit" aria-label="Send prompt" title="Send prompt" disabled={pending}><PaperPlaneTilt size={19} /></button></div></form>
    {pending && <div className="agent-pending"><CircleNotch size={18} className="spin" /> Gemma is reviewing local evidence and source freshness.</div>}
    {answer && <p className="agent-answer">{answer}</p>}
    <button className="trace-toggle" onClick={() => setShowTrace((value) => !value)} aria-expanded={showTrace}>Visible tool trace <CaretDown size={16} className={showTrace ? "turned" : ""} /></button>
    {showTrace && <div className="trace-list">{trace.length ? trace.map((item, index) => <div className="trace-entry" key={index}><div><strong>{item.toolName ?? item.function ?? "local tool"}</strong><span>{item.durationMs != null ? `${item.durationMs} ms` : "completed"} · {item.status ?? "completed"}</span></div><small>Safe arguments: {traceText(item.validatedArguments ?? item.arguments)}</small><small>Sources: {traceText(item.sourceStatus)}</small><small>Result: {traceText(item.resultSummary)}</small></div>) : <p className="quiet">No tool calls have been returned for this response.</p>}</div>}
  </section>;
}
