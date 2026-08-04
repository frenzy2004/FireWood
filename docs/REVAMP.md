# FireWood Revamp

## Objective

Make EmberField's core hackathon story demonstrably real: live upstream evidence, a useful interactive map, replay controls that visibly change the evidence, and a local Gemma 4 agent that performs native function calls within an interactive time budget. Fixture data remains a clearly labelled historical replay; it must never be presented as live evidence.

## Verified baseline failures

- A live snapshot can contain official WFIGS incidents and perimeters while FIRMS returns zero recent detections. The interface collapses this into an apparently empty view and provides no usable incident exploration.
- NWS is requested only for detection-group centroids. When FIRMS returns no groups, the asset itself receives no weather context.
- The 24-hour replay advances by half an hour every 900 milliseconds. The Camp Fire fixture's first event is near the end of that window, so playback shows an empty map for roughly forty seconds.
- A local Gemma request completed successfully but took 78.6 seconds. The request exposed all twelve tools and used unnecessary discovery/tool-selection rounds for a simple starter question.
- The map renders data but exposes little interaction: official incidents are not selectable, raw detections do not reveal evidence, and navigation, layer, legend, and reset affordances are missing.

## Architecture

### Independent live context

The snapshot service will fetch asset-level NWS weather in parallel with FIRMS, AirNow, and WFIGS. Cluster-level weather remains available for smoke transport, but a valid empty FIRMS result no longer suppresses environmental context. The snapshot contract will distinguish:

- a source request that succeeded with no observations;
- a source request that was not configured;
- a source request that failed;
- observations that exist independently of satellite detections.

The interface will always surface source status and nearby official incidents. An empty FIRMS result is a valid evidence result, not a blank application state.

### Operational map

MapLibre remains the rendering engine and OpenStreetMap remains the basemap. The map will add:

- native navigation and scale controls plus an explicit reset-to-asset action;
- independently toggleable FIRMS detections, WFIGS incidents/perimeters, asset radius, and smoke transport layers;
- a compact legend with observation counts and source state;
- selectable raw detections, detection groups, and official incidents;
- a single evidence popover showing timestamps, source identity, confidence, containment, area, and distance where available;
- an explicit live-empty panel that still reports AirNow, NWS, and WFIGS results.

Map selections use a discriminated selection contract, so details do not depend on a detection group existing.

### Event-driven replay

The timeline retains exact evidence timestamps and a 24-hour scrubber. Playback will step through the ordered unique event times rather than sweeping long empty intervals at a constant wall-clock rate. Starting playback at `Now` restarts immediately before the first available event. Each step updates the map, source states, inspector, cursor label, and selected evidence. Source toggles continue to filter the replay without changing the underlying snapshot.

When a snapshot has no temporal events, replay is disabled with an explicit explanation rather than a control that appears broken.

### Responsive local Gemma

Gemma 4 12B remains the only language model and continues using Ollama native function calling. The server will select the smallest allowlisted tool set that can answer an intent:

- smoke arrival starter: smoke-arrival and activity evidence;
- portfolio starter: portfolio triage;
- missing-evidence starter: asset/source inspection;
- free-form questions: the broader allowlist.

The active asset is stated directly in the system context, eliminating unnecessary `list_assets` discovery for single-asset questions. The model stays warm between calls, tool results reuse the request-local snapshot, and interactive starter paths use a bounded round budget. The response will expose real round/tool progress through a streaming event protocol; the client will never invent completed tool calls. JSON remains available as a compatibility fallback for existing tests and non-streaming callers.

### Failure handling

- Upstream failures remain isolated per source and are visible by source name.
- Valid empty results remain distinguishable from transport or credential failures.
- Map tile failure leaves the evidence summary usable.
- Replay never synthesizes observations between real timestamps.
- Gemma timeout or grounding failure preserves deterministic evidence and the completed tool trace.
- API credentials remain only in ignored local runtime configuration and server-side requests.

## Verification

Every behavior change starts with a failing test that names the user-visible break. Completion requires:

1. Snapshot tests proving asset-level NWS context survives zero FIRMS detections.
2. UI tests proving independent incidents and source states remain explorable without groups.
3. Map tests for layer toggles, reset controls, and selection detail contracts.
4. Timeline tests proving playback reaches the next real event promptly and disables itself when no events exist.
5. Agent tests proving starter intents receive only relevant native tools and avoid asset-discovery rounds.
6. Full unit tests, lint, and production build.
7. Browser verification of fixture replay, live source evidence, map selection, and a real local Gemma tool call.

## Checkpoint strategy

Work is committed on `revamp` after each independently green subsystem: design, live evidence, map, replay, Gemma, and final integration verification. No API key, local database, build output, or runtime log is committed.
