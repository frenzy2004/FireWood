"use client";

import {
  Crosshair,
  Fire,
  MapPin,
  NavigationArrow,
  Path,
  Stack,
  Target,
  Timer,
  WarningCircle,
  Wind,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import Map, {
  FullscreenControl,
  Layer,
  Marker,
  NavigationControl,
  ScaleControl,
  Source,
  type MapRef,
} from "react-map-gl/maplibre";

import { angleDifference, bearingDegrees } from "@/lib/domain/geometry";
import { corridorFeature, isochroneFeatures } from "@/lib/domain/plume";
import {
  MAX_VALIDATED_RANGE_KM,
  PLUME_HALF_WIDTH_DEG,
  estimateSmokeArrival,
  type SmokeArrival,
} from "@/lib/domain/smoke";

import { formatUtc, type DashboardSnapshot } from "../hooks/use-dashboard";
import { MapEvidenceCard } from "./MapEvidenceCard";
import {
  describeMapSelection,
  detectionSelectionId,
  type MapSelection,
} from "./map-evidence";

const style = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

type MapLayerKey = "detections" | "incidents" | "perimeters" | "radius" | "smoke";
type MapLayers = Record<MapLayerKey, boolean>;

const defaultLayers: MapLayers = {
  detections: true,
  incidents: true,
  perimeters: true,
  radius: true,
  smoke: true,
};

function radiusFeature(lat: number, lon: number, radiusKm: number) {
  const distance = radiusKm / 6_371.0088;
  const originLat = (lat * Math.PI) / 180;
  const originLon = (lon * Math.PI) / 180;
  const coordinates = Array.from({ length: 65 }, (_, index) => {
    const bearing = (index / 64) * Math.PI * 2;
    const ringLat = Math.asin(
      Math.sin(originLat) * Math.cos(distance)
      + Math.cos(originLat) * Math.sin(distance) * Math.cos(bearing),
    );
    const ringLon = originLon + Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(originLat),
      Math.cos(distance) - Math.sin(originLat) * Math.sin(ringLat),
    );
    return [(ringLon * 180) / Math.PI, (ringLat * 180) / Math.PI];
  });
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [coordinates] },
  };
}

const clusterSize = (count: number) => Math.max(44, Math.min(76, 40 + Math.sqrt(Math.max(1, count)) * 7));

/** Short HUD phrasing per advection status. Never invents a time. */
function arrivalHudLabel(arrival: SmokeArrival): string {
  switch (arrival.status) {
    case "inbound":
      return `Smoke in ${arrival.hoursUntilArrival?.toFixed(1)} h`;
    case "likely-arrived":
      return "Smoke likely arrived";
    case "beyond-range":
      return "Beyond validated range";
    case "off-plume":
      return "Not upwind of asset";
    case "calm-wind":
      return "Wind too calm to track";
    default:
      return "Arrival not assessable";
  }
}

function assetBounds(lat: number, lon: number, radiusKm: number): [[number, number], [number, number]] {
  const latitudeDelta = Math.max(0.01, radiusKm / 111.32);
  const longitudeDelta = Math.max(
    0.01,
    radiusKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180))),
  );
  return [
    [lon - longitudeDelta, lat - latitudeDelta],
    [lon + longitudeDelta, lat + latitudeDelta],
  ];
}

function LayerToggle({
  active,
  icon,
  label,
  shortLabel,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  shortLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      className="map-layer-toggle"
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {icon}
      <span>{shortLabel}</span>
    </button>
  );
}

export function MapCanvas({
  snapshot,
  selectedGroupId,
  onSelect,
}: {
  snapshot?: DashboardSnapshot;
  selectedGroupId: string;
  onSelect: (id: string) => void;
}) {
  const [canUseMap, setCanUseMap] = useState(false);
  const [layers, setLayers] = useState<MapLayers>(defaultLayers);
  const [selection, setSelection] = useState<MapSelection>(null);
  const mapRef = useRef<MapRef>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCanUseMap(typeof window.WebGLRenderingContext !== "undefined");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const assetLat = snapshot?.asset.location.lat;
  const assetLon = snapshot?.asset.location.lon;
  const assetRadiusKm = snapshot?.asset.radiusKm;
  const fitAsset = useCallback(() => {
    if (assetLat === undefined || assetLon === undefined || assetRadiusKm === undefined) return;
    mapRef.current?.fitBounds(assetBounds(assetLat, assetLon, assetRadiusKm), {
      padding: 48,
      maxZoom: 12,
      duration: 0,
    });
  }, [assetLat, assetLon, assetRadiusKm]);

  useEffect(() => {
    fitAsset();
  }, [fitAsset]);

  if (!snapshot) {
    return (
      <section className="map-canvas panel map-loading" aria-label="Evidence map">
        <div className="map-grid" />
        <p>Preparing local evidence map</p>
      </section>
    );
  }

  const toggleLayer = (key: MapLayerKey) => {
    setLayers((current) => ({ ...current, [key]: !current[key] }));
    if (
      (key === "detections" && (selection?.kind === "detection" || selection?.kind === "group"))
      || (key === "incidents" && selection?.kind === "incident")
    ) {
      setSelection(null);
    }
  };

  const asset = snapshot.asset;
  const selected = snapshot.groups.find((group) => group.cluster.id === selectedGroupId);
  const detail = describeMapSelection(snapshot, selection);
  const radius = radiusFeature(asset.location.lat, asset.location.lon, asset.radiusKm);
  const windDirection = selected?.weather?.windFromDeg == null
    ? null
    : (selected.weather.windFromDeg + 180) % 360;
  const assetBearing = selected ? bearingDegrees(selected.cluster.centroid, asset.location) : null;
  const windOffset = windDirection === null || assetBearing === null
    ? null
    : angleDifference(windDirection, assetBearing);
  const windAlignment = windOffset === null
    ? null
    : windOffset <= 30
      ? "toward asset"
      : windOffset >= 150
        ? "away from asset"
        : "crosswind";
  const windLabel = windDirection === null
    ? null
    : `Wind direction ${Math.round(windDirection)}°, ${windAlignment ?? "alignment unavailable"}${windOffset === null ? "" : `, ${Math.round(windOffset)}° from asset bearing`}`;
  const perimeters = {
    type: "FeatureCollection" as const,
    features: snapshot.perimeters.flatMap((perimeter) => {
      const geometry = perimeter.geometry as { type?: string; coordinates?: unknown };
      return geometry?.type && geometry.coordinates
        ? [{
            type: "Feature" as const,
            properties: { id: perimeter.id },
            geometry: geometry as GeoJSON.Geometry,
          }]
        : [];
    }),
  };
  const detectionLabel = `${snapshot.detections.length} raw detection${snapshot.detections.length === 1 ? "" : "s"}`;

  // Derived, never stored on the snapshot — so replay filtering cannot leak a
  // stale arrival, and the estimate is anchored to when the evidence was taken.
  const arrival: SmokeArrival | null = selected
    ? estimateSmokeArrival({
        asset: asset.location,
        source: selected.cluster.centroid,
        detectedAt: selected.cluster.latestAcquiredAt,
        windFromDeg: selected.weather?.windFromDeg ?? null,
        windSpeedMps: selected.weather?.windSpeedMps ?? null,
        now: new Date(snapshot.generatedAt),
      })
    : null;
  const corridorBearing = arrival?.transportBearingDeg ?? null;
  const corridorRangeKm = arrival === null
    ? null
    : Math.min(MAX_VALIDATED_RANGE_KM, Math.max(arrival.distanceKm * 1.3, asset.radiusKm));
  const showCorridor = selected !== undefined && corridorBearing !== null && corridorRangeKm !== null;
  const corridor = showCorridor
    ? corridorFeature(selected.cluster.centroid, corridorBearing, PLUME_HALF_WIDTH_DEG, corridorRangeKm)
    : null;
  const isochrones = showCorridor && selected.weather?.windSpeedMps
    ? isochroneFeatures(
        selected.cluster.centroid,
        corridorBearing,
        PLUME_HALF_WIDTH_DEG,
        selected.weather.windSpeedMps,
        corridorRangeKm,
      )
    : null;
  const legendLabel = [
    `Map legend: ${snapshot.detections.length} FIRMS detection${snapshot.detections.length === 1 ? "" : "s"}`,
    `${snapshot.incidents.length} official incident${snapshot.incidents.length === 1 ? "" : "s"}`,
    `${snapshot.perimeters.length} official perimeter${snapshot.perimeters.length === 1 ? "" : "s"}`,
  ].join(", ");

  return (
    <section className="map-canvas panel" aria-label="Evidence map">
      {canUseMap ? (
        <Map
          ref={mapRef}
          initialViewState={{ longitude: asset.location.lon, latitude: asset.location.lat, zoom: 9.4 }}
          mapStyle={style}
          onLoad={fitAsset}
        >
          <NavigationControl position="top-right" showCompass />
          <FullscreenControl position="top-right" />
          <ScaleControl position="bottom-right" unit="metric" />

          {layers.smoke && corridor ? (
            <Source id="plume-corridor" type="geojson" data={corridor}>
              <Layer id="plume-corridor-fill" type="fill" paint={{ "fill-color": "#e7ad4d", "fill-opacity": 0.09 }} />
              <Layer id="plume-corridor-line" type="line" paint={{ "line-color": "#e7ad4d", "line-width": 1, "line-opacity": 0.35, "line-dasharray": [3, 3] }} />
            </Source>
          ) : null}
          {layers.smoke && isochrones && isochrones.features.length > 0 ? (
            <Source id="plume-isochrones" type="geojson" data={isochrones}>
              <Layer id="plume-isochrone-lines" type="line" paint={{ "line-color": "#e7ad4d", "line-width": 1.4, "line-opacity": 0.55 }} />
            </Source>
          ) : null}
          {layers.radius ? (
            <Source id="asset-radius" type="geojson" data={radius}>
              <Layer id="asset-radius-fill" type="fill" paint={{ "fill-color": "#8fbd6b", "fill-opacity": 0.11 }} />
              <Layer id="asset-radius-line" type="line" paint={{ "line-color": "#8fbd6b", "line-width": 2, "line-opacity": 0.9 }} />
            </Source>
          ) : null}
          {layers.perimeters && perimeters.features.length > 0 ? (
            <Source id="perimeters" type="geojson" data={perimeters}>
              <Layer id="perimeter-lines" type="line" paint={{ "line-color": "#d6a84b", "line-width": 2, "line-opacity": 0.8 }} />
            </Source>
          ) : null}

          <Marker longitude={asset.location.lon} latitude={asset.location.lat}>
            <span className="asset-pin"><MapPin size={24} weight="fill" /></span>
          </Marker>

          {layers.detections ? snapshot.detections.map((detection, index) => {
            const id = detectionSelectionId(detection, index);
            return (
              <Marker key={id} longitude={detection.lon} latitude={detection.lat}>
                <button
                  className={`thermal-dot ${selection?.kind === "detection" && selection.id === id ? "selected" : ""}`}
                  type="button"
                  aria-label={`Select ${detection.satellite} heat anomaly acquired ${formatUtc(detection.acquiredAt)}`}
                  aria-pressed={selection?.kind === "detection" && selection.id === id}
                  title={`${detection.satellite} heat anomaly acquired ${formatUtc(detection.acquiredAt)}`}
                  onClick={() => setSelection({ kind: "detection", id })}
                />
              </Marker>
            );
          }) : null}

          {layers.detections ? snapshot.groups.map((group) => {
            const size = clusterSize(group.cluster.detectionCount);
            return (
              <Marker key={group.cluster.id} longitude={group.cluster.centroid.lon} latitude={group.cluster.centroid.lat}>
                <button
                  onClick={() => {
                    onSelect(group.cluster.id);
                    setSelection({ kind: "group", id: group.cluster.id });
                  }}
                  style={{ width: size, height: size }}
                  className={`cluster-mark ${selectedGroupId === group.cluster.id ? "selected" : ""}`}
                  aria-label={`Select activity group with ${group.cluster.detectionCount} detections`}
                >
                  {group.cluster.detectionCount}
                </button>
              </Marker>
            );
          }) : null}

          {layers.incidents ? snapshot.incidents.map((incident) => (
            <Marker key={incident.id} longitude={incident.location.lon} latitude={incident.location.lat}>
              <button
                className={`official-pin incident-button ${selection?.kind === "incident" && selection.id === incident.id ? "selected" : ""}`}
                type="button"
                aria-label={`Select official incident ${incident.name}`}
                aria-pressed={selection?.kind === "incident" && selection.id === incident.id}
                title={`Official incident context: ${incident.name}`}
                onClick={() => setSelection({ kind: "incident", id: incident.id })}
              >
                <WarningCircle size={24} weight="fill" />
              </button>
            </Marker>
          )) : null}

          {layers.smoke && windDirection !== null && selected ? (
            <Marker longitude={selected.cluster.centroid.lon} latitude={selected.cluster.centroid.lat} offset={[0, -45]}>
              <span className="wind-cue" title={windLabel ?? "Wind direction"} style={{ transform: `rotate(${windDirection}deg)` }}>
                <NavigationArrow size={27} weight="fill" />
              </span>
            </Marker>
          ) : null}
        </Map>
      ) : (
        <div className="map-fallback">
          <div className="map-grid" />
          <span className="map-area">{asset.name}</span>
          {layers.radius ? <span className="asset-radius-ring" aria-label={`${asset.radiusKm.toFixed(0)} kilometer asset radius`} /> : null}
          <span className="asset-pin fallback-pin"><MapPin size={25} weight="fill" /></span>

          {layers.detections ? snapshot.detections.map((detection, index) => {
            const id = detectionSelectionId(detection, index);
            const column = index % 4;
            const row = Math.floor(index / 4) % 3;
            return (
              <button
                key={id}
                className={`thermal-dot fallback-thermal ${selection?.kind === "detection" && selection.id === id ? "selected" : ""}`}
                type="button"
                style={{ top: `${28 + row * 14}%`, left: `${34 + column * 9}%` }}
                aria-label={`Select ${detection.satellite} heat anomaly acquired ${formatUtc(detection.acquiredAt)}`}
                aria-pressed={selection?.kind === "detection" && selection.id === id}
                onClick={() => setSelection({ kind: "detection", id })}
              />
            );
          }) : null}

          {layers.detections ? snapshot.groups.map((group, index) => {
            const size = clusterSize(group.cluster.detectionCount);
            return (
              <button
                key={group.cluster.id}
                type="button"
                onClick={() => {
                  onSelect(group.cluster.id);
                  setSelection({ kind: "group", id: group.cluster.id });
                }}
                style={{ width: size, height: size }}
                className={`cluster-mark fallback-cluster cluster-${index + 1} ${selectedGroupId === group.cluster.id ? "selected" : ""}`}
                aria-label={`Select activity group with ${group.cluster.detectionCount} detections`}
              >
                {group.cluster.detectionCount}
              </button>
            );
          }) : null}

          {layers.incidents ? snapshot.incidents.map((incident, index) => (
            <button
              key={incident.id}
              className={`official-pin incident-button fallback-incident incident-${index + 1} ${selection?.kind === "incident" && selection.id === incident.id ? "selected" : ""}`}
              type="button"
              aria-label={`Select official incident ${incident.name}`}
              aria-pressed={selection?.kind === "incident" && selection.id === incident.id}
              title={`Official incident context: ${incident.name}`}
              onClick={() => setSelection({ kind: "incident", id: incident.id })}
            >
              <WarningCircle size={24} weight="fill" />
            </button>
          )) : null}

          {layers.smoke && windDirection !== null ? (
            <span className="wind-cue fallback-wind" title={windLabel ?? "Wind direction"} style={{ transform: `rotate(${windDirection}deg)` }}>
              <NavigationArrow size={27} weight="fill" />
            </span>
          ) : null}
        </div>
      )}

      <div className="map-toolbar" aria-label="Map controls">
        <button className="map-reset-button" type="button" onClick={fitAsset} aria-label="Reset map view" title="Reset map view">
          <Target size={17} weight="bold" />
        </button>
        <div className="map-layer-controls">
          <LayerToggle active={layers.detections} icon={<Fire size={15} />} label="Toggle FIRMS detections" shortLabel="FIRMS" onClick={() => toggleLayer("detections")} />
          <LayerToggle active={layers.incidents} icon={<WarningCircle size={15} />} label="Toggle official incidents" shortLabel="Incidents" onClick={() => toggleLayer("incidents")} />
          <LayerToggle active={layers.perimeters} icon={<Path size={15} />} label="Toggle official perimeters" shortLabel="Perimeters" onClick={() => toggleLayer("perimeters")} />
          <LayerToggle active={layers.radius} icon={<Crosshair size={15} />} label="Toggle asset radius" shortLabel="Radius" onClick={() => toggleLayer("radius")} />
          <LayerToggle active={layers.smoke} icon={<Wind size={15} />} label="Toggle smoke transport" shortLabel="Smoke" onClick={() => toggleLayer("smoke")} />
        </div>
      </div>

      <div className="map-legend" aria-label={legendLabel}>
        <span><Fire size={13} weight="fill" /> {snapshot.detections.length} FIRMS</span>
        <span><WarningCircle size={13} weight="fill" /> {snapshot.incidents.length} incident{snapshot.incidents.length === 1 ? "" : "s"}</span>
        <span><Stack size={13} weight="fill" /> {snapshot.perimeters.length} perimeter{snapshot.perimeters.length === 1 ? "" : "s"}</span>
      </div>

      {detail ? <MapEvidenceCard detail={detail} onClose={() => setSelection(null)} /> : null}

      <div className="map-hud">
        <span><Crosshair size={15} /> {asset.radiusKm.toFixed(0)} km radius</span>
        <span>{detectionLabel}</span>
        {windLabel ? <span><Wind size={15} /> {windAlignment}, {Math.round(windOffset ?? 0)}° offset</span> : null}
        {arrival ? <span className={`hud-arrival ${arrival.status === "inbound" ? "inbound" : ""}`}><Timer size={15} /> {arrivalHudLabel(arrival)}</span> : null}
      </div>
      {arrival?.status === "inbound" ? (
        <p className="map-caption arrival-caption">Smoke-transport estimate only. It does not predict where the fire itself will go.</p>
      ) : null}
      {snapshot.detections.length === 0 ? (
        <p className="map-caption empty-detections">No recent satellite detections were returned. Absence of detections does not mean absence of fire.</p>
      ) : (
        <p className="map-caption">Thermal marks are satellite-detected heat anomalies. They are not confirmed wildfire locations.</p>
      )}
    </section>
  );
}
