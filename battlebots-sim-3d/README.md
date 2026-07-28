# Pro League Oracle - 3D Arena

The same bout the 2D arena plays, staged in 3D with real rigged mechs.

This folder is a **view**, not a second simulator. It imports the model and the bout generator
straight out of `../battlebots-sim/js/` and plays back the timeline they produce. Pick the
same two bots in both apps and you get the same winner, the same exchanges, the same damage
numbers and the same final clock, because it is literally the same code path - the fight
logic is not duplicated, re-tuned or re-rolled anywhere in here.

```
../battlebots-sim/js/model.js  -->  train()      the logistic model over scraped fights
../battlebots-sim/js/sim.js    -->  simulate()   deterministic bout timeline
./js/arena3d.js                -->  plays that timeline. Owns no outcomes.
```

## Run it

```bash
# from ~/Agents
bash Shared/tools/preview.sh Shared/experiments/battlebots-sim-3d "..."
# -> http://127.0.0.1:8099/Shared/experiments/battlebots-sim-3d/
```

Any static server works, and there is no build step. It must be http, not `file://` - the app
fetches JSON and uses ES modules. It needs the `battlebots-sim` folder to be its sibling.

three.js comes from unpkg via an import map in `index.html`. If the venue wifi is unreliable,
that import map is two lines and `index.html` says exactly what to swap them for.

## What the 3D view adds

- **Real fighters.** Four CC0 rigged mechs from Quaternius' Animated Mech Pack, with their own
  Idle / Run / Punch / SwordSlash / HitRecieve / Death / Dance clips. See `CREDITS.md`.
  Twenty-four bots map onto four models deterministically by weapon class, and the mapping
  guarantees the two fighters in any bout are never the same model.
- **Weapons that match the data.** Each bot's scraped `weapon` field builds its own rig:
  a toothed drum for a vertical spinner, a sweeping bar for an undercutter, a hinged wedge for
  a flipper, a hinged beak for a crusher, an overhead axe for a hammer. Spinners run
  continuously; contact weapons animate on the exchange they land.
- **Corner colour everywhere.** Red for A, blue for B, on the floor ring, the name plate, the
  weapon edges, the corner lights and the HP bars - the same convention the 2D arena uses.

## How a bout is staged

`simulate()` hands over a list of events. The renderer runs a three-phase cycle per event -
close, impact, break off - pacing the whole timeline into roughly twenty seconds regardless of
how many exchanges it contains. The engagement axis rotates a little each cycle so the fight
moves around the box rather than grinding in one spot. On impact it pops the next event, plays
the attacker's swing and the defender's flinch, spawns sparks and debris, shakes the camera,
and drives the HP bar off the event's own `hpA`/`hpB` values.

Nothing in that loop can change who wins. The last event decides it, and `bout.method` decides
whether the loser falls over (`Death`) or just loses on points (`No`).

## Known gaps

- **The scraped season has no flippers and no crushers.** It is eighteen vertical spinners,
  five horizontal spinners and one hammer. Those two weapon rigs are built and smoke-tested
  headlessly (`qa/qa.cjs` builds all five and asserts none throw), but they have never been
  seen in a live bout because no bot in the current data has one. A re-scrape that turns up a
  flipper will exercise them for the first time on stage.
- **Four models for twenty-four bots.** Two vertical spinners will always draw the same two
  mechs as each other, just in different corners.
- The clock is interpolated onto the bout's real duration rather than tracking event
  timestamps individually, so it advances smoothly rather than in the sim's actual jumps.

## Commands

```bash
node qa/qa.cjs                                  # headless: boots, fights, screenshots
QA_TAG=ko QA_A=manta QA_B=skorpios node qa/qa.cjs   # a specific matchup (KO path)
```

`qa/qa.cjs` needs the preview server on 8099. It writes `qa/shots/<tag>-*.png`, reports every
HTTP 4xx by URL, and exits non-zero on any console error, page error or failed request.
Screenshots are taken with `captureBeyondViewport:false` - the default hangs forever on a
canvas that animates every frame.

## Layout

```
index.html          import map, picker, HUD, winner card
styles.css
js/main.js          data load, model train, UI wiring. No fight logic.
js/arena3d.js       three.js scene, mech loading, weapon rigs, bout playback
assets/models/      four CC0 .glb mechs - see CREDITS.md
qa/qa.cjs           headless browser QA
```
