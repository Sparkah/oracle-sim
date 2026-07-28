# Frozen data contract

The whole app reads exactly two files. Swap their contents for real scraped data and
nothing else needs to change. Do not rename fields at the venue - fix the scraper instead.

## `data/bots.json`

```json
{
  "_meta": {
    "source": "synthetic",
    "sourceLabel": "Synthetic demo season",
    "fetchedAt": "2026-07-28T09:00:00Z",
    "n": 24
  },
  "bots": [
    {
      "id": "tombstone",
      "name": "Tombstone",
      "weapon": "hspinner",
      "weightLb": 250,
      "color": "#d94f3d",
      "chatter": { "mentions": 412, "sentiment": 0.42 }
    }
  ]
}
```

`weapon` must be one of: `vspinner`, `hspinner`, `flipper`, `crusher`, `hammer`.
Anything else is bucketed to `control` and excluded from the matchup matrix.

`chatter` is optional. When absent the fan-sentiment column just reads `-`.

Note what is NOT in here: no win/loss record, no KO counts, no power rating. Every one of
those is derived from `fights.json` at load time (`model.js` -> `deriveRecords`). This is
deliberate. A scraped record field and a scraped fight list will disagree with each other
eventually, and then the back-test is quietly measuring nothing. One source of truth.

## `data/fights.json`

```json
{
  "_meta": { "source": "synthetic", "season": "PL-1", "n": 52 },
  "fights": [
    {
      "id": "f001",
      "a": "tombstone",
      "b": "hydra",
      "winner": "hydra",
      "method": "KO",
      "sec": 96,
      "event": "S1E3"
    }
  ]
}
```

- `a` / `b` are bot ids and must exist in `bots.json`. Unknown ids are dropped with a
  warning surfaced in the DATA panel rather than silently ignored.
- `winner` must equal `a` or `b`. A draw is not representable - drop the fight.
- `method` is one of `KO`, `JD` (judges' decision), `TAP` (tap-out / submission).
  Only `KO` vs non-`KO` is used by the model, so a scraper that cannot tell `JD` from
  `TAP` can emit either.
- `sec` is match length in seconds. Used for pacing and for the "grinder vs finisher"
  read on a bot. Missing values fall back to the season median.

## Field provenance

`_meta.source` drives the honesty badge in the header. `synthetic` renders a loud amber
SYNTHETIC DEMO DATA pill. Anything else renders a green LIVE pill with the source label.
Do not set it to a live label until the data really is scraped - demoing fabricated
numbers as real is the one way to lose an engineering-judged hack.
