"use client";

import { Pause, Play, SkipBack } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { formatUtc, type DashboardSnapshot } from "../hooks/use-dashboard";

export function TimelineDock({ snapshot, onSelect }: { snapshot?: DashboardSnapshot; onSelect: (id: string) => void }) {
  const [playing, setPlaying] = useState(false);
  const [hour, setHour] = useState(24);
  const [firmsVisible, setFirmsVisible] = useState(true);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setHour((value) => value >= 24 ? 0 : value + 1), 900);
    return () => window.clearInterval(timer);
  }, [playing]);
  const marks = useMemo(
    () => snapshot?.groups.map((group) => ({
      id: group.cluster.id,
      position: Math.max(2, Math.min(98, 100 - ((Date.parse(snapshot.generatedAt) - Date.parse(group.cluster.latestAcquiredAt)) / 86_400_000) * 100)),
    })) ?? [],
    [snapshot],
  );
  return <section className="timeline panel" aria-label="24 hour activity timeline">
    <div className="timeline-header"><div><p className="eyebrow">24 hour replay</p><h2>Change in detected activity</h2></div><div className="timeline-controls"><button className="icon-button" aria-label="Reset timeline" title="Reset timeline" onClick={() => setHour(0)}><SkipBack size={18} /></button><button className="icon-button" aria-label={playing ? "Pause timeline" : "Play timeline"} title={playing ? "Pause timeline" : "Play timeline"} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={18} /> : <Play size={18} />}</button><label className="source-toggle"><input type="checkbox" checked={firmsVisible} onChange={(event) => setFirmsVisible(event.target.checked)} /> FIRMS</label></div></div>
    <div className="timeline-track"><input aria-label="Timeline position" type="range" min="0" max="24" value={hour} onChange={(event) => setHour(Number(event.target.value))} />{firmsVisible && marks.map((mark) => <button key={mark.id} className="timeline-mark" onClick={() => onSelect(mark.id)} style={{ left: `${mark.position}%` }} aria-label={`Select activity at ${formatUtc(snapshot?.groups.find((group) => group.cluster.id === mark.id)?.cluster.latestAcquiredAt)}`} />)}</div>
    <div className="timeline-labels"><span>24h ago</span><span>{hour === 24 ? "Now" : `${hour}h replay`}</span><span>{snapshot ? `Latest ${formatUtc(snapshot.groups[0]?.cluster.latestAcquiredAt)}` : "Waiting for evidence"}</span></div>
  </section>;
}
