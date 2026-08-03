# EmberField: GenAI for Good submission

## One-line pitch

EmberField gives farmers and rural operators a private, evidence-grounded early-context console for satellite heat activity near the places and people they care for.

## The problem

Wildfire information is fragmented across satellite feeds, weather grids, air-quality reports, and incident systems. A farm operator may need to understand whether a new heat detection is close to an orchard, whether a livestock site is roughly downwind, whether air quality has worsened, and whether officials have named the event. Raw feeds make that comparison slow, while generic chatbots can invent certainty in a safety-sensitive setting.

Agriculture also has a distinct operational geography. A home, an orchard, a hay barn, a crew location, and livestock pasture can require different monitoring radii and different follow-up actions. EmberField treats those as saved farm assets rather than a single anonymous map pin.

## The solution

EmberField is a local-first agriculture intelligence console. It groups recent NASA VIIRS heat detections near each saved asset, adds weather, air quality, and official incident context, and computes a transparent context score. A local Gemma 4 12B agent chooses the evidence tools it needs, then writes an operator briefing with a visible function-call trace.

The app deliberately separates facts from interpretation:

- Source adapters retain acquisition and update timestamps in UTC.
- Deterministic code calculates distance, direction, grouping, score contributions, and alert deduplication.
- Gemma decides what evidence to inspect and explains it in plain language.
- The UI names missing inputs and source failures instead of silently assigning zero.
- Safety language avoids confirmed-fire, spread-prediction, and evacuation claims.

## Why Gemma is core, not decorative

Gemma 4 12B is the primary intelligence in the operator workflow. A prompt such as "Brief me on the orchard and explain what changed" does not map to a hard-coded answer. Gemma uses native function calling to choose among allowlisted tools for farm assets, detection groups, weather, air quality, official incidents, the 24-hour timeline, and score explanations. It can gather more evidence over several rounds before synthesizing its response.

Every call is schema-validated. The trace shows the tool, safe arguments, duration, source status, and a bounded result summary. This makes the agent inspectable during judging and useful when sources disagree or data is incomplete. The model and Ollama runtime stay on loopback, so farm coordinates, prompts, and notes do not go to a hosted model.

## Judging criteria

### Gemma Integration, 30%

- Actual local `gemma4:12b`, not a mock or hosted proxy.
- Ollama native `message.tool_calls` with multi-round tool continuation.
- Nine domain-specific, schema-validated functions.
- Source-grounding system prompt and a visible, redacted execution trace.
- Graceful offline, invalid-call, timeout, and round-limit behavior.

### Innovation and Impact, 30%

- Reframes wildfire data around agriculture assets: fields, orchards, barns, livestock, crews, and storage.
- Unifies five public evidence systems without presenting an unofficial prediction as authority.
- Makes uncertainty visible through score ranges, completeness gates, freshness, and missing-input language.
- Preserves local privacy for sensitive agricultural locations and operator notes.
- Gives rural users a coherent starting point while repeatedly directing safety decisions to officials.

### Functionality, 20%

- Live and deterministic fixture modes.
- Interactive map with raw detections, grouped activity, radius, incidents, and perimeters.
- Address geocoding, direct coordinates, saved assets, and local D1 history.
- Weather/downwind, humidity, AQI, WFIGS matching, explainable scoring, and deduplicated alert rules.
- Replayable 24-hour detected-activity timeline.
- Tested API boundaries, source parsing, geometry, clustering, scoring, persistence, UI states, and Gemma loop.

### Presentation and Writeup, 20%

- The first screen is the working console with a fixture story that judges can replay reliably.
- Live and fixture evidence are labeled at every source boundary.
- Exact UTC timestamps and an expandable function trace make the demo auditable.
- The visual system reserves amber for heat evidence and alerts, keeping attention on the operational story.
- A three-minute script demonstrates the problem, evidence flow, Gemma autonomy, and safety stance.

## Architecture

```text
Agriculture asset
  -> live public-source adapters
     -> VIIRS detections -> temporal-spatial clusters
     -> NWS wind and humidity
     -> AirNow AQI
     -> WFIGS incidents and perimeters
  -> deterministic context score and alert rules
  -> D1 history and 24-hour timeline
  -> Gemma 4 12B local agent
     -> selects allowlisted functions
     -> synthesizes a source-grounded briefing
     -> exposes its tool trace
```

## Responsible-AI position

EmberField never claims that a FIRMS anomaly is a confirmed wildfire. It never turns detection count into acres, calls activity change confirmed spread, predicts arrival, or recommends evacuation. Missing data lowers confidence. The product is an informational triage surface that helps an operator decide what official information to check next.

## What to emphasize live

1. Switch between fixture and live source status without changing the meaning of the labels.
2. Select an activity group and show distance, age, satellite passes, wind relation, humidity, AQI, official match, and score reasons.
3. Ask Gemma for an orchard briefing and expand the native function-call trace.
4. Replay the 24-hour timeline and point out the careful phrase `change in detected activity`.
5. End on local privacy and the persistent emergency-use disclaimer.

## Next steps

- Background polling and native desktop notifications.
- Per-asset agronomic response checklists without automating emergency decisions.
- AirNow hourly monitor ingestion for PM2.5 concentration, distance, and observation-time matching.
- Improved FIRMS-to-WFIGS perimeter matching and prescribed-fire classification.
- Field testing with growers, extension services, and rural emergency managers.
