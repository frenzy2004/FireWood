# EmberField verification record

Verification date: 2026-08-04 MYT

Baseline: final `feature/emberfield` release candidate

This record separates deterministic verification, live external-source observations, and actual local-model evidence. External results can change at any time.

Snapshot persistence and historical replay status: **COMPLETE FOR THE LOCAL PROTOTYPE.** Saved live assets retain bounded run summaries, FIRMS detections, and enriched alerts. The virtual demo is never persisted.

## 1. Final release candidate

| Command | Recorded result |
| --- | --- |
| `npm test` | Passed: 20 test files, 255 tests |
| `npm run lint` | Passed with no ESLint findings |
| `npm run build` | Passed; Vinext produced the app and six API routes |
| `npm run db:local` | Passed; all versioned migrations applied, and the repeat run reported no pending migrations |

The build emitted one non-blocking warning about client chunks larger than 500 kB after minification.

The test suite covers source parsing, request timeouts and size limits, cache behavior, geometry and perimeter-radius intersection, clustering, repeated-pass scoring, alert deduplication, bounded persistence, source composition, repository behavior, fixture identity isolation, native Gemma Census geocoding, tool orchestration and claim grounding, redaction, UI state, replay behavior, and accessibility-oriented interactions.

Final desktop browser QA at 1280 by 720 verified:

- fixture evidence and permanent limitation copy;
- a saved live orchard with persisted history after reload and complete fetched/observed timestamps;
- timeline restart synchronizing the map and inspector to zero visible detections at the 24-hour cutoff;
- successful Census address normalization without saving the test address;
- actual grounded Gemma answers with expanded `inspect_asset` and live Census `geocode_location` traces;
- no error or warning entries in a fresh browser-tab log.

Responsive tabs, focus handling, and narrow-layout behavior are covered by automated UI tests; a physical narrow-screen rehearsal is still advisable before judging.

## 2. Actual local Gemma proof

### Installed runtime

Recorded on the presentation machine:

```text
Ollama version: 0.32.5
Model: gemma4:12b
Installed size: 7.6 GB
Parameter family: 11.9B
Quantization: Q4_K_M
Reported capabilities: completion, tools, thinking, vision
```

The model inventory can be checked without printing model digests:

```bash
ollama list
curl -sS http://127.0.0.1:11434/api/tags \
  | jq '.models[] | select(.name == "gemma4:12b") | {name, size, details, capabilities}'
```

### Final native function proof

A real request through `/api/agent` used the installed `gemma4:12b` model and completed in two rounds. Gemma selected native `inspect_asset`; the application returned a server-generated `trace-1`, evidence reference `1`, and the cited answer:

```text
The active evidence mode for this ranch is fixture [evidence:1].
```

The successful warm run completed in about 26.2 seconds and returned `persistenceStatus: not-persisted`. A separate cold or queued run reached the run timeout and returned the explicit warm-up fallback. Warm the model before judging.

After the final tool-set review, a second real request proved the new native `geocode_location` path. Gemma selected the tool, the live US Census Geocoder returned `status: ok`, and Gemma produced `The Census source mode is live [evidence:1].` in two rounds and about 7.0 seconds. The trace reported `geocode_location`, a server-issued evidence reference, and live Census source state; the prompt, answer, and trace were not persisted.

A broader live-orchard prompt also selected `inspect_asset` and received current live evidence. Synthesis failed the conservative claim-level validator because the model described evidence in synonyms the payload did not contain; evidence tools now emit a plain-language summary, which moved grounded briefings from none observed to roughly a third of sampled runs. The rate is not stable and the model may still paraphrase rather than quote. Unsupported prose is still replaced by the safe fallback, and the deterministic panels and visible tool result remain authoritative.

## 3. Sanitized live source proof

No credential values, source URLs, or precise request coordinates are recorded here.

### Combined live saved-asset probe

Recorded at `2026-08-03T16:52:16.992Z` for a local verification orchard with a 100 km radius:

| Source | Mode and status | Observed result |
| --- | --- | --- |
| NASA FIRMS | live, ok | 2 radius-filtered detections in 2 activity groups; latest observation `2026-08-03T10:15:00.000Z` |
| NWS | live, ok | Weather context succeeded for both activity groups, coverage 2 of 2; selected observation time `2026-08-03T10:00:00.000Z` |
| AirNow | live, ok | Current request and parser completed; selected observation time `2026-08-03T16:00:00.000Z` |
| WFIGS | live, ok | 3 incidents and 1 asset-radius-intersecting perimeter; latest source update `2026-08-03T16:43:02.480Z` |

The response reported exact-radius filtering, no truncation, and automated-alert eligibility. Two consecutive refreshes persisted as two local runs. Historical detections deduplicated to 2, enriched alert history remained at 4, and the unchanged second refresh emitted 0 new alerts.

These counts are evidence for one place and time, not guaranteed coverage. A successful empty response elsewhere still means only that the request completed; it never proves absence of fire.

### Contract and composition tests

The recorded source tests verify:

- FIRMS calls Suomi NPP, NOAA-20, and NOAA-21 feeds, normalizes UTC acquisition time, creates stable fingerprints, bounds response size, and avoids exposing the configured key in errors.
- NWS follows the official grid URL, sends an identifying user agent, selects each weather series near the target time, converts wind units, and uses separate point and observation cache lifetimes.
- AirNow returns an explicit missing-key state, rejects service-error payloads, preserves observation provenance, and selects the exact PM2.5 parameter when present.
- WFIGS queries incident and perimeter layers with a bounded envelope and preserves nullable source dates without inventing an epoch timestamp.
- Snapshot composition uses partial success, never substitutes fixture records into failed live data, reports NWS coverage, and strips credential-bearing FIRMS and AirNow URLs.
- WFIGS is bounded to 500 incident features and 100 perimeter features with 1 MB and 2 MB response limits, plus per-feature and per-layer coordinate limits.
- Saved snapshot history is asset- and mode-isolated, bounded to 48 runs and 8 MB of aggregate read material, and preflighted before persistence.

These are deterministic contract tests with controlled upstream responses. They complement the live probe but do not replace it.

## 4. Safety verification

Automated coverage includes:

- no score when mandatory proximity or recency evidence is absent;
- reduced confidence and blocked automated alerts when source coverage is insufficient;
- stable alert deduplication across repeated satellite passes;
- rejection of unsupported numeric claims, generic uncited conditions, false wildfire confirmation, and affirmative movement or evacuation language;
- replay cutoffs that hide unrecalculated scores and post-cutoff freshness timestamps;
- permanent UI language for anomaly, pixel, acreage, spread, preliminary air-quality, and emergency-use limits.

Manual release checks:

1. Confirm the interface says detection or thermal anomaly unless official WFIGS evidence names an incident.
2. Confirm no screen calls detection counts acres or calls replay activity spread.
3. Confirm missing weather and air evidence produce Limited data, not zero.
4. Confirm every score surface says it is context only and not an official danger rating.
5. Confirm the footer directs emergency decisions to local officials and NWS alerts.
6. Treat model grounding as defense in depth. Verify the cited tool trace before repeating a model statement in the pitch.

## 5. Local-only and privacy verification

- Ollama is restricted to an HTTP loopback authority by server validation.
- Gemma prompts and model inference are not sent to a hosted AI provider.
- FIRMS and AirNow credentials are read server-side. Tests verify they are absent from client-facing source state and persisted source URLs.
- Tool results and visible trace values are bounded and sanitized.
- Live public-source calls still transmit the coordinate, bounding area, or address required for the selected service. Do not describe that traffic as fully offline.
- The prototype has no public hosting, user accounts, cloud synchronization, background polling, or third-party notification provider.
- Saved snapshot evidence is persisted locally; Gemma prompts, answers, and traces are not automatically persisted.

Before a demo, inspect browser network responses and the expanded Gemma trace. Stop if any credential value or credential-bearing URL is visible.

## 6. Dependency audit caveat

Recorded with the current lockfile:

| Command | Recorded result |
| --- | --- |
| `npm audit --omit=dev` | Failed: 3 high severity findings in transitive production dependencies related to PostCSS and Sharp |
| `npm audit` | Failed: 18 findings total: 1 low, 4 moderate, and 13 high across production and development tooling |

The suggested force remediation includes breaking or incompatible version changes, so no automatic force fix was applied. Local-only operation narrows exposure, but it does not resolve dependency findings. Public deployment is deferred until the dependency graph is upgraded, retested, rebuilt, and audited again.

## 7. Final coordinator release gate

Run from a clean checkout after all in-progress work lands:

```bash
git status --short
npm ci
npm test
npm run lint
npm run build
npm audit --omit=dev
npm audit
ollama list
```

Expected release evidence:

- no unexpected working-tree changes;
- all tests pass with the final count recorded here;
- ESLint exits successfully;
- the production build exits successfully;
- audit findings are either remediated or explicitly accepted for a local-only judging build;
- `gemma4:12b` is installed on the presentation machine;
- the local health route reports configured sources and verifies that the exact `gemma4:12b` inventory entry is available without revealing credentials.

Then run `npm run dev` and manually verify:

1. Fixture mode loads a stable agriculture scenario.
2. Live refresh labels every source independently and preserves valid partial evidence.
3. Map selection, inspector, and timeline remain synchronized.
4. An actual Gemma prompt produces visible native function calls and a bounded final response.
5. Agent offline and timeout states preserve deterministic monitoring.
6. The console works at desktop and narrow responsive widths with keyboard navigation.
7. Browser console and network panels show no unexpected errors or credential-bearing values.
8. A saved live asset reports `persisted: true`, survives a reload with bounded history, and creates no duplicate alert on an unchanged second refresh.

## 8. Explicitly deferred

- background polling and unattended monitoring;
- SMS, email, mobile push, and desktop notification delivery;
- native iOS or Android applications;
- public hosting, accounts, team sharing, and cloud synchronization;
- reconstruction of historical NWS grids, AirNow readings, or prior risk scores in replay;
- production security certification, emergency-service integration, and field validation;
- any claim that EmberField predicts fire spread, evacuation need, or official danger. Smoke arrival is estimated, but only as transport from an already-detected source, capped at moderate confidence.
