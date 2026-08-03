# EmberField Design Specification

Date: 2026-08-03

## Product decision

EmberField is a local-first agriculture wildfire intelligence console for US growers and ranchers. It monitors farm assets such as fields, orchards, barns, livestock areas, worker staging areas, and storage sites. It combines satellite thermal anomalies, official incidents, local weather, and air quality, then lets the locally installed Gemma 4 model investigate conditions through native function calls.

The primary hackathon story is GenAI for Good in agriculture, with a strong Autonomous Agent implementation. Gemma is the operator-facing intelligence, while deterministic geospatial and scoring code remains the safety boundary.

The prototype runs only on the user's Mac. It uses the installed Ollama model `gemma4:12b`. No cloud AI service, account system, or public deployment is required.

## Success criteria

The prototype is successful when a reviewer can:

1. Start the local console and see whether Ollama and every upstream source are connected.
2. Save or select an agriculture asset with coordinates and an alert radius.
3. Refresh recent FIRMS VIIRS detections and see them on an interactive map.
4. See nearby detections clustered into activity groups instead of duplicate fire claims.
5. Inspect distance, age, satellite, confidence, FRP, weather, wind alignment, humidity, and air-quality evidence.
6. Read a transparent 0-100 context score with explicit reasons and a limited-data label when inputs are missing.
7. View deduplicated alerts and replay raw detections on a 24-hour timeline.
8. Ask Gemma a natural-language question and observe native tool calls followed by a source-grounded briefing.
9. Distinguish satellite heat anomalies from confirmed wildfire incidents and see persistent safety limitations.

## Scope

### Required prototype capabilities

- Local React product interface with map, asset rail, activity inspector, alert feed, timeline, and agent panel.
- Local server that protects API keys and talks to Ollama.
- SQLite local storage for saved assets, detections, clusters, observations, alerts, and agent runs.
- NASA FIRMS Area API adapter for `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT`, and `VIIRS_NOAA21_NRT`.
- US Census single-line geocoding plus direct coordinate entry for rural parcels without reliable street addresses.
- NWS point and grid or hourly forecast adapter for wind speed, wind direction, and humidity.
- AirNow current-observation adapter when a key is configured, with a visible unavailable state otherwise.
- WFIGS current incident and perimeter adapter for optional official context.
- Spatial and temporal clustering, deterministic scoring, alert deduplication, and source freshness tracking.
- Ollama chat loop using Gemma 4 native tool calls.
- Honest fixture-backed demo mode that is clearly labeled and never presented as live data.
- Automated tests for parsing, geometry, clustering, scoring, alerts, API states, and the tool loop.

### Deferred capabilities

- SMS, email, push notifications, and unattended background delivery.
- Multi-user accounts, cloud sync, public hosting, or mobile packaging.
- Nationwide ingestion, perimeter history, evacuation zones, and guaranteed monitoring.
- Acreage estimation from FIRMS points or predictions of fire movement.
- Automated emergency actions or agricultural instructions that could affect life or property.

## User model

The primary user is an individual grower or ranch operator monitoring one to ten assets. Each asset has a name, category, address or coordinates, alert radius, and optional notes. Agriculture categories include field, orchard, barn, livestock, workforce, storage, and other.

The console optimizes for a rapid morning or incident briefing rather than continuous dispatch operations.

## Experience design

### Design read

Reading this as a greenfield local agriculture operations console for growers, ranchers, and hackathon judges, with a trust-first field-instrument language and accessible product components.

- Design variance: 5. The map leads, with an offset asset rail and focused inspector rather than a generic equal-card dashboard.
- Motion intensity: 3. Motion communicates loading, timeline playback, alert arrival, and panel state only.
- Visual density: 7. Operational evidence is compact, but hierarchy and whitespace keep it readable.
- Foundation: one customized accessible React component system, Phosphor icons, native CSS tokens, and a proven map library.
- Theme: one charcoal and mineral-green dark theme for the prototype, with high-contrast amber reserved for thermal activity and alerts.
- Shape rule: 12px panels, 8px controls, and pill shapes only for compact status labels.

The installed Taste Skill explicitly excludes dense dashboards, so its anti-generic rules, typography, color, interaction states, copy audit, accessibility checks, and preflight checklist apply. Product interaction patterns come from the chosen accessible component foundation.

### Main screen

The first viewport is the actual console, not a marketing hero.

- Top bar: EmberField identity, connection health, last refresh, refresh action, and safety information.
- Left rail: saved agriculture assets, each showing category, radius, context score, trend, and data completeness.
- Center: interactive map with asset radius, raw FIRMS points, clustered activity, wind direction, WFIGS incidents, and perimeters.
- Right inspector: selected cluster details, official match, score breakdown, source timestamps, and a concise agricultural exposure note.
- Bottom dock: 24-hour timeline with play, pause, time scrubber, source toggles, and activity frequency.
- Agent drawer: conversation plus a visible trace of tool calls, source freshness, and the deterministic evidence supplied to Gemma.

On narrow screens the layout becomes a single map followed by tabbed Assets, Activity, Timeline, and Agent panels. All interactions remain keyboard accessible. Loading, empty, error, stale, missing-key, fixture, and live states are distinct.

## System architecture

```text
React console
  -> local HTTP API
      -> asset and observation store
      -> deterministic domain engine
      -> cached source adapters
          -> NASA FIRMS
          -> Census Geocoder
          -> NWS
          -> AirNow
          -> WFIGS ArcGIS
      -> Gemma agent loop
          -> Ollama gemma4:12b
          -> allowlisted local tools
```

The browser never receives secrets. Source adapters normalize data into UTC-first domain records and always return provenance, fetched time, observed time, live or fixture mode, and error state. Upstream calls use timeouts, bounded retries, and source-specific caching.

## Domain model

- `Asset`: name, category, coordinates, normalized address, radius, notes, timestamps.
- `Detection`: stable fingerprint, source feed, satellite or instrument, coordinates, acquisition time, confidence, FRP, day or night, raw source fields, fetched time.
- `ActivityCluster`: deterministic ID, centroid, first and latest detection times, detection count, satellite set, max confidence, max FRP, member IDs.
- `WeatherObservation`: coordinates, valid time, wind speed, wind-from bearing, humidity, source URL, fetched time.
- `AirObservation`: reporting coordinates or area, observation time, parameter, AQI, category, source URL, fetched time.
- `OfficialIncident`: WFIGS ID, name, type, coordinates or perimeter, acres, containment, update time.
- `Assessment`: asset and cluster IDs, score, band, reasons, missing inputs, completeness, calculated time.
- `Alert`: dedupe key, type, first and latest trigger time, score change, reason, acknowledgement.
- `AgentRun`: prompt, tool calls, tool results, final answer, model, duration, time.

## Data flow

1. The user saves an asset by US address or coordinates.
2. The server geocodes when necessary and builds a bounding box from the alert radius plus a small margin.
3. FIRMS adapters request one day of data from the three VIIRS feeds and normalize CSV records.
4. The domain engine calculates exact Haversine distance, fingerprints rows, and clusters detections that are within the configured spatial and temporal thresholds.
5. Nearby cluster coordinates feed NWS weather lookup. Asset coordinates feed AirNow. The current viewport or asset area feeds WFIGS.
6. Normalized observations are matched by UTC time and distance, then assessed by deterministic code.
7. The alert engine compares the assessment with prior state and emits a deduplicated alert for a new nearby cluster, a new satellite, or a meaningful score increase.
8. The UI renders the current snapshot and 24-hour timeline.
9. When the user asks Gemma for a briefing, the model calls allowlisted tools. The server executes tools, returns structured evidence to the model, and stores the trace.

## Clustering and scoring contract

Detections are clustered when they are within roughly 1.5 kilometers and 6 hours, using a deterministic connected-components pass. These thresholds are configurable and visible in developer documentation. A cluster is a group of detected activity, not a fire perimeter or confirmed incident.

The 0-100 context score is additive and capped. Distance and age carry most of the weight. Confidence, FRP, repeated detections, multiple satellites, downwind alignment, wind speed, low humidity, and PM2.5 or AQI can add context. Every contribution is returned as structured reasons.

Missing weather or air quality contributes no points and reduces data completeness. The UI must say `Limited data` rather than implying a zero reading. Score labels are `Low context`, `Watch`, `Elevated context`, and `High context`; no label uses `safe`, `danger`, `will spread`, or `evacuate`.

## Gemma agent contract

Gemma is the primary conversational intelligence and tool orchestrator. The first tool set is intentionally small and auditable:

- `list_assets`
- `inspect_asset`
- `refresh_asset_data`
- `get_activity_groups`
- `get_weather_context`
- `get_air_quality`
- `get_official_incidents`
- `get_timeline`
- `explain_assessment`

The server, not the model, validates tool arguments, enforces coordinate and radius limits, fetches external data, calculates scores, and creates source citations. Gemma may summarize evidence, compare assets, surface missing data, and propose low-risk preparation questions. It may not invent observations, claim confirmation, issue evacuation advice, or alter scores.

The tool trace is visible in the interface so judges can see meaningful native function calling rather than a hidden chat completion.

## Alerts

The prototype generates in-console alerts when:

- a new cluster first appears inside an asset radius;
- a new satellite joins an existing cluster;
- a cluster receives additional detections after a quiet interval;
- an assessment increases by at least a configured threshold;
- an official incident becomes associated with a cluster.

Repeated triggers share a deterministic dedupe key based on asset, cluster, and trigger family. The visible alert includes acquisition time, distance, confidence, source, and trigger reason.

## Failure handling

- Missing FIRMS key: preserve the configured asset, show setup guidance, and offer an explicitly labeled fixture demonstration.
- Missing AirNow key: continue without air quality and mark assessments limited.
- Ollama unavailable: preserve deterministic monitoring and show the agent as offline.
- Individual upstream failure: use still-valid cached data when available, mark it stale, and never substitute fixtures inside live mode.
- Invalid or unexpectedly large responses: reject them with a source-specific error and keep the prior snapshot.
- Empty detections: render a valid empty state that says no recent satellite detections were returned, not that no fire exists.

## Safety and privacy

Persistent copy: `Informational planning view only. Not for evacuation, dispatch, firefighting, or protection-of-life or property decisions. Data may be delayed, incomplete, or inaccurate. Follow local emergency officials and NWS alerts.`

The interface also states that FIRMS points are satellite-detected heat anomalies, pixels are approximately 375 meters for VIIRS, points do not measure burning acreage, and AirNow readings are preliminary.

Addresses and API keys remain local. Keys stay in environment files excluded from version control. Logs avoid full addresses and redact secret-bearing URLs.

## Test and verification strategy

- Unit tests: Haversine and bearing math, bbox creation, CSV parsing, time parsing, confidence normalization, clustering, wind alignment, score contributions, missing-data completeness, and alert dedupe.
- Contract tests: recorded minimal source fixtures for FIRMS, Census, NWS, AirNow, and WFIGS.
- Agent tests: mocked Ollama tool-call loop, invalid arguments, multiple tool rounds, offline state, and final cited response.
- UI tests: critical rendering states, asset creation, map selection, timeline playback, and agent trace.
- Runtime checks: real Ollama model handshake, live public-source probes, build, typecheck, and browser smoke test.
- Final self-review: two independent code-review passes, safety-copy audit, Taste Skill preflight for applicable UI rules, and requirement-by-requirement completion audit.

## Implementation sequence

1. Scaffold and runtime health.
2. Domain engine and tests.
3. Source adapters and persistence.
4. Gemma tool loop and trace.
5. Console UI and map.
6. Timeline, alerts, states, and fixtures.
7. Live probes, browser verification, documentation, and pitch material.

## Credential reality

`FIRMS_MAP_KEY` and `AIRNOW_API_KEY` are not present in the current environment. The build will include `.env.example`, a local setup screen, and an honest fixture demo. Live FIRMS is implemented and becomes active as soon as the free key is placed in the local environment. WFIGS, NWS, and Census can be exercised without user API keys, subject to their service requirements.
