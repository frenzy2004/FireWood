# EmberField Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a verified local agriculture wildfire intelligence console in which Ollama `gemma4:12b` calls live-data tools and explains deterministic, source-grounded assessments.

**Architecture:** A Vinext React application serves the product UI and local API routes. Cloudflare D1 provides local SQLite-compatible persistence, source adapters normalize and cache FIRMS, NWS, AirNow, Census, and WFIGS data, and a bounded Ollama tool loop exposes evidence to Gemma without letting the model calculate or alter scores.

**Tech Stack:** TypeScript 5.9, React 19, Vinext/Next App Router, Tailwind CSS 4 plus project CSS tokens, MapLibre GL, Phosphor icons, D1/SQLite, Drizzle schema and migrations, Ollama HTTP API, Zod, Papa Parse, Vitest, Testing Library.

## Global Constraints

- The product runs locally on macOS and uses `gemma4:12b` through `http://127.0.0.1:11434`.
- The browser never receives FIRMS or AirNow credentials.
- Every source record carries observed time, fetched time, provenance, and live or fixture mode.
- FIRMS points are called satellite-detected heat anomalies, never confirmed fires or perimeters.
- The 0-100 value is called a context score, never an official risk, danger, spread, or evacuation prediction.
- Missing inputs reduce completeness and produce `Limited data`; they never become numeric zero readings.
- The persistent disclaimer is: `Informational planning view only. Not for evacuation, dispatch, firefighting, or protection-of-life or property decisions. Data may be delayed, incomplete, or inaccurate. Follow local emergency officials and NWS alerts.`
- Keep all API keys in ignored local environment files and redact secret-bearing URLs from errors and logs.
- UI design read: greenfield agriculture operations console, variance 5, motion 3, density 7, charcoal and mineral-green theme, amber only for thermal activity and alerts.
- UI copy contains no em dash or en dash characters.
- No public deployment is part of this plan.

## File map

```text
outputs/emberfield/
  app/
    api/{health,geocode,snapshot,agent}/route.ts
    components/{AgentPanel,AssetRail,MapCanvas,ActivityInspector,TimelineDock,TopBar,SetupPanel}.tsx
    hooks/use-dashboard.ts
    globals.css
    layout.tsx
    page.tsx
  db/{index,schema}.ts
  drizzle/0000_emberfield.sql
  lib/
    agent/{ollama,tools}.ts
    domain/{alerts,cluster,geometry,score,types}.ts
    fixtures/demo.ts
    server/{cache,config,repository,snapshot}.ts
    sources/{airnow,census,firms,nws,wfigs}.ts
  tests/{agent,alerts,cluster,geometry,score,sources,snapshot}.test.ts
  .dev.vars.example
  .env.example
  README.md
```

---

### Task 1: Scaffold, local configuration, and runtime health

**Files:**
- Create: `outputs/emberfield/` from the Sites Vinext starter
- Modify: `outputs/emberfield/package.json`
- Modify: `outputs/emberfield/.gitignore`
- Modify: `outputs/emberfield/.openai/hosting.json`
- Create: `outputs/emberfield/.env.example`
- Create: `outputs/emberfield/.dev.vars.example`
- Create: `outputs/emberfield/lib/server/config.ts`
- Create: `outputs/emberfield/app/api/health/route.ts`
- Test: `outputs/emberfield/tests/sources.test.ts`

**Interfaces:**
- Produces: `getRuntimeConfig(): RuntimeConfig`, `GET /api/health -> HealthPayload`
- Consumes: Ollama at `127.0.0.1:11434`, environment bindings `FIRMS_MAP_KEY`, `AIRNOW_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`

- [ ] **Step 1: Initialize the site and start the retained preview**

Run the bundled Sites initializer with `outputs/emberfield` as the target, wait for installation, run `npm run dev`, and open the exact local URL once.

- [ ] **Step 2: Install only the required packages**

```bash
npm install @phosphor-icons/react maplibre-gl react-map-gl papaparse zod
npm install -D @testing-library/react @testing-library/user-event @types/papaparse jsdom vitest
```

- [ ] **Step 3: Configure D1 and ignored local credentials**

Set `.openai/hosting.json` to `{"d1":"DB","r2":null}`. Add `.dev.vars` to `.gitignore`. Keep both example files value-free:

```dotenv
FIRMS_MAP_KEY=
AIRNOW_API_KEY=
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:12b
```

- [ ] **Step 4: Write the failing config and health tests**

```ts
it("reports required and optional integrations without exposing secrets", async () => {
  const health = await buildHealth({ FIRMS_MAP_KEY: "secret", AIRNOW_API_KEY: "" }, okFetch);
  expect(health.integrations.firms).toMatchObject({ configured: true });
  expect(JSON.stringify(health)).not.toContain("secret");
});
```

- [ ] **Step 5: Run the test and verify failure**

Run: `npm run test:unit -- tests/sources.test.ts`

Expected: FAIL because `buildHealth` is not implemented.

- [ ] **Step 6: Implement validated configuration and bounded health probes**

`getRuntimeConfig` reads worker environment first and process environment second, uses Zod defaults, never returns secrets to the client, and gives probes a 2-second timeout. Ollama health calls `/api/tags`; source status distinguishes `ready`, `missing-key`, `offline`, and `error`.

- [ ] **Step 7: Run the health tests and commit**

Run: `npm run test:unit -- tests/sources.test.ts`

Expected: PASS.

Commit: `feat: scaffold EmberField local runtime`

### Task 2: Domain engine and transparent assessment

**Files:**
- Create: `outputs/emberfield/lib/domain/types.ts`
- Create: `outputs/emberfield/lib/domain/geometry.ts`
- Create: `outputs/emberfield/lib/domain/cluster.ts`
- Create: `outputs/emberfield/lib/domain/score.ts`
- Create: `outputs/emberfield/lib/domain/alerts.ts`
- Test: `outputs/emberfield/tests/geometry.test.ts`
- Test: `outputs/emberfield/tests/cluster.test.ts`
- Test: `outputs/emberfield/tests/score.test.ts`
- Test: `outputs/emberfield/tests/alerts.test.ts`

**Interfaces:**
- Produces: `distanceKm(a,b)`, `bearingDegrees(a,b)`, `boundingBox(center,radiusKm)`, `clusterDetections(rows, options)`, `assessCluster(input)`, `deriveAlerts(previous,current)`
- Produces domain types: `Asset`, `Detection`, `ActivityCluster`, `WeatherContext`, `AirQualityContext`, `OfficialIncident`, `Assessment`, `Alert`

- [ ] **Step 1: Write geometry failure cases**

```ts
expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111.195, 2);
expect(boundingBox({ lat: 36.7783, lon: -119.4179 }, 16).west).toBeLessThan(-119.4179);
expect(angleDifference(350, 10)).toBe(20);
```

- [ ] **Step 2: Run geometry tests and verify failure**

Run: `npm run test:unit -- tests/geometry.test.ts`

Expected: FAIL because the geometry functions are absent.

- [ ] **Step 3: Implement Haversine distance, bearings, angle difference, and bbox creation**

Use Earth radius `6371.0088 km`, normalize longitude to `[-180, 180]`, clamp latitude to `[-90, 90]`, and handle antimeridian boxes explicitly.

- [ ] **Step 4: Write clustering failure cases**

```ts
const clusters = clusterDetections(rows, { maxDistanceKm: 1.5, maxGapHours: 6 });
expect(clusters).toHaveLength(2);
expect(clusters[0].satellites).toEqual(["NOAA-20", "NOAA-21"]);
expect(clusters[0].detectionCount).toBe(3);
```

- [ ] **Step 5: Implement stable fingerprints and connected-components clustering**

Sort by acquisition time and fingerprint. Join detections when distance is at most 1.5 km and absolute time separation is at most 6 hours. Cluster ID is a stable hash of sorted member fingerprints. Aggregate centroid, first and latest time, satellite set, max confidence rank, and max FRP.

- [ ] **Step 6: Write score and missing-data failure cases**

```ts
const result = assessCluster(recentDownwindInput);
expect(result.score).toBeGreaterThan(60);
expect(result.reasons.map((r) => r.code)).toContain("downwind");
expect(result.completeness).toBe("complete");

const limited = assessCluster({ ...recentDownwindInput, weather: null, air: null });
expect(limited.missingInputs).toEqual(["weather", "air-quality"]);
expect(limited.dataQuality).toBe("limited");
```

- [ ] **Step 7: Implement gated weighted scoring**

Normalize distance, age, confidence, FRP, distinct passes, downwind alignment, wind speed, humidity, and PM2.5 or AQI to `[0, 1]`. Weight them `0.25, 0.15, 0.10, 0.10, 0.10, 0.10, 0.07, 0.06, 0.07`. Compute `base = .25*distance + .15*age` and `gate = .25 + .75*sqrt(distance*age)`, then `score = round(100 * clamp01(base + gate*support))`. The gate prevents distant stale detections from scoring high solely because of secondary conditions. Apply source-quality factors, return an uncertainty range for missing data, and suppress automated alerts below 60 percent data confidence. Return every contribution and missing input. Bands are `low-context` below 25, `watch` below 50, `elevated-context` below 75, and `high-context` at least 75.

- [ ] **Step 8: Write and implement alert deduplication cases**

```ts
expect(deriveAlerts(previous, current).map((a) => a.type)).toEqual([
  "new-satellite",
  "score-increase",
]);
expect(new Set(deriveAlerts(previous, current).map((a) => a.dedupeKey)).size).toBe(2);
```

Trigger on a new cluster in radius, a new satellite, activity after six quiet hours, a score increase of at least 10, or a newly matched official incident. Use `assetId:clusterId:triggerFamily` as the dedupe family and update existing alert timestamps instead of multiplying rows.

- [ ] **Step 9: Run all domain tests and commit**

Run: `npm run test:unit -- tests/geometry.test.ts tests/cluster.test.ts tests/score.test.ts tests/alerts.test.ts`

Expected: PASS.

Commit: `feat: add transparent wildfire context engine`

### Task 3: Live source adapters, fixtures, and snapshot composition

**Files:**
- Create: `outputs/emberfield/lib/sources/firms.ts`
- Create: `outputs/emberfield/lib/sources/census.ts`
- Create: `outputs/emberfield/lib/sources/nws.ts`
- Create: `outputs/emberfield/lib/sources/airnow.ts`
- Create: `outputs/emberfield/lib/sources/wfigs.ts`
- Create: `outputs/emberfield/lib/server/cache.ts`
- Create: `outputs/emberfield/lib/server/snapshot.ts`
- Create: `outputs/emberfield/lib/fixtures/demo.ts`
- Create: `outputs/emberfield/app/api/geocode/route.ts`
- Create: `outputs/emberfield/app/api/snapshot/route.ts`
- Test: `outputs/emberfield/tests/sources.test.ts`
- Test: `outputs/emberfield/tests/snapshot.test.ts`

**Interfaces:**
- Produces: `fetchFirmsDetections`, `geocodeAddress`, `fetchWeatherContext`, `fetchAirQuality`, `fetchWfigs`, `buildSnapshot`
- Consumes: domain engine from Task 2 and runtime configuration from Task 1

- [ ] **Step 1: Write parser contract tests from minimal recorded payloads**

```ts
expect(parseFirmsCsv(firmsCsv)[0]).toMatchObject({
  satellite: "NOAA-20",
  acquiredAt: "2026-08-03T04:27:00.000Z",
  frp: 14.32,
});
expect(parseNwsGrid(nwsJson, instant)).toMatchObject({ humidityPercent: 18 });
expect(parseAirNow(airNowJson)[0]).toMatchObject({ parameter: "PM2.5", aqi: 71 });
```

- [ ] **Step 2: Run source tests and verify failure**

Run: `npm run test:unit -- tests/sources.test.ts`

Expected: FAIL because source parsers do not exist.

- [ ] **Step 3: Implement FIRMS and Census adapters**

FIRMS calls each configured VIIRS feed for one day and the asset bbox, parses CSV with Papa Parse, bounds response size, sets a 12-second timeout, and never includes the key in thrown errors. Census calls the current single-line address endpoint from the server and returns the highest exact match or a typed no-match result.

- [ ] **Step 4: Implement NWS, AirNow, and WFIGS adapters**

NWS sends an identifying `User-Agent`, follows `forecastGridData`, selects the closest valid UTC values for wind and humidity, and converts units. AirNow uses the key only server-side and returns typed `missing-key` when absent. WFIGS queries current points and perimeters by bounding envelope with selected fields and GeoJSON geometry.

- [ ] **Step 5: Implement source-aware cache and snapshot composition**

Cache FIRMS for 10 minutes, NWS point mapping for 24 hours, NWS observations for 30 minutes, AirNow for 60 minutes, and WFIGS for 5 minutes. `buildSnapshot` uses `Promise.allSettled`, preserves partial success, clusters detections, assesses groups, associates official incidents by perimeter containment or bounded proximity, and returns source statuses plus UTC timestamps.

- [ ] **Step 6: Add honest fixture mode**

Fixture data uses fixed timestamps shifted into the current 24-hour window at runtime, is labeled `mode: "fixture"` on every payload, and is reachable only via `?mode=fixture`. Live mode never falls back silently.

- [ ] **Step 7: Run adapter and snapshot tests, then commit**

Run: `npm run test:unit -- tests/sources.test.ts tests/snapshot.test.ts`

Expected: PASS.

Commit: `feat: connect wildfire evidence sources`

### Task 4: D1 persistence and saved agriculture assets

**Files:**
- Modify: `outputs/emberfield/db/schema.ts`
- Modify: `outputs/emberfield/db/index.ts`
- Create: `outputs/emberfield/drizzle/0000_emberfield.sql`
- Create: `outputs/emberfield/lib/server/repository.ts`
- Create: `outputs/emberfield/app/api/assets/route.ts`
- Create: `outputs/emberfield/app/api/assets/[id]/route.ts`
- Test: `outputs/emberfield/tests/repository.test.ts`

**Interfaces:**
- Produces: `AssetRepository` with `listAssets`, `createAsset`, `updateAsset`, `saveSnapshot`, `listAlerts`, `saveAgentRun`
- Consumes: D1 `DB` binding and domain types from Task 2

- [ ] **Step 1: Write repository behavior tests against a fake prepared-statement binding**

```ts
const created = await repository.createAsset({
  name: "Sierra Vista Almonds",
  category: "orchard",
  latitude: 36.7378,
  longitude: -119.7871,
  radiusKm: 40.2,
});
expect((await repository.listAssets())[0].id).toBe(created.id);
```

- [ ] **Step 2: Define schema and migration**

Create tables for assets, detections, clusters, assessments, alerts, source snapshots, and agent runs. Use unique indexes for detection fingerprints and alert dedupe keys, plus indexes on `(asset_id, acquired_at)`, `(asset_id, calculated_at)`, and unacknowledged alerts. Each `prepare` call contains one SQL statement.

- [ ] **Step 3: Implement the repository and API validation**

Use Zod for asset name, category, latitude, longitude, radius from 1 to 160.934 km, and notes. Store UTC ISO strings. Batch related snapshot writes and never interpolate user values into SQL.

- [ ] **Step 4: Generate and inspect migration output**

Run: `npm run db:generate`

Expected: one reviewed migration with the defined tables and indexes.

- [ ] **Step 5: Run repository tests and commit**

Run: `npm run test:unit -- tests/repository.test.ts`

Expected: PASS.

Commit: `feat: persist farm assets and monitoring history`

### Task 5: Gemma 4 native tool-calling loop

**Files:**
- Create: `outputs/emberfield/lib/agent/tools.ts`
- Create: `outputs/emberfield/lib/agent/ollama.ts`
- Create: `outputs/emberfield/app/api/agent/route.ts`
- Test: `outputs/emberfield/tests/agent.test.ts`

**Interfaces:**
- Produces: `runAgent({ prompt, assetId, repository, snapshotService, fetchImpl }): AgentResult`
- Produces: visible `AgentTraceEntry[]` with tool name, validated arguments, duration, source status, and summarized result
- Consumes: repository and snapshot service from Tasks 3 and 4

- [ ] **Step 1: Write native Ollama loop tests**

```ts
const result = await runAgent(input, mockOllama([
  toolCall("inspect_asset", { assetId: "asset-1" }),
  assistant("The orchard has elevated context because...")
]));
expect(result.trace[0].toolName).toBe("inspect_asset");
expect(result.answer).toContain("elevated context");
```

Also test unknown tools, invalid coordinates, Ollama offline, a six-round ceiling, and a final answer that lacks invented source values.

- [ ] **Step 2: Run agent tests and verify failure**

Run: `npm run test:unit -- tests/agent.test.ts`

Expected: FAIL because `runAgent` does not exist.

- [ ] **Step 3: Implement allowlisted tools and schemas**

Implement `list_assets`, `inspect_asset`, `refresh_asset_data`, `get_activity_groups`, `get_weather_context`, `get_air_quality`, `get_official_incidents`, `get_timeline`, and `explain_assessment`. Validate every tool argument before execution and return JSON strings to Ollama.

- [ ] **Step 4: Implement the verified Ollama protocol**

POST `/api/chat` with `model: "gemma4:12b"`, `stream: false`, and `think: false`. Detect calls via `message.tool_calls`, preserve call IDs and function indexes in assistant history, append tool messages using `{ role: "tool", tool_name, content }`, cap at six rounds, and time out after 45 seconds.

- [ ] **Step 5: Add agricultural safety prompt and trace redaction**

The system prompt requires source-grounded language, calls anomalies `detections`, names missing data, prohibits evacuation or spread predictions, and asks the operator to follow officials. Trace output omits raw secret-bearing URLs and truncates oversized source payloads.

- [ ] **Step 6: Run tests, exercise the real model, and commit**

Run: `npm run test:unit -- tests/agent.test.ts`

Then run one real prompt that calls `inspect_asset` and verify a structured tool call plus final prose.

Commit: `feat: add local Gemma evidence agent`

### Task 6: Product console, map, timeline, alerts, and states

**Files:**
- Modify: `outputs/emberfield/app/layout.tsx`
- Modify: `outputs/emberfield/app/page.tsx`
- Modify: `outputs/emberfield/app/globals.css`
- Create: `outputs/emberfield/app/components/TopBar.tsx`
- Create: `outputs/emberfield/app/components/AssetRail.tsx`
- Create: `outputs/emberfield/app/components/MapCanvas.tsx`
- Create: `outputs/emberfield/app/components/ActivityInspector.tsx`
- Create: `outputs/emberfield/app/components/TimelineDock.tsx`
- Create: `outputs/emberfield/app/components/AgentPanel.tsx`
- Create: `outputs/emberfield/app/components/SetupPanel.tsx`
- Create: `outputs/emberfield/app/hooks/use-dashboard.ts`
- Test: `outputs/emberfield/tests/ui.test.tsx`

**Interfaces:**
- Consumes: `/api/health`, `/api/assets`, `/api/geocode`, `/api/snapshot`, `/api/agent`
- Produces: responsive, keyboard-accessible console with real `loading`, `empty`, `error`, `stale`, `missing-key`, `fixture`, and `live` states

- [ ] **Step 1: Remove all starter preview code and write UI state tests**

```tsx
render(<Dashboard initialState={limitedLiveSnapshot} />);
expect(screen.getByText("Limited data")).toBeVisible();
expect(screen.getByText(/satellite-detected heat anomaly/i)).toBeVisible();
expect(screen.queryByText(/confirmed fire/i)).not.toBeInTheDocument();
```

- [ ] **Step 2: Build the semantic shell and design tokens**

Use a charcoal canvas, mineral-green interactive accent, amber thermal marks, Geist and Geist Mono, 12px panels, 8px controls, clear focus rings, and no generic equal-card grid. Numbers use tabular mono styling. The first viewport is the real console.

- [ ] **Step 3: Build the asset rail and setup flow**

Support direct coordinates and Census address lookup, category selection, radius entry in miles with kilometer conversion, selected state, score band, trend, data completeness, and key or Ollama setup messages.

- [ ] **Step 4: Build the interactive MapLibre canvas**

Render a real base map, selected asset marker and radius, raw VIIRS points, activity cluster symbols sized by detections, WFIGS incident points and perimeter GeoJSON, and a wind-toward arrow. Selection synchronizes with the inspector. Controls have accessible labels and touch targets.

- [ ] **Step 5: Build the inspector, alerts, and 24-hour timeline**

Show score as a large number with contribution list, never as a filled progress bar. Display exact source timestamps and live or fixture labels. Timeline supports play, pause, scrub, and source toggles; its label says `change in detected activity`, not spread.

- [ ] **Step 6: Build the agent panel and tool trace**

Provide three useful agriculture prompt starters, streamed-looking pending feedback without fake tokens, final prose, and expandable tool trace showing function names, safe arguments, durations, and source freshness.

- [ ] **Step 7: Implement responsive and reduced-motion behavior**

Desktop uses rail, map, and inspector. Below 768px, map comes first and Assets, Activity, Timeline, and Agent become explicit tabs. No `h-screen`; use stable dynamic viewport units. Automatic animation is disabled under reduced motion.

- [ ] **Step 8: Run UI tests and commit**

Run: `npm run test:unit -- tests/ui.test.tsx`

Expected: PASS.

Commit: `feat: build EmberField operations console`

### Task 7: Live proof, self-review, verification, and handoff

**Files:**
- Modify: `outputs/emberfield/README.md`
- Create: `outputs/emberfield/docs/HACKATHON.md`
- Create: `outputs/emberfield/docs/DEMO-SCRIPT.md`
- Modify: any implementation files required by review findings

**Interfaces:**
- Produces: repeatable local startup, verified live NASA path, verified Gemma tool trace, safety-complete UI, and concise judging narrative

- [ ] **Step 1: Add the provided FIRMS key to the ignored local environment file**

Confirm with `git check-ignore .env.local` before writing the credential. Never echo or commit its value.

- [ ] **Step 2: Run the live integration proof**

Use a bounded US agriculture-region bbox. Confirm a 200 CSV response from at least one VIIRS feed, parsed rows or a valid empty result, NWS point and weather data, WFIGS GeoJSON, and a snapshot with live source timestamps. AirNow may be `missing-key` and must produce `Limited data`.

- [ ] **Step 3: Run the real Gemma proof**

Ask: `Brief me on the selected orchard. Call the tools you need, name missing data, and explain why its context score changed.` Verify at least two visible native tool calls and final evidence-grounded text.

- [ ] **Step 4: Run parallel code and product self-review**

One reviewer checks spec compliance and safety semantics. A second checks implementation quality, secret handling, accessibility, and failure states. Resolve every high and medium issue or document a concrete non-blocking limitation.

- [ ] **Step 5: Run the Taste Skill preflight where applicable**

Mechanically scan visible copy for em dash and en dash characters, audit contrast, focus, empty/loading/error states, shape and accent consistency, icon family, responsive collapse, reduced motion, and AI-generic visual patterns.

- [ ] **Step 6: Run full verification**

```bash
npm run test:unit
npm run lint
npm run build
```

Perform browser smoke testing on the retained local URL: save an asset, refresh live data, select a cluster, play the timeline, ask Gemma, inspect the tool trace, and test a narrow viewport.

- [ ] **Step 7: Write the handoff and judging materials**

README covers prerequisites, key setup without secret values, startup, tests, live versus fixture behavior, data sources, and limitations. Hackathon notes explicitly map Gemma Integration, Innovation and Impact, Functionality, and Presentation and Writeup to visible evidence. Demo script fits three minutes.

- [ ] **Step 8: Final requirement audit and commit**

Review every design-spec success criterion against runtime or test evidence. Commit only after the complete proof.

Commit: `docs: complete EmberField local prototype`
