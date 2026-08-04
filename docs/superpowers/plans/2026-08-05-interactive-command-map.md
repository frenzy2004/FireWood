# Interactive Command Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the evidence map, evidence dossier, and 24-hour replay operate as one accessible command surface with grounded camera focus and deliberate event follow.

**Architecture:** Put all geographic focus calculations in a pure `map-navigation.ts` module, then let `MapCanvas` translate those plans into guarded MapLibre calls or truthful fallback state. `TimelineDock` emits structured FIRMS focus events, and `Dashboard` coordinates replay cutoff, selected activity group, and a monotonic map focus request.

**Tech Stack:** React 19, TypeScript 5.9, Next/vinext, react-map-gl MapLibre, Vitest, Testing Library, Phosphor Icons, CSS.

## Global Constraints

- Do not add a map or animation dependency.
- Derive every camera target from the supplied `DashboardSnapshot`; never synthesize evidence.
- Keep the static smoke corridor and safety copy; do not imply fire-spread prediction.
- Camera transitions are 700 ms normally and 0 ms for reduced-motion users.
- Playback advances at exactly 2,000 ms per event.
- Preserve selection, layer toggles, and keyboard behavior in the WebGL-free fallback.

---

## File map

- Create `app/components/map-navigation.ts`: pure focus plans, coordinate validation, perimeter flattening, selection locations, and detection-to-group lookup.
- Create `tests/map-navigation.test.ts`: hand-derived geographic expectations and malformed-data cases.
- Modify `app/components/MapCanvas.tsx`: focus modes, external focus requests, marker camera moves, newest-detection pulse, and dossier focus action.
- Modify `app/components/MapEvidenceCard.tsx`: explicit `Focus on map` button.
- Modify `app/components/TimelineDock.tsx`: structured replay focus events, exact marker jumps, 2,000 ms playback, and automatic FIRMS follow.
- Modify `app/page.tsx`: replay/map coordination and focus-request state.
- Modify `app/globals.css`: command-map focus segment, dossier action, pulse, and responsive/reduced-motion rules.
- Modify `tests/ui-smoke-arrival.test.tsx`: fallback controls, selection focus, and dossier action.
- Modify `tests/ui.test.tsx`: exact timeline jump and two-second playback behavior.

### Task 1: Pure geographic focus plans

**Files:**
- Create: `app/components/map-navigation.ts`
- Create: `tests/map-navigation.test.ts`

**Interfaces:**
- Consumes: `DashboardSnapshot` from `app/hooks/use-dashboard` and `MapSelection` from `app/components/map-evidence`.
- Produces: `MapFocusMode`, `MapBounds`, `MapFocusPlan`, `MapFocusRequest`, `buildMapFocusPlan(snapshot, mode, selectedGroupId?)`, `selectionLocation(snapshot, selection)`, and `groupForDetection(snapshot, detectionId)`.

- [ ] **Step 1: Write failing focus-plan tests**

```ts
const assetPlan = buildMapFocusPlan(snapshot, "asset");
expect(assetPlan.bounds[0][0]).toBeCloseTo(-117.079889, 6);
expect(assetPlan.bounds[0][1]).toBeCloseTo(40.644793, 6);
expect(assetPlan.bounds[1][0]).toBeCloseTo(-116.007845, 6);
expect(assetPlan.bounds[1][1]).toBeCloseTo(41.453273, 6);
expect(buildMapFocusPlan(snapshot, "evidence").bounds).toEqual([
  [-117.2, 40.8],
  [-115.9, 41.4],
]);
expect(buildMapFocusPlan(snapshot, "threat", "cluster-1").bounds).toEqual([
  [-116.543867, 41.039033],
  [-116.143867, 41.059033],
]);
```

Add separate tests that malformed perimeter values are ignored, a one-point evidence set expands to non-zero bounds, `selectionLocation` resolves all three selection kinds, and `groupForDetection` returns `cluster-1` only for a member detection.

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm test -- tests/map-navigation.test.ts`

Expected: FAIL because `app/components/map-navigation.ts` does not exist.

- [ ] **Step 3: Implement the pure module**

```ts
export type MapFocusMode = "asset" | "evidence" | "threat";
export type MapBounds = [[number, number], [number, number]];
export type MapFocusPlan = { mode: MapFocusMode; bounds: MapBounds; target: { lat: number; lon: number } };
export type MapFocusRequest = { id: number; mode: MapFocusMode; groupId?: string };

export function buildMapFocusPlan(
  snapshot: DashboardSnapshot,
  mode: MapFocusMode,
  selectedGroupId = "",
): MapFocusPlan {
  const group = snapshot.groups.find((row) => row.cluster.id === selectedGroupId)
    ?? snapshot.groups[0];
  const resolvedMode = mode === "threat" && !group ? "asset" : mode;
  const points = resolvedMode === "asset"
    ? assetRadiusCorners(snapshot)
    : resolvedMode === "threat"
      ? [snapshot.asset.location, group!.cluster.centroid]
      : allEvidenceCoordinates(snapshot);
  return { mode: resolvedMode, bounds: boundsFor(points), target: resolvedMode === "threat" ? group!.cluster.centroid : snapshot.asset.location };
}
```

Implement `allEvidenceCoordinates` with recursive numeric-pair traversal, filter non-finite values, and have `boundsFor` expand equal longitude or latitude axes by `0.01` degrees.

- [ ] **Step 4: Run focus-plan tests and verify GREEN**

Run: `npm test -- tests/map-navigation.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit the pure navigation unit**

```bash
git add app/components/map-navigation.ts tests/map-navigation.test.ts
git commit -m "feat: derive grounded map focus plans"
```

### Task 2: Interactive focus controls and evidence camera actions

**Files:**
- Modify: `app/components/MapCanvas.tsx`
- Modify: `app/components/MapEvidenceCard.tsx`
- Modify: `tests/ui-smoke-arrival.test.tsx`

**Interfaces:**
- Consumes: `MapFocusRequest`, `MapFocusMode`, `buildMapFocusPlan`, and `selectionLocation` from Task 1.
- Produces: `MapCanvas` prop `focusRequest?: MapFocusRequest`; `MapEvidenceCard` prop `onFocus: () => void`.

- [ ] **Step 1: Write failing fallback interaction tests**

```tsx
render(<MapCanvas snapshot={mapSnapshot} selectedGroupId="cluster-1" onSelect={onSelect} />);
expect(screen.getByRole("button", { name: "Focus asset" }).getAttribute("aria-pressed")).toBe("true");
fireEvent.click(screen.getByRole("button", { name: "Fit all evidence" }));
expect(screen.getByRole("button", { name: "Fit all evidence" }).getAttribute("aria-pressed")).toBe("true");
expect(screen.getByText("Evidence framed in fallback view")).toBeTruthy();
fireEvent.click(screen.getByRole("button", { name: /Select official incident CHUTE/ }));
fireEvent.click(within(screen.getByRole("region", { name: "Selected map evidence" })).getByRole("button", { name: "Focus on map" }));
expect(screen.getByText("Selected evidence focused in fallback view")).toBeTruthy();
```

Add a test that a changing `{ id, mode: "threat", groupId: "cluster-1" }` request activates the Threat control.

- [ ] **Step 2: Run the component test and verify RED**

Run: `npm test -- tests/ui-smoke-arrival.test.tsx`

Expected: FAIL because the three focus controls, external focus request, focus live region, and dossier action do not exist.

- [ ] **Step 3: Implement the command-map interaction**

```tsx
const [focusMode, setFocusMode] = useState<MapFocusMode>("asset");
const [focusAnnouncement, setFocusAnnouncement] = useState("Asset framed");
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const focusPlan = useCallback((mode: MapFocusMode, groupId = selectedGroupId) => {
  const plan = buildMapFocusPlan(snapshot, mode, groupId);
  setFocusMode(plan.mode);
  mapRef.current?.fitBounds(plan.bounds, {
    padding: plan.mode === "asset" ? 48 : plan.mode === "evidence" ? 56 : 72,
    maxZoom: plan.mode === "asset" ? 12 : plan.mode === "evidence" ? 11 : 10.5,
    duration: reducedMotion() ? 0 : 700,
  });
  setFocusAnnouncement(`${plan.mode === "asset" ? "Asset" : plan.mode === "evidence" ? "Evidence" : "Threat"} framed${canUseMap ? "" : " in fallback view"}`);
}, [canUseMap, selectedGroupId, snapshot]);
```

Replace the reset button with Asset/Evidence/Threat buttons. Add `focusSelection` using `selectionLocation` and guarded `mapRef.current?.easeTo`. Route every marker click through a handler that sets the selection, selects a group when applicable, and focuses the coordinate. Pass `onFocus={focusSelection}` to the dossier.

- [ ] **Step 4: Run the component test and verify GREEN**

Run: `npm test -- tests/ui-smoke-arrival.test.tsx`

Expected: PASS with the existing smoke-arrival assertions unchanged.

- [ ] **Step 5: Commit interactive map controls**

```bash
git add app/components/MapCanvas.tsx app/components/MapEvidenceCard.tsx tests/ui-smoke-arrival.test.tsx
git commit -m "feat: add command map focus controls"
```

### Task 3: Synchronize replay events with map focus

**Files:**
- Modify: `app/components/TimelineDock.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/ui.test.tsx`

**Interfaces:**
- Consumes: `MapFocusRequest` from Task 1 and existing `ReplayState`.
- Produces: exported `ReplayFocusEvent`; `TimelineDock` prop `onFocusEvent: (event: ReplayFocusEvent) => void`.

- [ ] **Step 1: Write failing replay coordination tests**

```tsx
fireEvent.click(screen.getByRole("button", { name: "Select NOAA-20 detection at 2018-11-08T14:42:00Z" }));
expect(onFocusEvent).toHaveBeenCalledWith({
  acquiredAt: "2018-11-08T14:42:00.000Z",
  groupId: "cluster-1",
  detectionId: "detection-1",
});
expect(Number((screen.getByLabelText("Timeline position") as HTMLInputElement).value)).toBeCloseTo(23.7, 5);

fireEvent.click(screen.getByRole("button", { name: "Play timeline" }));
vi.advanceTimersByTime(1_999);
expect(onFocusEvent).not.toHaveBeenCalled();
vi.advanceTimersByTime(1);
expect(onFocusEvent).toHaveBeenCalledTimes(1);
```

Use a real stateful TimelineDock harness. Give its snapshot complete detection/group fields so the test observes the component rather than a mock implementation.

- [ ] **Step 2: Run the timeline tests and verify RED**

Run: `npm test -- tests/ui.test.tsx`

Expected: FAIL because marker clicks do not set the exact cutoff or emit structured focus events and playback still advances after 900 ms.

- [ ] **Step 3: Implement structured timeline focus**

```ts
export type ReplayFocusEvent = { acquiredAt: string; groupId: string; detectionId: string };

const emitFirmFocus = (mark: TimelineMark, stopPlayback: boolean) => {
  if (!mark.groupId || !mark.detectionId) return false;
  if (stopPlayback) setPlaying(false);
  onFocusEvent({ acquiredAt: mark.acquiredAt, groupId: mark.groupId, detectionId: mark.detectionId });
  return true;
};
```

Give FIRMS marks a `detectionId`. On mark click, call `emitFirmFocus(mark, true)`. In the playback effect, wait `2_000`, calculate the next replay state, find a FIRMS mark with the same cutoff, and call `emitFirmFocus(mark, false)` when present; otherwise call `onReplayChange(next)`. In `Dashboard`, keep a `{ id, mode, groupId }` focus request and handle the event by setting the exact replay state, selected group, and incremented request id before passing it to `MapCanvas`.

- [ ] **Step 4: Run timeline and dashboard tests and verify GREEN**

Run: `npm test -- tests/ui.test.tsx tests/ui-smoke-arrival.test.tsx`

Expected: PASS without act warnings.

- [ ] **Step 5: Commit replay-to-map coordination**

```bash
git add app/components/TimelineDock.tsx app/page.tsx tests/ui.test.tsx
git commit -m "feat: follow replay evidence on the map"
```

### Task 4: Motion, responsive styling, and full verification

**Files:**
- Modify: `app/components/MapCanvas.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `.map-focus-controls`, `.map-focus-button`, `.map-focus-status`, `.map-evidence-focus`, and `.thermal-dot.newest` classes from Tasks 2 and 3.
- Produces: responsive desktop/mobile styling and a one-shot reduced-motion-safe pulse.

- [ ] **Step 1: Write the visual behavior first in the existing component assertions**

Extend the Task 2 test to assert that exactly one visible detection has class `newest`, and that all three focus buttons remain reachable after toggling FIRMS off and on. Run it before changing the class assignment or CSS.

- [ ] **Step 2: Run the component test and verify RED**

Run: `npm test -- tests/ui-smoke-arrival.test.tsx`

Expected: FAIL because no detection carries the `newest` class.

- [ ] **Step 3: Add the minimal motion and layout styles**

```css
.map-focus-controls { display: flex; gap: 3px; padding: 3px; border: 1px solid #506055; border-radius: 8px; background: #101512ed; }
.map-focus-button { min-height: 32px; display: inline-flex; align-items: center; gap: 5px; padding: 0 9px; border: 1px solid transparent; border-radius: 5px; color: var(--muted); background: transparent; }
.map-focus-button[aria-pressed="true"] { border-color: #6d8b67; background: #2b402d; color: #eef7ea; }
.map-evidence-focus { margin-top: 10px; min-height: 34px; width: 100%; border: 1px solid #6d8b67; border-radius: 6px; background: #26382a; color: #eef7ea; }
.thermal-dot.newest::before { content: ""; position: absolute; inset: 8px; border: 1px solid #f0c56e; border-radius: 50%; animation: evidence-arrival 900ms ease-out 1; }
@keyframes evidence-arrival { from { opacity: .85; transform: scale(.45); } to { opacity: 0; transform: scale(1.6); } }
@media (prefers-reduced-motion: reduce) { .thermal-dot.newest::before { animation: none; opacity: 0; } }
```

At narrow widths, hide focus-button text only if the `aria-label` remains present; keep all three buttons at least 44 by 44 CSS pixels.

In `MapCanvas`, compute the latest finite `acquiredAt` value and add `newest` only to detections at that timestamp.

- [ ] **Step 4: Run all automated verification**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all Vitest tests pass, ESLint exits 0, production build exits 0, and `git diff --check` prints nothing.

- [ ] **Step 5: Verify the complete user journey with Computer Use**

In Safari at `http://localhost:3001`, exercise Asset, Evidence, Threat, FIRMS toggle, incident dossier, Focus on map, a FIRMS timeline mark, Play, and Pause. Confirm the live announcement and exact cutoff change in the accessibility tree. In Chrome at the same URL, repeat camera focus and timeline follow on the WebGL map, then visually inspect toolbar wrapping, dossier overlap, legend, HUD, and reduced motion behavior.

- [ ] **Step 6: Commit styling and verified polish**

```bash
git add app/components/MapCanvas.tsx app/globals.css
git commit -m "style: polish interactive command map"
```
