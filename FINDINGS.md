# Findings

Three results, each reproducible from this repository with no API key. Two of them are bugs we
found in our own work, which is why they are here rather than quietly fixed.

---

## 1. The model does not work, and that is the finding

Reproduce: `node battlebots-sim/tools/eval.mjs`

```
accuracy             56.5%   (13/23)
record baseline      41.3%
Brier                0.424   (0.25 = always guessing 50/50)
log loss             1.348
McNemar exact        b = 0, c = 0, p = 1.000
calibration          90-100% bucket:  claimed 95.3%, actual 30.0%
learned weights      win rate +2.455 | KO rate +0.000 | survivability +0.000 | weapon +0.222
```

Read those in order. Brier 0.424 is **worse than refusing to predict at all**. The McNemar
counts are the sharpest statement: `b = 0` and `c = 0` means the model and a record-only
baseline never disagreed on a single fight in the whole season, so there is no evidence
whatsoever that it forecasts better. And the calibration line is the headline - when this model
says 95% it is right 30% of the time.

The two zero weights are not a failure, they are the model behaving correctly. The wiki records
who won and nothing else - no method, no duration - so the KO-rate and survivability features
have no data and the fit gives them exactly nothing rather than manufacturing signal.

**Why the +15.2 point "lift" is not a result.** Both systems are scored on the same 23 fights,
so the comparison is paired and independent confidence intervals are the wrong test. McNemar is
the right one and it returns p = 1.00. Most of the apparent gap comes from how ties are scored:
with two fights per bot, many fights have both competitors on identical records, where the
baseline scores 0.5 by construction.

**Sweeping regularisation drives Brier monotonically to exactly 0.2500** - the coin flip. The
correctly calibrated model on this data declines to bet. That is the right answer.

### The same statement in money

Reproduce: `node battlebots-sim/tools/bet.mjs`

```
bets placed  17 of 23     bankroll 1000 -> 246     ROI -55.2%
```

The model claims edges of 33% and pays for them. Run `--l2 3` and it places fewer bets and
stops bleeding. A calibration chart is the correct way to show this and almost nobody reads
one; a bankroll going to 246 is the same statement and everybody reads it instantly.

Caveat we enforce in the tool's own output: at 11-17 bets, a *positive* return would be noise.
The -754 is robust because it is systematic overconfidence; do not read the reverse as skill.

---

## 2. Our logistic fit diverged while reporting a great accuracy

At `l2 >= 6` the fit went to `NaN` **while `backtest` still reported 69.6% accuracy** - which
made the numerically broken model the best-looking cell in the hyperparameter sweep.

Gradient descent with weight decay is only stable while `lr * l2 < 2`. The update was

```js
w[j] -= lr * (g[j] / nRows + l2 * w[j]);
```

so the decay factor is `1 - lr*l2`. At `lr = 0.35`, anything past `l2 ≈ 5.7` overshoots zero
every epoch and oscillates outward. The fix scales the step instead of letting it explode:

```js
const step = Math.min(lr, 1 / Math.max(l2, 1e-9));
```

In the limit this drives the weights to zero, which is exactly what a large `l2` is asking for -
a model collapsed onto the 50/50 prior - rather than one that has blown up. There is also a
non-finite guard so a broken fit can never be returned as a good one.

**Why it matters:** trusting the sweep would have put "69.6% accuracy" on stage. A hyperparameter
search that silently rewards divergence is a trap that any project doing model selection can
fall into, and ours did.

---

## 3. We 5x'd the data and the model got worse

Reproduce: `node battlebots-sim/scrape/career.mjs`

Every competitor's wiki page carries a full career results table - opponents beaten and lost to,
per competition, going back to 2004. Those pages were **already in the cache** from the roster
crawl, so mining them cost zero extra requests.

```
559 raw career results
455 unique fights after dedupe   (6 dropped for conflicting winners)
103 with both competitors in the Pro League field
 90 new after removing this season's overlap
```

Deduplication is load-bearing: every fight is written on **both** competitors' pages, once as a
win and once as a loss. Failing to dedupe would have silently doubled the sample and made every
shrinkage constant in the model wrong. Where the two pages disagreed about who won, we dropped
the fight rather than picking a side.

Result of training on 113 fights instead of 23:

```
Brier      0.424  ->  0.299     (better calibrated)
accuracy   56.5%  ->  46.0%     (below chance)
lift       +15.2  ->  -0.9 pts
```

More data made it better calibrated and worse at picking winners, because the extra fights span
twenty years and several rule sets. **It was never a data volume problem, it was a data
relevance problem**, and five times more of the wrong distribution does not fix it.

We therefore left the app on the 23 real season fights and kept the career set as a separate
`data/fights_career.json`. Shipping a 46% headline would have been easy and misleading.

---

## What we would do next

- **Sentiment, properly.** All three social datasets return engagement counts and not tone, so
  the app reports volume and reach only. Real sentiment needs a model over the comment text we
  now hold - 470 YouTube comments and 497 Reddit posts - rather than another scrape.
- **Reddit comment text.** The `Reddit - Comments` dataset failed with a crawl error where
  `Reddit - Posts` succeeded. Worth retrying; it is the densest opinion source available.
- **More X profiles.** That dataset discovers by profile, so adding team accounts multiplies the
  coverage with a config change. It cannot keyword-search, which is the real ceiling.
- **Not more history.** We tested that. See above.
