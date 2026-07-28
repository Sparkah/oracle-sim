Oracle Sim scrapes the live BattleBots Pro League 2026 season through Bright Data and then puts the resulting prediction model on trial, instead of claiming it works.

WHERE THE DATA COMES FROM
- 25 pages from battlebots.fandom.com via Web Unlocker: the season page plus one page per competitor. 24 bots, 23 aired fights, weapon class and weight off each robot's own page. A plain curl gets 403 here, which is what Web Unlocker is for.
- 40 posts from x.com via the Bright Data Scraper API dataset, giving mention counts and reach per bot.
- Polymarket's public Gamma API, to check whether a robot-combat prediction market exists. It does not.
Nothing is hand-entered. There are no authored power ratings anywhere in the codebase.

THE MODEL
Logistic regression on four difference features, no bias term, so P(A beats B) = 1 - P(B beats A) exactly - asserted to 1e-9 on every run. Every fight is trained in both orientations. The back-test is leave-one-out and refits everything per held-out fight: the weights, the feature scaling, the weapon matchup grid, and the win/loss records the features are built from. That last step is the one people skip and it is exactly where leakage hides.

THE FINDING: IT DOES NOT WORK, AND THAT IS THE RESULT
56.5% accuracy. Brier 0.424, where 0.25 is what you get by always saying 50/50. The 90-100% confidence bucket lands 30% of the time. McNemar exact p = 1.00 with b=0 and c=0 - the model and a record-only baseline never disagreed once across 23 fights. Following the model loses 754 of a 1000 bankroll. Sweeping regularisation improves Brier monotonically to exactly 0.2500, the coin flip: the correctly calibrated model on this data declines to bet.
A small-data model gets dangerously confident long before it gets accurate. That is the product.

THREE THINGS WE FOUND BY LOOKING PROPERLY
1. Web Unlocker fetches the wiki fine but refuses x.com, reddit.com and youtube.com on robots.txt grounds. Adding our IP to the allowlist changed nothing, because it was never an IP restriction - the large social platforms are carved out of immediate-access mode and served by the dedicated Scraper API datasets instead. All three then worked: 40 X posts in 26 seconds, 470 YouTube comments in 34, and 497 r/battlebots posts in 7.8 minutes. Not one of them was a wall; every refusal was a routing problem. The validation errors ARE the contract - each rejection names the field or discovery mode it will not take, so the input narrows until it is accepted. We nearly missed all of this by generalising a single early refusal into "this platform is unavailable", which is the mistake worth reporting.
2. Our own logistic fit diverged to NaN at l2 >= 6 while still reporting 69.6% accuracy, which made the broken model the best-looking cell in the hyperparameter sweep. Gradient descent with weight decay is only stable while lr*l2 < 2. Fixed by scaling the step, so heavy regularisation now collapses onto the 50/50 prior instead of exploding.
3. We suspected the model was starved, so we mined every competitor's full career results table off the same cached pages - zero extra requests - giving 559 raw results deduped to 455 unique fights (each fight is written on both bots' pages, once as a win and once as a loss). Calibration improved, Brier 0.424 to 0.299, and accuracy fell below chance to 46%. It was never a volume problem. Twenty years of BattleBots across different rule sets is a different distribution.

PROVENANCE IS ENFORCED, NOT ASSERTED
The fetch route is recorded per page beside the cache, so a run served entirely from cache cannot inherit a Bright Data provenance it only partly has; any page with an unknown route forces a "mixed" label. The header badge reads SYNTHETIC in amber until the data is genuinely scraped. The DATA tab lists every source, which Bright Data product fetched it, and what was refused - a lineage that only shows what worked is a sales pitch, not a lineage.

ALSO IN THE BUILD
A 3D arena driven by the same model and the same bout timeline (CC0 Quaternius models, no generation APIs used, no credits spent). Head-to-head player-versus-player betting with a leaderboard - deliberately not betting against the model, because the bout is generated from the model's own probability and a house priced off it would be settling bets against its own coin. Stackable prediction layers composed in log-odds so antisymmetry survives: base model, X buzz, a live Polymarket lookup that honestly reports no market exists and refuses to substitute our own prices, and a manual override. Power rankings and a weapon-meta grid, which together with the predictor and the fan-discussion view cover four of the five project ideas in the event brief.
