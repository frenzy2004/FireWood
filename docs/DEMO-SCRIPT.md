# EmberField three-minute demo

## Before presenting

- Start Ollama and confirm `gemma4:12b` is available.
- Warm the model once on the presentation machine; a cold local model can exceed the agent's 45 second budget.
- Start EmberField with the ignored local keys present.
- Keep Fixture selected for a repeatable opening, then show Live source freshness.
- Preselect Antelope Creek Ranch and keep the Gemma trace collapsed.

## 0:00 to 0:25: the agriculture problem

"This is EmberField, a local-first wildfire context console for agriculture. A farmer may care about an orchard, livestock pasture, barn, storage site, and field crew at the same time. The evidence exists, but it is split across satellite detections, weather, air quality, and official incident systems. EmberField brings those signals together without pretending they are a fire prediction."

Point to the asset rail and the persistent safety label.

## 0:25 to 0:55: real evidence on one map

"The amber points are individual NASA-style VIIRS heat detections. Each is the center of an approximately 375-meter satellite pixel, not a confirmed fire perimeter. EmberField keeps the raw observations, then groups nearby passes into one activity group so operators are not alerted once per satellite overpass."

Select the nearest group. Show its acquisition times, satellites, confidence, FRP, asset radius, and any WFIGS perimeter or incident match.

## 0:55 to 1:25: transparent context, not a black box

"The context score is deterministic and inspectable. Distance and age matter most. Repeated satellite passes, downwind alignment, wind speed, dryness, and air quality can add context. If a source is missing, EmberField marks Limited data and widens uncertainty. It never treats missing data as zero."

Point to the score range, top reasons, missing inputs, and exact UTC timestamps. Mention that this is not an official danger rating.

## 1:25 to 2:10: Gemma as the local evidence agent

Ask:

> Inspect the selected orchard. Explain its current deterministic context score and summarize detected activity in the last 24 hours. Cite every evidence claim.

While Gemma runs, say:

"This is the actual Gemma 4 12B model running through local Ollama. The prompt, inference, and asset notes stay off hosted AI services. Live tools still send the necessary geography to the selected public source. Gemma is not decorating a fixed report. It chooses from ten schema-validated tools, including live Census geocoding, can gather evidence over several rounds, and must ground its answer in returned values."

Expand the tool trace. Point out function names, validated arguments, duration, and source state. Read one concise sentence from the final briefing.

## 2:10 to 2:35: activity over time

Play the timeline.

"The 24-hour replay restores bounded FIRMS detections and alert evidence across saved refreshes. The current snapshot's NWS and AirNow observations are shown only when their timestamps are at or before the replay cutoff; this prototype does not reconstruct past weather, AQI, or risk scores. We call this a change in detected activity, not confirmed fire spread."

Toggle one satellite source and scrub to an earlier time.

## 2:35 to 2:52: live proof

Switch to Live and refresh.

"Live mode requests NASA FIRMS, AirNow, and WFIGS, then requests National Weather Service context for each activity group. If FIRMS returns no groups, NWS is correctly marked not requested. Every source keeps its own observation and fetch time, and one source can fail without erasing valid evidence from the others."

If the live query is empty, say that it is a valid current result and does not prove the absence of fire.

## 2:52 to 3:00: close

"EmberField turns public Earth observations and a private local Gemma agent into a practical agriculture briefing. It helps operators understand what to verify next, while leaving emergency decisions where they belong: with local officials."
