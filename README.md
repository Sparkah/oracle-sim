# Oracle Sim

A prediction model for the BattleBots Pro League 2026 season, scraped live through Bright
Data, and then **put on trial rather than sold as an oracle**.

Built at the BattleBots Hack Night, London, 28 July 2026.

The short version: we scraped the real season, built the model, and the honest result is that
it does not work. That finding, measured properly, is the product.

```
accuracy                56.5%   (13 of 23 fights)
record-only baseline    41.3%
Brier                   0.424   (0.25 = always saying 50/50)
90-100% confidence      lands 30% of the time
McNemar vs baseline     p = 1.00  (b=0, c=0 - they never once disagreed)
betting the model       1000 -> 246
```

A small-data model gets **dangerously confident long before it gets accurate**. That is what
this repository demonstrates, with the working shown.

## Run it

```bash
cd battlebots-sim
python3 -m http.server 8099      # any static server; it must be http, not file://
# open http://127.0.0.1:8099/
```

No build step, no npm install, no API key needed. The scraped data is committed, including
the raw page cache, so every number below reproduces offline:

```bash
node tools/eval.mjs              # model, calibration, McNemar, weights
node tools/bet.mjs               # season P&L - the cost of overconfidence
node tools/bet.mjs --l2 3        # the same season with the model regularised properly
node tools/sweep.mjs             # hyperparameter grid
node scrape/test_parsers.mjs     # parser + validator tests
node scrape/career.mjs           # re-derive 455 career fights from the cached pages
node tools/qa.cjs                # headless browser test (needs the server running)
```

## Where the data comes from

| Source | Bright Data product | Result |
| --- | --- | --- |
| battlebots.fandom.com | Web Unlocker | 25 pages, 24 bots, 23 fights |
| x.com | Scraper API dataset | 40 posts, 10 bots mentioned |
| youtube.com | Scraper API dataset | 470 comments over 15 episode videos, 21 bots mentioned |
| gamma-api.polymarket.com | Web Unlocker | live markets; no BattleBots market exists |
| reddit.com | Web Unlocker | **refused** (robots.txt), not fetched |

Nothing is hand-entered. There are no authored power ratings anywhere in the codebase - every
number the model uses is derived from the scraped fight list at load time.

Full detail, including the refusals and why they matter: [DATA_SOURCES.md](DATA_SOURCES.md).

## What is in here

- **`battlebots-sim/`** - the app. Arena, back-test, weapon meta, Polymarket port, data lineage.
- **`battlebots-sim-3d/`** - a 3D arena driven by the *same* model and the *same* bout timeline.
  CC0 assets, no generation APIs, no credits spent. See its `CREDITS.md`.

## Documents

- [FINDINGS.md](FINDINGS.md) - the three real results, including two bugs we found in our own work.
- [DATA_SOURCES.md](DATA_SOURCES.md) - every source, every refusal, and how provenance is enforced.
- [ARCHITECTURE.md](ARCHITECTURE.md) - the model, the back-test, and the decisions worth defending.
- [SUBMISSION.md](SUBMISSION.md) - the hackathon submission text.
- [battlebots-sim/SCHEMA.md](battlebots-sim/SCHEMA.md) - the frozen two-file data contract.

## Honest limitations

Stated here rather than buried, because the whole point of the project is not overclaiming:

- **23 fights, 24 bots.** Two fights each. Every win rate is 0, 0.5 or 1.
- **No fight method or duration anywhere in the source.** The wiki records who won and nothing
  else, so the KO-rate and survivability features carry weights of exactly `+0.000`. The model
  refuses to invent them.
- **18 of 24 bots are vertical spinners**, so most of the weapon-matchup grid is empty prior.
- **The +15.2 point "lift" over the baseline is not significant** and we do not claim it.
- **The fan data is volume, not sentiment.** Both the X and YouTube datasets return engagement
  counts, not tone, so no mood score is inferred anywhere. X additionally discovers by profile
  rather than by keyword.
- **The arena is forecast playback, not physics.** The model decides the winner and the visuals
  play toward it.

## Licence

Code MIT. Scraped data belongs to its sources. 3D assets are CC0, credited in
`battlebots-sim-3d/CREDITS.md`.
