# Data sources

Every source, which Bright Data product reached it, and the two that refused. A lineage that
only lists what worked is a sales pitch, not a lineage.

## Fetched

### battlebots.fandom.com - Web Unlocker - 25 pages

The season page plus one page per competitor. Yields 24 bots, 23 aired fights (episodes 1-8,
2-23 July 2026), and each robot's weapon class and weight.

A plain `curl` to this host returns **403**, which is precisely what Web Unlocker is for.

Requests go to the MediaWiki `action=parse` endpoint and take back **page source, not rendered
HTML**. That is deliberate: the rendered markup is a moving target of nested divs, whereas the
wikitext is a stable contract and a fight is a single unambiguous line in it.

Two parsing decisions worth stating:

- **The roster comes from the six group-standings tables, not from the prose.** The prose names
  absentees - SawBlaze, Lock-Jaw, Whiplash and Hydra are all explicitly *not* in the Pro League -
  and a name-scraping parser will happily enrol them.
- **The winner is encoded purely as emphasis:** `'''[[Winner]]''' vs. [[Loser]]`. Unaired
  episodes render as `'''TBC vs. TBC'''` and are skipped, because bolding there is a formatting
  choice and not a result.

### x.com - Scraper API dataset `gd_lwxkxvnf1cynvib9co` - 40 posts

Mentions and reach per bot; 10 of 24 bots are mentioned.

This is a **different product** to everything above, and that is the interesting part. See
"Refused" below.

The dataset **discovers by profile, not by keyword** - it reports its own allowed types as
`profile_url` and `profiles_array`. So this is league and team account output, not a search of
all of X. That ceiling is recorded in `data/bots.json` under `_meta.chatter.caveat`.

We publish **reach, not sentiment**: the dataset returns engagement counts, not tone. Running a
keyword sentiment guess over 40 posts would be inventing a number the source never provided.

### youtube.com - Scraper API dataset `gd_lk9q0ew71spt1mxywf` - 470 comments

Comments across 15 Pro League episode videos, whose URLs came out of the wiki pages we had
already cached. 21 of 24 bots are discussed - Tombstone 50 mentions, Skorpios 48, HyperShock 20 -
which is more than double the coverage X gave us.

Again this is **volume and likes, not sentiment**, for the same reason: the dataset returns
engagement counts, not tone.

We nearly did not get this. Web Unlocker refuses youtube.com, and we had written it off as
unavailable. It is served by the same Scraper API dataset mechanism as X, and once that was
understood the collection took 34 seconds.

### gamma-api.polymarket.com - Web Unlocker

Used to answer one question: does a robot-combat prediction market exist? Searched `battlebots`,
`robot` and `robot combat`. It does not - the only robot markets are Figure and Tesla Optimus.

So the app emits the Pro League matchups as genuine Polymarket market objects, clearly labelled
**PROPOSED - NOT TRADED**. The in-app Polymarket layer performs a real lookup against real
fetched markets, finds nothing, says so, and **refuses to fall back on our own proposed prices** -
folding those back in would be the model confirming itself.

## Refused

### reddit.com - Web Unlocker

```
Request Failed (bad_endpoint): Requested site is not available for immediate access mode
in accordance with robots.txt. Ask your account manager to get full access for targeting this site
```

Adding our IP to the allowlist **changed nothing**, because it was never an IP restriction. The
large social platforms are carved out of Web Unlocker's immediate-access mode and served by the
dedicated Scraper API datasets instead. x.com and youtube.com hit the identical message and both
were reached successfully through their datasets - so the refusal is a routing problem, not a
wall. Reddit is the one we did not get, because we ran out of time rather than because it is
impossible.

We got this wrong for about an hour: we tested Reddit, hit the refusal, and assumed x.com and
youtube.com behaved the same way **without testing them**. They do not - both have datasets and
both work. That mistake cost us the richest source in the project until someone corrected us, and
it is recorded here rather than tidied away.

There is **no Reddit data in this repository**, rather than something invented in its place.

## Provenance is enforced, not asserted

The scraper records the fetch route **per page**, in a manifest beside the cache, at fetch time.

Inferring it later is how provenance quietly goes wrong: a second run served entirely from cache
has no live route at all, and reporting that as "direct" understates a Bright Data fetch exactly
as badly as the reverse would overstate one. Any cached page with no manifest entry is marked
`unknown`, which forces the whole dataset's label to `mixed`.

This caught a real defect during the build: a run that was fully cache-served was labelling
itself "direct fetch" when the pages had in fact come through Bright Data.

The header badge reads amber **SYNTHETIC DEMO DATA** until `_meta.source` is genuinely something
else. The DATA tab renders the full lineage including the two refusals. The badge cannot be
talked into claiming a route that was not taken.
