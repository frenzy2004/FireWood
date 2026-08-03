"use client";

import { ArrowsClockwise, CloudArrowDown, Leaf, Radio, WarningCircle } from "@phosphor-icons/react";
import type { DataMode } from "../hooks/use-dashboard";

export function TopBar({ mode, loading, onModeChange, onRefresh }: { mode: DataMode; loading: boolean; onModeChange: (mode: DataMode) => void; onRefresh: () => void }) {
  return <header className="topbar">
    <div className="brand"><span className="brand-mark"><Leaf size={18} weight="bold" /></span><span>EmberField</span><small>operations console</small></div>
    <div className="topbar-actions">
      <span className="local-status"><Radio size={14} weight="fill" /> Gemma local</span>
      <div className="mode-switch" aria-label="Evidence mode">
        <button className={mode === "fixture" ? "is-active" : ""} onClick={() => onModeChange("fixture")}>Fixture data</button>
        <button className={mode === "live" ? "is-active" : ""} onClick={() => onModeChange("live")}>Live data</button>
      </div>
      <button className="control-button refresh-button" aria-label="Refresh evidence" title="Refresh evidence" onClick={onRefresh} disabled={loading}>
        {loading ? <CloudArrowDown size={18} /> : <ArrowsClockwise size={18} />}<span>{loading ? "Loading" : "Refresh"}</span>
      </button>
      <span className="safety-status" title="Informational context only"><WarningCircle size={17} /> Context only</span>
    </div>
  </header>;
}
