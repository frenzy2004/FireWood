"use client";

import { Crosshair, MapPin, NavigationArrow, WarningCircle, Wind } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import Map, { Layer, Marker, Source } from "react-map-gl/maplibre";
import type { DashboardSnapshot } from "../hooks/use-dashboard";

const style = { version: 8 as const, sources: { osm: { type: "raster" as const, tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } }, layers: [{ id: "osm", type: "raster" as const, source: "osm" }] };

function radiusFeature(lat: number, lon: number, radiusKm: number) {
  const distance = radiusKm / 6_371.0088;
  const originLat = (lat * Math.PI) / 180;
  const originLon = (lon * Math.PI) / 180;
  const coordinates = Array.from({ length: 65 }, (_, index) => {
    const bearing = (index / 64) * Math.PI * 2;
    const ringLat = Math.asin(Math.sin(originLat) * Math.cos(distance) + Math.cos(originLat) * Math.sin(distance) * Math.cos(bearing));
    const ringLon = originLon + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(originLat), Math.cos(distance) - Math.sin(originLat) * Math.sin(ringLat));
    return [(ringLon * 180) / Math.PI, (ringLat * 180) / Math.PI];
  });
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [coordinates] } };
}

export function MapCanvas({ snapshot, selectedGroupId, onSelect }: { snapshot?: DashboardSnapshot; selectedGroupId: string; onSelect: (id: string) => void }) {
  const [canUseMap, setCanUseMap] = useState(false);
  useEffect(() => { const frame = window.requestAnimationFrame(() => setCanUseMap(typeof window.WebGLRenderingContext !== "undefined")); return () => window.cancelAnimationFrame(frame); }, []);
  if (!snapshot) return <section className="map-canvas panel map-loading" aria-label="Evidence map"><div className="map-grid" /><p>Preparing local evidence map</p></section>;
  const asset = snapshot.asset;
  const selected = snapshot.groups.find((group) => group.cluster.id === selectedGroupId);
  const radius = radiusFeature(asset.location.lat, asset.location.lon, asset.radiusKm);
  const windToward = selected?.weather?.windFromDeg == null ? null : (selected.weather.windFromDeg + 180) % 360;
  const perimeters = { type: "FeatureCollection" as const, features: snapshot.perimeters.flatMap((perimeter) => {
    const geometry = perimeter.geometry as { type?: string; coordinates?: unknown };
    return geometry?.type && geometry.coordinates ? [{ type: "Feature" as const, properties: { id: perimeter.id }, geometry: geometry as GeoJSON.Geometry }] : [];
  }) };
  return <section className="map-canvas panel" aria-label="Evidence map">
    {canUseMap ? <Map initialViewState={{ longitude: asset.location.lon, latitude: asset.location.lat, zoom: 9.4 }} mapStyle={style} attributionControl={false}>
      <Source id="asset-radius" type="geojson" data={radius}><Layer id="asset-radius-fill" type="fill" paint={{ "fill-color": "#8fbd6b", "fill-opacity": 0.11 }} /><Layer id="asset-radius-line" type="line" paint={{ "line-color": "#8fbd6b", "line-width": 2, "line-opacity": 0.9 }} /></Source>
      {perimeters.features.length > 0 && <Source id="perimeters" type="geojson" data={perimeters}><Layer id="perimeter-lines" type="line" paint={{ "line-color": "#d6a84b", "line-width": 2, "line-opacity": 0.8 }} /></Source>}
      <Marker longitude={asset.location.lon} latitude={asset.location.lat}><span className="asset-pin"><MapPin size={24} weight="fill" /></span></Marker>
      {snapshot.detections.map((detection, index) => <Marker key={detection.id ?? index} longitude={detection.lon} latitude={detection.lat}><button className="thermal-dot" aria-label={`Satellite heat anomaly from ${detection.satellite}`} title={`Satellite heat anomaly from ${detection.satellite}`} /></Marker>)}
      {snapshot.groups.map((group) => <Marker key={group.cluster.id} longitude={group.cluster.centroid.lon} latitude={group.cluster.centroid.lat}><button onClick={() => onSelect(group.cluster.id)} className={`cluster-mark ${selectedGroupId === group.cluster.id ? "selected" : ""}`} aria-label={`Select activity group with ${group.cluster.detectionCount} detections`}>{group.cluster.detectionCount}</button></Marker>)}
      {snapshot.incidents.map((incident) => <Marker key={incident.id} longitude={incident.location.lon} latitude={incident.location.lat}><span className="official-pin" title={`Official incident context: ${incident.name}`}><WarningCircle size={22} weight="fill" /></span></Marker>)}
      {windToward !== null && selected && <Marker longitude={selected.cluster.centroid.lon} latitude={selected.cluster.centroid.lat}><span className="wind-cue" title={`Wind direction toward asset ${windToward} degrees`} style={{ transform: `rotate(${windToward}deg)` }}><NavigationArrow size={27} weight="fill" /></span></Marker>}
    </Map> : <div className="map-fallback"><div className="map-grid" /><span className="map-area">{asset.name}</span><span className="asset-radius-ring" aria-label={`${asset.radiusKm.toFixed(0)} kilometer asset radius`} /><span className="asset-pin fallback-pin"><MapPin size={25} weight="fill" /></span>{snapshot.groups.map((group, index) => <button key={group.cluster.id} onClick={() => onSelect(group.cluster.id)} className={`cluster-mark fallback-cluster cluster-${index + 1} ${selectedGroupId === group.cluster.id ? "selected" : ""}`} aria-label={`Select activity group with ${group.cluster.detectionCount} detections`}>{group.cluster.detectionCount}</button>)}{snapshot.incidents.map((incident, index) => <span key={incident.id} className={`official-pin fallback-incident incident-${index + 1}`} title={`Official incident context: ${incident.name}`}><WarningCircle size={22} weight="fill" /></span>)}{windToward !== null && <span className="wind-cue fallback-wind" title={`Wind direction toward asset ${windToward} degrees`} style={{ transform: `rotate(${windToward}deg)` }}><NavigationArrow size={27} weight="fill" /></span>}</div>}
    <div className="map-hud"><span><Crosshair size={15} /> {asset.radiusKm.toFixed(0)} km radius</span>{windToward !== null && <span><Wind size={15} /> wind toward asset</span>}</div>
    <p className="map-caption">Thermal marks are satellite-detected heat anomalies. They are not confirmed wildfire locations.</p>
  </section>;
}
