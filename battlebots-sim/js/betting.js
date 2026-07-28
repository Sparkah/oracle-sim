// Betting layer.
//
// Why this exists, and why it is the honest half rather than the fun half:
//
// A calibration chart is the correct way to show whether "70%" means 70%, and almost nobody
// reads one. A bankroll curve is the same statement denominated in money, and everybody
// reads it instantly. Betting the model against a price is the Brier score with the
// abstraction removed.
//
// The critical design point: you cannot make money betting into your OWN fair odds. Staking
// at a price derived from p, on an outcome that occurs with probability p, is zero-EV by
// construction no matter how good or bad the model is. Profit only exists relative to a
// DIFFERENT price. So the house here prices off the record-only baseline - the same
// comparison the back-test already makes - and the model bets only where it disagrees.
//
// That makes the season P&L a money-denominated McNemar test. If the model and the baseline
// disagree on one fight out of 23, there is exactly one bet to place all season and the
// curve is flat. That is not a broken feature, it is the finding.

export const VIG = 0.045; // house margin, applied to both sides so the book is overround

/** Fair decimal odds for a probability. 0.25 -> 4.00. */
export const fairOdds = (p) => 1 / Math.max(1e-9, Math.min(1 - 1e-9, p));

/**
 * The price actually offered, with the house margin taken out of the payout. Both sides are
 * shaded the same way, so the two implied probabilities sum to more than 1 - which is what
 * makes a real book beatable only with a genuine edge, and is why a model that merely
 * matches the baseline still bleeds.
 */
export const offeredOdds = (p, vig = VIG) => {
  // Taking the margin multiplicatively pushes very short prices below evens: a 99% shot
  // prices at 1.0101 fair, and 0.96 after vig, which would pay out LESS than the stake. No
  // book can offer that. Floor it just above 1.00 so the odds stay a real price.
  return Math.max(1.01, fairOdds(p) * (1 - vig));
};

/** What the offered price implies about probability - the number to compare a model to. */
export const impliedProb = (odds, vig = VIG) => (1 - vig) / Math.max(1e-9, odds);

/**
 * Kelly fraction for a bet at `odds` when you believe the true probability is `p`.
 * Returns 0 when there is no edge. Kelly is the mathematically optimal growth stake and it
 * is also brutally volatile, so callers scale it down - full Kelly on a model this uncertain
 * would be indistinguishable from gambling.
 */
export function kelly(p, odds) {
  const b = odds - 1;
  if (b <= 0) return 0;
  const f = (p * b - (1 - p)) / b;
  return Math.max(0, f);
}

/**
 * Walk the season, betting the model's disagreements with the house.
 *
 * `rows` are the leave-one-out back-test rows: each carries the model's out-of-sample
 * probability `p`, the house's record-only price `pBase`, and what actually happened.
 * Neither number has seen the fight being bet on.
 */
export function seasonPnL(rows, { bankroll = 1000, kellyScale = 0.25, vig = VIG, minEdge = 0.02 } = {}) {
  let bank = bankroll;
  const curve = [{ i: 0, bank, label: 'start' }];
  const bets = [];
  let staked = 0, won = 0, lost = 0, skipped = 0;

  for (const [i, r] of rows.entries()) {
    // Price both sides off the house's view of the fight.
    const oddsA = offeredOdds(r.pBase, vig);
    const oddsB = offeredOdds(1 - r.pBase, vig);

    // Back whichever side the model rates above the price implied by the house.
    const edgeA = r.p - impliedProb(oddsA, vig);
    const edgeB = (1 - r.p) - impliedProb(oddsB, vig);
    const backA = edgeA >= edgeB;
    const edge = backA ? edgeA : edgeB;
    const odds = backA ? oddsA : oddsB;
    const belief = backA ? r.p : 1 - r.p;

    if (edge < minEdge || bank <= 0) { skipped++; curve.push({ i: i + 1, bank, label: 'no bet' }); continue; }

    const stake = Math.min(bank, bank * kelly(belief, odds) * kellyScale);
    if (stake <= 0) { skipped++; curve.push({ i: i + 1, bank, label: 'no bet' }); continue; }

    const hit = backA ? r.actual === 1 : r.actual === 0;
    const delta = hit ? stake * (odds - 1) : -stake;
    bank += delta;
    staked += stake;
    hit ? won++ : lost++;
    bets.push({
      i, id: r.fight.id, a: r.fight.a, b: r.fight.b,
      backed: backA ? r.fight.a : r.fight.b,
      odds, edge, stake, hit, delta, bank,
    });
    curve.push({ i: i + 1, bank, label: `${hit ? '+' : ''}${delta.toFixed(0)}` });
  }

  const nBets = bets.length;
  return {
    start: bankroll,
    final: bank,
    profit: bank - bankroll,
    roi: staked > 0 ? (bank - bankroll) / staked : 0,
    nBets, won, lost, skipped,
    staked,
    hitRate: nBets ? won / nBets : null,
    curve,
    bets,
    // Betting every fight at the house price with no model at all. The vig alone guarantees
    // this bleeds, which is the point of showing it: "flat" is a win, not a failure.
    vigDrag: -vig,
  };
}

/** A single interactive wager, for the arena. */
export function settle({ stake, odds, hit }) {
  return hit ? { delta: stake * (odds - 1), payout: stake * odds } : { delta: -stake, payout: 0 };
}
