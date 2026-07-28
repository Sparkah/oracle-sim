# Architecture

## Shape

```
battlebots-sim/
  index.html  styles.css
  js/model.js      features, logistic fit, matchup grid, leave-one-out back-test, McNemar
  js/sim.js        bout timeline generation + commentary grounded in scraped numbers
  js/render.js     canvas arena: per-bot silhouettes, livery, impacts, name plates
  js/betting.js    odds, Kelly, season P&L
  js/audio.js      procedural Web Audio (no asset files, no <audio> element)
  js/app.js        wiring, integrity checks, prediction layers, all five views
  data/            the only files the app reads - see SCHEMA.md
  scrape/          Bright Data crawlers + parsers + their tests, and the raw page cache
  tools/           season eval, betting eval, hyperparameter sweep, headless browser QA
battlebots-sim-3d/ 3D arena importing the SAME model.js and sim.js
```

The app reads exactly two files, `data/bots.json` and `data/fights.json`, against a frozen
contract in `SCHEMA.md`. Swap their contents for a different season and nothing else changes.

## The model

Logistic regression on four difference features: win rate, KO rate, survivability, and a weapon
matchup edge. Four decisions are worth defending out loud.

**No bias term.** A bias would encode "the bot listed first tends to win", which is an artefact
of scrape order rather than a fact about robot combat. Dropping it makes the model exactly
antisymmetric - `P(A beats B) === 1 - P(B beats A)`, guaranteed rather than approximately.
`tools/eval.mjs` asserts this to 1e-9 on every run. Every fight is also featurised in both
orientations for the same reason.

**Shrinkage everywhere.** Each bot has about two fights, so a raw 2-0 is not evidence of a 100%
win rate. Per-bot rates are pulled toward the league average by a pseudo-count, and the 5x5
weapon grid is pulled toward 50/50 the same way - some of its cells have two samples in them,
and without shrinkage a 2-0 cell reads as total dominance and the model believes it.

**The back-test refits per fight.** Leave-one-out means leaving the fight out of *everything*:
the weights, the feature standardisation, the matchup grid, and the win/loss records the
features are built from. That last one is the step that is easy to skip and it is exactly where
leakage would hide, because a bot's win rate already contains the answer to the fight being
predicted.

**Features with no data get zero, not a guess.** The source has no fight method and no duration,
so KO rate and survivability carry weights of exactly `+0.000`.

## Prediction layers

Stackable, independently toggleable signals composed in **log-odds, not probability**. Adding
probabilities would let two layers push past 1.0 and would destroy the antisymmetry the whole
model rests on; adding log-odds preserves it exactly however many layers are stacked.

- `BASE MODEL` - the fit. Cannot be switched off; there is nothing to layer onto without it.
- `X BUZZ` - scraped reach, squashed through `tanh` so a viral post cannot overrule the fit.
  Off by default so the headline number cannot be accused of quietly containing it.
- `POLYMARKET` - a live lookup against really-fetched markets. Finds nothing, says so, and
  never substitutes our own proposed prices.
- `YOUR CALL` - a manual nudge.

## Why the outcome is decided before the fight plays

The model picks the winner, then the renderer generates exchanges that arrive there. If the
visuals rolled their own dice you could show a 91% favourite losing on stage while the bar above
it still read 91%, and that reads as broken rather than as variance. Bouts are seeded on the two
bot ids, so a matchup always plays out identically and a demo can be rehearsed.

This is **forecast playback, not a physics simulation**, and the app says so.

## Betting: why it is player-versus-player

An earlier version had you bet against a house priced off the record baseline. That was wrong,
and it is worth recording why: the bout's winner is drawn from the model's own probability
(`sim.js`: `rng() < pred.p`), so a house pricing off that same model is settling bets against
its own coin. Winning proved nothing.

The interactive layer is now two humans anteing into one pot, with the forecast as shared
information rather than a counterparty. That is a fair game, and it makes the determinism of the
bout irrelevant instead of fatal.

The *evidence* lives in `tools/bet.mjs`, which settles against real scraped outcomes and is not
circular.

## Integrity

- Boot-time checks drop fights referencing unknown bots and surface the count, rather than
  letting them poison the records silently. Unrecognised weapons fall through to `control` and
  are excluded from the matchup grid rather than being miscategorised.
- `scrape/test_parsers.mjs` covers the parsers and the validator, including a case asserting
  that a legitimate scrape is *not* rejected by an over-eager rule.
- `tools/qa.cjs` boots the page headlessly, plays a real bout, and checks console errors,
  prediction antisymmetry, commentary population and mobile overflow.

## Known trap for anyone reusing this code

`page.screenshot` hangs indefinitely on an animating canvas unless you pass
`captureBeyondViewport: false`. It makes Chrome re-composite the whole page off-screen and it
never returns while a `requestAnimationFrame` loop is running.
