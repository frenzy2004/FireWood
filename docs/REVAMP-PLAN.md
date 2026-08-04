# FireWood Functional Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FireWood's live evidence, operational map, replay, and local Gemma agent visibly functional with real upstream data and truthful state.

**Architecture:** Preserve the existing asset-centered snapshot architecture while making its independent evidence sources first-class. Add small pure contracts for map selection, replay event sequencing, and agent tool selection, then let the existing React panels and route handlers consume those contracts.

**Tech Stack:** Next.js 16 App Router through Vinext, React 19, TypeScript 5.9, MapLibre GL 6, Ollama `gemma4:12b`, Vitest 4, Testing Library, Cloudflare D1.

## Global Constraints

- Gemma 4 12B through local Ollama remains the only language model.
- Gemma starter paths must use native Ollama function calls; deterministic code must not pretend to be the model.
- Fixture evidence remains clearly labelled historical replay data.
- Live evidence must come from NASA FIRMS, NWS, AirNow, and WFIGS adapters.
- A valid empty source result must never be presented as a request failure.
- API credentials stay in ignored server-side runtime configuration.
- Replay uses exact source timestamps and never invents observations between them.
- Work is checkpointed on `revamp` after every independently green subsystem.

---

### Task 1: Independent live context

**Files:**
- Modify: `lib/server/snapshot.ts`
- Modify: `app/hooks/use-dashboard.ts`
- Modify: `app/components/ActivityInspector.tsx`
- Modify: `tests/snapshot.test.ts`
- Modify: `tests/ui.test.tsx`

**Interfaces:**
- Produces: `Snapshot.assetWeather: WeatherContext | null`
- Produces: `DashboardSnapshot.assetWeather: DashboardWeather | null`
- Preserves: `SnapshotGroup.weather` for cluster-specific smoke transport.

- [ ] **Step 1: Write the failing snapshot test**

Add a zero-detection composition case using real-shaped adapter payloads:

```ts
it("fetches asset weather when FIRMS returns no detection groups", async () => {
  const fetchWeather = vi.fn(async () => weatherPayload);
  const snapshot = await buildSnapshot(
    { asset: DEMO_ASSET, bbox: DEMO_BBOX, mode: "live" },
    {
      now: () => now,
      config: configuredRuntime,
      fetchFirms: async () => ({ ...firmsPayload, detections: [], observedAt: null }),
      fetchWeather,
      fetchAir: async () => airPayload,
      fetchWfigs: async () => wfigsPayload,
      cache: new MemoryTtlCache(() => 0),
    },
  );

  expect(fetchWeather).toHaveBeenCalledWith(
    { location: DEMO_ASSET.location, at: now },
    expect.objectContaining({ refresh: undefined }),
  );
  expect(snapshot.assetWeather).toMatchObject({ windSpeedMps: 6 });
  expect(snapshot.sources.nws).toMatchObject({ status: "ok", coverage: { succeeded: 1, failed: 0, total: 1 } });
});
```

- [ ] **Step 2: Verify the test fails for missing `assetWeather`**

Run: `npm run test:unit -- tests/snapshot.test.ts`

Expected: FAIL because no weather request is made when `clusters.length === 0` and `assetWeather` is absent.

- [ ] **Step 3: Implement asset-level weather composition**

Fetch the asset coordinate once in the initial `Promise.allSettled`, keep cluster weather fetches for groups, and make source coverage count both request kinds without duplicating the asset request when a cluster shares its coordinate.

```ts
export interface Snapshot {
  // existing fields
  assetWeather: WeatherContext | null;
}
```

For fixtures, set `assetWeather` to the fixture NWS weather. For live snapshots, set it from the independent asset request and derive NWS status from all attempted weather requests.

- [ ] **Step 4: Write the failing UI test for zero-detection live context**

Render `ActivityInspector` with zero groups, six WFIGS incidents, successful FIRMS/WFIGS source states, and asset weather. Assert that the view includes `Nearby official incidents`, `6`, `Asset weather`, and `No recent FIRMS detections`.

- [ ] **Step 5: Implement the independent evidence summary**

Replace the early zero-group return with a summary that renders source-result cards, asset weather, AirNow state, and a compact official-incident list. Keep the existing detection-group inspector below that branch when groups exist.

- [ ] **Step 6: Run the focused and full tests**

Run: `npm run test:unit -- tests/snapshot.test.ts tests/ui.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/server/snapshot.ts app/hooks/use-dashboard.ts app/components/ActivityInspector.tsx tests/snapshot.test.ts tests/ui.test.tsx
git commit -m "feat: surface independent live evidence"
```

---

### Task 2: Operational map selection and controls

**Files:**
- Create: `app/components/map-evidence.ts`
- Create: `app/components/MapEvidenceCard.tsx`
- Modify: `app/components/MapCanvas.tsx`
- Modify: `app/hooks/use-dashboard.ts`
- Modify: `app/globals.css`
- Create: `tests/map-evidence.test.ts`
- Modify: `tests/ui-smoke-arrival.test.tsx`

**Interfaces:**
- Produces: `MapSelection = { kind: "detection"; id: string } | { kind: "group"; id: string } | { kind: "incident"; id: string } | null`
- Produces: `MapLayerState = { detections: boolean; incidents: boolean; perimeters: boolean; radius: boolean; smoke: boolean }`
- Produces: `describeMapSelection(snapshot, selection): MapEvidenceDetail | null`

- [ ] **Step 1: Write failing pure selection tests**

Cover incident, detection, and group selection with hand-authored expected details. The incident case must expose name, update time, containment, acres, and distance without requiring any FIRMS group.

- [ ] **Step 2: Verify the tests fail because the map contract does not exist**

Run: `npm run test:unit -- tests/map-evidence.test.ts`

Expected: FAIL on the missing module.

- [ ] **Step 3: Implement the map evidence contract**

```ts
export type MapSelection =
  | { kind: "detection"; id: string }
  | { kind: "group"; id: string }
  | { kind: "incident"; id: string }
  | null;

export function describeMapSelection(
  snapshot: DashboardSnapshot,
  selection: MapSelection,
): MapEvidenceDetail | null;
```

Compute distance with the existing `distanceBetweenKm` helper and return only source-backed fields.

- [ ] **Step 4: Write failing map UI tests**

Render the no-WebGL fallback with incidents and assert unique controls for `Reset map view`, `Toggle FIRMS detections`, `Toggle official incidents`, and a selectable incident button. Click the incident and assert the evidence card appears.

- [ ] **Step 5: Implement interactive map controls**

Add MapLibre `NavigationControl` and `ScaleControl`, an explicit reset button, layer toggles, a compact legend, and accessible selection buttons in both WebGL and fallback renderers. Raw detection and incident markers call `onSelectionChange`; group markers continue to synchronize the activity inspector.

- [ ] **Step 6: Implement `MapEvidenceCard`**

Render one source-backed detail card anchored over the map with a dismiss button. Never synthesize missing containment, acreage, timestamps, or confidence.

- [ ] **Step 7: Verify focused tests**

Run: `npm run test:unit -- tests/map-evidence.test.ts tests/ui-smoke-arrival.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/components/map-evidence.ts app/components/MapEvidenceCard.tsx app/components/MapCanvas.tsx app/hooks/use-dashboard.ts app/globals.css tests/map-evidence.test.ts tests/ui-smoke-arrival.test.tsx
git commit -m "feat: make the evidence map operational"
```

---

### Task 3: Event-driven replay

**Files:**
- Create: `app/components/replay-events.ts`
- Modify: `app/components/TimelineDock.tsx`
- Modify: `app/globals.css`
- Create: `tests/replay-events.test.ts`
- Modify: `tests/ui.test.tsx`

**Interfaces:**
- Produces: `replayEventTimes(snapshot, sources): string[]`
- Produces: `nextReplayEvent(snapshot, replay): ReplayState | null`
- Produces: `replayPosition(snapshot, replay): number`

- [ ] **Step 1: Write failing replay sequencing tests**

```ts
it("jumps from restart to the first real event", () => {
  const restarted = { cutoff: new Date(Date.parse(snapshot.generatedAt) - 86_400_000).toISOString(), sources: FULL_REPLAY_STATE.sources };
  expect(nextReplayEvent(snapshot, restarted)?.cutoff).toBe("2018-11-08T14:42:00.000Z");
});

it("returns null when enabled sources have no events", () => {
  expect(nextReplayEvent(emptySnapshot, FULL_REPLAY_STATE)).toBeNull();
});
```

- [ ] **Step 2: Verify the sequencing test fails on the missing module**

Run: `npm run test:unit -- tests/replay-events.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement ordered source events**

Collect FIRMS acquisition times, NWS observation time, AirNow observation time, and alert times inside the 24-hour window. Deduplicate, validate, and sort exact ISO timestamps. `nextReplayEvent` returns the next enabled event and ends at `cutoff: null` after the last event.

- [ ] **Step 4: Write the failing component playback test**

Use fake timers, click `Play timeline`, advance 900 milliseconds, and assert the slider/cutoff reaches the first fixture detection rather than `0.5` hours.

- [ ] **Step 5: Replace constant-rate playback**

Drive each 900-millisecond step with `nextReplayEvent`. Disable Play and Restart with `No replay events for enabled sources` when the event list is empty. Add a visible cursor label and event count.

- [ ] **Step 6: Verify replay tests**

Run: `npm run test:unit -- tests/replay-events.test.ts tests/ui.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/components/replay-events.ts app/components/TimelineDock.tsx app/globals.css tests/replay-events.test.ts tests/ui.test.tsx
git commit -m "feat: replay real evidence events"
```

---

### Task 4: Intent-scoped native Gemma tools

**Files:**
- Create: `lib/agent/tool-selection.ts`
- Modify: `lib/agent/ollama.ts`
- Modify: `lib/agent/tools.ts`
- Create: `tests/agent-tool-selection.test.ts`
- Modify: `tests/agent.test.ts`

**Interfaces:**
- Produces: `selectAgentTools(prompt: string): AgentToolDefinition[]`
- Extends: `RunAgentInput.availableTools?: AgentToolDefinition[]`
- Extends: `RunAgentInput.maximumRounds?: number`

- [ ] **Step 1: Write failing intent-selection tests**

Assert exact native tool names:

```ts
expect(toolNames(selectAgentTools("When would smoke reach here?"))).toEqual([
  "get_smoke_arrival",
]);
expect(toolNames(selectAgentTools("Which of my sites is in trouble?"))).toEqual([
  "triage_assets",
]);
expect(toolNames(selectAgentTools("What evidence is missing?"))).toEqual([
  "inspect_asset",
]);
```

Free-form prompts receive the full allowlist.

- [ ] **Step 2: Verify the tests fail because selection does not exist**

Run: `npm run test:unit -- tests/agent-tool-selection.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement conservative intent selection**

Use anchored phrase families for the three starters and return `AGENT_TOOL_DEFINITIONS` for everything else. Never infer a reduced tool set for an ambiguous prompt.

- [ ] **Step 4: Write the failing agent request test**

Capture the first Ollama request and assert that a missing-evidence starter exposes only `inspect_asset`, includes the active asset id in the user context, sets `keep_alive: "30m"`, and completes within three rounds.

- [ ] **Step 5: Implement scoped tool requests**

Use `input.availableTools ?? selectAgentTools(parsedRequest.prompt)`, append `Active asset id: <id>` to the user context, set the starter maximum to three rounds, and send `keep_alive: "30m"`. Keep every existing allowlist, validation, grounding, deadline, and trace invariant.

- [ ] **Step 6: Verify agent tests**

Run: `npm run test:unit -- tests/agent-tool-selection.test.ts tests/agent.test.ts tests/agent-grounding.test.ts tests/evidence-answer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/tool-selection.ts lib/agent/ollama.ts lib/agent/tools.ts tests/agent-tool-selection.test.ts tests/agent.test.ts
git commit -m "perf: scope Gemma native tools by intent"
```

---

### Task 5: Truthful streamed agent progress

**Files:**
- Modify: `lib/agent/ollama.ts`
- Create: `lib/agent/events.ts`
- Modify: `app/api/agent/route.ts`
- Modify: `app/components/AgentPanel.tsx`
- Modify: `app/globals.css`
- Modify: `tests/agent-route.test.ts`
- Modify: `tests/ui.test.tsx`

**Interfaces:**
- Produces: `AgentProgressEvent = { type: "round-start"; round: number } | { type: "tool-complete"; entry: AgentTraceEntry } | { type: "complete"; result: AgentResult }`
- Extends: `RunAgentInput.onProgress?: (event: AgentProgressEvent) => void`
- Agent route returns `application/x-ndjson` when `Accept: application/x-ndjson`; existing JSON callers remain supported.

- [ ] **Step 1: Write the failing route stream test**

Request NDJSON, consume every line, and assert ordered `round-start`, `tool-complete`, and `complete` events. Assert that the tool event contains the same trace entry as the final result.

- [ ] **Step 2: Verify the route test fails with the current JSON-only route**

Run: `npm run test:unit -- tests/agent-route.test.ts`

Expected: FAIL because the response content type and event lines are absent.

- [ ] **Step 3: Implement progress callbacks and NDJSON streaming**

Emit progress only from real run-loop boundaries. Use a `TransformStream` in the route, enqueue one JSON object per line, close after `complete`, and abort the run when the request signal aborts. Preserve the JSON branch when NDJSON is not requested.

- [ ] **Step 4: Write the failing panel progress test**

Return a controlled NDJSON stream and assert the panel shows `Round 1`, then the completed real tool name, then the grounded answer. No completed tool name may appear before its event is read.

- [ ] **Step 5: Implement streamed client consumption**

Set `Accept: application/x-ndjson`, incrementally decode complete lines, update round/tool progress from events, and apply the final result through the existing answer/trace/status state. Fall back to JSON when the response is not NDJSON.

- [ ] **Step 6: Verify route and panel tests**

Run: `npm run test:unit -- tests/agent-route.test.ts tests/ui.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/events.ts lib/agent/ollama.ts app/api/agent/route.ts app/components/AgentPanel.tsx app/globals.css tests/agent-route.test.ts tests/ui.test.tsx
git commit -m "feat: stream truthful Gemma progress"
```

---

### Task 6: Integration verification and publish

**Files:**
- Modify only if verification exposes a covered defect.

- [ ] **Step 1: Run static and automated verification**

```bash
npm run test:unit
npm run lint
npm run build
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 2: Verify server integrations without exposing credentials**

Confirm `/api/health` reports FIRMS, AirNow, and Ollama `ready`. Request fixture and live snapshots and verify mode, source statuses, independent weather, incident counts, and exact generated timestamps.

- [ ] **Step 3: Verify fixture behavior in the browser**

Confirm the map loads without an error overlay, incident and detection evidence cards open, layer toggles affect the visible map, reset view works, and Play reaches the first Camp Fire event within one second.

- [ ] **Step 4: Verify live behavior in the browser**

Switch to Live, confirm a valid empty FIRMS result remains distinct from errors, select a real WFIGS incident, inspect asset weather/source state, and refresh successfully.

- [ ] **Step 5: Verify a real local Gemma native tool call**

Run `What evidence is missing?`, observe real round/tool progress, confirm the visible trace contains `inspect_asset`, confirm the final answer is grounded, and record wall-clock duration.

- [ ] **Step 6: Commit any integration-only fixes and push**

```bash
git status -sb
git push -u origin revamp
```

Expected: `origin/revamp` points to the verified commit and the worktree has no tracked changes.
