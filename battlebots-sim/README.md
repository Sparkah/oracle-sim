# Pro League Oracle

A fight model fit on scraped BattleBots Pro League results, and a top-down arena that plays
out what the model predicts.

Two halves, deliberately:

- **The demo half.** Pick two bots, hit RUN FIGHT, watch a twenty-second bout with sparks,
  health bars and commentary that quotes real scraped numbers.
- **The substance half.** A leave-one-out back-test over the whole season showing the model
  beats a record-only baseline, with its calibration and its learned weights on screen.

A simulator with no validation is a toy. A dashboard with no simulator is the same thing
five other teams built. This is both, and the same model drives them, so the fight you watch
and the number you quote are the same claim.

## Run it

```bash
# from ~/Agents
bash Shared/tools/preview.sh Shared/experiments/battlebots-sim "..."
# -> http://127.0.0.1:8099/Shared/experiments/battlebots-sim/
```

Any static server works. It must be http, not `file://`, because the app fetches its data
as JSON and uses ES modules.

## The 60-second demo

1. ARENA tab. Leave the default matchup. Point at the prediction bar: *"this is the model's
   call before anything happens, and the two halves always sum to 100 because there is no
   bias term."*
2. RUN FIGHT. Let it play. The commentary drips in scraped facts between exchanges.
3. When it resolves, the result card says whether the model called it, and at what
   confidence.
4. BACK-TEST tab. *"That was one fight. Here is every fight of the season, each one
   predicted by a model refit from scratch without it."* Point at accuracy vs baseline.
5. If they look like they want to poke holes, go to WEAPON META and show the learned
   weights, or DATA and show the integrity checks.

Do not skip step 4. The arena is what makes people watch; the back-test is what makes
engineers believe it.

## Swapping in real data at the venue

The app never touches the network. `scrape/scrape.mjs` is the only thing that does, and its
entire job is to emit two files. Nothing else changes.

```bash
export BRIGHTDATA_API_KEY=...          # from the $100 credit link at the event
export BRIGHTDATA_ZONE=web_unlocker1

node scrape/scrape.mjs --list                    # confirm targets and that the key is set
node scrape/scrape.mjs --probe <a-real-url>      # DO THIS FIRST - proves the transport works
# edit TARGETS + the two parsers in scrape/scrape.mjs for the real markup
node scrape/test_parsers.mjs                     # keep this green as you edit
node scrape/scrape.mjs --out data --dry-run      # parse and validate, write nothing
node scrape/scrape.mjs --out data                # write it
node tools/eval.mjs                              # SEE THE NUMBER BEFORE YOU SHOW IT
```

Order matters. `--probe` first, because the Bright Data request shape is the one thing here
written against docs rather than against a live response. If it 401s or 404s, fix
`brightDataFetch` and nothing else in the file has to move. Then the parsers, which you will
be writing live against HTML you have not seen.

The header badge reads **SYNTHETIC DEMO DATA** in amber until `_meta.source` is something
other than `synthetic`, then it flips to a green LIVE pill. Leave that alone. Presenting
fabricated numbers as scraped is the one thing that loses an engineering-judged hack, and
the badge makes it impossible to do by accident.

If the scrape only half-works, the app degrades rather than lying: fights referencing unknown
bots are dropped and counted in the DATA tab, unrecognised weapons fall through to `control`
and are excluded from the matchup grid, and missing chatter just empties one table.

## How the model works

Logistic regression on four features, all differences between the two bots: win rate, KO
rate, survivability, and a weapon-matchup edge. Everything is derived from the fight list -
there are no hand-authored power ratings anywhere in the codebase.

Three decisions worth defending, because they are the ones that get asked about:

**No bias term.** A bias would encode "the bot listed first tends to win", which is an
artefact of scrape order. Dropping it makes the model exactly antisymmetric: P(A beats B) is
exactly 1 - P(B beats A). `tools/eval.mjs` asserts this to 1e-9 on every run. Every fight is
also trained in both orientations for the same reason.

**Shrinkage everywhere.** Each bot has about five fights, so a raw 5-0 is not evidence of a
100% win rate. Per-bot rates are pulled toward the league average by a pseudo-count, and the
5x5 weapon grid is pulled toward 50/50 the same way - some of its cells have two samples in
them, and without shrinkage a 2-0 cell reads as total dominance and the model believes it.

**The back-test refits per fight.** Leave-one-out means leaving the fight out of everything:
the weights, the feature scaling, the matchup grid, and the win/KO records the features are
built from. That last one is the step that is easy to skip and exactly where leakage would
hide, because a bot's win rate already contains the answer to the fight you are predicting.

### On the headline number, and why the lift is not what it looks like

On the real scraped season the model does not work, and it cannot be made to work: 56.5%
accuracy, Brier 0.424 against 0.25 for always saying 50/50, and a 90-100% confidence bucket
that lands 30% of the time. Sweeping regularisation improves Brier monotonically all the way
to 0.2500 exactly, which IS the coin flip. McNemar has b=0 and c=0 - the model and the
record-only baseline never once disagree, so p=1.00.

Do not present the +15.2 point "lift" as the model forecasting better. It is not significant,
and most of it comes from how tied records are scored: with two fights per bot, eleven of the
23 fights have both bots on identical records, where the baseline scores 0.5 by construction.

That is not a flaw in the model, it is 24 bots with two fights each. Every win rate is 0, 0.5
or 1. KO rate and survivability weights sit at exactly +0.000 because the wiki records who won
and nothing else - no method, no duration - and the model correctly refuses to invent them.

The honest headline is that the season is eight episodes old and not yet predictable, and that
a small-data model gets dangerously confident before it gets accurate. `tools/bet.mjs` is that
statement in money: following the naive fit loses 754 of a 1000 bankroll.

## Why the outcome is decided before the fight plays

The model picks the winner, then the renderer generates exchanges that arrive there. If the
visuals rolled their own dice you could show a 90% favourite losing on stage while the bar
above it still read 90%, and that reads as broken rather than as variance. Bouts are seeded
on the two bot ids, so a matchup always plays out identically and you can rehearse the exact
fight you intend to show.

## Layout

```
index.html  styles.css
js/model.js     features, logistic fit, matchup grid, leave-one-out back-test
js/sim.js       bout timeline generation + grounded commentary lines
js/render.js    canvas arena: steering, impacts, particles, name plates
js/audio.js     procedural Web Audio (no asset files, no <audio> element)
js/app.js       wiring, integrity checks, all four views
data/           the only two files the app reads - see SCHEMA.md
scrape/         Bright Data fetch + parsers + validation, and their tests
tools/          season generator, headless eval, hyperparameter sweep, browser QA
```

## Commands

```bash
node tools/gen_synthetic_season.mjs   # regenerate the demo season (deterministic)
node tools/eval.mjs                   # headless: accuracy, weights, calibration, matchup
node tools/sweep.mjs                  # hyperparameter grid
node scrape/test_parsers.mjs          # parser + validator tests
node tools/qa.cjs                     # headless browser: plays a real bout, screenshots
```

`tools/qa.cjs` needs the preview server on 8099 first.

## Global hackathon

Everything built at the event can be entered into Bright Data's `#battlebotsdev` hackathon,
deadline 31 July. Before submitting: run the real scrape so the badge is green, re-run
`tools/eval.mjs` and update the number quoted above, and re-run `tools/qa.cjs`.
