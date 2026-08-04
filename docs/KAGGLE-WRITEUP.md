# EmberField

Build with Gemma, TFUG Prayagraj — GenAI for Good, agriculture.
Model: `gemma4:12b`, running locally through Ollama on loopback.

## The problem

Every air-quality product is a sensor. It tells a farm operator the air is bad
once it already is, and by then the crew has been outside for hours.

Smoke has a source that satellites already detect, a direction and a speed that
wind data already gives, and therefore an arrival time. Those three facts exist
in NASA FIRMS, the National Weather Service, AirNow, and WFIGS, on different
clocks and in different formats. Nobody puts them in front of the person
deciding whether to send a crew into an orchard this afternoon.

## What it does

EmberField is a local-first console organised around saved agricultural assets —
orchards, barns, livestock areas, storage, crew locations — each with its own
monitoring radius. For every asset it groups recent VIIRS heat detections into
activity clusters, attaches wind, humidity, AQI, and official incident context,
computes an explainable context score that names its missing inputs instead of
scoring them zero, and estimates when smoke from each group reaches the asset.

The map draws the estimate rather than only asserting it: a corridor wedge
opening 50 degrees either side of the transport bearing, with hourly isochrone
arcs placed by inverting the calibrated transit rather than re-deriving it, so
nothing is drawn until the 1.4 hour correction has elapsed and the map cannot
contradict the arrival time beside it. Arcs beyond the corridor range are
omitted rather than clamped, so the map never implies more reach than the
method has.

**The line we do not cross.** EmberField does not predict fire spread. Fire
spread is hard and being wrong about it is dangerous. Smoke advection from an
already-detected source is a different and far more tractable problem, and
naming that distinction is the difference between a defensible tool and a
liability. Confidence is capped at `moderate` permanently, and every estimate
states in its own words that it is not a fire-spread prediction.

## How Gemma 4 is used

Gemma is the operator interface, not a caption generator. "Brief me on the
orchard and explain what changed" has no hard-coded answer, so the model decides
what evidence to gather.

**Native function calling.** The agent posts to Ollama's `/api/chat` with
`tools`, `stream: false`, `think: false`, `num_predict: 256`, `temperature: 0.1`
and reads `message.tool_calls` directly. No LangChain, no JSON-in-prose parsing.

**Twelve allowlisted, schema-validated tools:** `list_assets`, `triage_assets`,
`inspect_asset`, `refresh_asset_data`, `get_activity_groups`,
`get_weather_context`, `get_air_quality`, `get_official_incidents`,
`get_smoke_arrival`, `get_timeline`, `explain_assessment`, `geocode_location`. Every call is validated against a Zod
schema before execution; unknown names and bad arguments come back to the model
as structured tool errors instead of throwing.

**Bounded loop.** Six rounds maximum, twelve calls per round, eighteen tool calls
total, one live refresh, and a single 90-second deadline covering model time and
tool time together. Exhausting any bound produces a labelled fallback rather than
a partial briefing.

**Grounding validator.** Each successful call returns a server-issued
`evidenceRef`; the system prompt requires every assertion to cite one as
`[evidence:REF]`. Before an answer is returned, each sentence is checked
independently: numbers must match a value in the cited tool result *and* sit
near that value's own field label, source states (`live`, `fixture`, `ok`,
`partial`, `error`, `missing-key`) must match a real state on the named source,
and non-framing vocabulary must appear in the evidence. Sentences asserting
safety, danger, evacuation, or a fire reaching somewhere are rejected outright.
"Confirmed wildfire" is only permitted when a WFIGS incident of that name was
actually returned.

**Local.** The Ollama URL is parsed and rejected unless it is plain HTTP on
`localhost`, `127.0.0.1`, or `[::1]`, with no credentials, query, or fragment.
Prompts, asset notes, and synthesis never leave the machine. Live evidence calls
still send the coordinates the public source needs; we say so rather than
claiming everything is local.

**Visible.** The trace panel shows tool name, validated arguments, duration,
per-source status, and a bounded result summary for every call, including failed
ones. Credential-bearing URLs are stripped before anything reaches the browser.

## The claim we can actually prove

`npm run replay` reconstructs 8 November 2018 with no keys, no Ollama, and no
network. Thirty minutes after the Camp Fire started, the air at a farm 103.6 km
downwind reads AQI 18 — clean. The console already places smoke arrival at
19:10:43 UTC: **4.2 hours of warning**. The EPA monitor at those exact
coordinates recorded arrival 6.5 hours after ignition; the estimate was 4.7
hours. **1.8 hours early** — the safe direction.

Across fourteen California monitors from 104 km to 262 km, using NASA POWER 50 m
wind and EPA AirData hourly PM2.5 as ground truth (first hour above three times
each monitor's own pre-fire median):

```
raw advection      median +1.4h   mean |error| 2.3h
after correction   median +0.0h   mean |error| 1.6h
```

No monitor was warned more than 2.2 hours late. Two of the fourteen are badly
wrong: 9.8 hours and 3.8 hours early, both attributable to coastal-range terrain
channelling. Both are kept in `tests/smoke.test.ts` with their errors named in
comments. A validation fixture that drops its failures is not a validation, and
those two are the reason this is not a warning system.

## Architecture

```
Browser console
  -> same-origin API routes
     -> FIRMS, NWS, AirNow, Census, WFIGS adapters (UTC timestamps retained)
     -> deterministic clustering, scoring, smoke advection, alert rules
     -> bounded local D1 snapshot history
     -> Ollama on 127.0.0.1 -> gemma4:12b -> allowlisted evidence tools
```

The split is the point. Deterministic code owns every measurement: distance,
bearing, clustering, transit time, score contributions, alert deduplication.
Gemma owns tool selection and synthesis. The score stays inspectable while the
briefing stays adaptive, and neither can quietly become the other. Twenty test
files cover source parsing, geometry, clustering, scoring, persistence, routes,
UI states, the agent loop, and the grounding validator.

## Challenges in the sprint

**The validator kept rejecting true sentences.** Grounding a number required its
field label nearby, but the label was the raw camelCase key. Gemma writing
"arrives in 4.2 hours" could not match `hoursUntilArrival`, so briefings kept
falling back. The fix was an alias table mapping fields to natural phrasings,
plus a system-prompt instruction to name the quantity in the same sentence as
the number.

**Timestamps were ungroundable.** The numeric scanner's lookbehind rejected the
hour in `T19`, and fractional seconds parsed as `42.523`. A briefing quoting a
time from a tool result failed against that same result. Fixed by indexing ISO
timestamp components additively.

**Cold-start latency.** The final warm run completed in about 26.2 seconds
against the run budget. A cold or queued model did hit the timeout, so the
demo checklist includes warming the model first.

**Calibration honesty.** The obvious move after seeing a 9.8-hour miss is to
drop the monitor. Keeping it forced the range cap, the confidence ceiling, and
the corridor gate, which are now the reason the estimate is defensible.

## Build timeline

The repository is larger than a one-day build looks, and the history says why:
48 commits between 2026-08-03 20:48 and 2026-08-04 13:29, roughly 16,000 lines
of TypeScript, written in one continuous session with heavy AI coding-assistant
support and a deliberately narrow scope. Nothing was carried in from an earlier
project. The commit log is the receipt and is worth reading.

## Honest limitations

- Self-scored 80/100 in `docs/SELF-EVALUATION.md` (Gemma 23/30, Innovation
  25/30, Functionality 16/20, Presentation 16/20).
- Grounding depends on the model reusing the evidence's vocabulary. Briefings
  were being rejected for ordinary synonyms — "detection group" cannot be
  checked when the payload holds `detectionCount` and no word for "group". The
  fix was to make each evidence tool emit a plain-language summary, so the
  vocabulary and the numbers arrive together. Grounded briefings went from none
  observed to roughly a third of runs, but the rate is unstable: whether a 12B
  model quotes the supplied phrasing or paraphrases it is not something the
  system controls. Tool selection is correct on every run; the prose is not.
  The deterministic panels stay authoritative, which is why the demo leads with
  the offline replay.
- One well-observed event is not a validated model. The +1.4h correction is a
  single measured median, not a fit.
- Straight-line advection ignores terrain, mixing height, and diurnal wind shift.
  The two failing monitors are exactly that gap.
- Monitoring runs only when the console is loaded or refreshed. No background
  scheduler, no SMS or push delivery, no mobile app, no hosted URL.
- No field study with growers, extension services, or emergency managers.
- FIRMS VIIRS is global, and the advection arithmetic is source-agnostic, but the
  weather, air-quality, incident, and geocoding adapters are United States only.
  Applying this to stubble-burning smoke over the Indo-Gangetic plain would need
  IMD and CPCB adapters, and re-validation against Indian monitors. We have not
  done that work and will not claim it transfers untested.

EmberField is informational context. It is not an evacuation tool, a dispatch
system, or an emergency-warning service. Follow local officials.

<!-- word count:     1493 -->
