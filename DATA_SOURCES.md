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

### reddit.com - Scraper API dataset `gd_lvz8ah06191smkebj4` - 497 posts

Top posts of the month from r/battlebots, discovered by `subreddit_url`. 16 of 24 bots are
discussed; HUGE leads with 18 posts carrying 9,649 upvotes, then Tombstone on 16.

Volume and upvotes, not sentiment, for the same reason as the others.

This one is the honest low point of the build. Reddit was written off early: Web Unlocker
refuses it, one dataset attempt returned a validation error, and it was abandoned - while
x.com and youtube.com were pursued through the identical mechanism until they worked. It only
got revisited because someone at the event said Reddit worked for them.

It did. The first attempt had sent a `date` field that mode does not accept, and the second
sent `time_filter` instead of `sort_by_time`. Correcting the field name was the entire fix.
The collection then took 7.8 minutes, against 26 seconds for X and 34 for YouTube, which is
why it looked dead when it was merely slow.

### gamma-api.polymarket.com - Web Unlocker

Used to answer one question: does a robot-combat prediction market exist? Searched `battlebots`,
`robot` and `robot combat`. It does not - the only robot markets are Figure and Tesla Optimus.

So the app emits the Pro League matchups as genuine Polymarket market objects, clearly labelled
**PROPOSED - NOT TRADED**. The in-app Polymarket layer performs a real lookup against real
fetched markets, finds nothing, says so, and **refuses to fall back on our own proposed prices** -
folding those back in would be the model confirming itself.

## What Web Unlocker refuses, and why it does not matter

All three social platforms return the same message:

```
Request Failed (bad_endpoint): Requested site is not available for immediate access mode
in accordance with robots.txt. Ask your account manager to get full access for targeting this site
```

Adding our IP to the allowlist **changed nothing**, because it was never an IP restriction.
x.com, reddit.com and youtube.com are carved out of Web Unlocker's immediate-access mode and
served by dedicated Scraper API datasets instead.

**All three were fetched successfully through those datasets.** Not one was a wall. Every
refusal in this project turned out to be a routing problem.

The technique that unlocked them is worth stating plainly, because it is reusable: **the
validation errors are the contract.** Each rejection names the field it will not take or lists
the discovery modes it supports - `profile_url` and `profiles_array` for X, `subreddit_url`,
`keyword` and `author_url` for Reddit - so every failed call narrows the input until it is
accepted. Nothing here required documentation we did not have.

The mistake worth reporting: we tested Reddit, hit the refusal, and generalised it into "the
social platforms are unavailable" without testing the others. That assumption cost us YouTube -
the single richest source in the project - for most of the evening, and cost us Reddit until
someone told us it worked for them. One refusal is a data point, not a rule.

The one genuine failure is the `Reddit - Comments` dataset, which returned `records: 0` with a
crawl error. Post volume is included; Reddit comment text is not.

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
