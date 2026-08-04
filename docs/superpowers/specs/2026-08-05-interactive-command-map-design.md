# Interactive Command Map Design

## Purpose

Turn EmberField's evidence map from a passive layer viewer into the main command surface for investigating wildfire evidence. The interaction must remain grounded in the evidence already present in a `DashboardSnapshot`; camera motion and animation may explain the evidence, but may never manufacture detections, incidents, perimeters, wind, or arrival times.

## Product outcome

An operator can answer three map questions with one action:

1. **Where is my asset?** `Asset` frames the saved place and its monitoring radius.
2. **What evidence exists?** `Evidence` frames every visible detection, official incident, perimeter coordinate, and the asset.
3. **What is the active threat relationship?** `Threat` frames the selected activity group together with the asset. If no group is selected, it uses the first visible group; if no group exists, it falls back to the asset view.

The timeline and map behave as one instrument. Selecting a FIRMS timeline event pauses playback, moves the replay cutoff to that exact timestamp, selects its activity group, and asks the map to focus that group. Playback advances through real source timestamps at a deliberate two-second cadence and focuses each FIRMS event as it appears.

## Interaction model

### Camera focus modes

The existing reset control becomes a compact three-button segmented control:

- `Asset` — fit the saved asset radius with 48 pixels of padding and maximum zoom 12.
- `Evidence` — fit the asset plus every visible evidence coordinate with 56 pixels of padding and maximum zoom 11.
- `Threat` — fit the asset and selected activity-group centroid with 72 pixels of padding and maximum zoom 10.5.

All three controls expose visible text, an icon, `aria-label`, and `aria-pressed`. A polite live region announces the completed focus mode. When MapLibre is unavailable, the fallback keeps the same controls and state announcements; it must not pretend that geographic camera movement occurred.

Clicking a detection, activity group, or official incident selects it, opens the evidence dossier, and smoothly centers the real map on its coordinate without an excessive zoom. The dossier includes a `Focus on map` action so keyboard and screen-reader users can repeat the camera action without hunting for the marker.

### Evidence framing

Camera calculations live in a pure module, separate from MapLibre and React:

- `buildMapFocusPlan(snapshot, mode, selectedGroupId?)` returns a `MapFocusPlan` containing the requested mode, a non-empty southwest/northeast bounding box, and an optional focus coordinate.
- Polygon and multipolygon perimeter coordinates are flattened recursively. Malformed and non-finite coordinates are ignored.
- Degenerate one-point bounds are expanded by a minimum geographic delta so MapLibre never receives a zero-area fit.
- `selectionLocation(snapshot, selection)` returns the coordinate for a detection, group, or incident selection.
- `groupForDetection(snapshot, detectionId)` resolves the FIRMS activity group used by timeline-to-map synchronization.

These pure functions are the source of truth for both real-map camera behavior and fallback focus state.

### Timeline synchronization

`TimelineDock` emits a structured focus event rather than only a group id:

```ts
type ReplayFocusEvent = {
  acquiredAt: string;
  groupId: string;
  detectionId: string;
};
```

When a FIRMS marker is clicked, `TimelineDock` stops playback and calls `onFocusEvent` with the exact event. The dashboard then:

1. writes a replay state whose cutoff equals `acquiredAt` and whose source toggles are unchanged;
2. selects `groupId` in the dashboard;
3. increments a monotonic map-focus request carrying that group id.

During playback, the same callback fires after each FIRMS step. NWS and AirNow steps advance the replay cutoff but do not move or relabel the map. Restart clears playback and returns to the beginning of the 24-hour window.

### Motion language

- Camera transitions use a 700 ms `fitBounds` or `easeTo` animation when the user has not requested reduced motion; reduced-motion users receive duration 0.
- The newest visible detection receives one restrained amber pulse when its timestamp becomes visible. The pulse does not loop.
- No smoke animation suggests physical precision. The existing static directional corridor and wind cue remain explanatory overlays.
- Reduced-motion CSS disables the detection pulse and other map transition effects.

## Component changes

### `app/components/map-navigation.ts`

Owns camera plans, coordinate validation, perimeter flattening, selection location, and detection-to-group resolution. It has no browser, React, or MapLibre dependency.

### `app/components/MapCanvas.tsx`

Consumes a `focusRequest` from the dashboard, manages the active focus mode, translates pure focus plans into MapLibre camera calls, and keeps fallback focus state truthful. Marker clicks use one selection handler that updates the dossier and focuses the coordinate. The latest detection receives the one-shot pulse class.

### `app/components/MapEvidenceCard.tsx`

Adds the explicit `Focus on map` button while preserving the existing evidence summary and close behavior.

### `app/components/TimelineDock.tsx`

Adds `onFocusEvent`, sets exact cutoffs on marker clicks, emits FIRMS focus events during playback, and uses a 2,000 ms playback interval.

### `app/page.tsx`

Owns the monotonic map-focus request and provides the single coordination function that updates replay, selected group, and map focus together.

### `app/globals.css`

Styles the focus-mode segment, focus action, live/fallback state, and one-shot pulse. It includes `prefers-reduced-motion: reduce` handling.

## Failure and fallback behavior

- Missing snapshots keep the existing loading state.
- Missing detections or groups never disable `Asset`; `Evidence` frames whatever official context is present, and `Threat` falls back to `Asset`.
- Invalid perimeter geometry is skipped rather than crashing camera calculation.
- A focus request for a group that is hidden by the current replay state leaves the camera stable; the next visible FIRMS event supplies a resolvable focus request.
- MapLibre camera methods are guarded through `mapRef.current`. The WebGL-free fallback never throws and preserves all selection, layer, timeline, and accessibility behavior.

## Accessibility

- Every focus mode is a native button with visible text and `aria-pressed`.
- Marker selection state continues to use `aria-pressed` where applicable.
- Timeline marks name their source and exact UTC timestamp.
- Focus changes are announced through `aria-live="polite"`.
- The evidence dossier is keyboard reachable and contains native `Focus on map` and close buttons.
- Reduced motion removes the pulse and zeroes camera animation duration.

## Verification

Automated tests cover:

- asset, evidence, and threat camera bounds;
- malformed perimeter coordinates and degenerate bounds;
- detection-to-group and selection coordinate resolution;
- visible focus controls and accessible pressed/live state in the WebGL-free fallback;
- the dossier focus action;
- exact timeline marker cutoff, selection, and focus event;
- 2,000 ms replay cadence and FIRMS-only automatic focus behavior;
- regression coverage through the complete Vitest suite, ESLint, and production build.

Manual Computer Use verification covers:

- Safari fallback navigation, focus controls, marker dossier, layer toggles, exact timeline jump, play, and pause;
- Chrome geographic map navigation when MapLibre/WebGL is available, including camera fit, marker focus, evidence dossier, and timeline-driven camera follow;
- visual inspection at desktop width for overlap, clipping, contrast, and motion restraint.

## Non-goals

- No new map or animation dependency.
- No route planning, evacuation guidance, dispatch recommendation, or prediction of fire spread.
- No synthetic evidence and no external API request added to camera interaction.
- No redesign of the asset rail, activity inspector, or Gemma agent panel.
