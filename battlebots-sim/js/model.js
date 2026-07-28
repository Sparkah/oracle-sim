// Prediction model. Everything here is derived from the scraped fight list - there are no
// hand-tuned "power ratings" anywhere in this file.
//
// Design notes worth defending out loud:
//
// 1. NO BIAS TERM. A bias would encode "the bot listed first tends to win", which is an
//    artefact of scrape order, not of robot combat. Dropping it makes the model exactly
//    antisymmetric: P(A beats B) === 1 - P(B beats A), guaranteed, not approximately.
//
// 2. EVERY fight is featurised in both orientations. Same reason - the model never gets a
//    chance to learn anything from which side of the record a bot was written on.
//
// 3. THE BACK-TEST REFITS FROM SCRATCH PER FIGHT. Leave-one-out means leaving it out of
//    *everything*: the weights, the feature standardisation, the weapon matchup matrix, and
//    the win/KO records that feed the features. Recomputing records is the step that is easy
//    to skip and it is exactly where the leakage would hide - a bot's win rate already
//    contains the answer to the fight you are trying to predict.

export const CLASSES = ['vspinner', 'hspinner', 'flipper', 'crusher', 'hammer'];
export const CLASS_LABEL = {
  vspinner: 'Vertical spinner',
  hspinner: 'Horizontal spinner',
  flipper: 'Flipper',
  crusher: 'Crusher',
  hammer: 'Hammer / saw',
  control: 'Control',
};
const FEATURES = ['win rate', 'KO rate', 'survivability', 'weapon matchup'];
export const FEATURE_NAMES = FEATURES;

const norm = (w) => (CLASSES.includes(w) ? w : 'control');

// ---------------------------------------------------------------- derived records

// Pseudo-count for per-bot rates. A season gives each bot roughly five fights, so a raw
// 5-0 is not evidence of a 100% win rate - it is evidence of a good bot with a small
// sample. Rates are shrunk toward the league average by K_REC imaginary league-average
// fights. Without this the model hands out 95% predictions that land about 73% of the
// time, which is the difference between a calibrated forecast and a confident guess.
const K_REC = 3;

// Per-bot aggregates computed from a fight list. Pass a subset to exclude a fight.
export function deriveRecords(bots, fights) {
  const rec = {};
  for (const b of bots) {
    rec[b.id] = {
      id: b.id, w: 0, l: 0, n: 0,
      ko: 0, koLoss: 0,
      secTotal: 0, winSecTotal: 0, winSecN: 0,
    };
  }
  for (const f of fights) {
    const A = rec[f.a], B = rec[f.b];
    if (!A || !B) continue;
    const win = f.winner === f.a ? A : B;
    const lose = f.winner === f.a ? B : A;
    A.n++; B.n++;
    win.w++; lose.l++;
    if (f.method === 'KO') { win.ko++; lose.koLoss++; }
    const s = Number.isFinite(f.sec) ? f.sec : 180;
    A.secTotal += s; B.secTotal += s;
    win.winSecTotal += s; win.winSecN++;
  }
  // League priors, computed from this fight list only so the back-test stays clean.
  const all = Object.values(rec);
  const totalN = all.reduce((s, r) => s + r.n, 0) || 1;
  const priorKO = all.reduce((s, r) => s + r.ko, 0) / totalN;
  const priorKOLoss = all.reduce((s, r) => s + r.koLoss, 0) / totalN;

  for (const r of Object.values(rec)) {
    // raw values kept for display - the UI shows a real 5-0, not a shrunk 0.79
    r.rawWinRate = r.n ? r.w / r.n : 0.5;
    r.rawKoRate = r.n ? r.ko / r.n : 0;

    r.winRate = (r.w + K_REC * 0.5) / (r.n + K_REC);
    r.koRate = (r.ko + K_REC * priorKO) / (r.n + K_REC);
    r.koLossRate = (r.koLoss + K_REC * priorKOLoss) / (r.n + K_REC);
    r.survivability = 1 - r.koLossRate;
    r.avgSec = r.n ? r.secTotal / r.n : 180;
    r.avgWinSec = r.winSecN ? r.winSecTotal / r.winSecN : null;
  }
  return rec;
}

// ---------------------------------------------------------------- weapon matchup

// Shrunk toward 50/50 with a pseudo-count. A 5x5 grid over ~60 fights leaves cells with
// two or three samples in them; without shrinkage a 2-0 cell screams "100% dominance" and
// the model happily believes it. K is the number of imaginary even-split fights added to
// every cell, so a cell needs real volume before it moves far from zero.
const SHRINK_K = 6;

export function deriveMatchup(bots, fights, { k = SHRINK_K } = {}) {
  const weapon = Object.fromEntries(bots.map((b) => [b.id, norm(b.weapon)]));
  const wins = {}, total = {};
  for (const x of CLASSES) { wins[x] = {}; total[x] = {}; for (const y of CLASSES) { wins[x][y] = 0; total[x][y] = 0; } }

  for (const f of fights) {
    const wa = weapon[f.a], wb = weapon[f.b];
    if (!CLASSES.includes(wa) || !CLASSES.includes(wb) || wa === wb) continue;
    total[wa][wb]++; total[wb][wa]++;
    if (f.winner === f.a) wins[wa][wb]++; else wins[wb][wa]++;
  }

  const edge = {}, rate = {}, n = {};
  for (const x of CLASSES) {
    edge[x] = {}; rate[x] = {}; n[x] = {};
    for (const y of CLASSES) {
      if (x === y) { edge[x][y] = 0; rate[x][y] = 0.5; n[x][y] = total[x][y]; continue; }
      const p = (wins[x][y] + k / 2) / (total[x][y] + k);
      rate[x][y] = p;
      edge[x][y] = Math.log(p / (1 - p));   // exact negative of edge[y][x], by construction
      n[x][y] = total[x][y];
    }
  }
  return { edge, rate, n, rawWins: wins };
}

// ---------------------------------------------------------------- features

function featurise(aId, bId, rec, matchup, weapon) {
  const A = rec[aId], B = rec[bId];
  const wa = weapon[aId], wb = weapon[bId];
  const m = (CLASSES.includes(wa) && CLASSES.includes(wb)) ? matchup.edge[wa][wb] : 0;
  return [
    A.winRate - B.winRate,
    A.koRate - B.koRate,
    A.survivability - B.survivability,
    m,
  ];
}

function standardiser(rows) {
  const d = rows[0].length;
  const sd = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    // mean is structurally zero (every row appears with its negation), so scale only
    let ss = 0;
    for (const r of rows) ss += r[j] * r[j];
    sd[j] = Math.sqrt(ss / rows.length) || 1;
  }
  return {
    sd,
    apply: (row) => row.map((v, j) => v / sd[j]),
  };
}

// ---------------------------------------------------------------- logistic fit

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitLogistic(X, y, { epochs = 600, lr = 0.35, l2 = 0.02 } = {}) {
  const d = X[0].length;
  let w = new Array(d).fill(0);
  const nRows = X.length;
  // Gradient descent with weight decay is stable only while lr*l2 < 2. Past that the decay
  // term overshoots zero every epoch and oscillates outward: the fit diverges to NaN while
  // backtest still reports an accuracy, so a sweep hands back a broken model that looks like
  // the best cell in the grid. Shrink the step instead. In the limit this drives the weights
  // to zero, which is exactly what a large l2 is asking for - a model that has collapsed
  // onto the 50/50 prior - rather than one that has blown up.
  const step = Math.min(lr, 1 / Math.max(l2, 1e-9));
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < nRows; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) w[j] -= step * (g[j] / nRows + l2 * w[j]);
  }
  // Belt and braces: never hand back a non-finite fit, however it got there.
  if (!w.every(Number.isFinite)) return new Array(d).fill(0);
  return w;
}

// Train on a fight list. Returns a predictor closure plus the artefacts the UI shows off.
export function train(bots, fights, opts = {}) {
  const weapon = Object.fromEntries(bots.map((b) => [b.id, norm(b.weapon)]));
  const rec = deriveRecords(bots, fights);
  const matchup = deriveMatchup(bots, fights, opts);

  const raw = [], y = [];
  for (const f of fights) {
    raw.push(featurise(f.a, f.b, rec, matchup, weapon)); y.push(f.winner === f.a ? 1 : 0);
    raw.push(featurise(f.b, f.a, rec, matchup, weapon)); y.push(f.winner === f.b ? 1 : 0);
  }
  const std = raw.length ? standardiser(raw) : { sd: [1, 1, 1, 1], apply: (r) => r };
  const X = raw.map(std.apply);
  const w = raw.length ? fitLogistic(X, y, opts) : [0, 0, 0, 0];

  const predict = (aId, bId) => {
    if (!rec[aId] || !rec[bId]) return { p: 0.5, contrib: [0, 0, 0, 0], features: [0, 0, 0, 0] };
    const f = featurise(aId, bId, rec, matchup, weapon);
    const xs = std.apply(f);
    const contrib = xs.map((v, j) => v * w[j]);
    const z = contrib.reduce((s, v) => s + v, 0);
    return { p: sigmoid(z), contrib, features: f, z };
  };

  // Power ranking falls straight out of the model: average win probability against the
  // entire field. No separate scoring system to justify.
  const rating = {};
  for (const b of bots) {
    let s = 0, c = 0;
    for (const o of bots) { if (o.id === b.id) continue; s += predict(b.id, o.id).p; c++; }
    rating[b.id] = c ? s / c : 0.5;
  }

  return { predict, weights: w, scale: std.sd, records: rec, matchup, rating, weapon, nFights: fights.length };
}

// ---------------------------------------------------------------- evaluation

// Leave-one-out. Every fight is predicted by a model that has never seen it in any form:
// not in the weights, not in the standardisation, not in the matchup grid, and not in the
// win/KO records the features are built from.
export function backtest(bots, fights, opts = {}) {
  const rows = [];
  let brier = 0, logloss = 0, hits = 0, baseHits = 0;
  // McNemar counts. The model and the baseline are scored on the SAME fights, so the two
  // accuracies are paired and comparing their separate confidence intervals is the wrong
  // test - it is far too conservative. What matters is only the fights where the two
  // disagree: b = model right where baseline was wrong, c = the reverse.
  let mcB = 0, mcC = 0, mcTies = 0, mcTieWins = 0;

  for (const f of fights) {
    const rest = fights.filter((g) => g.id !== f.id);
    const m = train(bots, rest, opts);
    const { p } = m.predict(f.a, f.b);
    const actual = f.winner === f.a ? 1 : 0;
    const correct = (p >= 0.5) === (actual === 1);

    // Baseline: back whoever has the better record, computed on the same held-out data so
    // the comparison is fair. Ties score half a point rather than a coin flip, which keeps
    // the number stable across runs.
    const rec = m.records;
    const dw = rec[f.a].rawWinRate - rec[f.b].rawWinRate;   // naive: back the better record
    const baseScore = Math.abs(dw) < 1e-9 ? 0.5 : (((dw > 0) === (actual === 1)) ? 1 : 0);

    hits += correct ? 1 : 0;
    baseHits += baseScore;
    brier += (p - actual) ** 2;
    logloss += -(actual * Math.log(Math.max(1e-9, p)) + (1 - actual) * Math.log(Math.max(1e-9, 1 - p)));

    // ties (identical records) are excluded from the discordant counts rather than being
    // scored half-right, which McNemar has no way to represent
    if (baseScore === 0.5) { mcTies++; if (correct) mcTieWins++; }
    else {
      const baseCorrect = baseScore === 1;
      if (correct && !baseCorrect) mcB++;
      else if (!correct && baseCorrect) mcC++;
    }

    // The baseline as a PRICE, not just a right/wrong mark. Betting needs something to bet
    // against, and the fair thing to bet against is the same record-only view the accuracy
    // comparison already uses - priced Bradley-Terry style off the shrunk win rates, and
    // computed on the same held-out fit so the house never sees the fight either.
    const pBase = rec[f.a].winRate / Math.max(1e-9, rec[f.a].winRate + rec[f.b].winRate);

    rows.push({ fight: f, p, pBase, actual, correct, conf: Math.max(p, 1 - p) });
  }

  const n = fights.length || 1;

  // Calibration: when it says 70%, does it happen 70% of the time? Bucketed on confidence
  // in the predicted side so every bucket is >= 0.5 by construction.
  const bins = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
    const inBin = rows.filter((r) => r.conf >= lo && r.conf < hi);
    return {
      lo, hi, n: inBin.length,
      claimed: inBin.length ? inBin.reduce((s, r) => s + r.conf, 0) / inBin.length : null,
      actual: inBin.length ? inBin.filter((r) => r.correct).length / inBin.length : null,
    };
  });

  return {
    n: fights.length,
    accuracy: hits / n,
    baseline: baseHits / n,
    brier: brier / n,
    logloss: logloss / n,
    rows: rows.sort((x, y) => y.conf - x.conf),
    bins,
    mcnemar: { b: mcB, c: mcC, ties: mcTies, tieWins: mcTieWins, p: mcnemarExactP(mcB, mcC) },
  };
}

// Exact two-sided McNemar: under the null the two systems are equally likely to be the one
// that got a discordant fight right, so b ~ Binomial(b + c, 0.5).
export function mcnemarExactP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.max(b, c);
  // sum the upper tail exactly; n is tiny here so there is no need for an approximation
  const logChoose = (nn, kk) => {
    let s = 0;
    for (let i = 0; i < kk; i++) s += Math.log(nn - i) - Math.log(i + 1);
    return s;
  };
  let tail = 0;
  for (let i = k; i <= n; i++) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}
