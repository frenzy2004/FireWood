# EmberField

EmberField is a local-first agricultural wildfire evidence console powered by the actual `gemma4:12b` model through Ollama. It combines live NASA FIRMS VIIRS detections, National Weather Service conditions, AirNow air quality, US Census geocoding, and WFIGS incident context around saved farms, orchards, barns, livestock areas, and workforce locations.

Gemma uses native function calling across ten schema-validated tools. Deterministic code owns clustering, distance calculations, context scoring, alert rules, persistence bounds, and safety checks; the model selects evidence and writes a cited briefing with a visible trace.

The functional local application, setup guide, architecture notes, demo script, verification evidence, and honest self-evaluation are in [outputs/emberfield](outputs/emberfield/README.md).

## Run locally

```bash
cd outputs/emberfield
cp .dev.vars.example .dev.vars
# Add a free FIRMS MAP_KEY and AirNow API key to .dev.vars.
npm ci
npm run db:local
npm run dev
```

Install and verify the required local model separately:

```bash
ollama pull gemma4:12b
ollama list
```

No public deployment or hosted AI provider is required. Live public-source calls still transmit the geography or address needed by each selected service.

## Safety boundary

A FIRMS point is a satellite-detected heat anomaly, not a confirmed wildfire or fire perimeter. EmberField is an informational planning prototype, not an evacuation tool, emergency-warning system, or official wildfire danger rating. Follow local emergency officials and National Weather Service alerts for safety decisions.
