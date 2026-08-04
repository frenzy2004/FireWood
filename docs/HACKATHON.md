# EmberField: GenAI for Good submission

## One-line pitch

EmberField gives farmers and rural operators a local-inference, evidence-grounded early-context console for satellite heat activity near the places and people they care for.

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

## The claim we can actually prove

Every air-quality product is a sensor: it tells you the air is bad once it
already is. By then the crew has been outside for hours.

Smoke has a source that VIIRS detects, a direction and a speed that wind data
gives, and therefore an arrival time. EmberField estimates it, and the estimate
is checkable against an event that already happened.

`npm run replay` reconstructs 8 November 2018 with no keys, no Ollama and no
network. Thirty minutes after the Camp Fire started, the air at a farm 104 km
downwind reads AQI 18 — clean. The console already places smoke arrival at
19:10 UTC: **4.2 hours of warning**.

The EPA monitor at those exact coordinates recorded arrival 6.5 hours after
ignition. The estimate was 4.7 hours. **1.8 hours early** — the safe direction.

Across 14 California monitors from 104 km to 262 km, using NASA POWER 50 m wind
and EPA AirData PM2.5 as ground truth:

```
raw advection      median +1.4h   mean |error| 2.3h
after correction   median +0.0h   mean |error| 1.6h
```

No monitor was warned more than 2.2 hours late. Two of the fourteen are badly
wrong, both early, both terrain channelling — and both are kept in the test
suite. A validation fixture that drops its failures is not a validation.

The console draws it as well as states it: a corridor wedge opening the validated
50 degrees either side of the transport bearing, with hourly isochrone arcs marking
where the leading edge should be after each hour. Distance is wind speed times
elapsed time — the same arithmetic the estimator performs, drawn rather than
asserted. Arcs beyond the corridor range are omitted rather than clamped, so the
map never implies more reach than the method has.

**The line we do not cross.** We will not predict where a fire goes. Fire spread
is genuinely hard and getting it wrong is dangerous. Smoke advection from an
already-detected source is a different and far more tractable problem, and
naming that distinction is the difference between a defensible tool and a
liability. Confidence is capped at `moderate` permanently, and every estimate
says in its own words that it is not a fire-spread prediction.

## Why Gemma is core, not decorative

Gemma 4 12B is the primary intelligence in the operator workflow. A prompt such as "Brief me on the orchard and explain what changed" does not map to a hard-coded answer. Gemma uses native function calling to choose among allowlisted tools for farm assets, detection groups, weather, air quality, official incidents, the 24-hour timeline, and score explanations. It can gather more evidence over several rounds before synthesizing its response.

Every call is schema-validated. The trace shows the tool, safe arguments, duration, source status, and a bounded result summary. This makes the agent inspectable during judging and useful when sources disagree or data is incomplete. The model and Ollama runtime stay on loopback, so prompts and asset notes do not go to a hosted model. Live evidence and map requests still send required coordinates, bounding areas, or addresses to the selected public service.

## Judging criteria

### Gemma Integration, 30%

- Actual local `gemma4:12b`, not a mock or hosted proxy.
- Ollama native `message.tool_calls` with multi-round tool continuation.
- Eleven domain-specific, schema-validated functions, including a Camp-Fire-validated smoke-arrival estimate.
- Source-grounding system prompt and a visible, redacted execution trace.
- Graceful offline, invalid-call, timeout, and round-limit behavior.

### Innovation and Impact, 30%

- Reframes wildfire data around agriculture assets: fields, orchards, barns, livestock, crews, and storage.
- Unifies five public evidence systems without presenting an unofficial prediction as authority.
- Makes uncertainty visible through score ranges, completeness gates, freshness, and missing-input language.
- Keeps prompts, model inference, and asset notes off hosted AI services while disclosing the geography sent to live public sources.
- Gives rural users a coherent starting point while repeatedly directing safety decisions to officials.

### Functionality, 20%

- Live and deterministic fixture modes.
- Interactive map with raw detections, grouped activity, radius, incidents, and perimeters.
- Address geocoding, direct coordinates, saved assets, and bounded local D1 snapshot history.
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
3. Ask Gemma to inspect the orchard, explain its current deterministic score, and summarize 24-hour detected activity; then expand the native function-call trace.
4. Replay the 24-hour timeline and point out the careful phrase `change in detected activity`.
5. End on local privacy and the persistent emergency-use disclaimer.

## Next steps

- Background polling and native desktop notifications.
- Per-asset agronomic response checklists without automating emergency decisions.
- AirNow hourly monitor ingestion for PM2.5 concentration, distance, and observation-time matching.
- Improved FIRMS-to-WFIGS perimeter matching and prescribed-fire classification.
- Field testing with growers, extension services, and rural emergency managers.
