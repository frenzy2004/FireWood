# Recording the EmberField demo

Read this page once, top to bottom, before you touch anything. Then follow it
literally. Budget 30 minutes including one retake.

The narration for every beat lives in `docs/DEMO-SCRIPT.md`. This page is only
about producing the file.

## What you are producing

| Artifact | Command | Needs | Priority |
| --- | --- | --- | --- |
| `emberfield-replay.cast` | `npm run replay` under asciinema | Nothing but the repo | **Required** |
| `emberfield-console.mov` | macOS screen recording of the browser | Dev server, warm Ollama | Optional |

The `.cast` recording is the submission artifact. It is a public URL, plays in
any browser, needs no login from the viewer, and cannot fail because of a cold
model or a flaky public API. Produce it first. If you run out of energy after
that, you are done.

## Before anything: two things you must not record

- Never open `.dev.vars`, `.env`, or `.dev.vars.example` on camera, and never
  `cat` them. `.dev.vars` in this repo contains real keys.
- Never open the browser network tab or dev console during a screen recording.
  Request URLs carry API keys.

If either appears in a take, delete the take and start again. Do not try to edit
it out at 2am.

---

# 0. Pre-flight

Do every step. Tick them off.

## 0.1 Confirm the replay works before you start recording anything

```bash
cd /path/to/FireWood
npm install
npm run replay
```

You must see these three things in the output:

- `▶ SMOKE ARRIVES 2018-11-08 19:10:43 UTC`
- `▶ 4.2 HOURS OF WARNING`
- `error           -1.8 h (early — the safe direction)`

If you do not see them, stop. Nothing else on this page matters until this does.
The run should take well under a second.

## 0.2 Warm the model — only if you are also recording the console

Skip this entirely if you are only recording the terminal demo.

```bash
ollama serve
```

Leave that running. In a second terminal:

```bash
ollama list
```

Confirm `gemma4:12b` is listed. Then warm it:

```bash
ollama run gemma4:12b
```

At the `>>>` prompt, type `say ok`, wait for the reply, then type `/bye`.

This is not optional and it is not superstition. `docs/SELF-EVALUATION.md`
records a cold or queued run that hit the agent's 45 second budget and timed
out. The successful warm run finished in about 26 seconds. A cold model on
camera is the single most likely way this recording fails.

## 0.3 Silence the machine

- Turn on Do Not Disturb / Focus. Notifications will appear in a screen
  recording and they will appear in the menu bar.
- Quit Slack, Mail, Messages, and calendar apps.
- Close every other terminal window and every other browser tab.
- Plug in the laptop. Rendering and uploads are slower on battery.

## 0.4 Set up the terminal window

Make the font large. 16pt minimum, 18pt is better. A judge may be watching this
at a quarter of the screen.

Then set the window to a known size, from inside the terminal you will record
in:

```bash
printf '\e[8;40;100t'
stty size
```

`stty size` should print `40 100`. The replay prints 34 lines, one of which wraps
to three rows at this width, so forty rows holds the whole output and the command
above it without scrolling; a hundred columns keeps the 70-character rules from
wrapping.

Use a dark theme with reasonable contrast. The output uses bold, dim, amber,
green, and cyan; a low-contrast pastel theme destroys the dim safety text.

Finally:

```bash
clear
```

## 0.5 Install asciinema

```bash
brew install asciinema
asciinema --version
```

If Homebrew is not installed and you do not want to install it right now, skip
to section 2 and use the macOS screen recorder instead. Do not spend twenty
minutes fighting a package manager.

---

# 1. Record the terminal demo

This is the required artifact.

## 1.1 Understand the pacing problem before you start

`npm run replay` finishes in about 0.3 seconds. The whole screen appears at once.
If you record only the command, you get a two-second video that nobody can read.

The fix is to pace the recording with **typed shell comments**. A line starting
with `#` is visible in the recording, does nothing when you press Enter, and —
crucially — takes real time to type, which is time the viewer spends reading the
output above it. Do not use silent pauses for pacing; the idle-time limit
compresses them.

**Type the lines. Do not paste them.** Typing is the pacing mechanism.

## 1.2 Start the recorder

```bash
cd /path/to/FireWood
asciinema rec --idle-time-limit 2 --title "EmberField — Camp Fire replay (offline, no keys)" ~/Desktop/emberfield-replay.cast
```

`--idle-time-limit 2` caps any dead air at two seconds, so a fumble while you
find the next line does not become a hole in the recording.

If the file already exists from a previous take, delete it first:

```bash
rm -f ~/Desktop/emberfield-replay.cast
```

You are now recording. Everything you type is captured.

## 1.3 Type exactly this

```
# EmberField — Camp Fire replay
# 8 November 2018. No API key. No Ollama. No network. One command.
npm run --silent replay
# 15:00 UTC — thirty minutes after ignition, 104 km downwind.
# The orchard's air is clean: AQI 18. Nothing is wrong yet.
# Three VIIRS detections, two satellites, one activity group.
# Wind 10 m/s from 060, from NASA POWER at 50 m. Keyless, re-queryable.
# The orchard sits 26 deg off the 240 deg transport bearing — inside the plume.
# Straight-line advection: 2.9 h. Corrected for measured bias: 4.3 h.
# Smoke arrives 19:10 UTC. That is 4.2 hours of warning.
# Did it happen? The EPA monitor at those exact coordinates says 6.5 h.
# We said 4.7 h. Wrong by 1.8 hours, early — the safe direction.
# 14 monitors, 104 to 262 km, including the 2 failures: tests/smoke.test.ts
exit
```

Note `--silent`, which suppresses npm's own two-line banner and leaves only the
replay output.

Pacing rules, in order of importance:

1. After you press Enter on `npm run --silent replay`, **stop and count to
   three** before typing the next line. Let the screen land.
2. Type the comment lines at a normal, unhurried speed. Do not race.
3. Do not fix typos in comment lines. A typo in a comment is invisible; a
   backspace storm is not.
4. If you make a real mistake, press Ctrl-C, type `clear`, and carry on. Do not
   start the whole take over unless the replay output itself was wrong.

Target length: 60 to 90 seconds. Under 45 seconds means you typed too fast.

## 1.4 Stop the recorder

Type `exit` (the last line above) or press Ctrl-D. asciinema prints the path to
the saved file.

## 1.5 Watch it back before you upload

```bash
asciinema play ~/Desktop/emberfield-replay.cast
```

Check all of these:

- The full replay output is visible without scrolling.
- `4.2 HOURS OF WARNING` and `-1.8 h` are legible.
- The dim safety line at the bottom is readable, not washed out.
- No API key, no file path containing your name, and no `.dev.vars` anywhere.
- Total length is 60 to 90 seconds.
- There is no dead air longer than about two seconds.

If any check fails, delete the file and redo section 1.2 onward. A retake is
five minutes. A bad submitted artifact is permanent.

## 1.6 Upload and get the public link

```bash
asciinema upload ~/Desktop/emberfield-replay.cast
```

**Read the output of this command. Do not close the terminal.** It prints two
things:

1. The public URL of your recording. This is what goes in the submission.
2. On a first upload from a machine, a **claim URL**. Recordings uploaded from
   an unregistered install are deleted automatically after a short window — the
   command output states the exact deadline.

Open the claim URL in a browser and finish the association now, while you are
looking at it. An unclaimed recording will disappear before judging. This is the
single most common way this artifact is lost.

Then open the public URL in a **private/incognito window** to confirm it plays
with no login. That is the actual requirement.

Paste the URL somewhere you will find it again — the submission draft, or a note
file. Do not rely on shell history.

## 1.7 Keep an offline copy

Keep `~/Desktop/emberfield-replay.cast` and back it up. It is a small text file.
If the hosted link ever breaks, anyone can replay it with
`asciinema play emberfield-replay.cast`.

If you also want an embeddable image, for example for a Kaggle writeup that
cannot embed a player:

```bash
brew install agg
agg ~/Desktop/emberfield-replay.cast ~/Desktop/emberfield-replay.gif
```

Check the GIF's size. If it is over about 10 MB, re-run with `agg --fps-cap 10`.

---

# 2. Fallback: macOS screen recording

Use this if asciinema will not install, or if you also want the browser
walkthrough. It produces a `.mov` you upload wherever the submission accepts
video.

## 2.1 Interactive method

1. Press **Cmd-Shift-5**.
2. Choose **Record Selected Portion** and drag a box tightly around the terminal
   window. Do not record the whole screen — it captures your menu bar, your dock,
   and your wallpaper.
3. Click **Options**:
   - **Save to:** Desktop
   - **Timer:** None
   - **Microphone:** pick your mic if you are narrating, otherwise **None**
   - Untick **Show Floating Thumbnail**
   - Untick **Remember Last Selection** is not needed; leave it
4. Click **Record**.
5. Perform the demo exactly as in section 1.3. The typed comment lines still
   work as pacing, and they double as subtitles if you record without audio.
6. Stop with **Cmd-Ctrl-Esc**, or the stop button in the menu bar.
7. The `.mov` lands on the Desktop.

## 2.2 Command-line method

```bash
screencapture -v ~/Desktop/emberfield-replay.mov
```

Recording starts immediately and captures the whole screen. Press **Ctrl-C** in
that terminal to stop. macOS will ask for Screen Recording permission the first
time; grant it in System Settings and run the command again.

Because this captures everything, re-read section "two things you must not
record" before you start.

## 2.3 Trim the top and tail

Open the `.mov` in QuickTime Player, then **Edit → Trim**, drag the yellow
handles to cut the seconds where you were reaching for the keyboard, click
**Trim**, and **File → Save**. Nothing more elaborate is needed.

---

# 3. Optional: record the console walkthrough

Only attempt this after section 1 is finished and uploaded.

## 3.1 Set up, in this exact order

1. `ollama serve` is running, and you have already warmed `gemma4:12b`
   (section 0.2).
2. `npm run dev` in its own terminal. Open the URL it prints, on `127.0.0.1`.
3. Hide the browser bookmarks bar: **Cmd-Shift-B**.
4. Close every other tab. One window, one tab.
5. In the **Farm assets** rail on the left, select
   **Colusa County Orchard (Camp Fire replay)**.
6. Confirm the mode switch at the top reads **Fixture data**, not Live data.
7. Confirm the **Visible tool trace** toggle in the Gemma panel is collapsed.
8. Let the map finish loading tiles. Wait for it. A half-drawn basemap looks
   broken.

Selecting the Camp Fire asset pins the console to the same instant as the
terminal replay, so the on-screen numbers match the numbers in the `.cast`
recording. That continuity is the reason to record this at all.

## 3.2 Record in this order, and no other

Roughly 90 seconds. Follow Part B of `docs/DEMO-SCRIPT.md` for the words.

1. **The map, wide.** Green 120 km asset ring, amber detection points, the amber
   plume corridor wedge opening toward 240 degrees, and the four hourly smoke
   front arcs inside it at 22, 58, 94 and 130 km — hours two through five, with
   no arc at hour one. Let it sit for three seconds before you move the mouse.
2. **The HUD strip** along the bottom of the map: `120 km radius`,
   `3 raw detections`, `toward asset, 26° offset`, `Smoke in 4.2 h`.
3. **The smoke-arrival panel** in the activity inspector on the right: the
   `4.2 h` headline, the `moderate confidence` badge, the estimated arrival and
   transit line, and the permanent small print that this does not predict where
   the fire will go.
4. **Scroll once** to the evidence list, the context score contributions, and
   the source freshness rows. Do not scroll fast. One notch, pause, one notch.
5. **Gemma.** Type the prompt from the demo script, then sit still while it
   runs. Do not click anything while it is pending.
6. **Expand the tool trace.** Hold on one entry long enough to read the function
   name, the validated arguments, and the duration.
7. **Timeline.** Play it for about five seconds, then stop.
8. **Live data.** Switch the mode, refresh once, and hold on the source
   freshness rows.

If Gemma times out or reports offline, keep recording and move to step 7. The
console showing an honest offline state is better footage than a retake at 2am.

## 3.3 Mouse discipline

- Move the pointer slowly and deliberately. Fast mouse movement is unwatchable
  when scaled down.
- Park the pointer outside the panel you want read. Do not hover over the text.
- Never move the mouse while something is loading.

---

# 4. Final checklist

Before you close the laptop:

- [ ] `emberfield-replay.cast` exists on disk and is backed up somewhere else.
- [ ] The asciinema public URL plays in a private/incognito window with no login.
- [ ] The claim URL has been opened and completed, so the recording will not be
      auto-deleted.
- [ ] The URL is written down somewhere that is not shell history.
- [ ] No API key, key-bearing URL, `.dev.vars`, or personal filename appears in
      any take.
- [ ] The replay numbers in the recording match `docs/DEMO-SCRIPT.md`: 4.2 hours
      of warning, arrival 19:10:43 UTC, error -1.8 h.
- [ ] Anything you decided not to use is deleted, so you cannot submit the wrong
      file tomorrow.

---

# 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm run replay` errors out | Dependencies not installed | `npm install`, then retry |
| Replay prints different numbers | You are on the wrong branch or have local edits to `lib/` | `git status`, then get back to a clean tree |
| `asciinema: command not found` | Not installed | `brew install asciinema`, or use section 2 |
| Recording is only a few seconds | You paced with silence instead of typing | Redo with the typed comment lines in 1.3 |
| Output wraps and looks broken | Terminal too narrow | `printf '\e[8;40;100t'`, confirm with `stty size` |
| Colours are invisible on playback | Low-contrast terminal theme | Switch to a standard dark theme and retake |
| npm banner clutters the recording | You omitted `--silent` | Use `npm run --silent replay` |
| Upload prints a claim warning | Unregistered install | Open the claim URL immediately; otherwise it is deleted |
| Uploaded link asks for a login | You are looking at your own dashboard URL, not the recording URL | Re-check the URL the upload command printed, in incognito |
| Gemma spins then reports timeout | Cold or queued model | Stop, run `ollama run gemma4:12b` once, retake |
| Gemma reports offline | `ollama serve` not running | Start it, reload the console page |
| Map is blank | WebGL unavailable | The non-WebGL fallback view is legitimate footage; carry on |
| Live mode returns no groups | Valid empty current result | Say so on camera; point at the source freshness rows |
| macOS refuses to screen record | Permission not granted | System Settings → Privacy & Security → Screen Recording, enable your terminal, restart it |
