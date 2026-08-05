# EmberField three-minute demo

Two parts on one clock.

**Part A (0:00 to 1:15) is the offline terminal demo.** One command. No API
keys, no Ollama, no network, no browser, no login. It prints the same numbers on
any machine that can run `npm install`. This is the part to record, and the part
that cannot fail in front of an audience.

**Part B (1:15 to 2:45) is the live console.** Richer, but it depends on a local
dev server, a warm local model, and — in Live mode — on five public services
being reachable. Treat everything in Part B as a bonus on top of a demo that has
already landed.

**Part C (2:45 to 3:00) closes.**

If you are running long, cut Part B from the back: drop Live mode first, then the
timeline, then Gemma. Never cut Part A.

For turning this into a recorded artifact, see `docs/RECORDING.md`.

## Timing at a glance

| Time | Beat | Surface | Can it fail? |
| --- | --- | --- | --- |
| 0:00 to 0:15 | The blind spot | Terminal | No |
| 0:15 to 0:20 | `npm run replay` | Terminal | No |
| 0:20 to 1:15 | Read the four blocks of output | Terminal | No |
| 1:15 to 1:35 | Same event on the map, plume corridor | Console, fixture | Needs dev server |
| 1:35 to 1:55 | Smoke-arrival panel | Console, fixture | Needs dev server |
| 1:55 to 2:15 | Gemma picks its own tools | Console, fixture | Needs warm Ollama |
| 2:15 to 2:25 | Rank the portfolio by risk | Console | Needs dev server |
| 2:25 to 2:45 | Timeline, then Live proof | Console, live | Needs network |
| 2:45 to 3:00 | Close | Anywhere | No |

---

# Part A — the offline terminal demo

Full-screen terminal. Large font. Nothing else on the desktop.

## 0:00 to 0:15 — the blind spot

Start with an empty prompt on screen and say:

> "An air-quality sensor on a farm can tell you that smoke has arrived. It
> cannot tell you that smoke is coming. On 8 November 2018 an orchard in Colusa
> County sat 104 kilometres downwind of the Camp Fire ignition point. Thirty
> minutes after ignition its air was still clean. This is what EmberField would
> have said at that moment."

## 0:15 to 0:20 — run it

```bash
npm run replay
```

That is the whole invocation. No flags, no environment variables, no keys, no
model. It returns in well under a second.

Say while it prints:

> "Nothing here is reaching the network. No API key, no Ollama, no hosted model."

## 0:20 to 1:15 — read the four blocks

This is the actual current output, captured from this repository:

```text
> emberfield@0.1.0 replay
> tsx scripts/replay-camp-fire.ts


  EmberField — Camp Fire replay
  8 November 2018 · offline · no keys · no model required
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SITUATION
  time now        2018-11-08 15:00:00 UTC
  asset           Colusa County Orchard (Camp Fire replay)
  air at asset    AQI 18 — clean  nothing is wrong yet
──────────────────────────────────────────────────────────────────────
  EVIDENCE
  detections      3 in 1 group · NOAA-20 + SNPP
  first seen      2018-11-08 14:42:00 UTC
  latest          2018-11-08 14:54:00 UTC
  wind            10 m/s from 60° (NASA POWER, 50 m)
──────────────────────────────────────────────────────────────────────
  SMOKE ADVECTION
  distance        103.6 km
  transport       toward 240° · asset 26° off axis
  transit         2.9 h raw → 4.3 h corrected
  confidence      moderate

  ▶ SMOKE ARRIVES 2018-11-08 19:10:43 UTC
  ▶ 4.2 HOURS OF WARNING
──────────────────────────────────────────────────────────────────────
  DID IT ACTUALLY HAPPEN?
  predicted       4.7 h after ignition
  observed        6.5 h after ignition  (EPA monitor, same coordinates)
  error           -1.8 h (early — the safe direction)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  104 km downwind at 26 deg off the 240 deg transport bearing, with 10 m/s wind. Straight-line advection gives 2.9 h, corrected to 4.3 h using the +1.4 h median lateness measured against EPA monitors during the 2018 Camp Fire. This is an advection estimate, not a fire-spread prediction.

  Informational context, not an evacuation tool. A satellite heat
  anomaly is not a confirmed wildfire. Follow local officials.
```

Walk it in four beats. Roughly fourteen seconds each.

**Beat 1 — SITUATION.** Point at `AQI 18 — clean`.

> "Fifteen hundred UTC, thirty minutes after ignition. The air at the orchard is
> AQI 18. A monitoring product built on air quality alone has nothing to say
> here, because nothing is wrong yet. That is exactly the window we care about."

**Beat 2 — EVIDENCE.** Point at the detections and the wind line.

> "Three VIIRS heat detections from two satellites, NOAA-20 and SNPP, grouped
> into one activity group rather than three separate alerts. Wind is 10 metres
> per second from 060, taken from NASA POWER at 50 metres — a keyless endpoint
> anyone can re-query."

**Beat 3 — SMOKE ADVECTION.** Point at the two amber lines.

> "The orchard is 103.6 kilometres away and sits 26 degrees off the transport
> bearing, so it is inside the plume corridor. Straight-line advection gives 2.9
> hours. We correct that to 4.3, because straight-line advection ran a median of
> 1.4 hours early against real EPA monitors. Arrival 19:10 UTC. Four point two
> hours of warning, from a satellite pass and a wind vector."

**Beat 4 — DID IT ACTUALLY HAPPEN?** This is the beat that earns the demo.

> "The asset is deliberately colocated with a real EPA PM2.5 monitor. That
> monitor's first hour above three times its pre-fire median was 6.5 hours after
> ignition. We predicted 4.7. We were 1.8 hours early — and early is the
> direction you want to be wrong in. This number is not a claim, it is a test:
> fourteen California monitors from 104 to 262 kilometres are asserted in
> `tests/smoke.test.ts`, including the two that the model gets badly wrong."

Close Part A on the safety line at the bottom of the screen:

> "And the last line never leaves the output. A heat anomaly is not a confirmed
> wildfire, and this is not an evacuation tool."

**If you are recording a terminal-only demo, stop here.** Part A is a complete,
self-contained artifact.

---

# Part B — the live console

## Pre-flight, before the clock starts

Do all of this before you begin speaking. None of it belongs inside the three
minutes.

1. `ollama serve` in its own terminal.
2. `ollama run gemma4:12b` once, ask it anything, then `/bye`. A cold model can
   exceed the agent's 90 second budget; `docs/SELF-EVALUATION.md` records a cold
   run that actually did time out. A warm run finished in about 26 seconds.
3. `npm run dev` in its own terminal. Open the URL it prints, on 127.0.0.1.
4. In the asset rail, select **Colusa County Orchard (Camp Fire replay)**.
5. Confirm the mode switch reads **Fixture data**.
6. Press **Asset**, **Evidence**, and **Threat** once each. Confirm that every
   control reframes the map and leave **Asset** selected.
7. Confirm the Gemma tool trace is collapsed, and the browser has no other tabs.

Selecting the Camp Fire asset pins the console to the same evaluation instant as
the terminal replay, so every number on screen matches the numbers you just
narrated. That continuity is the point of doing Part B at all.

## 1:15 to 1:35 — the same event, drawn

Switch from the terminal to the browser without changing the story.

> "Same event, same instant, now on a map. The green ring is the orchard's 120
> kilometre radius — sized for smoke, not for flame, which is why a source 104
> kilometres upwind is visible at all. The amber points are the raw VIIRS
> detections; each is the centre of a roughly 375 metre pixel, not a fire
> perimeter."

Press **Evidence**, then **Threat**, without pausing the narration.

> "This is an operational map rather than a poster. Asset frames the place we
> protect, Evidence fits every returned source, and Threat follows the active
> detection group. Selecting a satellite point opens its exact timestamp,
> confidence, radiative power, coordinates, and a one-click camera focus."

Point at the amber wedge opening away from the detections.

> "The wedge is the plume corridor: 50 degrees either side of the 240 degree
> transport bearing, drawn a third again past the source — about 135 kilometres
> here, and never past the 263 kilometre range the estimate is actually validated
> over. The four arcs inside it are hourly smoke-front positions — 22, 58, 94
> and 130 kilometres at hours two through five. They carry the same 1.4 hour
> calibration as the arrival time, which is why there is no arc at hour one:
> the front has not cleared the calibration delay yet. The map cannot draw
> smoke somewhere the panel says it cannot yet be."

Point at the HUD strip along the bottom of the map.

> "The heads-up line reads 120 kilometre radius, three raw detections, toward
> asset at 26 degrees offset, smoke in 4.2 hours."

Worth saying once, because judges will ask:

> "The corridor is a smoke-transport envelope. It is not a fire-spread
> prediction, and a wind shift invalidates it immediately."

## 1:35 to 1:55 — the smoke-arrival panel

Move to the activity inspector on the right.

> "The context score above is deterministic and inspectable — distance and age
> dominate, and every contribution is listed with its weight and its quality."

Then land on the smoke-arrival block.

> "This panel is the terminal output, in the console. Headline 4.2 hours.
> Moderate confidence, stated as a badge rather than buried. Estimated arrival
> 19:10 UTC on 8 November, transit time 4.3 hours."

Point at the small print under it.

> "And permanently, in the panel itself: a smoke-transport estimate from
> measured wind, which does not predict where the fire itself will go."

Scroll one notch to the evidence list and the official context row.

> "Wind alignment, humidity, air quality, detection age, and the WFIGS incident
> match. When a source is missing, EmberField marks Limited data and widens
> uncertainty. It never treats a missing input as a zero."

## 1:55 to 2:25 — Gemma chooses its own tools

Type into the evidence assistant:

> When would smoke reach the orchard?

Use that wording. It is not arbitrary: a question that maps to one tool's answer
grounds reliably (4 of 4 measured), while a compound question — "is smoke
heading here, and when would it arrive, and what is the score" — makes the model
write summarising prose that the validator cannot tie back to a tool result
(0 of 8 measured). Ask one thing at a time. "Which of my sites is in trouble?"
also grounds 4 of 4 and is the better second question.

While it runs, say:

> "This is Gemma 4 12B running locally through Ollama on loopback. Prompt,
> inference, and asset notes never reach a hosted AI service. Gemma is not
> narrating a fixed report: it selects from twelve schema-validated evidence
> tools, including the smoke-arrival estimate you just watched, can gather
> evidence over several rounds, and has to ground its answer in what those tools
> returned."

Expand **Visible tool trace**. Point at one entry.

> "Function name, validated arguments, duration, source status, and a bounded
> result summary. Deterministic code still owns the distances, the clustering,
> the score, and the arrival time. Gemma owns tool selection and synthesis."

Read one sentence of the briefing aloud. One. Do not read the whole thing.

**If the briefing falls back instead of grounding, do not retry and do not
apologise.** Say this and move on — it is a stronger point than the prose was:

> "That is the grounding validator refusing a sentence it could not tie back to
> a tool result. It would rather say nothing than say something unverifiable.
> The evidence is in the trace either way."

### The portfolio question — the one only an agent can answer

Everything so far describes one place. In the asset rail, press **Rank by risk**.

> "Every panel you have seen answers a question about one asset. An operator
> with an orchard, a barn, a livestock pasture and a crew in the field has a
> different question, and it is the one that matters: which of my places is in
> trouble right now? That is a judgement across assets, so no single-asset panel
> can produce it."

Point at the ranked rail and the portfolio sentence.

> "One call, every saved place, ranked by how soon smoke could reach it. Only
> the inbound one is amber and only the inbound one carries a number, because
> that is the only status with a number worth acting on. And the ordering is
> decided in code, not by the model — Gemma reads the ranking out, it does not
> get to invent it."

Worth adding, because it is the difference between a demo and a product:

> "An asset whose evidence could not be fetched is listed as a failure, not
> ranked as clear. Unreachable is unknown, not safe."

## 2:25 to 2:45 — timeline, then live proof

Play the timeline for a few seconds.

> "The 24-hour replay restores bounded detections and alert evidence across saved
> refreshes. Weather, air quality, and scores are shown only when their own
> timestamps fall at or before the cutoff — this prototype does not reconstruct
> past weather or recompute historical scores, and it says so on screen. This is
> a change in detected activity, not confirmed fire spread."

Switch the mode to **Live data** and refresh.

> "Live mode requests NASA FIRMS, AirNow, and WFIGS, then requests National
> Weather Service context per activity group. Each source keeps its own fetch
> time and observation time, and one source failing does not erase valid
> evidence from the others."

If Live returns nothing, do not apologise. Say:

> "An empty live result is a valid current answer. It does not prove the absence
> of fire, and the console does not pretend otherwise."

---

# Part C — 2:45 to 3:00 — close

> "EmberField takes public Earth observations and a private, local Gemma agent
> and turns them into an agriculture briefing that says what to verify next. The
> Camp Fire replay is checkable: 1.8 hours early against a real EPA monitor, with
> the failures kept in the test suite. Emergency decisions stay where they
> belong — with local officials."

---

## If something breaks mid-demo

| Symptom | What to say | What to do |
| --- | --- | --- |
| Dev server will not start | "Let me show you the part that never needs a server." | Go back to the terminal and re-run `npm run replay`. |
| Gemma status shows Offline | "The agent is local, so when Ollama is down the console says so instead of inventing an answer." | Skip to the timeline beat. |
| Gemma times out | "That is the 90 second budget doing its job rather than hanging." | Move on. Do not retry on stage. |
| Live returns no groups | "A valid empty result, not a failure." | Point at the source freshness rows showing NWS correctly marked not requested. |
| Map fails to render | "There is a non-WebGL fallback, which is the same evidence without the tiles." | Carry on in the fallback view. |
| Anything else | Nothing. | Re-run `npm run replay`. It is 0.3 seconds and it always works. |

## Reproducing the pasted output

```bash
npm run replay
```

The block above is verbatim, with ANSI colour escapes stripped. To regenerate it
in that form:

```bash
npm run replay 2>&1 | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g'
```
