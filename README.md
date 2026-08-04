# EmberField

EmberField is a local-first agriculture operations console for monitoring satellite-detected heat activity near farms, orchards, livestock areas, barns, storage sites, and field crews. It combines live NASA FIRMS VIIRS detections with National Weather Service conditions, AirNow air quality, WFIGS official wildfire context, and a locally running Gemma 4 12B agent.

Gemma chooses from an allowlisted set of evidence tools, explains current conditions and detected activity, names missing data, and leaves a visible function-call trace. Gemma prompts, inference, and asset notes stay off hosted AI services. Live public-source and map requests still send the geographic information those services need.

> EmberField is informational context, not an evacuation tool or emergency-warning system. A FIRMS point is a satellite-detected heat anomaly, not a confirmed wildfire or its perimeter. Follow local officials and emergency services for safety decisions.

## What the prototype does

- Saves agriculture assets with a configurable monitoring radius.
- Geocodes US addresses or accepts direct coordinates.
- Pulls recent near-real-time VIIRS detections from Suomi NPP, NOAA-20, and NOAA-21.
- Groups nearby detections into activity clusters while retaining every raw observation.
- Adds wind, humidity, AQI, and nearby official incident context.
- Computes an explainable context score with explicit missing-data gating.
- Estimates when smoke from each detection group reaches the asset, validated against the 2018 Camp Fire.
- Shows raw points, grouped activity, official perimeters, source freshness, and a 24-hour timeline.
- Produces deduplicated in-console alerts during load or refresh for new groups, new satellite confirmation, resumed activity, material score changes, and official matches.
- Runs Gemma 4 12B locally through Ollama native function calling.

## Run the Camp Fire replay

No API keys, no Ollama, no network:

```bash
npm install
npm run replay
```

This reconstructs 8 November 2018 and shows the console as it would have looked
30 minutes after the Camp Fire started. The air at a farm 104 km downwind is
still clean; the smoke-advection estimate already places arrival at 19:10 UTC,
**4.2 hours of warning**.

The EPA monitor at those exact coordinates recorded arrival 6.5 hours after
ignition. The estimate was 4.7 hours — **1.8 hours early**, which is the safe
direction to be wrong.

### How the estimate is validated

Straight-line advection from the detection centroid using measured wind, gated
on whether the asset sits inside the plume corridor. Wind comes from NASA POWER
(keyless, 50 m, hourly). Ground truth comes from EPA AirData hourly PM2.5, taken
as the first hour each monitor exceeded three times its own pre-fire median.

Across 14 California monitors between 104 km and 262 km:

```
raw advection      median +1.4h   mean |error| 2.3h
after correction   median +0.0h   mean |error| 1.6h
```

No monitor was warned more than 2.2 hours late. Two of the fourteen are badly
wrong regardless — both early, both attributable to coastal-range terrain
channelling. All fourteen, including the failures, are kept in
`tests/smoke.test.ts`. A validation fixture that drops its failures is not a
validation.

Confidence is capped at `moderate` permanently, and every estimate states that
it is not a fire-spread prediction. EmberField does not predict where a fire
goes; it estimates where the smoke from an already-detected fire is heading.

## Prerequisites

- macOS or Linux with Node.js 22.13 or newer
- Ollama 0.32 or newer
- The local model: `ollama pull gemma4:12b`
- A free [NASA FIRMS MAP_KEY](https://firms.modaps.eosdis.nasa.gov/api/map_key/)
- An optional [AirNow API key](https://docs.airnowapi.org/)

The Census geocoder, NWS, WFIGS, and OpenStreetMap basemap do not require application keys. Fixture evidence works without external credentials, but map tiles still require network access.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` locally:

```dotenv
FIRMS_MAP_KEY=your_firms_key
AIRNOW_API_KEY=your_airnow_key
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

The file is ignored by Git. Never put credentials in browser code, source URLs, screenshots, or commits.

Build once and apply the versioned local D1 migrations:

```bash
npm run build
npm run db:local
```

Start Ollama and EmberField in separate terminals:

```bash
ollama serve
```

```bash
npm run dev
```

Open the local URL printed by Vinext. EmberField loads the Antelope Creek Ranch fixture story first. Switch the source control to Live to request current observations.

## Commands

```bash
npm run replay       # Camp Fire replay — offline, no keys, no model
npm run dev          # local Vinext and Cloudflare development server
npm run db:local     # apply versioned migrations to local D1 state
npm run test:unit    # unit, route, agent, and UI tests
npm run lint         # ESLint checks
npm run build        # production Vinext build
```

## Local architecture

```text
Browser console
  -> same-origin API routes
     -> NASA FIRMS, NWS, AirNow, Census, WFIGS
     -> deterministic clustering, scoring, and alert rules
     -> bounded local Cloudflare D1 snapshot history
     -> Ollama on 127.0.0.1
        -> Gemma 4 12B native function calls
        -> allowlisted EmberField evidence tools
```

The deterministic context engine owns measurements and scoring. Gemma owns tool selection and evidence-grounded synthesis. This keeps the score inspectable while making the operational briefing adaptive and conversational.

## Live and fixture behavior

- **Fixture** is a deterministic virtual agriculture scenario with NASA-like detections, weather, AQI, and an official perimeter. It is clearly labeled, never persisted, and its evidence works without credentials; the basemap still needs network access.
- **Live** calls the configured sources. Each source reports mode, status, fetched time, and observation time independently.
- Saved non-demo assets are live-only. Successful refreshes persist bounded 24-hour run summaries, FIRMS detections, and enriched alert evidence to local D1.
- Monitoring and alerts run only while the operator actively loads or refreshes the console. There is no background scheduler or outbound notification delivery.
- Missing or failed weather and air-quality inputs reduce data confidence and produce `Limited data`. They are never treated as zero.
- A valid empty FIRMS response means no detections were returned for that request. It does not prove there is no fire.
- The agent receives bounded, redacted tool results. FIRMS and AirNow credential-bearing URLs are never returned to the browser or persisted.

## Data sources

- [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/)
- [VIIRS active-fire attributes](https://www.earthdata.nasa.gov/data/tools/firms/active-fire-data-attributes-modis-viirs)
- [National Weather Service API](https://www.weather.gov/documentation/services-web-api)
- [EPA AirNow](https://docs.airnowapi.org/webservices)
- [US Census Geocoder](https://geocoding.geo.census.gov/geocoder/)
- [NIFC WFIGS](https://data-nifc.opendata.arcgis.com/)

## Important limitations

- VIIRS marks the center of an approximately 375-meter pixel containing unusual heat. It does not locate a fire edge.
- Prescribed burns, volcanoes, gas flares, and other heat sources can produce detections.
- Detection counts cannot be converted to burned acreage.
- Clouds, smoke, sensor differences, and satellite schedules change what is observed.
- More detections over time are described only as a change in detected activity, not confirmed fire spread.
- Weather values represent an area. Air-quality observations can be distant and preliminary.
- The context score is an EmberField comparison aid, not an official wildfire danger rating or a prediction that fire will reach an asset.

## Hackathon material

- [Judging narrative](docs/HACKATHON.md)
- [Three-minute demo script](docs/DEMO-SCRIPT.md)
- [Evidence-based self-evaluation](docs/SELF-EVALUATION.md)
- [Release verification record](docs/VERIFICATION.md)

## License and data use

This prototype is intended for education and hackathon demonstration. Review each upstream source's terms and attribution requirements before any production deployment.
