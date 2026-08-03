"use client";

import { X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import type { SavedAsset } from "../hooks/use-dashboard";

const categories = ["field", "orchard", "barn", "livestock", "workforce", "storage", "other"];
const MIN_RADIUS_MILES = 0.63;
const MAX_RADIUS_MILES = 62.14;
const MILES_TO_KM = 1.60934;

export function SetupPanel({ onClose, onSaved }: { onClose: () => void; onSaved: (asset: SavedAsset) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [category, setCategory] = useState("field");
  const [miles, setMiles] = useState("25");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const panelRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const lookup = async () => {
    setLookingUp(true);
    setError("");
    try {
      const response = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`);
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok || !data || typeof data !== "object") {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Address lookup is unavailable.";
        throw new Error(message);
      }
      const result = data as { status?: string; match?: { location?: { lat: number; lon: number } } | null };
      if (result.status === "no-match" || !result.match?.location) {
        throw new Error("No Census coordinate match was returned. Check the address or enter coordinates directly.");
      }
      setLatitude(String(result.match.location.lat));
      setLongitude(String(result.match.location.lon));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Address lookup is unavailable. Enter coordinates directly.");
    } finally {
      setLookingUp(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    const radiusKm = Number(miles) * MILES_TO_KM;
    if (!name.trim()) {
      setError("Asset name is required.");
      return;
    }
    if (!Number.isFinite(parsedLatitude) || parsedLatitude < -90 || parsedLatitude > 90 || !Number.isFinite(parsedLongitude) || parsedLongitude < -180 || parsedLongitude > 180) {
      setError("Enter valid latitude and longitude coordinates.");
      return;
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 100) {
      setError("Radius must be between 0.63 and 62.14 miles.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category,
          latitude: parsedLatitude,
          longitude: parsedLongitude,
          radiusKm,
          notes: notes.trim() || undefined,
        }),
      });
      const data: unknown = await response.json().catch(() => null);
      const asset = data && typeof data === "object" && "asset" in data ? data.asset : null;
      if (!response.ok || !asset || typeof asset !== "object") {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Asset could not be saved.";
        throw new Error(message);
      }
      onSaved(asset as SavedAsset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Asset could not be saved. Your entries are still here to retry.");
    } finally {
      setSaving(false);
    }
  };

  return <div className="setup-backdrop" role="presentation">
    <form ref={panelRef} className="setup-panel panel" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="panel-heading"><div><p className="eyebrow">Asset setup</p><h2 id="setup-title">Add a farm asset</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close asset setup"><X size={19} /></button></div>
      <label>Name<input ref={nameRef} required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Address lookup<div className="lookup-row"><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Optional rural address" /><button type="button" onClick={() => void lookup()} disabled={lookingUp || !address.trim()}>{lookingUp ? "Looking up" : "Lookup"}</button></div></label>
      <div className="form-grid"><label>Latitude<input required type="number" min="-90" max="90" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label><label>Longitude<input required type="number" min="-180" max="180" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label></div>
      <div className="form-grid"><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><label>Radius miles<input required type="number" min={MIN_RADIUS_MILES} max={MAX_RADIUS_MILES} step="0.01" value={miles} onChange={(event) => setMiles(event.target.value)} /></label></div>
      <label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="primary-button" disabled={saving}>{saving ? "Saving" : "Save asset"}</button>
    </form>
  </div>;
}
