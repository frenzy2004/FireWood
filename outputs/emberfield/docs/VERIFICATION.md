# EmberField verification record

Verification date: 2026-08-04 MYT

Baseline commit: `db1bd9f`

This record separates committed baseline verification, live external-source observations, and final release work. External results can change at any time.

Snapshot persistence and historical replay status: **IN PROGRESS OUTSIDE THIS DOCUMENT COMMIT.** Coordinator update: replace this line and rerun every release gate after that work lands.

## 1. Clean committed baseline

The active shared worktree contained unrelated in-progress hardening changes. To avoid treating that transient state as released behavior, baseline commit `db1bd9f` was exported to an isolated temporary directory and verified there.

| Command | Recorded result |
| --- | --- |
| `npm test` | Passed: 11 test files, 139 tests |
| `npm run lint` | Passed with no ESLint findings |
| `npm run build` | Passed; Vinext produced the app and six API routes |

The build emitted one non-blocking warning about client chunks larger than 500 kB after minification.

The test suite covers source parsing, request timeouts and size limits, cache behavior, geometry, clustering, scoring, alert deduplication, source composition, repository behavior, API boundaries, Gemma tool orchestration, redaction, UI state, replay behavior, and accessibility-oriented interactions.

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

### Native function smoke test

A real local request using the same model, native tools field, non-streaming mode, and disabled thinking returned:

```json
{
  "role": "assistant",
  "content": "",
  "tool": {
    "name": "inspect_asset",
    "arguments": {
      "assetId": "orchard-1"
    }
  }
}
```

The response completed in about five seconds, including about 3.4 seconds of model load time. The call identity was intentionally omitted from this record.

This proves that the installed model accepts the application's native function shape and chooses a structured tool. It does not by itself prove a full multi-round final briefing. Before judging, run the application flow and capture at least two visible real tool calls followed by an evidence-grounded answer.

## 3. Sanitized live source proof

No credential values, source URLs, or precise request coordinates are recorded here.

### Combined live snapshot probe

Recorded at `2026-08-03T16:12:48.941Z`:

| Source | Mode and status | Observed result |
| --- | --- | --- |
| NASA FIRMS | live, ok | Three configured VIIRS feeds completed and returned a valid empty result: 0 detections and 0 groups; no observation timestamp was available |
| AirNow | live, ok | Request completed, but no current PM2.5 observation was selected; no AQI or concentration claim is made |
| WFIGS | live, ok | 1 incident and 0 perimeters; latest reported source update was `2026-08-03T03:45:46.930Z` |
| NWS in combined snapshot | live, not-requested | No activity group existed, so group-level weather work was correctly skipped with coverage 0 of 0 |

A separate NWS probe for the same general demonstration area completed at `2026-08-03T16:13:01.428Z`. It returned an observation time of `2026-08-03T16:00:00.000Z` with wind speed, wind direction, and relative humidity present.

A successful empty response is evidence that a request completed, not evidence that no fire exists. The AirNow result is evidence of endpoint and parser behavior, not proof of current PM2.5 coverage at every asset.

### Contract and composition tests

The recorded source tests verify:

- FIRMS calls Suomi NPP, NOAA-20, and NOAA-21 feeds, normalizes UTC acquisition time, creates stable fingerprints, bounds response size, and avoids exposing the configured key in errors.
- NWS follows the official grid URL, sends an identifying user agent, selects each weather series near the target time, converts wind units, and uses separate point and observation cache lifetimes.
- AirNow returns an explicit missing-key state, rejects service-error payloads, preserves observation provenance, and selects the exact PM2.5 parameter when present.
- WFIGS queries incident and perimeter layers with a bounded envelope and preserves nullable source dates without inventing an epoch timestamp.
- Snapshot composition uses partial success, never substitutes fixture records into failed live data, reports NWS coverage, and strips credential-bearing FIRMS and AirNow URLs.

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
- The prototype has no public hosting, user accounts, cloud synchronization, or third-party notification provider.

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
- the local health route reports the model and configured sources without revealing credentials.

Then run `npm run dev` and manually verify:

1. Fixture mode loads a stable agriculture scenario.
2. Live refresh labels every source independently and preserves valid partial evidence.
3. Map selection, inspector, and timeline remain synchronized.
4. An actual Gemma prompt produces visible native function calls and a bounded final response.
5. Agent offline and timeout states preserve deterministic monitoring.
6. The console works at desktop and narrow responsive widths with keyboard navigation.
7. Browser console and network panels show no unexpected errors or credential-bearing values.
8. The snapshot persistence and historical replay status line at the top of this file is updated only after its final tests pass.

## 8. Explicitly deferred

- background polling and unattended monitoring;
- SMS, email, mobile push, and desktop notification delivery;
- native iOS or Android applications;
- public hosting, accounts, team sharing, and cloud synchronization;
- production security certification, emergency-service integration, and field validation;
- any claim that EmberField predicts spread, arrival, evacuation need, or official danger.
