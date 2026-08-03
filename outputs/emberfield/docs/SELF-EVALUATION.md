# EmberField self-evaluation

Evaluation date: 2026-08-04 MYT

Evaluated baseline: commit `db1bd9f`

This is a self-assessment, not a predicted judge score. It separates demonstrated behavior from planned work and applies deductions where proof is incomplete.

## Scorecard

| Criterion | Weight | Self-score | Evidence in the prototype | Main deductions |
| --- | ---: | ---: | --- | --- |
| Gemma Integration | 30 | 23 | Actual local `gemma4:12b`, native Ollama tool calls, nine schema-validated evidence tools, bounded multi-round loop, visible trace, deterministic source context | No recorded full real-model multi-round briefing in the final verification set; claim-level grounding remains a guardrail rather than formal proof; one 45 second budget can be tight after a cold model load |
| Innovation and Impact | 30 | 25 | Agriculture asset framing, five public evidence systems, explainable context rather than a spread prediction, local AI inference, explicit uncertainty | No grower field study, extension-service validation, or measured outcome data; live evidence coverage varies by place and time |
| Functionality | 20 | 15 | Live and fixture modes, map, saved assets, Census lookup, clustering, scoring, in-console alerts, replay, source freshness, Gemma agent | Background polling and outbound alerts are not implemented; historical snapshot persistence is still in progress; live probes can validly return sparse evidence |
| Presentation and Writeup | 20 | 16 | Coherent operations console, fixture story, permanent safety copy, visible tool trace, judging narrative, three-minute script | No public demo, mobile app, submitted video, or external usability review is included in this repository |
| **Total** | **100** | **79** | | |

## Gemma Integration: 23 of 30

### Demonstrated

- Ollama 0.32.5 reports a locally installed `gemma4:12b` model with an 11.9B parameter family, Q4_K_M quantization, and native tool capability.
- A real local `/api/chat` smoke test returned a native `inspect_asset` function call with the requested asset argument. This was not a mocked model response.
- The application exposes nine agriculture evidence tools for assets, activity groups, refresh, weather, air quality, official incidents, timeline evidence, and deterministic assessment explanations.
- Tool arguments are schema-validated. Results are bounded and sanitized before entering model history or the visible trace.
- Gemma chooses tools and synthesizes the briefing. Deterministic code retains ownership of distances, clustering, score contributions, and alert rules.
- Tests cover multi-round continuation, tool limits, timeout behavior, invalid calls, offline behavior, evidence citations, safety language, redaction, and trace rendering.

### Deductions

- The recorded real-model proof demonstrates native function selection, not a complete multi-round live-source briefing. A final demo rehearsal should capture at least two real tool calls and the resulting visible answer.
- Claim-level lexical grounding reduces unsupported prose, but it is not a formal verifier. It can still require hardening for unsupported generic claims and can reject legitimate paraphrases. The deterministic panels and source trace remain the authoritative evidence surface.
- The agent uses one 45 second budget for model work, tools, and persistence. The observed native call completed in about five seconds on this machine, including a cold load, but slower hardware or a more complex turn can time out.

## Innovation and Impact: 25 of 30

### Demonstrated

- The product centers fields, orchards, barns, livestock areas, workforce locations, and storage sites instead of treating wildfire context as one anonymous map pin.
- It combines NASA FIRMS VIIRS detections, NWS weather, AirNow air quality, WFIGS official incidents, and Census geocoding in one local console.
- It distinguishes a heat anomaly from a confirmed wildfire and a change in detected activity from confirmed spread.
- Missing sources reduce completeness and confidence instead of being converted to zero.
- Local Gemma inference keeps prompts and synthesis off hosted AI services. Credentials remain in server-side local configuration.

### Deductions

- Live source requests necessarily send the requested coordinates, bounding area, or address to the relevant public data service. Local-first does not mean live geographic queries never leave the machine.
- There is no documented field study with growers, ranchers, extension services, or rural emergency managers.
- The context score is a transparent comparison aid, not a validated agronomic or wildfire prediction model.
- The prototype has not measured faster decisions, reduced losses, or alert precision in operational use.

## Functionality: 15 of 20

### Demonstrated

- A clean export of baseline commit `db1bd9f` passed 139 tests across 11 files, passed ESLint, and completed the production build.
- Live source probes on 2026-08-03 UTC returned successful FIRMS, AirNow, WFIGS, and NWS responses. The result was honestly sparse: FIRMS returned zero detections, AirNow returned no current PM2.5 observation, WFIGS returned one incident and no perimeter, and NWS separately returned wind, direction, and humidity.
- Fixture mode supplies a deterministic, clearly labeled story for repeatable judging.
- The UI supports exact 1 to 100 km asset radii, address lookup cancellation, stable cluster identity, replay cutoffs, source freshness, mode-safe summaries, and stale-response protection.
- The map and inspector retain raw detections and present grouped activity, official context, score reasons, missing inputs, and UTC timestamps.

### Deductions and deferred scope

- Monitoring runs when the operator loads or refreshes the local console. There is no background scheduler.
- Alerts are currently in-console. SMS, email, mobile push, and desktop notification delivery are deferred.
- There is no native mobile application.
- Public hosting, accounts, multi-user authorization, and cloud synchronization are deferred.
- This is not an evacuation, dispatch, firefighting, or emergency-warning system.
- Snapshot persistence and historical replay status: **IN PROGRESS OUTSIDE THIS DOCUMENT COMMIT.** Coordinator update: replace this line only after the migration, repository behavior, routes, and tests land and pass.

## Presentation and Writeup: 16 of 20

### Demonstrated

- The console opens on a coherent agriculture scenario and keeps live versus fixture state visible.
- The UI exposes source freshness, missing data, score contributions, and Gemma tool traces instead of hiding the evidence chain.
- Permanent copy states the key FIRMS, pixel, acreage, spread, air-quality, and emergency-use limitations.
- `docs/HACKATHON.md` provides the judging narrative and `docs/DEMO-SCRIPT.md` provides a timed three-minute walkthrough.
- Responsive tabs, keyboard navigation, focus handling, loading states, retained-evidence errors, and agent offline states have automated coverage.

### Deductions

- The repository does not contain a final pitch video or recorded end-to-end demo.
- There is no publicly hosted judge URL because the chosen delivery is local-only.
- A final browser rehearsal on the presentation machine is still required for map rendering, responsive layout, live credentials, and actual Gemma latency.
- The current production build reports a large-chunk warning. It does not block the local demo, but it remains a performance cleanup item.

## Safety and privacy boundaries

- A FIRMS point is a satellite-detected thermal anomaly, not a confirmed wildfire, edge, or perimeter.
- VIIRS points represent the center of an approximately 375 meter pixel and cannot be converted into burned acreage.
- Detection frequency is described as detected activity, not confirmed spread.
- The context score is not an official danger rating and does not predict whether fire will reach an asset.
- Missing weather or air-quality evidence is labeled and reduces confidence.
- Users are directed to local emergency officials and NWS alerts for safety decisions.
- Gemma runs through loopback Ollama. Prompts are not sent to a hosted model.
- Live public-source calls do receive the coordinates, area, or address needed to answer the request.
- Source credentials are server-side and must never appear in browser payloads, screenshots, traces, or committed files.

## Best judging fit

EmberField fits both tracks, with the strongest primary story in the Autonomous Agent Track and a strong secondary story in GenAI for Good agriculture. The core claim is narrow and defensible: local Gemma autonomously selects evidence tools to help an agricultural operator inspect public wildfire context, while deterministic code and permanent safety language constrain the result.
